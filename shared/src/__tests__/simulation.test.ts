/**
 * Engine tests.
 *
 * These cover the vertical slice the whole game rests on: a card can be
 * played, it costs energy, a body spawns, it walks, it fights, a tower
 * falls, and the match ends with a winner.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  CARDS,
  COLLECTIBLE_CARDS,
  DECK_SIZE,
  ENERGY_MAX,
  ENERGY_START,
  HAND_SIZE,
  MatchPhase,
  PlayRejection,
  STARTER_DECK,
  Simulation,
  Team,
  TowerSlot,
  analyzeDeck,
  getCard,
  sanitizeDeck,
  validateDeck,
  type SimulationConfig,
} from '../index.js';
import { EntityKind, CardType } from '../types.js';

function makeSim(overrides: Partial<SimulationConfig> = {}): Simulation {
  return new Simulation({
    matchId: 'test',
    seed: 1234,
    skipCountdown: true,
    players: [
      { id: 'p1', name: 'Blue', team: Team.Blue, deck: [...STARTER_DECK] },
      { id: 'p2', name: 'Red', team: Team.Red, deck: [...STARTER_DECK] },
    ],
    ...overrides,
  });
}

/** Runs the sim forward by a number of seconds at the fixed step. */
function advance(sim: Simulation, seconds: number, step = 1 / 30): void {
  const steps = Math.round(seconds / step);
  for (let i = 0; i < steps; i++) sim.step(step);
}

describe('card data', () => {
  it('has at least 24 collectible cards', () => {
    assert.ok(
      COLLECTIBLE_CARDS.length >= 24,
      `expected >= 24 collectible cards, got ${COLLECTIBLE_CARDS.length}`,
    );
  });

  it('has unique ids', () => {
    const ids = new Set(CARDS.map((c) => c.id));
    assert.equal(ids.size, CARDS.length);
  });

  it('only references cards that exist from abilities and spells', () => {
    for (const card of CARDS) {
      for (const ability of card.abilities ?? []) {
        if (ability.spawns) {
          assert.ok(getCard(ability.spawns), `${card.id} spawns missing card ${ability.spawns}`);
        }
      }
      const summons = card.spell?.summons;
      if (summons) {
        assert.ok(getCard(summons.cardId), `${card.id} summons missing card ${summons.cardId}`);
      }
    }
  });

  it('gives every non-spell card the stats it needs to function', () => {
    for (const card of CARDS) {
      if (card.type === CardType.Spell) {
        assert.ok(card.spell, `${card.id} is a spell with no spell spec`);
        continue;
      }
      assert.ok((card.health ?? 0) > 0, `${card.id} has no health`);
      // A building may have zero damage (spawners, gravity wells); a unit may not.
      if (card.type === CardType.Unit) {
        assert.ok((card.damage ?? 0) > 0, `${card.id} deals no damage`);
        assert.ok((card.movementSpeed ?? 0) > 0, `${card.id} cannot move`);
      }
    }
  });

  it('keeps the starter deck legal', () => {
    assert.equal(validateDeck(STARTER_DECK).valid, true);
    assert.equal(STARTER_DECK.length, DECK_SIZE);
  });
});

describe('deck handling', () => {
  it('rejects malformed decks', () => {
    assert.equal(validateDeck([]).valid, false);
    assert.equal(validateDeck(['not-a-card', ...STARTER_DECK.slice(1)]).valid, false);
    // Duplicates are illegal.
    const dupe = [STARTER_DECK[0] as string, ...STARTER_DECK.slice(0, DECK_SIZE - 1)];
    assert.equal(validateDeck(dupe).valid, false);
  });

  it('repairs a bad deck instead of failing', () => {
    const repaired = sanitizeDeck(['garbage', 'shard-hound', 'shard-hound']);
    assert.equal(repaired.length, DECK_SIZE);
    assert.equal(validateDeck(repaired).valid, true);
  });

  it('reports deck statistics', () => {
    const stats = analyzeDeck(STARTER_DECK);
    assert.equal(stats.units + stats.buildings + stats.spells, DECK_SIZE);
    assert.ok(stats.averageCost > 0);
  });
});

