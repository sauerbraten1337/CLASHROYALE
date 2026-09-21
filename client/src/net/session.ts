/**
 * Match sessions.
 *
 * The battle screen talks to a `MatchSession` and never learns whether it is
 * driving a local bot match or a networked one. That keeps all the
 * online/offline branching in this one file instead of smeared through the
 * UI, and it means practice and ranked play exercise the same rendering,
 * input and HUD code paths.
 */

import {
  BotMatch,
  MatchPhase,
  ServerMessageType,
  TICK_SECONDS,
  Team,
  rewardsFor,
  type BotDifficulty,
  type BotStrategy,
  type MatchResult,
  type MatchRewards,
  type MatchSnapshot,
} from '@riftbound/shared';

import type { Connection } from './Connection.js';

export interface MatchSessionEvents {
  onSnapshot: (snapshot: MatchSnapshot) => void;
  onEnd: (result: MatchResult, rewards: MatchRewards) => void;
  /** Non-fatal notices: a rejected play, the opponent dropping, etc. */
  onNotice: (message: string) => void;
}

export interface MatchSession {
  /** The team the local player controls. */
  readonly team: Team;
  readonly opponentName: string;
  /** True when the match runs entirely in this browser. */
  readonly isLocal: boolean;
  /** Human-readable bot description, for practice matches. */
  readonly botLabel?: string;

  /** Advances a local match. Networked sessions ignore this. */
  advance(deltaSeconds: number): void;
  /** Requests a card play. May be rejected by the authority. */
  play(handIndex: number, x: number, y: number): void;
  forfeit(): void;
  /** Detaches listeners and stops any loop. */
  dispose(): void;

  /** Diagnostics for the debug overlay. */
  debugInfo(): { ping: number | null; botDecision?: string };

  // --- Developer tools, local matches only -------------------------------
  /** True when developer shortcuts are permitted (never in online play). */
  readonly allowsDevTools: boolean;
  devAddEnergy?(amount: number): void;
  devSpawnTestUnit?(): void;
}

// ---------------------------------------------------------------------------
// Local (bot) session
// ---------------------------------------------------------------------------

export interface LocalSessionOptions {
  playerName: string;
  deck: string[];
  difficulty: BotDifficulty;
  strategy?: BotStrategy;
  seed?: number;
}

export class LocalSession implements MatchSession {
  readonly team = Team.Blue;
  readonly isLocal = true;
  readonly allowsDevTools = true;
  readonly opponentName = 'Riftbound AI';
  readonly botLabel: string;

  private readonly match: BotMatch;
  private readonly events: MatchSessionEvents;
  private ended = false;

  constructor(options: LocalSessionOptions, events: MatchSessionEvents) {
    const matchOptions: ConstructorParameters<typeof BotMatch>[0] = {
      playerName: options.playerName,
      playerDeck: options.deck,
      difficulty: options.difficulty,
    };
    if (options.strategy !== undefined) matchOptions.strategy = options.strategy;
    if (options.seed !== undefined) matchOptions.seed = options.seed;

    this.match = new BotMatch(matchOptions);
    this.botLabel = this.match.botLabel;
    this.events = events;
  }

  advance(deltaSeconds: number): void {
    if (this.ended) return;
    this.match.advance(deltaSeconds);
    this.events.onSnapshot(this.match.snapshot());

    if (this.match.finished && !this.ended) {
      this.ended = true;
      const result = this.match.sim.result;
      if (result) {
        this.events.onEnd(result, rewardsFor(result.winner, this.team));
      }
    }
  }

  play(handIndex: number, x: number, y: number): void {
    const outcome = this.match.play(handIndex, x, y);
    if (!outcome.ok) this.events.onNotice(outcome.message);
  }

  forfeit(): void {
    this.match.forfeit();
  }

  dispose(): void {
    this.ended = true;
  }

  debugInfo(): { ping: number | null; botDecision?: string } {
    return { ping: null, botDecision: this.match.botDecision };
  }

  /**
   * Developer helpers. These mutate the local simulation directly, which is
   * only ever safe because this session has no authority over anyone else.
   */
  devAddEnergy(amount: number): void {
    const player = this.match.sim.players.get(this.match.humanId);
    if (player) player.energy = Math.min(10, player.energy + amount);
  }

  devSpawnTestUnit(): void {
    const card = this.match.sim.cardLookup('shard-hound');
    if (!card) return;
    this.match.sim.spawnUnits(card, Team.Blue, this.match.humanId, 50, 120, { instant: true });
  }
}

// ---------------------------------------------------------------------------
// Online session
// ---------------------------------------------------------------------------

export class OnlineSession implements MatchSession {
  readonly isLocal = false;
  readonly allowsDevTools = false;

  readonly team: Team;
  readonly opponentName: string;
  readonly matchId: string;

  private readonly connection: Connection;
  private readonly events: MatchSessionEvents;
  private readonly unsubscribe: () => void;
  private ended = false;

  constructor(
    connection: Connection,
    info: { matchId: string; team: Team; opponentName: string },
    events: MatchSessionEvents,
  ) {
    this.connection = connection;
    this.team = info.team;
    this.opponentName = info.opponentName;
    this.matchId = info.matchId;
    this.events = events;

    this.unsubscribe = connection.subscribe((message) => {
      switch (message.type) {
        case ServerMessageType.Snapshot:
          if (message.snapshot.matchId === this.matchId) {
            this.events.onSnapshot(message.snapshot);
          }
          break;

        case ServerMessageType.MatchEnd:
          if (!this.ended) {
            this.ended = true;
            this.events.onEnd(message.result, message.rewards);
          }
          break;

        case ServerMessageType.OpponentLeft:
          this.events.onNotice(
            `Opponent disconnected. They have ${Math.round(message.graceSeconds)}s to return.`,
          );
          break;

        case ServerMessageType.OpponentReturned:
          this.events.onNotice('Opponent reconnected.');
          break;

        case ServerMessageType.Error:
          // Play rejections surface here; the authoritative state never moved.
          this.events.onNotice(message.message);
          break;

        default:
          break;
      }
    });
  }

  /** Networked matches are driven by the server, not by a local clock. */
  advance(): void {
    // Intentionally empty.
  }

  play(handIndex: number, x: number, y: number): void {
    this.connection.playCard(handIndex, x, y);
  }

  forfeit(): void {
    this.connection.forfeit();
  }

  dispose(): void {
    this.unsubscribe();
  }

  debugInfo(): { ping: number | null } {
    return { ping: this.connection.ping };
  }
}

/** Re-exported so callers do not need the shared constant. */
export const LOCAL_STEP_SECONDS = TICK_SECONDS;
export { MatchPhase };
