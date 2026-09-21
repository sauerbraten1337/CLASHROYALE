/**
 * Riftbound Rivals dedicated server.
 *
 * Runs the authoritative simulation for every online match and serves the
 * built client. The single most important property of this process is that
 * it never takes a client's word for anything that affects a match: clients
 * send intents, the simulation decides outcomes.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  ClientMessageType,
  ServerMessageType,
  TICK_RATE,
  TICK_SECONDS,
  type PlayerId,
  type ServerMessage,
} from '@riftbound/shared';

import { MatchManager } from './match/MatchManager.js';
import { RateLimiter, encode, parseClientMessage, sanitizeName } from './net/protocol.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

/** Where the built client lives, when it has been built. */
const CLIENT_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../client/dist',
);

/** Per-connection state. */
interface Connection {
  socket: WebSocket;
  playerId: PlayerId;
  name: string;
  /** Set once the client has said hello. */
  identified: boolean;
  limiter: RateLimiter;
  alive: boolean;
}

const manager = new MatchManager();
const connections = new Map<WebSocket, Connection>();
/** Lets a reconnecting player displace their own stale socket. */
const byPlayerId = new Map<PlayerId, Connection>();

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...manager.stats(), tickRate: TICK_RATE }));
    return;
  }

  // Resolve inside CLIENT_DIR only: never let a path escape the web root.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = resolve(join(CLIENT_DIR, normalize(requested)));
  if (candidate !== CLIENT_DIR && !candidate.startsWith(CLIENT_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(candidate);
    res.writeHead(200, {
      'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
      'cache-control': requested === '/index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(body);
  } catch {
    // Single-page app: unknown paths fall back to the shell, when built.
    try {
      const shell = await readFile(join(CLIENT_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] as string });
      res.end(shell);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        'Riftbound Rivals server is running, but the client has not been built.\n' +
          'Run `npm run build` at the repository root, or `npm run dev` for the dev server.\n',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(encode(message));
  } catch {
    // A failed send is not fatal: the close handler will clean the slot up.
  }
}

function fail(connection: Connection, code: string, message: string): void {
  send(connection.socket, { type: ServerMessageType.Error, code, message });
}

/** Generates a server-side player id for clients that arrive without one. */
function newPlayerId(): PlayerId {
  return `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function handleMessage(connection: Connection, raw: string | Buffer): void {
  if (!connection.limiter.take()) {
    fail(connection, 'rate-limited', 'Too many messages.');
    return;
  }

  const parsed = parseClientMessage(raw);
  if (!parsed.ok) {
    fail(connection, 'bad-message', parsed.reason);
    return;
  }
  const message = parsed.message;

  // Everything except hello and ping requires an identified connection.
  if (
    !connection.identified &&
    message.type !== ClientMessageType.Hello &&
    message.type !== ClientMessageType.Ping
  ) {
    fail(connection, 'not-identified', 'Send hello first.');
    return;
  }

  switch (message.type) {
    case ClientMessageType.Hello: {
      // A client-supplied id is only an identity *hint* for reconnecting. It
      // grants nothing on its own: a player can only act on a match they
      // already occupy a slot in.
      const claimed = message.playerId;
      const playerId = claimed && claimed.length >= 4 ? claimed : newPlayerId();

      // Displace any older socket using the same identity.
      const existing = byPlayerId.get(playerId);
      if (existing && existing !== connection) {
        existing.socket.close(4000, 'replaced by a newer connection');
      }

      connection.playerId = playerId;
      connection.name = sanitizeName(message.name);
      connection.identified = true;
      byPlayerId.set(playerId, connection);

      const resumable = manager.matchFor(playerId);
      send(connection.socket, {
        type: ServerMessageType.Welcome,
        playerId,
        serverTickRate: TICK_RATE,
        ...(resumable && !resumable.isFinished ? { resumableMatchId: resumable.matchId } : {}),
      });
      break;
    }

    case ClientMessageType.QueueJoin: {
      if (manager.matchFor(connection.playerId)) {
        fail(connection, 'already-in-match', 'You are already in a match.');
        return;
      }
      manager.enqueue({
        playerId: connection.playerId,
        name: connection.name,
        deck: message.deck,
        trophies: message.trophies,
        send: (m) => send(connection.socket, m),
      });
      send(connection.socket, {
        type: ServerMessageType.QueueStatus,
        searching: manager.isQueued(connection.playerId),
        queued: manager.queueLength,
        waitedSeconds: 0,
      });
      break;
    }

    case ClientMessageType.QueueLeave: {
      manager.dequeue(connection.playerId);
      send(connection.socket, {
        type: ServerMessageType.QueueStatus,
        searching: false,
        queued: manager.queueLength,
        waitedSeconds: 0,
      });
      break;
    }

    case ClientMessageType.CreatePrivate: {
      if (manager.matchFor(connection.playerId)) {
        fail(connection, 'already-in-match', 'You are already in a match.');
        return;
      }
      const code = manager.createRoom({
        playerId: connection.playerId,
        name: connection.name,
        deck: message.deck,
        trophies: 0,
        send: (m) => send(connection.socket, m),
      });
      send(connection.socket, { type: ServerMessageType.PrivateRoom, code, occupants: 1 });
      break;
    }

    case ClientMessageType.JoinPrivate: {
      if (manager.matchFor(connection.playerId)) {
        fail(connection, 'already-in-match', 'You are already in a match.');
        return;
      }
      const result = manager.joinRoom(message.code, {
        playerId: connection.playerId,
        name: connection.name,
        deck: message.deck,
        trophies: 0,
        send: (m) => send(connection.socket, m),
      });
      if (!result.ok) fail(connection, result.code, result.message);
      break;
    }

    case ClientMessageType.LeavePrivate: {
      manager.leaveRoom(connection.playerId);
      break;
    }

    case ClientMessageType.PlayCard: {
      const match = manager.matchFor(connection.playerId);
      if (!match) {
        fail(connection, 'no-match', 'You are not in a match.');
        return;
      }
      match.playCard(connection.playerId, message.handIndex, message.x, message.y);
      break;
    }

    case ClientMessageType.Forfeit: {
      manager.matchFor(connection.playerId)?.forfeit(connection.playerId);
      break;
    }

    case ClientMessageType.Reconnect: {
      // A player may only reclaim a slot they already hold. Naming someone
      // else's match gets nothing.
      const match = manager.getMatch(message.matchId);
      if (!match || match.isFinished) {
        fail(connection, 'no-match', 'That match is no longer running.');
        return;
      }
      if (!match.slots.has(connection.playerId)) {
        fail(connection, 'not-your-match', 'You are not a player in that match.');
        return;
      }
      match.connect(connection.playerId, (m) => send(connection.socket, m));

      // Re-send the match details. A reconnecting client has lost the
      // original MatchFound, so without this it would have a live socket to
      // a match it cannot render: no team, no opponent, no arena to enter.
      const slot = match.slots.get(connection.playerId);
      const opponent = match.opponentOf(connection.playerId);
      if (slot) {
        send(connection.socket, {
          type: ServerMessageType.MatchFound,
          matchId: match.matchId,
          team: slot.team,
          opponentName: opponent?.name ?? 'Opponent',
          opponentTrophies: 0,
          // The match is already under way; drop straight in.
          countdown: 0,
        });
      }
      break;
    }

    case ClientMessageType.Ping: {
      send(connection.socket, {
        type: ServerMessageType.Pong,
        t: message.t,
        serverTime: Date.now(),
      });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  serveStatic(req, res).catch((error) => {
    console.error('static handler failed:', error);
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal error');
  });
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (socket: WebSocket) => {
  const connection: Connection = {
    socket,
    playerId: newPlayerId(),
    name: 'Challenger',
    identified: false,
    // Generous enough for normal play, tight enough to stop a flood.
    limiter: new RateLimiter(40, 20),
    alive: true,
  };
  connections.set(socket, connection);

  socket.on('message', (raw) => {
    try {
      handleMessage(connection, raw as Buffer);
    } catch (error) {
      // A malformed message must never kill the process.
      console.error('message handler failed:', error);
      fail(connection, 'internal', 'Message could not be processed.');
    }
  });

  socket.on('pong', () => {
    connection.alive = true;
  });

  socket.on('close', () => {
    connections.delete(socket);
    if (byPlayerId.get(connection.playerId) === connection) {
      byPlayerId.delete(connection.playerId);
    }
    manager.removeWaiting(connection.playerId);
    // The match slot is held open for the grace period rather than forfeited.
    manager.matchFor(connection.playerId)?.disconnect(connection.playerId);
  });

  socket.on('error', () => {
    // Errors are followed by close; nothing extra to do here.
  });
});

/** Fixed-rate simulation loop. */
let lastTick = Date.now();
let accumulator = 0;
const tickInterval = setInterval(() => {
  const now = Date.now();
  // Cap the catch-up so a stalled event loop cannot cause a death spiral.
  accumulator += Math.min((now - lastTick) / 1000, 0.5);
  lastTick = now;

  let steps = 0;
  while (accumulator >= TICK_SECONDS && steps < 10) {
    accumulator -= TICK_SECONDS;
    manager.tickMatches();
    steps++;
  }
}, 1000 / TICK_RATE);

/** Slower housekeeping loop: matchmaking, room expiry, dead socket reaping. */
const maintenanceInterval = setInterval(() => {
  manager.maintain();

  for (const connection of connections.values()) {
    if (!connection.alive) {
      connection.socket.terminate();
      continue;
    }
    connection.alive = false;
    try {
      connection.socket.ping();
    } catch {
      connection.socket.terminate();
    }
  }
}, 1000);

httpServer.listen(PORT, HOST, () => {
  console.log(`Riftbound Rivals server listening on http://${HOST}:${PORT}`);
  console.log(`  websocket:  ws://${HOST}:${PORT}/ws`);
  console.log(`  simulation: ${TICK_RATE} Hz, server-authoritative`);
});

function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down.`);
  clearInterval(tickInterval);
  clearInterval(maintenanceInterval);
  for (const connection of connections.values()) {
    connection.socket.close(1001, 'server shutting down');
  }
  wss.close();
  httpServer.close(() => process.exit(0));
  // Do not hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  // Log and keep serving: one bad match must not end everyone else's game.
  console.error('uncaught exception:', error);
});