describe('match setup', () => {
  it('gives both players a full hand and starting energy', () => {
    const sim = makeSim();
    for (const player of sim.players.values()) {
      assert.equal(player.hand.length, HAND_SIZE);
      assert.equal(player.cycle.length, DECK_SIZE - HAND_SIZE);
      assert.equal(player.energy, ENERGY_START);
    }
  });

  it('spawns three towers per side', () => {
    const sim = makeSim();
    assert.equal(sim.towersRemaining(Team.Blue), 3);
    assert.equal(sim.towersRemaining(Team.Red), 3);
    const cores = [...sim.entities.values()].filter((e) => e.slot === TowerSlot.Core);
    assert.equal(cores.length, 2);
  });

  it('runs a countdown before accepting plays', () => {
    const sim = makeSim({ skipCountdown: false });
    assert.equal(sim.phase, MatchPhase.Countdown);
    const rejected = sim.playCard('p1', 0, 50, 150);
    assert.equal(rejected.ok, false);
    advance(sim, 3.5);
    assert.equal(sim.phase, MatchPhase.Active);
  });
});

describe('energy', () => {
  it('regenerates over time and caps at the maximum', () => {
    const sim = makeSim();
    const player = sim.getPlayer(Team.Blue);
    assert.ok(player);
    advance(sim, 10);
    assert.ok(player.energy > ENERGY_START, 'energy should regenerate');
    advance(sim, 60);
    assert.ok(player.energy <= ENERGY_MAX + 0.001, 'energy must not exceed the cap');
  });

  it('is charged when a card is played', () => {
    const sim = makeSim();
    const player = sim.getPlayer(Team.Blue);
    assert.ok(player);
    // Find an affordable card in hand.
    const index = player.hand.findIndex((id) => (getCard(id)?.cost ?? 99) <= ENERGY_START);
    assert.ok(index >= 0, 'expected an affordable card in the opening hand');
    const cost = getCard(player.hand[index] as string)?.cost ?? 0;
    const before = player.energy;
    const result = sim.playCard('p1', index, 50, 150);
    assert.equal(result.ok, true);
    assert.ok(Math.abs(player.energy - (before - cost)) < 0.001);
  });
});

describe('playCard validation', () => {
  it('refuses an unaffordable card', () => {
    const sim = makeSim();
    const player = sim.getPlayer(Team.Blue);
    assert.ok(player);
    player.energy = 0;
    const result = sim.playCard('p1', 0, 50, 150);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, PlayRejection.NotEnoughEnergy);
  });

  it('refuses an out-of-range hand slot', () => {
    const sim = makeSim();
    for (const bad of [-1, HAND_SIZE, 99, 1.5]) {
      const result = sim.playCard('p1', bad, 50, 150);
      assert.equal(result.ok, false, `hand index ${bad} should be rejected`);
      if (!result.ok) assert.equal(result.code, PlayRejection.BadHandIndex);
    }
  });

  it('refuses an unknown player', () => {
    const sim = makeSim();
    const result = sim.playCard('nobody', 0, 50, 150);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, PlayRejection.NoSuchPlayer);
  });

  it('refuses a unit deployed on the enemy half', () => {
    const sim = makeSim();
    const player = sim.getPlayer(Team.Blue);
    assert.ok(player);
    player.energy = ENERGY_MAX;
    const index = player.hand.findIndex((id) => getCard(id)?.type !== CardType.Spell);
    assert.ok(index >= 0);
    // Blue defends the high-y end, so y=20 is deep in Red's half.
    const result = sim.playCard('p1', index, 50, 20);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, PlayRejection.IllegalPosition);
  });

  it('refuses non-finite coordinates', () => {
    const sim = makeSim();
    const player = sim.getPlayer(Team.Blue);
    assert.ok(player);
    player.energy = ENERGY_MAX;
    const result = sim.playCard('p1', 0, Number.NaN, 150);
    assert.equal(result.ok, false);
  });

  it('rotates the hand so the played card goes to the back of the cycle', () => {
    const sim = makeSim();
    const player = sim.getPlayer(Team.Blue);
    assert.ok(player);
    player.energy = ENERGY_MAX;
    const played = player.hand[0] as string;
    const expectedNext = player.cycle[0] as string;

    sim.playCard('p1', 0, 50, 150);

    assert.equal(player.hand[0], expectedNext, 'played slot should draw the next card');
    assert.equal(player.cycle.at(-1), played, 'played card should re-queue at the back');
    assert.equal(player.hand.length, HAND_SIZE);
    assert.equal(player.cycle.length, DECK_SIZE - HAND_SIZE);
  });
});

