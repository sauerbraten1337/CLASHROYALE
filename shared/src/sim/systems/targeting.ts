/**
 * Target acquisition.
 *
 * Entities re-evaluate their target on a stagger rather than every tick: it
 * costs far less, and it stops units from jittering between two equidistant
 * enemies. A unit keeps its current target while that target stays alive,
 * legal and within leash range.
 */

import { AGGRO_LEASH, TARGET_REFRESH_SECONDS, forwardSign } from '../../constants.js';
import { EntityKind, TargetPriority, TowerSlot, opposingTeam, CardRole } from '../../types.js';
import type { SimEntity } from '../entity.js';
import type { Simulation } from '../Simulation.js';

export function updateTargeting(sim: Simulation, dt: number): void {
  for (const entity of sim.entities.values()) {
    if (!entity.isAlive || !entity.isActive) continue;
    // Structures with no weapon (spawners, gravity wells) never need a target.
    if (entity.damage <= 0) continue;

    entity.targetRefresh -= dt;

    const current = entity.targetId !== null ? sim.entities.get(entity.targetId) : undefined;
    const currentValid =
      current !== undefined &&
      current.isAlive &&
      current.isTargetableBy(entity) &&
      withinLeash(entity, current);

    if (currentValid && entity.targetRefresh > 0) continue;

    entity.targetRefresh = TARGET_REFRESH_SECONDS;
    const next = acquireTarget(sim, entity);
    entity.targetId = next ? next.id : null;
  }
}

/**
 * Units do not chase an enemy indefinitely - once a target drags them too far
 * from their own position they drop it and resume pushing. Structures never
 * leash (they cannot move anyway) and siege units ignore it.
 */
function withinLeash(entity: SimEntity, target: SimEntity): boolean {
  if (entity.isStructure) {
    return entity.gapTo(target) <= entity.range;
  }
  if (target.isStructure) return true;
  return entity.gapTo(target) <= AGGRO_LEASH;
}

/** Picks the best legal target for an entity according to its priority. */
export function acquireTarget(sim: Simulation, entity: SimEntity): SimEntity | null {
  const enemyTeam = opposingTeam(entity.team);
  let best: SimEntity | null = null;
  let bestScore = -Infinity;

  for (const candidate of sim.teamEntities(enemyTeam)) {
    if (!candidate.isTargetableBy(entity)) continue;
    if (!withinLeash(entity, candidate)) continue;

    const score = scoreTarget(entity, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  // Nothing worth attacking: march on the nearest enemy structure instead.
  if (best === null && !entity.isStructure) {
    best = nearestStructure(sim, entity);
  }
  return best;
}

/** Higher is better. Every priority reduces to a single comparable number. */
function scoreTarget(entity: SimEntity, candidate: SimEntity): number {
  const gap = entity.gapTo(candidate);
  // Proximity is the baseline for every priority; the modifiers below reorder
  // candidates that are roughly equally close.
  let score = -gap;

  switch (entity.priority) {
    case TargetPriority.Nearest:
      break;

    case TargetPriority.LowestHealth:
      // Favour finishing wounded bodies.
      score += (1 - candidate.health / candidate.maxHealth) * 40;
      break;

    case TargetPriority.Buildings:
      if (candidate.isStructure) score += 500;
      break;

    case TargetPriority.Ranged:
      // Assassins dive the back line.
      if (candidate.range > 6 && !candidate.isStructure) score += 45;
      break;

    case TargetPriority.Support:
      if (candidate.card.roles.includes(CardRole.Support)) score += 60;
      break;

    case TargetPriority.HighestThreat:
      // Threat is damage output weighted by how much life it still has.
      score += threatOf(candidate) * 0.12;
      break;
  }

  // All else equal, prefer whatever is deeper in our own half - that is the
  // thing actually doing damage to us.
  score += advancementBonus(entity, candidate);
  return score;
}

/** Rough damage-per-second times survivability, used for threat ranking. */
function threatOf(entity: SimEntity): number {
  const dps = entity.damage * Math.max(0.1, entity.attackSpeed);
  const durability = entity.health / 100;
  return dps * Math.sqrt(Math.max(1, durability));
}

/** Rewards targeting enemies that have pushed furthest into our territory. */
function advancementBonus(entity: SimEntity, candidate: SimEntity): number {
  if (candidate.isStructure) return 0;
  const sign = forwardSign(entity.team);
  // Candidates "behind" us (further along our own forward axis) are deeper in.
  return sign * (entity.y - candidate.y) * -0.15;
}

/** The closest enemy structure, preferring guard towers over the core. */
function nearestStructure(sim: Simulation, entity: SimEntity): SimEntity | null {
  const enemyTeam = opposingTeam(entity.team);
  let best: SimEntity | null = null;
  let bestScore = -Infinity;

  for (const candidate of sim.teamEntities(enemyTeam)) {
    if (!candidate.isStructure) continue;
    if (!candidate.isTargetableBy(entity)) continue;

    let score = -entity.gapTo(candidate);
    // The core is only a valid objective once its guards are down, so push
    // guard towers up the ordering while they still stand.
    if (candidate.kind === EntityKind.Tower && candidate.slot !== TowerSlot.Core) score += 30;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
