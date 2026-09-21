/**
 * Attacks and projectiles.
 *
 * Melee and hitscan attacks resolve immediately; ranged attacks spawn a
 * travelling projectile that resolves on arrival. Splash, crits, knockback
 * and on-hit ability riders all funnel through `resolveHit`.
 */

import { CENTER_ZONE, forwardSign } from '../../constants.js';
import {
  AbilityKind,
  EntityKind,
  FxKind,
  StatusKind,
  type EntityId,
  type Team,
} from '../../types.js';
import type { SimEntity } from '../entity.js';
import type { Simulation } from '../Simulation.js';
import { angleTo, distance, normalize } from '../geometry.js';
import { displace } from './movement.js';

/** A projectile in flight. Engine-internal; projected into wire form on snapshot. */
export interface SimProjectile {
  id: EntityId;
  team: Team;
  cardId: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  /** Homing projectiles re-aim at a live entity each step. */
  targetId: EntityId | null;
  speed: number;
  damage: number;
  splashRadius: number;
  /** Entity that fired it, for on-hit riders and attribution. */
  sourceId: EntityId | null;
  crit: boolean;
  art: string;
  /** Set when the projectile has resolved and should be reaped. */
  done: boolean;
  /** Magnetizable projectiles can be stolen by a Magnetic Golem. */
  magnetic: boolean;
}

/** How long the attack animation flag stays raised, in seconds. */
const ATTACK_ANIM_SECONDS = 0.18;

export function updateCombat(sim: Simulation, dt: number): void {
  for (const entity of sim.entities.values()) {
    if (!entity.isAlive || !entity.isActive) continue;

    if (entity.attackAnim > 0) {
      entity.attackAnim -= dt;
      if (entity.attackAnim <= 0) entity.attacking = false;
    }

    if (entity.damage <= 0) continue;
    // Phasing units cannot attack while out of phase.
    if (entity.phased) continue;

    entity.attackCooldown -= dt;

    const rate = entity.currentAttackSpeed();
    if (rate <= 0) continue;
    if (entity.attackCooldown > 0) continue;

    const target = entity.targetId !== null ? sim.entities.get(entity.targetId) : undefined;
    if (!target || !target.isAlive || !target.isTargetableBy(entity)) continue;
    if (entity.gapTo(target) > entity.range) continue;

    entity.attackCooldown = 1 / rate;
    entity.attacking = true;
    entity.attackAnim = ATTACK_ANIM_SECONDS;
    entity.facing = angleTo(entity.x, entity.y, target.x, target.y);

    fireAttack(sim, entity, target);
  }
}

/** Resolves one attack, either instantly or by launching a projectile. */
function fireAttack(sim: Simulation, attacker: SimEntity, target: SimEntity): void {
  const crit = attacker.critChance > 0 && sim.rng.chance(attacker.critChance);
  let damage = attacker.damage * (crit ? attacker.critMultiplier : 1);

  // Magnetize releases everything the golem has absorbed on its next swing.
  if (attacker.magnetCharge > 0) {
    damage += attacker.magnetCharge;
    attacker.magnetCharge = 0;
  }

  // Siege specialists hit structures far harder than bodies.
  const siege = attacker.ability(AbilityKind.SiegeSpecialist);
  if (siege && target.isStructure) damage *= siege.value ?? 1.4;

  if (attacker.projectileSpeed > 0) {
    launchProjectile(sim, attacker, target, damage, crit);
  } else {
    resolveHit(sim, attacker, target, damage, crit, target.x, target.y);
  }

  // Echo schedules a weaker repeat of the same attack at the same place.
  const echo = attacker.ability(AbilityKind.Echo);
  if (echo && attacker.canUseAbilities()) {
    sim.pendingSpells.push({
      kind: 'echo',
      team: attacker.team,
      owner: attacker.owner,
      sourceId: attacker.id,
      x: target.x,
      y: target.y,
      delay: echo.duration ?? 0.5,
      damage: damage * (echo.value ?? 0.5),
      radius: Math.max(2.5, attacker.splashRadius),
      impactsLeft: 1,
      interval: 0,
      cardId: attacker.card.id,
    });
  }
}

