/**
 * Periodic and on-death abilities.
 *
 * On-hit riders live in combat.ts, because they need the attack context.
 * Everything driven by a timer or by dying is handled here.
 */

import { forwardSign } from '../../constants.js';
import { AbilityKind, FxKind, StatusKind, opposingTeam } from '../../types.js';
import type { SimEntity } from '../entity.js';
import type { Simulation } from '../Simulation.js';
import { distance } from '../geometry.js';
import { displace } from './movement.js';

export function updateAbilities(sim: Simulation, dt: number): void {
  for (const entity of sim.entities.values()) {
    if (!entity.isAlive) continue;

    // Tick every ability cooldown down, even while silenced, so a silence
    // delays a use rather than resetting the whole rotation.
    for (const [kind, remaining] of entity.abilityTimers) {
      if (remaining > 0) entity.abilityTimers.set(kind, remaining - dt);
    }

    if (!entity.isActive) continue;

    updatePhaseShift(sim, entity, dt);
    updateCloak(sim, entity);

    if (!entity.canUseAbilities()) continue;

    for (const spec of entity.card.abilities ?? []) {
      switch (spec.kind) {
        case AbilityKind.GravityWell:
          if (ready(entity, spec.kind)) {
            arm(entity, spec.kind, spec.cooldown ?? 3);
            pullEnemies(sim, entity, spec.radius ?? 18, spec.value ?? 8);
          }
          break;

        case AbilityKind.Spawner:
          if (ready(entity, spec.kind) && spec.spawns) {
            arm(entity, spec.kind, spec.cooldown ?? 5);
            const card = sim.cardLookup(spec.spawns);
            if (card) {
              const sign = forwardSign(entity.team);
              sim.spawnUnits(card, entity.team, entity.owner, entity.x, entity.y + sign * 4, {
                count: spec.spawnCount ?? 1,
                instant: true,
              });
            }
          }
          break;

        case AbilityKind.MendPulse:
          if (ready(entity, spec.kind)) {
            arm(entity, spec.kind, spec.cooldown ?? 2.5);
            mendAllies(sim, entity, spec.radius ?? 14, spec.value ?? 60);
          }
          break;

        case AbilityKind.RallyAura:
          if (ready(entity, spec.kind)) {
            arm(entity, spec.kind, spec.cooldown ?? 1);
            rallyAllies(sim, entity, spec.radius ?? 15, spec.value ?? 0.25);
          }
          break;

        case AbilityKind.Barrier:
          if (ready(entity, spec.kind)) {
            arm(entity, spec.kind, spec.cooldown ?? 8);
            castBarrier(sim, entity, spec.radius ?? 12, spec.value ?? 200, spec.duration ?? 4);
          }
          break;

        case AbilityKind.Blink:
          tryBlink(sim, entity, spec.value ?? 14);
          break;

        default:
          // On-hit and on-death abilities are handled elsewhere.
          break;
      }
    }
  }
}

function ready(entity: SimEntity, kind: AbilityKind): boolean {
  return (entity.abilityTimers.get(kind) ?? 0) <= 0;
}

function arm(entity: SimEntity, kind: AbilityKind, cooldown: number): void {
  entity.abilityTimers.set(kind, cooldown);
}

// ---------------------------------------------------------------------------
// Individual abilities
// ---------------------------------------------------------------------------

/**
 * Phase Shift: the wraith periodically drops out of reality, becoming
 * untargetable, then bursts on return.
 */
function updatePhaseShift(sim: Simulation, entity: SimEntity, dt: number): void {
  const spec = entity.ability(AbilityKind.PhaseShift);
  if (!spec) return;

  if (entity.phased) {
    entity.phaseTimer -= dt;
    if (entity.phaseTimer <= 0) {
      entity.phased = false;
      // Burst on re-entry.
      const radius = spec.radius ?? 6;
      const damage = spec.value ?? 80;
      for (const enemy of sim.entitiesInRadius(entity.x, entity.y, radius, opposingTeam(entity.team))) {
        sim.dealDamage(enemy, damage, entity, {});
      }
      sim.addFx({ kind: FxKind.Phase, x: entity.x, y: entity.y, team: entity.team, scale: radius / 5 });
    }
    return;
  }

  if (!entity.canUseAbilities()) return;
  if (ready(entity, AbilityKind.PhaseShift)) {
    arm(entity, AbilityKind.PhaseShift, spec.cooldown ?? 6);
    entity.phased = true;
    entity.phaseTimer = spec.duration ?? 1.5;
    entity.targetId = null;
    sim.addFx({ kind: FxKind.Phase, x: entity.x, y: entity.y, team: entity.team });
  }
}

/** Cloak: invisible except in the moment of striking. */
function updateCloak(sim: Simulation, entity: SimEntity): void {
  if (!entity.hasAbility(AbilityKind.Cloak)) return;

  const shouldCloak = !entity.attacking && entity.canUseAbilities();
  if (shouldCloak && !entity.hasStatus(StatusKind.Invisible)) {
    entity.applyStatus(StatusKind.Invisible, 0.5, 1, entity.id);
  } else if (!shouldCloak) {
    entity.removeStatus(StatusKind.Invisible);
  }
}

