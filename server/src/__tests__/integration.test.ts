/**
 * Server integration tests.
 *
 * These drive the real server over a real WebSocket: boot the process,
 * connect two clients, get matched, play cards, and confirm the server
 * stays authoritative throughout. The cheat-resistance cases are the
 * important ones - they are the reason the client is not trusted.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  ClientMessageType,
  ENERGY_MAX,
  MatchPhase,
  ServerMessageType,
  STARTER_DECK,
  Team,
  type MatchSnapshot,
  type ServerMessage,
} from '@riftbound/shared';

const PORT = 8123 + Math.floor(Math.random() * 400);
const SERVER_ENTRY = resolve(fileURLToPath(new URL('../../dist/index.js', import.meta.url)));

let server: ChildProcess;

/** A test client that records everything the server sends it. */
class TestClient {
  readonly socket: WebSocket;
  readonly received: ServerMessage[] = [];
  playerId = '';

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      this.received.push(message);
      if (message.type === ServerMessageType.Welcome) this.playerId = message.playerId;
    });
  }

  static async connect(): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise<void>((res, rej) => {
      socket.once('open', () => res());
      socket.once('error', rej);
    });
    return new TestClient(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Sends a raw string, for malformed-input tests. */
  sendRaw(text: string): void {
    this.socket.send(text);
  }

  /** Waits for the first message of a type, or throws on timeout. */
  async waitFor<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 8000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const existing = this.received.find((m) => m.type === type);
    if (existing) return existing as Extract<ServerMessage, { type: T }>;

    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.socket.off('message', onMessage);
        rej(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);

      const onMessage = (raw: Buffer): void => {
        const message = JSON.parse(raw.toString()) as ServerMessage;
        if (message.type === type) {
          clearTimeout(timer);
          this.socket.off('message', onMessage);
          res(message as Extract<ServerMessage, { type: T }>);
        }
      };
      this.socket.on('message', onMessage);
    });
  }

  /** The most recent snapshot received. */
  latestSnapshot(): MatchSnapshot | null {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const message = this.received[i];
      if (message && message.type === ServerMessageType.Snapshot) return message.snapshot;
    }
    return null;
  }

  async hello(name: string, playerId = ''): Promise<void> {
    this.send({ type: ClientMessageType.Hello, name, playerId });
    await this.waitFor(ServerMessageType.Welcome);
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

before(async () => {
  server = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => {
    const text = String(d);
    // Surface real server errors in the test output.
    if (text.trim()) console.error('[server]', text.trim());
  });

  // Wait for the port to accept connections.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill('SIGKILL');
});