function launchProjectile(
  sim: Simulation,
  attacker: SimEntity,
  target: SimEntity,
  damage: number,
  crit: boolean,
): void {
  sim.projectiles.push({
    id: sim.allocateId(),
    team: attacker.team,
    cardId: attacker.card.id,
    x: attacker.x,
    y: attacker.y,
    targetX: target.x,
    targetY: target.y,
    targetId: target.id,
    speed: attacker.projectileSpeed,
    damage,
    splashRadius: attacker.splashRadius,
    sourceId: attacker.id,
    crit,
    art: attacker.card.artwork,
    done: false,
    // Tower shots and unit shots are both magnetizable; spells are not.
    magnetic: true,
  });
}

export function updateProjectiles(sim: Simulation, dt: number): void {
  for (const p of sim.projectiles) {
    if (p.done) continue;

    // Home in on the live target where there still is one.
    const target = p.targetId !== null ? sim.entities.get(p.targetId) : undefined;
    if (target && target.isAlive && !target.phased) {
      p.targetX = target.x;
      p.targetY = target.y;
    }

    const step = p.speed * dt;
    const remaining = distance(p.x, p.y, p.targetX, p.targetY);

    // A Magnetic Golem in the flight path swallows the shot outright.
    const magnet = p.magnetic ? findMagnet(sim, p) : null;
    if (magnet) {
      const spec = magnet.ability(AbilityKind.Magnetize);
      magnet.magnetCharge += p.damage * (spec?.value ?? 0.5);
      sim.addFx({ kind: FxKind.Shield, x: magnet.x, y: magnet.y, team: magnet.team });
      p.done = true;
      continue;
    }

    // A barrier between shooter and target eats the projectile.
    if (blockedByBarrier(sim, p)) {
      sim.addFx({ kind: FxKind.Shield, x: p.x, y: p.y, team: p.team });
      p.done = true;
      continue;
    }

    if (step >= remaining) {
      p.x = p.targetX;
      p.y = p.targetY;
      const source = p.sourceId !== null ? sim.entities.get(p.sourceId) ?? null : null;
      if (target && target.isAlive) {
        resolveHit(sim, source, target, p.damage, p.crit, p.x, p.y, p.splashRadius);
      } else {
        // Target died mid-flight: splash still lands where it was aimed.
        if (p.splashRadius > 0) {
          splashAt(sim, source, p.team, p.x, p.y, p.splashRadius, p.damage, p.crit, null);
        }
        sim.addFx({ kind: FxKind.Hit, x: p.x, y: p.y, team: p.team, amount: 0 });
      }
      p.done = true;
      continue;
    }

    const dir = normalize(p.targetX - p.x, p.targetY - p.y);
    p.x += dir.x * step;
    p.y += dir.y * step;
  }
}

/** A hostile Magnetize carrier close enough to the projectile to absorb it. */
function findMagnet(sim: Simulation, p: SimProjectile): SimEntity | null {
  for (const e of sim.entities.values()) {
    if (!e.isAlive || e.team === p.team) continue;
    if (!e.hasAbility(AbilityKind.Magnetize) || !e.canUseAbilities()) continue;
    const spec = e.ability(AbilityKind.Magnetize);
    const radius = spec?.radius ?? 8;
    if (distance(p.x, p.y, e.x, e.y) <= radius) return e;
  }
  return null;
}

/** True when an enemy barrier stands between the projectile and its target. */
function blockedByBarrier(sim: Simulation, p: SimProjectile): boolean {
  for (const e of sim.entities.values()) {
    if (!e.isAlive || e.team === p.team) continue;
    const shield = e.status(StatusKind.Shielded);
    if (!shield || shield.magnitude <= 0) continue;
    // Only barriers cast by a Void Architect block; personal shields do not.
    if (shield.sourceId === undefined) continue;
    const source = sim.entities.get(shield.sourceId);
    if (!source || !source.hasAbility(AbilityKind.Barrier)) continue;
    if (distance(p.x, p.y, e.x, e.y) <= e.radius + 0.8) {
      shield.magnitude -= p.damage;
      if (shield.magnitude <= 0) e.removeStatus(StatusKind.Shielded);
      return true;
    }
  }
  return false;
}

/**
 * Applies one landed attack: primary damage, splash, and every on-hit rider
 * the attacker carries.
 */
