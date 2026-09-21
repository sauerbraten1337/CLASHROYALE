/**
 * A live server-side match.
 *
 * Owns an authoritative `Simulation`, the two player slots, and the tick
 * loop. Clients send intents; this class validates ownership, applies them
 * through the simulation, and broadcasts snapshots. A client never sends
 * state, only intent.
 */

import {
  MatchPhase,
  RECONNECT_GRACE_SECONDS,
  REWARD_DRAW,
  REWARD_LOSS,
  REWARD_WIN,
  SNAPSHOT_INTERVAL_TICKS,
  ServerMessageType,
  Simulation,
  TICK_SECONDS,
  Team,
  type MatchRewards,
  type MatchResult,
  type PlayerId,
  type ServerMessage,
} from '@riftbound/shared';
import { Bot } from '@riftbound/shared';
import type { BotDifficulty, BotStrategy } from '@riftbound/shared';

/** One side of a match. */
export interface MatchSlot {
  playerId: PlayerId;
  name: string;
  team: Team;
  /** Delivers a message to this player, or null when they are disconnected. */
  send: ((message: ServerMessage) => void) | null;
  /** Seconds this slot has been disconnected, for the reconnect grace period. */
  disconnectedFor: number;
  /** True for a bot-controlled slot. */
  isBot: boolean;
}

export interface MatchOptions {
  matchId: string;
  seed: number;
  /** Called once the match has ended and its rewards are known. */
  onFinished: (match: Match) => void;
}

export class Match {
  readonly matchId: string;
  readonly sim: Simulation;
  readonly slots = new Map<PlayerId, MatchSlot>();
  readonly startedAt = Date.now();

  /** Present when one side is bot-controlled (queue fallback). */
  private bot: Bot | null = null;
  private readonly onFinished: (match: Match) => void;
  private ticksSinceSnapshot = 0;
  private finished = false;

  constructor(
    options: MatchOptions,
    players: Array<{ playerId: PlayerId; name: string; team: Team; deck: string[] }>,
  ) {
    this.matchId = options.matchId;
    this.onFinished = options.onFinished;

    const [first, second] = players;
    if (!first || !second) throw new Error('a match needs exactly two players');

    this.sim = new Simulation({
      matchId: options.matchId,
      seed: options.seed,
      players: [
        { id: first.playerId, name: first.name, team: first.team, deck: first.deck },
        { id: second.playerId, name: second.name, team: second.team, deck: second.deck },
      ],
    });

    for (const p of players) {
      this.slots.set(p.playerId, {
        playerId: p.playerId,
        name: p.name,
        team: p.team,
        send: null,
        disconnectedFor: 0,
        isBot: false,
      });
    }
  }

  /** Marks a slot as bot-controlled and attaches its AI. */
  attachBot(playerId: PlayerId, difficulty: BotDifficulty, strategy: BotStrategy, seed: number): void {
    const slot = this.slots.get(playerId);
    if (!slot) return;
    slot.isBot = true;
    this.bot = new Bot({ playerId, team: slot.team, difficulty, strategy, seed });
  }

  /** Binds a live socket to a slot. */
  connect(playerId: PlayerId, send: (message: ServerMessage) => void): boolean {
    const slot = this.slots.get(playerId);
    if (!slot) return false;
    const wasDisconnected = slot.send === null;
    slot.send = send;
    slot.disconnectedFor = 0;
    this.sim.setDisconnected(playerId, false);
    if (wasDisconnected) {
      this.sendToOpponent(playerId, { type: ServerMessageType.OpponentReturned });
    }
    return true;
  }

  /**
   * Detaches a socket. The slot is held open for the grace period so the
   * player can reclaim it; their towers keep fighting in the meantime.
   */
  disconnect(playerId: PlayerId): void {
    const slot = this.slots.get(playerId);
    if (!slot) return;
    slot.send = null;
    slot.disconnectedFor = 0;
    this.sim.setDisconnected(playerId, true);
    this.sendToOpponent(playerId, {
      type: ServerMessageType.OpponentLeft,
      graceSeconds: RECONNECT_GRACE_SECONDS,
    });
  }

  /**
   * Applies a card play on behalf of a player.
   *
   * The simulation performs every rule check; this only guards ownership,
   * which is the one thing the simulation cannot know from its arguments.
   */
  playCard(playerId: PlayerId, handIndex: number, x: number, y: number): void {
    if (this.finished) return;
    const slot = this.slots.get(playerId);
    if (!slot) return;

    const outcome = this.sim.playCard(playerId, handIndex, x, y);
    if (!outcome.ok && slot.send) {
      // Tell the client so it can un-stick its own UI; the authoritative
      // state is unchanged either way.
      slot.send({
        type: ServerMessageType.Error,
        code: outcome.code,
        message: outcome.message,
      });
    }
  }

  forfeit(playerId: PlayerId): void {
    if (this.finished) return;
    this.sim.forfeit(playerId);
  }

  /** Advances the match one simulation step. Called by the server loop. */
  tick(): void {
    if (this.finished) return;

    this.sim.step(TICK_SECONDS);
    if (this.bot) this.bot.update(this.sim, TICK_SECONDS);

    this.updateDisconnects();

    this.ticksSinceSnapshot++;
    if (this.ticksSinceSnapshot >= SNAPSHOT_INTERVAL_TICKS) {
      this.ticksSinceSnapshot = 0;
      this.broadcastSnapshot();
    }

    if (this.sim.phase === MatchPhase.Finished) this.finish();
  }

  /** Times out slots whose grace period has expired. */
  private updateDisconnects(): void {
    for (const slot of this.slots.values()) {
      if (slot.send !== null || slot.isBot) continue;
      slot.disconnectedFor += TICK_SECONDS;
      if (slot.disconnectedFor >= RECONNECT_GRACE_SECONDS) {
        // The player never came back: concede on their behalf.
        this.sim.forfeit(slot.playerId);
      }
    }
  }

  private broadcastSnapshot(): void {
    const snapshot = this.sim.snapshot();
    const message: ServerMessage = { type: ServerMessageType.Snapshot, snapshot };
    for (const slot of this.slots.values()) {
      slot.send?.(message);
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;

    const result = this.sim.result;
    if (!result) return;

    // Always send a final snapshot so clients see the deciding moment.
    this.broadcastSnapshot();

    for (const slot of this.slots.values()) {
      slot.send?.({
        type: ServerMessageType.MatchEnd,
        result,
        rewards: rewardsFor(result, slot.team),
      });
    }
    this.onFinished(this);
  }

  private sendToOpponent(playerId: PlayerId, message: ServerMessage): void {
    for (const slot of this.slots.values()) {
      if (slot.playerId !== playerId) slot.send?.(message);
    }
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** True once every human slot has gone and the grace period has expired. */
  get isAbandoned(): boolean {
    for (const slot of this.slots.values()) {
      if (slot.isBot) continue;
      if (slot.send !== null) return false;
      if (slot.disconnectedFor < RECONNECT_GRACE_SECONDS) return false;
    }
    return true;
  }

  opponentOf(playerId: PlayerId): MatchSlot | null {
    for (const slot of this.slots.values()) {
      if (slot.playerId !== playerId) return slot;
    }
    return null;
  }
}

/** Rewards for one side, given a finished match. */
export function rewardsFor(result: MatchResult, team: Team): MatchRewards {
  if (result.winner === null) return { ...REWARD_DRAW };
  return result.winner === team ? { ...REWARD_WIN } : { ...REWARD_LOSS };
}