describe('the vertical slice', () => {
  it('spawns a body that walks, fights and damages an enemy tower', () => {
    const sim = makeSim();
    const blue = sim.getPlayer(Team.Blue);
    assert.ok(blue);

    // Put a known attacker directly in front of Red's left guard tower.
    const card = getCard('shard-hound');
    assert.ok(card);
    const redGuard = [...sim.entities.values()].find(
      (e) => e.team === Team.Red && e.slot === TowerSlot.LeftGuard,
    );
    assert.ok(redGuard, 'red guard tower should exist');
    const towerHealthBefore = redGuard.health;

    const spawned = sim.spawnUnits(card, Team.Blue, 'p1', redGuard.x, redGuard.y + 15, {
      instant: true,
    });
    assert.equal(spawned.length, card.spawnAmount ?? 1);

    // Give them time to close and attack.
    advance(sim, 12);

    assert.ok(
      redGuard.health < towerHealthBefore,
      `tower should have taken damage (was ${towerHealthBefore}, now ${redGuard.health})`,
    );
  });

  it('destroys a tower and credits the kill', () => {
    const sim = makeSim();
    const redGuard = [...sim.entities.values()].find(
      (e) => e.team === Team.Red && e.slot === TowerSlot.LeftGuard,
    );
    assert.ok(redGuard);
    // Soften it so the test does not need a full siege.
    redGuard.health = 60;

    const card = getCard('shard-hound');
    assert.ok(card);
    sim.spawnUnits(card, Team.Blue, 'p1', redGuard.x, redGuard.y + 8, { instant: true });
    advance(sim, 12);

    assert.equal(sim.towersRemaining(Team.Red), 2, 'red should have lost a tower');
    assert.equal(sim.getPlayer(Team.Blue)?.towersDestroyed, 1);
  });

  it('ends the match the moment a core falls', () => {
    const sim = makeSim();
    const redCore = [...sim.entities.values()].find(
      (e) => e.team === Team.Red && e.slot === TowerSlot.Core,
    );
    assert.ok(redCore);
    redCore.health = 40;

    const card = getCard('shard-hound');
    assert.ok(card);
    sim.spawnUnits(card, Team.Blue, 'p1', redCore.x, redCore.y + 8, { instant: true });
    advance(sim, 15);

    assert.equal(sim.phase, MatchPhase.Finished);
    assert.equal(sim.result?.winner, Team.Blue);
    assert.equal(sim.result?.reason, 'core-destroyed');
  });
});

describe('match flow', () => {
  it('enters overcharge in the final stretch', () => {
    const sim = makeSim({ matchSeconds: 70 });
    advance(sim, 15);
    assert.equal(sim.phase, MatchPhase.Overcharge, 'should be in overcharge below 60s remaining');
  });

  it('goes to sudden death when regular time ends level, then can be won', () => {
    const sim = makeSim({ matchSeconds: 2 });
    advance(sim, 3);
    assert.equal(sim.phase, MatchPhase.SuddenDeath);
    // Read through a local: asserting on `sim.result` directly would narrow
    // the property to null for the rest of the test, and TypeScript has no way
    // to know that stepping the sim reassigns it.
    const resultOnEntry: unknown = sim.result;
    assert.ok(resultOnEntry === null, 'sudden death must not resolve on entry');

    // Break the deadlock: the first tower to fall decides it.
    const redGuard = [...sim.entities.values()].find(
      (e) => e.team === Team.Red && e.slot === TowerSlot.LeftGuard,
    );
    assert.ok(redGuard);
    sim.killEntity(redGuard, null);
    sim.step(1 / 30);

    assert.equal(sim.phase, MatchPhase.Finished);
    assert.equal(sim.result?.winner, Team.Blue);
    assert.equal(sim.result?.reason, 'sudden-death');
  });

  it('awards the win on tower count at time-up', () => {
    const sim = makeSim({ matchSeconds: 2 });
    const redGuard = [...sim.entities.values()].find(
      (e) => e.team === Team.Red && e.slot === TowerSlot.LeftGuard,
    );
    assert.ok(redGuard);
    sim.killEntity(redGuard, null);

    advance(sim, 3);
    assert.equal(sim.phase, MatchPhase.Finished);
    assert.equal(sim.result?.winner, Team.Blue);
    assert.equal(sim.result?.reason, 'tower-count');
  });

  it('ends on forfeit', () => {
    const sim = makeSim();
    sim.forfeit('p1');
    assert.equal(sim.phase, MatchPhase.Finished);
    assert.equal(sim.result?.winner, Team.Red);
    assert.equal(sim.result?.reason, 'forfeit');
  });
});

