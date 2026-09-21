/**
 * A complete local match against a bot.
 *
 * Wraps a `Simulation` plus a `Bot` so the client can run practice matches
 * entirely in the browser with no server involved, using the identical
 * engine the dedicated server runs. The bot drives its side through the same
 * validated `playCard` path the human player uses.
 */

import { BOT_DECKS } from '../data/cards.js';
import { sanitizeDeck } from '../data/decks.js';
import { TICK_SECONDS } from '../constants.js';
import {
  BotDifficulty,
  BotStrategy,
  MatchPhase,
  Team,
  type MatchSnapshot,
  type PlayerId,
} from '../types.js';
import { Rng } from '../sim/rng.js';
import { Simulation, type PlayCardOutcome } from '../sim/Simulation.js';
import { Bot, describeBot, pickBotLoadout } from './bot.js';

export interface BotMatchOptions {
  playerName: string;
  playerDeck: string[];
  difficulty: BotDifficulty;
  /** Omit to let the difficulty pick a personality. */
  strategy?: BotStrategy;
  /** Omit for a random match. */
  seed?: number;
  /** Overrides the bot's deck, for testing specific matchups. */
  botDeck?: string[];
  matchSeconds?: number;
  skipCountdown?: boolean;
}

export const HUMAN_PLAYER_ID: PlayerId = 'local-player';
export const BOT_PLAYER_ID: PlayerId = 'local-bot';

export class BotMatch {
  readonly sim: Simulation;
  readonly bot: Bot;
  readonly humanId = HUMAN_PLAYER_ID;
  readonly botLabel: string;

  /** Accumulates real time so the sim always advances in fixed steps. */
  private accumulator = 0;

  constructor(options: BotMatchOptions) {
    const seed = options.seed ?? Math.floor(Math.random() * 0x7fffffff);
    const rng = new Rng(seed);
    const loadout = pickBotLoadout(options.difficulty, rng, BOT_DECKS);
    const strategy = options.strategy ?? loadout.strategy;
    const botDeck = sanitizeDeck(options.botDeck ?? loadout.deck);

    const config: ConstructorParameters<typeof Simulation>[0] = {
      matchId: `local-${seed}`,
      seed,
      players: [
        {
          id: HUMAN_PLAYER_ID,
          name: options.playerName || 'You',
          team: Team.Blue,
          deck: sanitizeDeck(options.playerDeck),
        },
        { id: BOT_PLAYER_ID, name: 'Riftbound AI', team: Team.Red, deck: botDeck },
      ],
    };
    if (options.matchSeconds !== undefined) config.matchSeconds = options.matchSeconds;
    if (options.skipCountdown !== undefined) config.skipCountdown = options.skipCountdown;

    this.sim = new Simulation(config);
    this.bot = new Bot({
      playerId: BOT_PLAYER_ID,
      team: Team.Red,
      difficulty: options.difficulty,
      strategy,
      seed: seed ^ 0x9e37,
    });
    this.botLabel = describeBot(options.difficulty, strategy);
  }

  /**
   * Advances the match by a wall-clock delta, stepping the simulation at its
   * fixed rate. Large deltas (a backgrounded tab) are capped rather than
   * spiral-stepped, so returning to the tab never locks the page up.
   */
  advance(deltaSeconds: number): void {
    this.accumulator += Math.min(deltaSeconds, 0.25);
    let steps = 0;
    while (this.accumulator >= TICK_SECONDS && steps < 8) {
      this.accumulator -= TICK_SECONDS;
      this.sim.step(TICK_SECONDS);
      this.bot.update(this.sim, TICK_SECONDS);
      steps++;
    }
  }

  /** Plays a card for the human player. Validated exactly as online play is. */
  play(handIndex: number, x: number, y: number): PlayCardOutcome {
    return this.sim.playCard(this.humanId, handIndex, x, y);
  }

  forfeit(): void {
    this.sim.forfeit(this.humanId);
  }

  snapshot(): MatchSnapshot {
    return this.sim.snapshot();
  }

  get finished(): boolean {
    return this.sim.phase === MatchPhase.Finished;
  }

  /** What the bot decided last, for the debug overlay. */
  get botDecision(): string {
    return this.bot.lastDecision;
  }
}
