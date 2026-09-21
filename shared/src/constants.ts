/**
 * Tunable constants and arena geometry.
 *
 * The arena uses an abstract unit grid that is independent of pixels: the
 * renderer scales it to whatever viewport it is given. Blue defends the
 * high-y end, Red defends the low-y end.
 */

import { Team, TowerSlot, type Vec2 } from './types.js';

/** Simulation steps per second. Fixed, so the sim is deterministic. */
export const TICK_RATE = 30;
export const TICK_SECONDS = 1 / TICK_RATE;

/** How often the host broadcasts a snapshot. */
export const SNAPSHOT_RATE = 15;
export const SNAPSHOT_INTERVAL_TICKS = Math.round(TICK_RATE / SNAPSHOT_RATE);

// --- Arena dimensions (abstract units) -------------------------------------

export const ARENA_WIDTH = 100;
export const ARENA_HEIGHT = 180;

/** The river/rift runs across the middle. */
export const RIVER_Y = ARENA_HEIGHT / 2;
export const RIVER_HALF_HEIGHT = 5;

/** Bridges are the only ground crossings over the rift. */
export const BRIDGE_HALF_WIDTH = 7;
export const LEFT_BRIDGE_X = 24;
export const RIGHT_BRIDGE_X = ARENA_WIDTH - LEFT_BRIDGE_X;

/** Lane centre lines, used by unit pathing and by the bot's threat model. */
export const LANE_LEFT_X = LEFT_BRIDGE_X;
export const LANE_RIGHT_X = RIGHT_BRIDGE_X;
export const LANE_CENTER_X = ARENA_WIDTH / 2;

/**
 * The central contested zone. Units standing inside it take slightly reduced
 * damage from structures, which rewards fighting for the middle instead of
 * only running the two lanes.
 */
export const CENTER_ZONE = {
  x: ARENA_WIDTH / 2,
  y: ARENA_HEIGHT / 2,
  radius: 16,
  /** Multiplier applied to tower damage against units inside the zone. */
  towerDamageFactor: 0.8,
};

/** Static obstacles. Ground units path around them; air units ignore them. */
export const OBSTACLES: Array<{ x: number; y: number; radius: number; art: string }> = [
  { x: 50, y: 52, radius: 5, art: 'crystal-spire' },
  { x: 50, y: 128, radius: 5, art: 'crystal-spire' },
  { x: 11, y: 90, radius: 4.5, art: 'rift-monolith' },
  { x: 89, y: 90, radius: 4.5, art: 'rift-monolith' },
];

// --- Towers -----------------------------------------------------------------

export interface TowerLayout {
  slot: TowerSlot;
  pos: Vec2;
  health: number;
  damage: number;
  attackSpeed: number;
  range: number;
  radius: number;
  projectileSpeed: number;
}

const GUARD_TOWER_BASE = {
  health: 1450,
  damage: 62,
  attackSpeed: 0.8,
  range: 26,
  radius: 5,
  projectileSpeed: 70,
};

const CORE_BASE = {
  health: 2600,
  damage: 76,
  attackSpeed: 0.7,
  range: 28,
  radius: 7,
  projectileSpeed: 70,
};

/** Tower positions for a team, mirrored across the rift. */
export function towerLayout(team: Team): TowerLayout[] {
  const bottom = team === Team.Blue;
  const guardY = bottom ? ARENA_HEIGHT - 44 : 44;
  const coreY = bottom ? ARENA_HEIGHT - 16 : 16;
  return [
    { slot: TowerSlot.LeftGuard, pos: { x: LANE_LEFT_X, y: guardY }, ...GUARD_TOWER_BASE },
    { slot: TowerSlot.RightGuard, pos: { x: LANE_RIGHT_X, y: guardY }, ...GUARD_TOWER_BASE },
    { slot: TowerSlot.Core, pos: { x: LANE_CENTER_X, y: coreY }, ...CORE_BASE },
  ];
}

/**
 * The y coordinate a team's units march toward when they have no target.
 * Blue pushes up (decreasing y), Red pushes down.
 */
export function forwardSign(team: Team): number {
  return team === Team.Blue ? -1 : 1;
}

/** True when the point lies on the given team's own half. */
export function isOwnHalf(team: Team, y: number): boolean {
  return team === Team.Blue ? y > RIVER_Y : y < RIVER_Y;
}

// --- Energy -----------------------------------------------------------------

export const ENERGY_MAX = 10;
export const ENERGY_START = 5;
/** Seconds to regenerate one energy during the normal phase. */
export const ENERGY_REGEN_SECONDS = 2.6;

// --- Match timing -----------------------------------------------------------

export const COUNTDOWN_SECONDS = 3;
/** Regular time. */
export const MATCH_SECONDS = 180;
/** Final stretch of regular time where energy regeneration doubles. */
export const OVERCHARGE_SECONDS = 60;
export const OVERCHARGE_MULTIPLIER = 2;
/** Extra time played when regular time ends level. */
export const SUDDEN_DEATH_SECONDS = 60;

// --- Cards / hand -----------------------------------------------------------

export const DECK_SIZE = 8;
export const HAND_SIZE = 4;

// --- Combat -----------------------------------------------------------------

/** Deploy delay before a freshly placed unit becomes active. */
export const DEPLOY_DELAY = 1.0;
/** How close two units must be before they push each other apart. */
export const SEPARATION_FORCE = 9;
/** Units re-evaluate their target this often. */
export const TARGET_REFRESH_SECONDS = 0.35;
/** A unit chases a spotted enemy no further than this from its lane. */
export const AGGRO_LEASH = 22;
/** Global crit multiplier default. */
export const DEFAULT_CRIT_MULTIPLIER = 1.5;

// --- Networking -------------------------------------------------------------

/** Seconds a disconnected player's slot is held open for reconnect. */
export const RECONNECT_GRACE_SECONDS = 30;

// --- Progression ------------------------------------------------------------

export const REWARD_WIN = { xp: 30, coins: 45, trophies: 28 };
export const REWARD_LOSS = { xp: 10, coins: 12, trophies: -22 };
export const REWARD_DRAW = { xp: 16, coins: 20, trophies: 2 };
/** XP needed to reach level n+1 from level n. */
export function xpForLevel(level: number): number {
  return Math.round(100 * Math.pow(1.35, level - 1));
}