describe('robustness', () => {
  it('survives a long match with heavy random play without throwing', () => {
    const sim = makeSim();
    const playable = ['p1', 'p2'];
    for (let i = 0; i < 30 * 200; i++) {
      sim.step(1 / 30);
      if (sim.phase === MatchPhase.Finished) break;
      // Every half second, both sides try to dump a random card.
      if (i % 15 === 0) {
        for (const id of playable) {
          const player = sim.players.get(id);
          if (!player) continue;
          const index = Math.floor(sim.rng.next() * HAND_SIZE);
          const y = player.team === Team.Blue ? 120 : 60;
          sim.playCard(id, index, sim.rng.range(5, ARENA_WIDTH - 5), y);
        }
      }
    }
    // The match must have resolved one way or another.
    assert.equal(sim.phase, MatchPhase.Finished);
    assert.ok(sim.result);
  });

  it('never leaves a unit stranded in the river off-bridge', () => {
    const sim = makeSim();
    const card = getCard('bastion-shell');
    assert.ok(card);
    // Spawn a ground unit and let it path across; it must use a bridge.
    sim.spawnUnits(card, Team.Blue, 'p1', 50, 100, { instant: true });
    advance(sim, 25);

    for (const e of sim.entities.values()) {
      if (e.kind !== EntityKind.Unit) continue;
      if (e.layer !== 'ground') continue;
      const inRiver = Math.abs(e.y - ARENA_HEIGHT / 2) <= 5;
      if (inRiver) {
        const onBridge = Math.abs(e.x - 24) <= 7 || Math.abs(e.x - 76) <= 7;
        assert.ok(onBridge, `ground unit at (${e.x}, ${e.y}) is in the river off-bridge`);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const run = (): string => {
      const sim = makeSim({ seed: 999 });
      for (let i = 0; i < 30 * 40; i++) {
        sim.step(1 / 30);
        if (i % 20 === 0) {
          sim.playCard('p1', i % HAND_SIZE, 40, 140);
          sim.playCard('p2', i % HAND_SIZE, 60, 40);
        }
      }
      // Fingerprint the resulting world.
      return [...sim.entities.values()]
        .map((e) => `${e.card.id}:${e.x.toFixed(2)}:${e.y.toFixed(2)}:${e.health.toFixed(1)}`)
        .sort()
        .join('|');
    };
    assert.equal(run(), run(), 'same seed and inputs must produce the same world');
  });

  it('produces a snapshot that is JSON-serialisable', () => {
    const sim = makeSim();
    advance(sim, 5);
    sim.playCard('p1', 0, 40, 140);
    advance(sim, 2);
    const snap = sim.snapshot();
    const round = JSON.parse(JSON.stringify(snap));
    assert.equal(round.matchId, snap.matchId);
    assert.equal(round.players.length, 2);
    assert.ok(Array.isArray(round.entities));
  });

  it('drains fx events on each snapshot', () => {
    const sim = makeSim();
    sim.playCard('p1', 0, 40, 140);
    const first = sim.snapshot();
    const second = sim.snapshot();
    assert.ok(first.fx.length > 0, 'playing a card should emit fx');
    assert.equal(second.fx.length, 0, 'fx must not be re-sent');
  });
});
