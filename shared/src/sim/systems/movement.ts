/**
 * Movement, pathing and crowd separation.
 *
 * Ground units are routed over the two bridges; air units fly straight.
 * Bodies push each other apart so a stack of units spreads into a front
 * instead of occupying one point.
 */

import {
  ARENA_HEIGHT,
  SEPARATION_FORCE,
  forwardSign,
} from '../../constants.js';
import { EntityKind, Layer, StatusKind } from '../../types.js';
import type { SimEntity } from '../entity.js';
import type { Simulation } from '../Simulation.js';
import {
  angleTo,
  avoidObstacles,
  clampToArena,
  isGroundPassable,
  normalize,
  steeringTarget,
} from '../geometry.js';

/** How long a unit's position trail is kept, for Rewind. */
const POSITION_HISTORY_SECONDS = 3;

export function updateMovement(sim: Simulation, dt: number): void {
  for (const entity of sim.entities.values()) {
    if (!entity.isAlive) continue;

    // Deploy delay: the body exists and can be attacked, but cannot act yet.
    if (entity.deployTimer > 0) {
      entity.deployTimer -= dt;
      continue;
    }
    if (entity.isStructure || entity.moveSpeed <= 0) continue;

    entity.recordPosition(sim.time, POSITION_HISTORY_SECONDS);

    const speed = entity.currentSpeed();
    if (speed <= 0) continue;

    const destination = destinationFor(sim, entity);
    if (destination === null) continue;

    const waypoint = steeringTarget({ x: entity.x, y: entity.y }, destination, entity.layer);
    const dir = normalize(waypoint.x - entity.x, waypoint.y - entity.y);

    let dx = dir.x * speed * dt;
    let dy = dir.y * speed * dt;

    // Crowd separation keeps bodies from occupying the same point.
    const push = separation(sim, entity);
    dx += push.x * dt;
    dy += push.y * dt;

    if (entity.layer === Layer.Ground) {
      const adjusted = avoidObstacles(entity.x, entity.y, dx, dy, entity.radius);
      dx = adjusted.dx;
      dy = adjusted.dy;
    }

    const nextX = entity.x + dx;
    const nextY = entity.y + dy;

    // Ground units may not walk into the rift off-bridge. Try the axes
    // independently so they slide along the bank rather than sticking.
    if (entity.layer === Layer.Ground && !isGroundPassable(nextX, nextY, entity.radius)) {
      if (isGroundPassable(nextX, entity.y, entity.radius)) {
        applyMove(entity, nextX, entity.y);
      } else if (isGroundPassable(entity.x, nextY, entity.radius)) {
        applyMove(entity, entity.x, nextY);
      }
      continue;
    }

    applyMove(entity, nextX, nextY);
  }
}

function applyMove(entity: SimEntity, x: number, y: number): void {
  const clamped = clampToArena({ x, y }, entity.radius);
  if (clamped.x !== entity.x || clamped.y !== entity.y) {
    entity.facing = angleTo(entity.x, entity.y, clamped.x, clamped.y);
  }
  entity.x = clamped.x;
  entity.y = clamped.y;
}

/**
 * Where a unit is trying to get to.
 *
 * Returns null when it is already in range of its target and should stand
 * still and fight instead of walking into the target's body.
 */
function destinationFor(sim: Simulation, entity: SimEntity): { x: number; y: number } | null {
  const target = entity.targetId !== null ? sim.entities.get(entity.targetId) : undefined;

  if (target && target.isAlive) {
    // Already in weapon reach: hold position.
    if (entity.gapTo(target) <= entity.range) return null;
    return { x: target.x, y: target.y };
  }

  // No target at all: advance down the lane toward the enemy end.
  const sign = forwardSign(entity.team);
  const goalY = sign < 0 ? 0 : ARENA_HEIGHT;
  return { x: entity.x, y: goalY };
}

/**
 * Soft body separation. Only nearby same-layer bodies push each other, and
 * structures push units without being moved themselves.
 */
function separation(sim: Simulation, entity: SimEntity): { x: number; y: number } {
  let px = 0;
  let py = 0;

  for (const other of sim.entities.values()) {
    if (other === entity || !other.isAlive) continue;
    if (other.layer !== entity.layer && other.kind !== EntityKind.Tower && !other.isStructure) {
      continue;
    }
    // Phasing units walk through everything.
    if (entity.phased) continue;

    const dx = entity.x - other.x;
    const dy = entity.y - other.y;
    const minDist = entity.radius + other.radius;
    const distSq = dx * dx + dy * dy;
    if (distSq >= minDist * minDist || distSq < 0.0001) continue;

    const dist = Math.sqrt(distSq);
    // Strength scales with how deeply the bodies overlap.
    const overlap = (minDist - dist) / minDist;
    const strength = SEPARATION_FORCE * overlap * (other.isStructure ? 2 : 1);
    px += (dx / dist) * strength;
    py += (dy / dist) * strength;
  }

  return { x: px, y: py };
}

/** Shoves an entity away from a point, used by knockback and gravity wells. */
export function displace(entity: SimEntity, fromX: number, fromY: number, amount: number): void {
  if (entity.isStructure) return; // structures are immovable
  if (entity.hasStatus(StatusKind.Frozen) && amount < 0) return;

  const dir = normalize(entity.x - fromX, entity.y - fromY);
  if (dir.x === 0 && dir.y === 0) return;

  let nx = entity.x + dir.x * amount;
  let ny = entity.y + dir.y * amount;

  if (entity.layer === Layer.Ground && !isGroundPassable(nx, ny, entity.radius)) {
    // Do not shove ground units into the water; slide them along instead.
    if (isGroundPassable(nx, entity.y, entity.radius)) ny = entity.y;
    else if (isGroundPassable(entity.x, ny, entity.radius)) nx = entity.x;
    else return;
  }

  const clamped = clampToArena({ x: nx, y: ny }, entity.radius);
  entity.x = clamped.x;
  entity.y = clamped.y;
}