describe('server handshake', () => {
  it('serves a health endpoint', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`);
    assert.equal(response.ok, true);
    const body = (await response.json()) as { ok: boolean; tickRate: number };
    assert.equal(body.ok, true);
    assert.ok(body.tickRate > 0);
  });

  it('assigns a player id on hello', async () => {
    const client = await TestClient.connect();
    await client.hello('Alice');
    assert.ok(client.playerId.length > 0);
    client.close();
  });

  it('honours a client-supplied id so a player can reconnect as themselves', async () => {
    const client = await TestClient.connect();
    await client.hello('Alice', 'stable-id-12345');
    assert.equal(client.playerId, 'stable-id-12345');
    client.close();
  });

  it('refuses gameplay messages before hello', async () => {
    const client = await TestClient.connect();
    client.send({ type: ClientMessageType.PlayCard, handIndex: 0, x: 50, y: 150 });
    const error = await client.waitFor(ServerMessageType.Error);
    assert.equal(error.code, 'not-identified');
    client.close();
  });

  it('survives malformed and hostile input', async () => {
    const client = await TestClient.connect();
    await client.hello('Alice');

    client.sendRaw('this is not json');
    let error = await client.waitFor(ServerMessageType.Error);
    assert.equal(error.code, 'bad-message');

    // A well-formed frame of the wrong shape.
    client.received.length = 0;
    client.send({ type: 'no-such-type' });
    error = await client.waitFor(ServerMessageType.Error);
    assert.equal(error.code, 'bad-message');

    // Hostile numbers must not get through.
    client.received.length = 0;
    client.send({ type: ClientMessageType.PlayCard, handIndex: 1e9, x: 50, y: 150 });
    error = await client.waitFor(ServerMessageType.Error);
    assert.equal(error.code, 'bad-message');

    // The connection is still usable afterwards.
    client.send({ type: ClientMessageType.Ping, t: 1 });
    const pong = await client.waitFor(ServerMessageType.Pong);
    assert.equal(pong.t, 1);
    client.close();
  });
});

describe('matchmaking', () => {
  it('pairs two queued players into one match on opposite teams', async () => {
    const a = await TestClient.connect();
    const b = await TestClient.connect();
    await a.hello('Alice');
    await b.hello('Bob');

    a.send({ type: ClientMessageType.QueueJoin, deck: STARTER_DECK, trophies: 100 });
    b.send({ type: ClientMessageType.QueueJoin, deck: STARTER_DECK, trophies: 110 });

    const foundA = await a.waitFor(ServerMessageType.MatchFound);
    const foundB = await b.waitFor(ServerMessageType.MatchFound);

    assert.equal(foundA.matchId, foundB.matchId);
    assert.notEqual(foundA.team, foundB.team);
    assert.equal(foundA.opponentName, 'Bob');
    assert.equal(foundB.opponentName, 'Alice');

    a.close();
    b.close();
  });

  it('runs a private room end to end', async () => {
    const host = await TestClient.connect();
    const guest = await TestClient.connect();
    await host.hello('Host');
    await guest.hello('Guest');

    host.send({ type: ClientMessageType.CreatePrivate, deck: STARTER_DECK });
    const room = await host.waitFor(ServerMessageType.PrivateRoom);
    assert.ok(room.code.length >= 4);

    guest.send({ type: ClientMessageType.JoinPrivate, code: room.code, deck: STARTER_DECK });

    const foundHost = await host.waitFor(ServerMessageType.MatchFound);
    const foundGuest = await guest.waitFor(ServerMessageType.MatchFound);
    assert.equal(foundHost.matchId, foundGuest.matchId);

    host.close();
    guest.close();
  });

  it('rejects an unknown room code', async () => {
    const client = await TestClient.connect();
    await client.hello('Lost');
    client.send({ type: ClientMessageType.JoinPrivate, code: 'ZZZZZ', deck: STARTER_DECK });
    const error = await client.waitFor(ServerMessageType.Error);
    assert.equal(error.code, 'no-such-room');
    client.close();
  });
});

describe('authoritative play', () => {
  /** Queues two clients and waits until their match is live. */
  async function startMatch(): Promise<{ a: TestClient; b: TestClient; matchId: string }> {
    const a = await TestClient.connect();
    const b = await TestClient.connect();
    await a.hello(`A${Math.random().toString(36).slice(2, 7)}`);
    await b.hello(`B${Math.random().toString(36).slice(2, 7)}`);
    a.send({ type: ClientMessageType.QueueJoin, deck: STARTER_DECK, trophies: 500 });
    b.send({ type: ClientMessageType.QueueJoin, deck: STARTER_DECK, trophies: 505 });
    const found = await a.waitFor(ServerMessageType.MatchFound);
    await b.waitFor(ServerMessageType.MatchFound);
    await a.waitFor(ServerMessageType.Snapshot);
    return { a, b, matchId: found.matchId };
  }

  it('broadcasts snapshots that both clients agree on', async () => {
    const { a, b } = await startMatch();
    await sleep(600);

    const snapA = a.latestSnapshot();
    const snapB = b.latestSnapshot();
    assert.ok(snapA && snapB);
    assert.equal(snapA.matchId, snapB.matchId);
    // Both sides see the same six towers.
    assert.equal(snapA.entities.filter((e) => e.kind === 'tower').length, 6);
    assert.equal(snapB.entities.filter((e) => e.kind === 'tower').length, 6);

    a.close();
    b.close();
  });

  it('spawns a unit when a legal card is played', async () => {
    const { a } = await startMatch();
    // Wait out the countdown and bank some energy.
    await sleep(4000);

    const before = a.latestSnapshot();
    assert.ok(before);
    const unitsBefore = before.entities.filter((e) => e.kind !== 'tower').length;

    a.send({ type: ClientMessageType.PlayCard, handIndex: 0, x: 24, y: 140 });
    await sleep(600);

    const after = a.latestSnapshot();
    assert.ok(after);
    const unitsAfter = after.entities.filter((e) => e.kind !== 'tower').length;
    assert.ok(unitsAfter > unitsBefore, 'playing a card should put something on the board');

    a.close();
  });

  it('never lets a client exceed the energy cap however fast it spams', async () => {
    const { a } = await startMatch();
    await sleep(3500);

    // Hammer the server with plays. Most will be rejected for lack of energy;
    // none of them may ever push energy above the cap or below zero.
    for (let i = 0; i < 30; i++) {
      a.send({ type: ClientMessageType.PlayCard, handIndex: i % 4, x: 24, y: 140 });
    }
    await sleep(1000);

    const snapshot = a.latestSnapshot();
    assert.ok(snapshot);
    for (const player of snapshot.players) {
      assert.ok(player.energy <= ENERGY_MAX + 0.01, `energy ${player.energy} over cap`);
      assert.ok(player.energy >= -0.01, `energy ${player.energy} below zero`);
    }
    a.close();
  });

  it('refuses to deploy a unit on the enemy half', async () => {
    const { a } = await startMatch();
    await sleep(4000);

    const before = a.latestSnapshot();
    assert.ok(before);
    const redUnitsBefore = before.entities.filter(
      (e) => e.team === Team.Red && e.kind !== 'tower',
    ).length;

    // Blue defends the high-y end, so y=20 is deep inside Red's territory.
    for (let i = 0; i < 4; i++) {
      a.send({ type: ClientMessageType.PlayCard, handIndex: i, x: 50, y: 20 });
    }
    await sleep(800);

    const after = a.latestSnapshot();
    assert.ok(after);
    const blueUnitsDeep = after.entities.filter(
      (e) => e.team === Team.Blue && e.kind !== 'tower' && e.y < 60,
    ).length;
    const redUnitsAfter = after.entities.filter(
      (e) => e.team === Team.Red && e.kind !== 'tower',
    ).length;

    assert.equal(blueUnitsDeep, 0, 'no blue unit should have appeared in red territory');
    assert.equal(redUnitsAfter, redUnitsBefore, 'the enemy side must be unaffected');

    a.close();
  });

  it('will not let one player spend the other player\'s hand', async () => {
    const { a, b } = await startMatch();
    await sleep(4000);

    const before = b.latestSnapshot();
    assert.ok(before);
    const bBefore = before.players.find((p) => p.team === Team.Red);
    assert.ok(bBefore);
    const energyBefore = bBefore.energy;

    // A plays repeatedly. B's energy must only ever move by regeneration.
    for (let i = 0; i < 6; i++) {
      a.send({ type: ClientMessageType.PlayCard, handIndex: i % 4, x: 24, y: 140 });
    }
    await sleep(700);

    const after = b.latestSnapshot();
    assert.ok(after);
    const bAfter = after.players.find((p) => p.team === Team.Red);
    assert.ok(bAfter);
    assert.ok(
      bAfter.energy >= energyBefore,
      "the opponent's plays must not drain this player's energy",
    );

    a.close();
    b.close();
  });

  it('refuses a reconnect to a match the player is not in', async () => {
    const { a, matchId } = await startMatch();
    const intruder = await TestClient.connect();
    await intruder.hello('Intruder');

    intruder.send({
      type: ClientMessageType.Reconnect,
      matchId,
      playerId: intruder.playerId,
    });
    const error = await intruder.waitFor(ServerMessageType.Error);
    assert.equal(error.code, 'not-your-match');

    intruder.close();
    a.close();
  });

  it('holds a slot open across a drop and lets the player return', async () => {
    const a = await TestClient.connect();
    const b = await TestClient.connect();
    const aId = `drop-test-${Math.random().toString(36).slice(2, 8)}`;
    await a.hello('Dropper', aId);
    await b.hello('Stayer');

    a.send({ type: ClientMessageType.QueueJoin, deck: STARTER_DECK, trophies: 900 });
    b.send({ type: ClientMessageType.QueueJoin, deck: STARTER_DECK, trophies: 905 });
    const found = await a.waitFor(ServerMessageType.MatchFound);
    await b.waitFor(ServerMessageType.MatchFound);

    // Drop the first player.
    a.close();
    const left = await b.waitFor(ServerMessageType.OpponentLeft);
    assert.ok(left.graceSeconds > 0);

    // Reconnect as the same identity and reclaim the slot.
    const back = await TestClient.connect();
    await back.hello('Dropper', aId);
    back.send({
      type: ClientMessageType.Reconnect,
      matchId: found.matchId,
      playerId: aId,
    });

    await b.waitFor(ServerMessageType.OpponentReturned);
    const snapshot = await back.waitFor(ServerMessageType.Snapshot);
    assert.equal(snapshot.snapshot.matchId, found.matchId);

    back.close();
    b.close();
  });

  it('ends the match and pays out rewards on forfeit', async () => {
    const { a, b } = await startMatch();
    await sleep(3500);

    a.send({ type: ClientMessageType.Forfeit });

    const endA = await a.waitFor(ServerMessageType.MatchEnd);
    const endB = await b.waitFor(ServerMessageType.MatchEnd);

    assert.equal(endA.result.reason, 'forfeit');
    assert.equal(endA.result.winner, Team.Red);
    // The winner gains trophies, the loser drops them.
    assert.ok(endB.rewards.trophies > 0, 'winner should gain trophies');
    assert.ok(endA.rewards.trophies < 0, 'loser should lose trophies');
    assert.ok(endB.rewards.xp > 0 && endB.rewards.coins > 0);

    a.close();
    b.close();
  });

  it('reports a finished phase in the final snapshot', async () => {
    const { a, b } = await startMatch();
    await sleep(3500);
    a.send({ type: ClientMessageType.Forfeit });
    await a.waitFor(ServerMessageType.MatchEnd);

    const snapshot = a.latestSnapshot();
    assert.ok(snapshot);
    assert.equal(snapshot.phase, MatchPhase.Finished);

    a.close();
    b.close();
  });
});
