/**
 * Wire protocol validation.
 *
 * This is the trust boundary. Everything arriving from a socket is treated
 * as hostile until it has been through `parseClientMessage`: the payload may
 * be malformed, oversized, the wrong shape, or deliberately crafted to make
 * the server misbehave. Nothing downstream re-checks these basics, so the
 * checks here have to be complete.
 */

import {
  ClientMessageType,
  type ClientMessage,
  type ServerMessage,
} from '@riftbound/shared';

/** Largest frame we will even attempt to parse. */
export const MAX_MESSAGE_BYTES = 8 * 1024;

/** Caps on the free-text and array fields a client can send. */
const MAX_NAME_LENGTH = 24;
const MAX_DECK_LENGTH = 16;
const MAX_CARD_ID_LENGTH = 48;
const MAX_PLAYER_ID_LENGTH = 64;
const MAX_ROOM_CODE_LENGTH = 8;

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number within bounds. Rejects NaN, Infinity and non-numbers. */
function isBoundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isCleanString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * Strips anything that could confuse a UI or a log: control characters and
 * surrounding whitespace. Names are displayed to the other player, so they
 * are sanitised rather than merely length-checked.
 */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Challenger';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (cleaned.length === 0) return 'Challenger';
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/** Validates a deck payload into a plain string array. */
function parseDeck(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_DECK_LENGTH) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (!isCleanString(entry, MAX_CARD_ID_LENGTH)) return null;
    out.push(entry);
  }
  return out;
}

/**
 * Parses and validates a raw frame.
 *
 * Note that a deck passing validation here only means it is *well-formed*.
 * Whether those card ids exist and form a legal deck is decided by the
 * simulation when the match starts, which repairs rather than rejects.
 */
export function parseClientMessage(raw: string | Buffer): ParseResult {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > MAX_MESSAGE_BYTES) {
    return { ok: false, reason: 'message too large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed JSON' };
  }
  if (!isObject(parsed)) return { ok: false, reason: 'message must be an object' };

  const type = parsed.type;
  if (typeof type !== 'string') return { ok: false, reason: 'missing message type' };

  switch (type) {
    case ClientMessageType.Hello: {
      // An absent or empty id means "this is a new client, assign me one".
      // Only a non-empty id has to look like a real identity.
      const playerId = parsed.playerId;
      const hasId = playerId !== undefined && playerId !== '';
      if (hasId && !isCleanString(playerId, MAX_PLAYER_ID_LENGTH)) {
        return { ok: false, reason: 'bad playerId' };
      }
      return {
        ok: true,
        message: {
          type: ClientMessageType.Hello,
          name: sanitizeName(parsed.name),
          playerId: hasId ? (playerId as string) : '',
        },
      };
    }

    case ClientMessageType.QueueJoin: {
      const deck = parseDeck(parsed.deck);
      if (deck === null) return { ok: false, reason: 'bad deck' };
      // Trophies are a client-supplied matchmaking hint only. They are
      // clamped here and never trusted for anything that affects a match.
      const trophies = isBoundedNumber(parsed.trophies, 0, 100000) ? parsed.trophies : 0;
      return { ok: true, message: { type: ClientMessageType.QueueJoin, deck, trophies } };
    }

    case ClientMessageType.QueueLeave:
      return { ok: true, message: { type: ClientMessageType.QueueLeave } };

    case ClientMessageType.CreatePrivate: {
      const deck = parseDeck(parsed.deck);
      if (deck === null) return { ok: false, reason: 'bad deck' };
      return { ok: true, message: { type: ClientMessageType.CreatePrivate, deck } };
    }

    case ClientMessageType.JoinPrivate: {
      const deck = parseDeck(parsed.deck);
      if (deck === null) return { ok: false, reason: 'bad deck' };
      if (!isCleanString(parsed.code, MAX_ROOM_CODE_LENGTH)) {
        return { ok: false, reason: 'bad room code' };
      }
      return {
        ok: true,
        message: {
          type: ClientMessageType.JoinPrivate,
          code: parsed.code.toUpperCase(),
          deck,
        },
      };
    }

    case ClientMessageType.LeavePrivate:
      return { ok: true, message: { type: ClientMessageType.LeavePrivate } };

    case ClientMessageType.PlayCard: {
      // The hand index is an index, not a card id: the client cannot name
      // which card it wants to play, only which of its own slots to spend.
      // That removes a whole class of "play a card I do not have" cheats.
      if (!Number.isInteger(parsed.handIndex)) return { ok: false, reason: 'bad hand index' };
      const handIndex = parsed.handIndex as number;
      if (handIndex < 0 || handIndex > 32) return { ok: false, reason: 'hand index out of range' };
      // Generous bounds here; the simulation clamps to the real arena and
      // enforces the actual deployment rules.
      if (!isBoundedNumber(parsed.x, -1000, 1000) || !isBoundedNumber(parsed.y, -1000, 1000)) {
        return { ok: false, reason: 'bad coordinates' };
      }
      const message: ClientMessage = {
        type: ClientMessageType.PlayCard,
        handIndex,
        x: parsed.x,
        y: parsed.y,
      };
      return { ok: true, message };
    }

    case ClientMessageType.Forfeit:
      return { ok: true, message: { type: ClientMessageType.Forfeit } };

    case ClientMessageType.Reconnect: {
      if (!isCleanString(parsed.matchId, 64)) return { ok: false, reason: 'bad matchId' };
      if (!isCleanString(parsed.playerId, MAX_PLAYER_ID_LENGTH)) {
        return { ok: false, reason: 'bad playerId' };
      }
      return {
        ok: true,
        message: {
          type: ClientMessageType.Reconnect,
          matchId: parsed.matchId,
          playerId: parsed.playerId,
        },
      };
    }

    case ClientMessageType.Ping: {
      const t = isBoundedNumber(parsed.t, 0, Number.MAX_SAFE_INTEGER) ? parsed.t : 0;
      return { ok: true, message: { type: ClientMessageType.Ping, t } };
    }

    default:
      return { ok: false, reason: `unknown message type: ${type.slice(0, 32)}` };
  }
}

/** Serialises an outbound message. */
export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * A simple token bucket, used to stop a client flooding the server with
 * messages. Each connection gets its own.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Consumes a token. Returns false when the client is over its budget. */
  take(now: number = Date.now()): boolean {
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
