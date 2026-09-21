/**
 * Spell resolution.
 *
 * Instant spells resolve the moment they are cast. Telegraphed spells (and a
 * couple of delayed ability effects that behave identically) are queued as
 * `PendingSpell` entries and resolved by `updatePendingSpells`.
 */

import { FxKind, StatusKind, opposingTeam, type CardDef, type EntityId, type PlayerId, type Team } from '../../types.js';
import type { PlayerRuntime, Simulation } from '../Simulation.js';
import { displace } from './movement.js';

/** A spell effect waiting on its timer. */
export interface PendingSpell {
  /** 'spell' for real cards, 'strike'/'echo' for delayed ability effects. */
  kind: 'spell' | 'strike' | 'echo';
  team: Team;
  owner: PlayerId;
  /** Caster, where one is still relevant for attribution. */
  sourceId: EntityId | null;
  x: number;
  y: number;
  /** Seconds until the next impact. */
  delay: number;
  damage: number;
  radius: number;
  /** Impacts still to land. */
  impactsLeft: number;
  /** Seconds between impacts. */
  interval: number;
  cardId: string;
  /** Full card definition, for spells that do more than damage. */
  card?: CardDef;
}

export function updatePendingSpells(sim: Simulation, dt: number): void {
  for (let i = sim.pendingSpells.length - 1; i >= 0; i--) {
    const pending = sim.pendingSpells[i] as PendingSpell;
    pending.delay -= dt;
    if (pending.delay > 0) continue;

    resolveImpact(sim, pending);
    pending.impactsLeft--;

    if (pending.impactsLeft <= 0) {
      sim.pendingSpells.splice(i, 1);
    } else {
      pending.delay = pending.interval;
      // Scatter repeat impacts slightly so a barrage covers its zone.
      const spread = pending.radius * 0.45;
      pending.x += sim.rng.range(-spread, spread);
      pending.y += sim.rng.range(-spread, spread);
    }
  }
}

/** Lands one impact of a pending spell. */
function resolveImpact(sim: Simulation, pending: PendingSpell): void {
  const enemyTeam = opposingTeam(pending.team);
  const source = pending.sourceId !== null ? sim.entities.get(pending.sourceId) ?? null : null;
  const spec = pending.card?.spell;
  const buildingFactor = spec?.buildingDamageFactor ?? 0.4;

  if (pending.damage > 0) {
    for (const enemy of sim.entitiesInRadius(pending.x, pending.y, pending.radius, enemyTeam)) {
      // Spells hit structures for a reduced fraction, so no deck can simply
      // burn towers down from hand.
      const damage = enemy.isStructure ? pending.damage * buildingFactor : pending.damage;
      sim.dealDamage(enemy, damage, source, { isSpell: true });
    }
  }

  if (spec) applyNonDamageEffects(sim, pending, spec, source);

  sim.addFx({
    kind: FxKind.SpellImpact,
    x: pending.x,
    y: pending.y,
    scale: Math.max(1, pending.radius / 6),
    team: pending.team,
    cardId: pending.cardId,
  });
}

/** Knockback, statuses, dispels, heals and summons attached to a spell. */
function applyNonDamageEffects(
  sim: Simulation,
  pending: PendingSpell,
  spec: NonNullable<CardDef['spell']>,
  source: ReturnType<Simulation['entities']['get']> | null,
): void {
  const enemyTeam = opposingTeam(pending.team);
  const enemies = sim.entitiesInRadius(pending.x, pending.y, pending.radius, enemyTeam);
  const allies = sim.entitiesInRadius(pending.x, pending.y, pending.radius, pending.team);

  for (const enemy of enemies) {
    if (spec.knockback) displace(enemy, pending.x, pending.y, spec.knockback);
    if (spec.dispel) enemy.dispelBuffs();
    for (const status of spec.applies ?? []) {
      enemy.applyStatus(status.kind, status.duration, status.magnitude, source?.id);
    }
  }

  for (const ally of allies) {
    if (spec.heal) {
      // Structures are healed at a reduced rate.
      sim.heal(ally, ally.isStructure ? spec.heal * 0.4 : spec.heal);
    }
    for (const status of spec.appliesToAllies ?? []) {
      if (ally.isStructure && status.kind === StatusKind.Shielded) continue;
      ally.applyStatus(status.kind, status.duration, status.magnitude, source?.id);
    }
  }

  if (spec.summons) {
    const card = sim.cardLookup(spec.summons.cardId);
    if (card) {
      sim.spawnUnits(card, pending.team, pending.owner, pending.x, pending.y, {
        count: spec.summons.count,
        instant: true,
      });
    }
  }
}

/**
 * Casts a spell card. Instant spells resolve now; delayed ones are queued.
 * Energy has already been charged by `Simulation.playCard`.
 */
export function castSpell(
  sim: Simulation,
  player: PlayerRuntime,
  card: CardDef,
  x: number,
  y: number,
): void {
  const spec = card.spell;
  if (!spec) return;

  // Self-targeted utility: an energy overcharge on the caster, not a zone.
  if (spec.energyBoost) {
    player.energyBoost = {
      multiplier: spec.energyBoost.multiplier,
      remaining: spec.energyBoost.duration,
    };
    sim.addFx({
      kind: FxKind.LevelBanner,
      x,
      y,
      team: player.team,
      cardId: card.id,
    });
    // An energy spell may still carry a zone effect; fall through if it does.
    if (!spec.damage && !spec.applies && !spec.heal) return;
  }

  const impacts = Math.max(1, spec.impacts ?? 1);
  const pending: PendingSpell = {
    kind: 'spell',
    team: player.team,
    owner: player.id,
    sourceId: null,
    x,
    y,
    delay: spec.delay ?? 0,
    damage: spec.damage ?? 0,
    radius: spec.radius,
    impactsLeft: impacts,
    interval: spec.impactInterval ?? 0.4,
    cardId: card.id,
    card,
  };

  // Telegraph the landing zone so the opponent gets a chance to react.
  if (pending.delay > 0) {
    sim.addFx({
      kind: FxKind.Phase,
      x,
      y,
      team: player.team,
      cardId: card.id,
      scale: spec.radius / 5,
    });
  }

  if (pending.delay <= 0) {
    resolveImpact(sim, pending);
    pending.impactsLeft--;
    if (pending.impactsLeft > 0) {
      pending.delay = pending.interval;
      sim.pendingSpells.push(pending);
    }
  } else {
    sim.pendingSpells.push(pending);
  }
}