/** Gravity Forge: drags every enemy in range toward the well. */
function pullEnemies(sim: Simulation, source: SimEntity, radius: number, strength: number): void {
  const enemies = sim.entitiesInRadius(source.x, source.y, radius, opposingTeam(source.team));
  for (const enemy of enemies) {
    if (enemy.isStructure) continue;
    const d = distance(source.x, source.y, enemy.x, enemy.y);
    // Pull harder the further out they are, up to the rim of the well.
    const pull = Math.min(strength, d * 0.6);
    displace(enemy, source.x, source.y, -pull);
  }
  sim.addFx({
    kind: FxKind.SpellImpact,
    x: source.x,
    y: source.y,
    scale: radius / 6,
    team: source.team,
  });
}

/** Lumen Warden: heals every damaged ally in range. */
function mendAllies(sim: Simulation, source: SimEntity, radius: number, amount: number): void {
  let healedAny = false;
  for (const ally of sim.entitiesInRadius(source.x, source.y, radius, source.team)) {
    if (ally.health >= ally.maxHealth) continue;
    // Towers heal at a reduced rate so a warden cannot stall out a push.
    const scale = ally.isStructure ? 0.4 : 1;
    if (sim.heal(ally, amount * scale) > 0) healedAny = true;
  }
  if (healedAny) {
    sim.addFx({ kind: FxKind.Heal, x: source.x, y: source.y, team: source.team, scale: radius / 8 });
  }
}

/** Aegis Drummer: hastes nearby allies. */
function rallyAllies(sim: Simulation, source: SimEntity, radius: number, magnitude: number): void {
  for (const ally of sim.entitiesInRadius(source.x, source.y, radius, source.team)) {
    if (ally.isStructure) continue;
    // Refreshed every second, so it lapses shortly after leaving the aura.
    ally.applyStatus(StatusKind.Hasted, 1.4, magnitude, source.id);
  }
}

/** Void Architect: projects a projectile-eating barrier over nearby allies. */
function castBarrier(
  sim: Simulation,
  source: SimEntity,
  radius: number,
  pool: number,
  duration: number,
): void {
  const allies = sim.entitiesInRadius(source.x, source.y, radius, source.team);
  let shielded = 0;
  for (const ally of allies) {
    if (ally.isStructure) continue;
    ally.applyStatus(StatusKind.Shielded, duration, pool, source.id);
    shielded++;
  }
  if (shielded > 0) {
    sim.addFx({ kind: FxKind.Shield, x: source.x, y: source.y, team: source.team, scale: radius / 7 });
  }
}

/**
 * Rift Runner: one-shot blink past whatever is blocking it. Only fires when
 * something actually stands in the way, so it is not wasted on an open lane.
 */
function tryBlink(sim: Simulation, entity: SimEntity, range: number): void {
  if (entity.blinkUsed) return;

  const target = entity.targetId !== null ? sim.entities.get(entity.targetId) : undefined;
  if (!target || !target.isAlive) return;
  // Only blink toward a structure objective - the point is bypassing blockers.
  if (!target.isStructure) return;

  // Is anything hostile standing between us and the objective?
  const blockers = sim
    .entitiesInRadius(entity.x, entity.y, 9, opposingTeam(entity.team))
    .filter((e) => !e.isStructure);
  if (blockers.length === 0) return;

  const sign = forwardSign(entity.team);
  const destY = entity.y + sign * range;
  sim.addFx({ kind: FxKind.Blink, x: entity.x, y: entity.y, team: entity.team });
  entity.blinkUsed = true;
  entity.y = destY;
  entity.targetId = null;
  sim.addFx({ kind: FxKind.Blink, x: entity.x, y: entity.y, team: entity.team });
}

// ---------------------------------------------------------------------------
// Death effects
// ---------------------------------------------------------------------------

/** Runs every on-death ability the entity carries. Called once, on death. */
export function runDeathEffects(sim: Simulation, entity: SimEntity, _killer: SimEntity | null): void {
  for (const spec of entity.card.abilities ?? []) {
    switch (spec.kind) {
      case AbilityKind.DeathBlast: {
        const radius = spec.radius ?? 8;
        const damage = spec.value ?? 100;
        for (const enemy of sim.entitiesInRadius(entity.x, entity.y, radius, opposingTeam(entity.team))) {
          sim.dealDamage(enemy, damage, entity, {});
          // Venom Spore leaves a lingering cloud on whatever it catches.
          if (entity.hasAbility(AbilityKind.VenomTouch)) {
            enemy.applyStatus(StatusKind.Poisoned, 4, 22, entity.id);
          }
        }
        sim.addFx({
          kind: FxKind.SpellImpact,
          x: entity.x,
          y: entity.y,
          scale: radius / 5,
          team: entity.team,
          cardId: entity.card.id,
        });
        break;
      }

      case AbilityKind.Split: {
        if (!spec.spawns) break;
        const card = sim.cardLookup(spec.spawns);
        if (card) {
          sim.spawnUnits(card, entity.team, entity.owner, entity.x, entity.y, {
            count: spec.spawnCount ?? 2,
            instant: true,
          });
        }
        break;
      }

      case AbilityKind.DeathCharge: {
        // Thunder Seed: charge up, then call a strike down on the grave.
        sim.pendingSpells.push({
          kind: 'strike',
          team: entity.team,
          owner: entity.owner,
          sourceId: null,
          x: entity.x,
          y: entity.y,
          delay: spec.duration ?? 2,
          damage: spec.value ?? 300,
          radius: spec.radius ?? 8,
          impactsLeft: 1,
          interval: 0,
          cardId: entity.card.id,
        });
        sim.addFx({
          kind: FxKind.Phase,
          x: entity.x,
          y: entity.y,
          team: entity.team,
          cardId: entity.card.id,
          scale: 1.5,
        });
        break;
      }

      default:
        break;
    }
  }
}
