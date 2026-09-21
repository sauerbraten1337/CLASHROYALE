/** Public surface of the shared package: data, types and the simulation. */

export * from './types.js';
export * from './constants.js';
export * from './data/cards.js';
export * from './data/decks.js';
export { Simulation, PlayRejection } from './sim/Simulation.js';
export type {
  SimulationConfig,
  SimPlayerConfig,
  PlayerRuntime,
  PlayCardOutcome,
} from './sim/Simulation.js';
export { SimEntity } from './sim/entity.js';
export { Rng } from './sim/rng.js';
export * from './sim/geometry.js';
export type { SimProjectile } from './sim/systems/combat.js';
export { Bot, pickBotLoadout, describeBot } from './ai/bot.js';
export type { BotConfig } from './ai/bot.js';
export { BotMatch, HUMAN_PLAYER_ID, BOT_PLAYER_ID } from './ai/BotMatch.js';
export type { BotMatchOptions } from './ai/BotMatch.js';
