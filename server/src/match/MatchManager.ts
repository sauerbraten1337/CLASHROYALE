/**
 * Matchmaking, private rooms and the live match registry.
 *
 * The queue is deliberately simple for now - a single list widened by wait
 * time - but the shape is the one a real ranked queue needs: candidates are
 * scored, the band relaxes the longer someone waits, and pairing is a pure
 * function of the queue contents so it can be moved onto a shared store
 * later without changing callers.
 */

import {
  BotDifficulty,
  BotStrategy,
  ServerMessageType,
  Team,
  type PlayerId,
  type ServerMessage,
} from '@riftbound/shared';
import { Match } from './Match.js';

/** Someone waiting for an opponent. */
export interface QueueEntry {
  playerId: PlayerId;
  name: string;
  deck: string[];
  trophies: number;
  queuedAt: number;
  send: (message: ServerMessage) => void;
}

/** A private room waiting to be filled. */
export interface PrivateRoom {
  code: string;
  host: QueueEntry;
  createdAt: number;
}

/** How wide the trophy band starts, and how fast it opens up. */
const INITIAL_TROPHY_BAND = 150;
const BAND_GROWTH_PER_SECOND = 120;
/** After this long, the player is matched with a bot rather than left waiting. */
const BOT_FALLBACK_SECONDS = 12;
/** Private rooms are reclaimed after this long unused. */
const ROOM_TTL_MS = 15 * 60 * 1000;

export interface MatchManagerOptions {
  /** Injectable for tests. */
  now?: () => number;
  random?: () => number;
  /** Set false to disable filling an unmatched queue with a bot. */
  botFallback?: boolean;
}

export class MatchManager {
  private readonly queue: QueueEntry[] = [];
  private readonly rooms = new Map<string, PrivateRoom>();
  private readonly matches = new Map<string, Match>();
  /** Which match a player is currently in, for reconnects. */
  private readonly playerMatch = new Map<PlayerId, string>();

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly botFallback: boolean;
  private seedCounter = 1;

  constructor(options: MatchManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.botFallback = options.botFallback ?? true;
  }

  // =========================================================================
  // Queue
  // =========================================================================

  /** Adds a player to the queue, replacing any existing entry for them. */
  enqueue(entry: Omit<QueueEntry, 'queuedAt'>): void {
    this.dequeue(entry.playerId);
    this.queue.push({ ...entry, queuedAt: this.now() });
    this.tryPair();
  }

  dequeue(playerId: PlayerId): void {
    const index = this.queue.findIndex((e) => e.playerId === playerId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Pairs whoever is compatible. Called on every enqueue and on a timer, so
   * a widening band eventually matches anyone still waiting.
   */
  tryPair(): void {
    // Longest-waiting first, so nobody starves.
    this.queue.sort((a, b) => a.queuedAt - b.queuedAt);

    for (let i = 0; i < this.queue.length; i++) {
      const a = this.queue[i];
      if (!a) continue;

      let bestIndex = -1;
      let bestGap = Infinity;
      for (let j = i + 1; j < this.queue.length; j++) {
        const b = this.queue[j];
        if (!b) continue;
        const gap = Math.abs(a.trophies - b.trophies);
        if (gap < bestGap && gap <= this.bandFor(a, b)) {
          bestGap = gap;
          bestIndex = j;
        }
      }

      if (bestIndex >= 0) {
        const b = this.queue[bestIndex] as QueueEntry;
        this.queue.splice(bestIndex, 1);
        this.queue.splice(i, 1);
        this.createMatch(a, b);
        // Restart: indices have shifted.
        this.tryPair();
        return;
      }
    }
  }

  /** The acceptable trophy gap for a pair, widened by whoever waited longer. */
  private bandFor(a: QueueEntry, b: QueueEntry): number {
    const now = this.now();
    const longestWait = Math.max(now - a.queuedAt, now - b.queuedAt) / 1000;
    return INITIAL_TROPHY_BAND + longestWait * BAND_GROWTH_PER_SECOND;
  }

  /**
   * Matches anyone who has waited too long against a bot, so a quiet server
   * still gives players a game. Called on the same timer as `tryPair`.
   */
  fillStaleWithBots(): void {
    if (!this.botFallback) return;
    const now = this.now();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i];
      if (!entry) continue;
      if ((now - entry.queuedAt) / 1000 < BOT_FALLBACK_SECONDS) continue;
      this.queue.splice(i, 1);
      this.createBotMatch(entry);
    }
  }

  /** Seconds the given player has been queueing, or 0 when not queued. */
  waitedSeconds(playerId: PlayerId): number {
    const entry = this.queue.find((e) => e.playerId === playerId);
    return entry ? (this.now() - entry.queuedAt) / 1000 : 0;
  }

  isQueued(playerId: PlayerId): boolean {
    return this.queue.some((e) => e.playerId === playerId);
  }

  // =========================================================================
  // Private rooms
  // =========================================================================

  /** Creates a room and returns its join code. */
  createRoom(host: Omit<QueueEntry, 'queuedAt'>): string {
    // Drop any room this player already hosts.
    for (const [code, room] of this.rooms) {
      if (room.host.playerId === host.playerId) this.rooms.delete(code);
    }

    const code = this.generateRoomCode();
    this.rooms.set(code, {
      code,
      host: { ...host, queuedAt: this.now() },
      createdAt: this.now(),
    });
    return code;
  }

