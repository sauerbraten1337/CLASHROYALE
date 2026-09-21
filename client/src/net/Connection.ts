/**
 * The WebSocket client.
 *
 * Owns one socket to the game server and fans incoming messages out to
 * subscribers. Reconnection is automatic with exponential backoff, and the
 * player's id is persisted so a dropped player comes back as themselves and
 * can reclaim their match slot.
 */

import {
  ClientMessageType,
  ServerMessageType,
  type ClientMessage,
  type ServerMessage,
} from '@riftbound/shared';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

type Listener = (message: ServerMessage) => void;
type StatusListener = (status: ConnectionStatus, detail?: string) => void;

const PING_INTERVAL_MS = 4000;
const MAX_BACKOFF_MS = 15000;

export class Connection {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private attempt = 0;
  /** Set when the caller explicitly closed the connection. */
  private deliberateClose = false;

  status: ConnectionStatus = 'idle';
  /** Round-trip time in milliseconds, or null before the first pong. */
  ping: number | null = null;
  playerId = '';
  playerName = 'Challenger';
  /** A match the server says we can rejoin after reconnecting. */
  resumableMatchId: string | null = null;

  constructor(private readonly url: string = defaultUrl()) {}

  // --- Subscriptions -------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status, detail);
  }

  private emit(message: ServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  // --- Lifecycle -----------------------------------------------------------

  /** Opens the socket and identifies. Safe to call when already connected. */
  connect(name: string, playerId: string): void {
    this.playerName = name;
    this.playerId = playerId;
    this.deliberateClose = false;

    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('connected');
      this.send({
        type: ClientMessageType.Hello,
        name: this.playerName,
        playerId: this.playerId,
      });
      this.startPinging();
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        // A frame we cannot parse is dropped rather than throwing.
        return;
      }

      if (message.type === ServerMessageType.Welcome) {
        this.playerId = message.playerId;
        this.resumableMatchId = message.resumableMatchId ?? null;
        persistPlayerId(message.playerId);
      } else if (message.type === ServerMessageType.Pong) {
        this.ping = Math.max(0, Math.round(Date.now() - message.t));
      }

      this.emit(message);
    };

    socket.onclose = () => {
      this.stopPinging();
      this.socket = null;
      if (this.deliberateClose) {
        this.setStatus('idle');
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows, which is where reconnection is handled.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.attempt++;
    // Exponential backoff with a cap, so a down server is not hammered.
    const delay = Math.min(MAX_BACKOFF_MS, 500 * Math.pow(1.7, this.attempt - 1));
    this.setStatus('reconnecting', `retrying in ${(delay / 1000).toFixed(1)}s`);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.playerName, this.playerId);
    }, delay);
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: ClientMessageType.Ping, t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  close(): void {
    this.deliberateClose = true;
    this.stopPinging();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus('idle');
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  // --- Sending -------------------------------------------------------------

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // A failed send is recoverable: the close handler will reconnect.
    }
  }

  joinQueue(deck: string[], trophies: number): void {
    this.send({ type: ClientMessageType.QueueJoin, deck, trophies });
  }

  leaveQueue(): void {
    this.send({ type: ClientMessageType.QueueLeave });
  }

  createPrivate(deck: string[]): void {
    this.send({ type: ClientMessageType.CreatePrivate, deck });
  }

  joinPrivate(code: string, deck: string[]): void {
    this.send({ type: ClientMessageType.JoinPrivate, code, deck });
  }

  leavePrivate(): void {
    this.send({ type: ClientMessageType.LeavePrivate });
  }

  playCard(handIndex: number, x: number, y: number): void {
    this.send({ type: ClientMessageType.PlayCard, handIndex, x, y });
  }

  forfeit(): void {
    this.send({ type: ClientMessageType.Forfeit });
  }

  reconnectToMatch(matchId: string): void {
    this.send({ type: ClientMessageType.Reconnect, matchId, playerId: this.playerId });
  }
}

/** Same-origin websocket URL, so the client works wherever it is served. */
function defaultUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:8080/ws';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

const PLAYER_ID_KEY = 'riftbound.playerId';

/** A stable local identity, so a reconnecting player reclaims their slot. */
export function loadPlayerId(): string {
  try {
    const existing = localStorage.getItem(PLAYER_ID_KEY);
    if (existing && existing.length >= 4) return existing;
  } catch {
    // Storage can be unavailable in private browsing; fall through.
  }
  const generated = `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  persistPlayerId(generated);
  return generated;
}

function persistPlayerId(id: string): void {
  try {
    localStorage.setItem(PLAYER_ID_KEY, id);
  } catch {
    // Not fatal: the player simply gets a fresh identity next session.
  }
}
