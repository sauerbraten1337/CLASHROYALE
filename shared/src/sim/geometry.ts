/**
 * Geometry and pathing helpers shared by the movement, targeting and spell
 * systems. Everything here is pure: no simulation state is touched.
 */

import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  BRIDGE_HALF_WIDTH,
  LEFT_BRIDGE_X,
  OBSTACLES,
  RIGHT_BRIDGE_X,
  RIVER_HALF_HEIGHT,
  RIVER_Y,
} from '../constants.js';
import { Layer, type Vec2 } from '../types.js';

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Keeps a point inside the playable rectangle, allowing for a body radius. */
export function clampToArena(p: Vec2, radius = 0): Vec2 {
  return {
    x: clamp(p.x, radius, ARENA_WIDTH - radius),
    y: clamp(p.y, radius, ARENA_HEIGHT - radius),
  };
}

/** True when the point is in the rift channel that splits the arena. */
export function isInRiver(y: number): boolean {
  return Math.abs(y - RIVER_Y) <= RIVER_HALF_HEIGHT;
}

/** True when the x coordinate lies on one of the two bridge decks. */
export function isOnBridge(x: number): boolean {
  return (
    Math.abs(x - LEFT_BRIDGE_X) <= BRIDGE_HALF_WIDTH ||
    Math.abs(x - RIGHT_BRIDGE_X) <= BRIDGE_HALF_WIDTH
  );
}

/** The x coordinate of whichever bridge is closer to the given point. */
export function nearestBridgeX(x: number): number {
  return Math.abs(x - LEFT_BRIDGE_X) <= Math.abs(x - RIGHT_BRIDGE_X)
    ? LEFT_BRIDGE_X
    : RIGHT_BRIDGE_X;
}

/** True when a and b sit on opposite banks of the rift. */
export function acrossRiver(ay: number, by: number): boolean {
  return (ay < RIVER_Y) !== (by < RIVER_Y);
}

/**
 * True when a ground body of the given radius may occupy this point.
 * The rift is impassable except on the bridges; obstacles are always solid.
 */
export function isGroundPassable(x: number, y: number, radius: number): boolean {
  if (isInRiver(y) && !isOnBridge(x)) return false;
  for (const o of OBSTACLES) {
    if (distanceSq(x, y, o.x, o.y) < (o.radius + radius) * (o.radius + radius)) return false;
  }
  return true;
}

/**
 * Produces the point a unit should steer toward this step.
 *
 * Ground units that need to reach the far bank are routed to the nearest
 * bridge first; air units fly straight. This is deliberately a simple
 * waypoint rule rather than a full pathfinder: the arena has exactly two
 * crossings, so anything heavier would be wasted work.
 */
export function steeringTarget(
  from: Vec2,
  to: Vec2,
  layer: Layer,
): Vec2 {
  if (layer === Layer.Air) return to;
  if (!acrossRiver(from.y, to.y)) return to;

  const bridgeX = nearestBridgeX(from.x);
  // Already lined up with the bridge mouth: commit to crossing straight over.
  if (Math.abs(from.x - bridgeX) <= BRIDGE_HALF_WIDTH * 0.6) {
    return { x: bridgeX, y: to.y };
  }
  // Otherwise walk to the near side of the bridge first.
  const approachY = from.y < RIVER_Y ? RIVER_Y - RIVER_HALF_HEIGHT - 1 : RIVER_Y + RIVER_HALF_HEIGHT + 1;
  return { x: bridgeX, y: approachY };
}

/**
 * Slides a blocked movement step along the obstacle surface instead of
 * stopping dead, so units never wedge themselves on a pillar.
 */
export function avoidObstacles(
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
): { dx: number; dy: number } {
  const nx = x + dx;
  const ny = y + dy;
  for (const o of OBSTACLES) {
    const minDist = o.radius + radius;
    const d = distance(nx, ny, o.x, o.y);
    if (d >= minDist) continue;

    // Push the step out to the obstacle surface, preserving tangential motion.
    const awayX = d > 0.0001 ? (nx - o.x) / d : 1;
    const awayY = d > 0.0001 ? (ny - o.y) / d : 0;
    const targetX = o.x + awayX * minDist;
    const targetY = o.y + awayY * minDist;
    return { dx: targetX - x, dy: targetY - y };
  }
  return { dx, dy };
}

/** Normalises a vector, returning a zero vector when the input has no length. */
export function normalize(dx: number, dy: number): Vec2 {
  const len = Math.hypot(dx, dy);
  if (len < 0.00001) return { x: 0, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** Angle in radians pointing from (ax, ay) to (bx, by). */
export function angleTo(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}