  /**
   * Joins an existing room. Returns the created match, or an error code the
   * caller can relay.
   */
  joinRoom(
    code: string,
    guest: Omit<QueueEntry, 'queuedAt'>,
  ): { ok: true; match: Match } | { ok: false; code: string; message: string } {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) {
      return { ok: false, code: 'no-such-room', message: 'No room with that code.' };
    }
    if (room.host.playerId === guest.playerId) {
      return { ok: false, code: 'own-room', message: 'You cannot join your own room.' };
    }
    this.rooms.delete(room.code);
    const match = this.createMatch(room.host, { ...guest, queuedAt: this.now() });
    return { ok: true, match };
  }

  leaveRoom(playerId: PlayerId): void {
    for (const [code, room] of this.rooms) {
      if (room.host.playerId === playerId) this.rooms.delete(code);
    }
  }

  roomFor(playerId: PlayerId): PrivateRoom | null {
    for (const room of this.rooms.values()) {
      if (room.host.playerId === playerId) return room;
    }
    return null;
  }

  /** Unambiguous code alphabet: no O/0, I/1 confusion. */
  private generateRoomCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 5; i++) {
        code += alphabet[Math.floor(this.random() * alphabet.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    // Fall back to something guaranteed unique.
    return `R${this.seedCounter++}`;
  }

  // =========================================================================
  // Matches
  // =========================================================================

  private createMatch(a: QueueEntry, b: QueueEntry): Match {
    const matchId = `m${this.seedCounter++}-${Math.floor(this.random() * 1e6).toString(36)}`;
    const seed = Math.floor(this.random() * 0x7fffffff);

    const match = new Match(
      { matchId, seed, onFinished: (m) => this.retireMatch(m) },
      [
        { playerId: a.playerId, name: a.name, team: Team.Blue, deck: a.deck },
        { playerId: b.playerId, name: b.name, team: Team.Red, deck: b.deck },
      ],
    );

    this.matches.set(matchId, match);
    this.playerMatch.set(a.playerId, matchId);
    this.playerMatch.set(b.playerId, matchId);

    match.connect(a.playerId, a.send);
    match.connect(b.playerId, b.send);

    this.announce(match, a, b);
    return match;
  }

  /** Creates a match against a bot for a player the queue could not pair. */
  private createBotMatch(entry: QueueEntry): Match {
    const matchId = `b${this.seedCounter++}-${Math.floor(this.random() * 1e6).toString(36)}`;
    const seed = Math.floor(this.random() * 0x7fffffff);
    const botId = `bot:${matchId}`;

    const match = new Match(
      { matchId, seed, onFinished: (m) => this.retireMatch(m) },
      [
        { playerId: entry.playerId, name: entry.name, team: Team.Blue, deck: entry.deck },
        { playerId: botId, name: 'Riftbound AI', team: Team.Red, deck: [] },
      ],
    );
    match.attachBot(botId, BotDifficulty.Normal, BotStrategy.Aggressive, seed ^ 0x1234);

    this.matches.set(matchId, match);
    this.playerMatch.set(entry.playerId, matchId);
    match.connect(entry.playerId, entry.send);

    entry.send({
      type: ServerMessageType.MatchFound,
      matchId,
      team: Team.Blue,
      opponentName: 'Riftbound AI',
      opponentTrophies: entry.trophies,
      countdown: 3,
    });
    return match;
  }

  private announce(match: Match, a: QueueEntry, b: QueueEntry): void {
    a.send({
      type: ServerMessageType.MatchFound,
      matchId: match.matchId,
      team: Team.Blue,
      opponentName: b.name,
      opponentTrophies: b.trophies,
      countdown: 3,
    });
    b.send({
      type: ServerMessageType.MatchFound,
      matchId: match.matchId,
      team: Team.Red,
      opponentName: a.name,
      opponentTrophies: a.trophies,
      countdown: 3,
    });
  }

  matchFor(playerId: PlayerId): Match | null {
    const matchId = this.playerMatch.get(playerId);
    if (!matchId) return null;
    return this.matches.get(matchId) ?? null;
  }

  getMatch(matchId: string): Match | null {
    return this.matches.get(matchId) ?? null;
  }

  get activeMatches(): number {
    return this.matches.size;
  }

  /** Advances every live match by one tick and reaps the dead ones. */
  tickMatches(): void {
    for (const match of this.matches.values()) {
      try {
        match.tick();
      } catch (error) {
        // One broken match must never take the whole server down.
        console.error(`[match ${match.matchId}] tick failed:`, error);
        this.retireMatch(match);
      }
      if (!match.isFinished && match.isAbandoned) this.retireMatch(match);
    }
  }

  private retireMatch(match: Match): void {
    this.matches.delete(match.matchId);
    for (const playerId of match.slots.keys()) {
      if (this.playerMatch.get(playerId) === match.matchId) {
        this.playerMatch.delete(playerId);
      }
    }
  }

  /** Housekeeping: expire stale rooms, widen the queue, fill with bots. */
  maintain(): void {
    const now = this.now();
    for (const [code, room] of this.rooms) {
      if (now - room.createdAt > ROOM_TTL_MS) this.rooms.delete(code);
    }
    this.tryPair();
    this.fillStaleWithBots();
  }

  /** Removes a player from every waiting structure. Called on disconnect. */
  removeWaiting(playerId: PlayerId): void {
    this.dequeue(playerId);
    this.leaveRoom(playerId);
  }

  stats(): { queued: number; rooms: number; matches: number } {
    return { queued: this.queue.length, rooms: this.rooms.size, matches: this.matches.size };
  }
}