export function resolveHit(
  sim: Simulation,
  attacker: SimEntity | null,
  target: SimEntity,
  damage: number,
  crit: boolean,
  hitX: number,
  hitY: number,
  splashRadius = attacker?.splashRadius ?? 0,
): void {
  const scaled = applyZoneModifier(attacker, target, damage);
  sim.dealDamage(target, scaled, attacker, { crit });

  if (attacker) {
    applyOnHitRiders(sim, attacker, target);
    if (attacker.knockback > 0) {
      displace(target, attacker.x, attacker.y, attacker.knockback);
    }
  }

  if (splashRadius > 0) {
    splashAt(sim, attacker, target.team, hitX, hitY, splashRadius, damage * 0.6, crit, target);
  }

  // Chain splash arcs a fraction of the damage onto neighbours.
  const chain = attacker?.ability(AbilityKind.ChainSplash);
  if (chain && attacker) {
    const radius = chain.radius ?? 7;
    const fraction = chain.value ?? 0.4;
    for (const other of sim.entitiesInRadius(target.x, target.y, radius, target.team)) {
      if (other.id === target.id) continue;
      sim.dealDamage(other, damage * fraction, attacker, {});
    }
  }
}

/**
 * Units fighting inside the contested centre take reduced tower fire, which
 * is what makes holding the middle worth doing.
 */
function applyZoneModifier(attacker: SimEntity | null, target: SimEntity, damage: number): number {
  if (!attacker || attacker.kind !== EntityKind.Tower) return damage;
  if (target.isStructure) return damage;
  const inZone = distance(target.x, target.y, CENTER_ZONE.x, CENTER_ZONE.y) <= CENTER_ZONE.radius;
  return inZone ? damage * CENTER_ZONE.towerDamageFactor : damage;
}

/** Status riders that some attackers apply on every landed hit. */
function applyOnHitRiders(sim: Simulation, attacker: SimEntity, target: SimEntity): void {
  if (!attacker.canUseAbilities()) return;

  const chill = attacker.ability(AbilityKind.ChillTouch);
  if (chill) {
    target.applyStatus(StatusKind.Slowed, chill.duration ?? 2, chill.value ?? 0.35, attacker.id);
  }

  const venom = attacker.ability(AbilityKind.VenomTouch);
  if (venom) {
    target.applyStatus(StatusKind.Poisoned, venom.duration ?? 4, venom.value ?? 25, attacker.id);
  }

  // Mirror Mite spawns a fading copy of itself on a cooldown.
  const mirror = attacker.ability(AbilityKind.MirrorClone);
  if (mirror) {
    const ready = (attacker.abilityTimers.get(AbilityKind.MirrorClone) ?? 0) <= 0;
    if (ready && mirror.spawns) {
      attacker.abilityTimers.set(AbilityKind.MirrorClone, mirror.cooldown ?? 5);
      spawnFrom(sim, attacker, mirror.spawns, mirror.spawnCount ?? 1);
    }
  }

  // Chrono Fox rewinds to where it stood a moment ago, dodging the answer.
  const rewind = attacker.ability(AbilityKind.Rewind);
  if (rewind) {
    const ready = (attacker.abilityTimers.get(AbilityKind.Rewind) ?? 0) <= 0;
    if (ready) {
      attacker.abilityTimers.set(AbilityKind.Rewind, rewind.cooldown ?? 4);
      const past = attacker.positionAt(sim.time, rewind.duration ?? 1.2);
      if (past) {
        sim.addFx({ kind: FxKind.Blink, x: attacker.x, y: attacker.y, team: attacker.team });
        attacker.x = past.x;
        attacker.y = past.y;
        sim.addFx({ kind: FxKind.Blink, x: past.x, y: past.y, team: attacker.team });
      }
    }
  }
}

/** Helper used by clone/split spawns to place a token next to its parent. */
function spawnFrom(sim: Simulation, parent: SimEntity, cardId: string, count: number): void {
  const card = sim.cardLookup(cardId);
  if (!card) return;
  const sign = forwardSign(parent.team);
  sim.spawnUnits(card, parent.team, parent.owner, parent.x, parent.y - sign * 2, {
    count,
    instant: true,
  });
}

/** Damages everything of the given team inside a radius, skipping the primary target. */
export function splashAt(
  sim: Simulation,
  attacker: SimEntity | null,
  team: Team,
  x: number,
  y: number,
  radius: number,
  damage: number,
  crit: boolean,
  skip: SimEntity | null,
): void {
  for (const other of sim.entitiesInRadius(x, y, radius, team)) {
    if (skip && other.id === skip.id) continue;
    sim.dealDamage(other, damage, attacker, { crit });
  }
  sim.addFx({ kind: FxKind.SpellImpact, x, y, scale: radius / 6, team });
}
