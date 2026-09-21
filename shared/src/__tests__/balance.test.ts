/**
 * Balance tests.
 *
 * These pin down the handful of relationships the whole game's pacing rests
 * on. They are deliberately about *relationships* (a tower beats one cheap
 * card, a counter beats what it is meant to counter) rather than exact
 * numbers, so the set can be tuned without rewriting the suite.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  COLLECTIBLE_CARDS,
  MatchPhase,
  Simulation,
  TICK_SECONDS,
  Team,
  TowerSlot,
  STARTER_DECK,
  getCard,
  towerLayout,
} from '../index.js';
import { CardType, EntityKind, StatusKind, type CardDef } from '../types.js';

function arena(): Simulation {
  return new Simulation({
    matchId: 'balance',
    seed: 42,
    skipCountdown: true,
    players: [
      { id: 'blue', name: 'Blue', team: Team.Blue, deck: [...STARTER_DECK] },
      { id: 'red', name: 'Red', team: Team.Red, deck: [...STARTER_DECK] },
    ],
  });
}

function advance(sim: Simulation, seconds: number): void {
  const steps = Math.round(seconds / TICK_SECONDS);
  for (let i = 0; i < steps; i++) sim.step(TICK_SECONDS);
}

/** Drops a card in front of Red's left guard tower and reports the outcome. */
function siegeGuardTower(
  cardId: string,
  copies = 1,
): { towerSurvived: boolean; towerHealthPct: number; attackersLeft: number; seconds: number } {
  const sim = arena();
  const card = getCard(cardId);
  assert.ok(card, `missing card ${cardId}`);

  const tower = [...sim.entities.values()].find(
    (e) => e.team === Team.Red && e.slot === TowerSlot.LeftGuard,
  );
  assert.ok(tower);

  for (let i = 0; i < copies; i++) {
    sim.spawnUnits(card, Team.Blue, 'blue', tower.x + (i - copies / 2) * 3, tower.y + 14, {
      instant: true,
    });
  }

  let seconds = 0;
  // Run until the fight resolves one way or the other.
  for (let i = 0; i < 30 * 45; i++) {
    sim.step(TICK_SECONDS);
    seconds += TICK_SECONDS;
    const attackers = [...sim.entities.values()].filter(
      (e) => e.team === Team.Blue && e.kind === EntityKind.Unit,
    );
    if (!tower.isAlive || attackers.length === 0) break;
  }

  const attackersLeft = [...sim.entities.values()].filter(
    (e) => e.team === Team.Blue && e.kind === EntityKind.Unit,
  ).length;

  return {
    towerSurvived: tower.isAlive,
    towerHealthPct: tower.isAlive ? tower.health / tower.maxHealth : 0,
    attackersLeft,
    seconds,
  };
}

describe('tower anchoring', () => {
  it('lets a guard tower survive the cheapest swarm in the set, but barely', () => {
    const result = siegeGuardTower('shard-hound');
    assert.ok(
      result.towerSurvived,
      'a single 2-energy swarm card should not be able to take a guard tower alone',
    );
    assert.equal(result.attackersLeft, 0, 'the tower should have killed the swarm');
    // "Barely" is the point: if the tower walks away near full, cheap pressure
    // is meaningless and the whole game slows to a crawl.
    assert.ok(
      result.towerHealthPct < 0.55,
      `tower should be badly hurt, ended at ${(result.towerHealthPct * 100).toFixed(0)}%`,
    );
  });

  it('falls to a committed multi-card push', () => {
    const result = siegeGuardTower('shard-hound', 3);
    assert.equal(
      result.towerSurvived,
      false,
      'three swarm cards (6 energy) should take a guard tower',
    );
  });

  it('lets a lone cheap unit lose decisively to a tower', () => {
    const result = siegeGuardTower('spark-drone');
    assert.ok(result.towerSurvived);
    assert.ok(
      result.towerHealthPct > 0.75,
      'one 2-energy ranged unit should barely scratch a tower',
    );
  });

  it('gives the core more staying power than a guard tower', () => {
    const guard = towerLayout(Team.Blue).find((t) => t.slot === TowerSlot.LeftGuard);
    const core = towerLayout(Team.Blue).find((t) => t.slot === TowerSlot.Core);
    assert.ok(guard && core);
    assert.ok(core.health > guard.health, 'the core must outlast a guard tower');
    assert.ok(core.range >= guard.range);
  });
});

describe('counterplay', () => {
  /** Fights two cards head-on in open ground and reports the survivor. */
  function duel(aId: string, bId: string, aCopies = 1, bCopies = 1): 'a' | 'b' | 'draw' {
    const sim = arena();
    const a = getCard(aId);
    const b = getCard(bId);
    assert.ok(a && b);

    sim.spawnUnits(a, Team.Blue, 'blue', 50, 95, { count: (a.spawnAmount ?? 1) * aCopies, instant: true });
    sim.spawnUnits(b, Team.Red, 'red', 50, 85, { count: (b.spawnAmount ?? 1) * bCopies, instant: true });

    for (let i = 0; i < 30 * 30; i++) {
      sim.step(TICK_SECONDS);
      const aliveA = [...sim.entities.values()].some(
        (e) => e.team === Team.Blue && e.kind === EntityKind.Unit,
      );
      const aliveB = [...sim.entities.values()].some(
        (e) => e.team === Team.Red && e.kind === EntityKind.Unit,
      );
      if (!aliveA || !aliveB) {
        if (aliveA) return 'a';
        if (aliveB) return 'b';
        return 'draw';
      }
    }
    return 'draw';
  }

  it('has area damage beat a swarm', () => {
    // Geode Titan splashes; three hounds should not beat it.
    const winner = duel('geode-titan', 'shard-hound');
    assert.equal(winner, 'a', 'a splash tank should beat a single cheap swarm');
  });

  it('has a swarm beat a single-target heavy for less energy', () => {
    // Siege Crawler ignores units entirely, so a swarm eats it alive.
    const winner = duel('shard-hound', 'siege-crawler');
    assert.equal(winner, 'a', 'a 2-energy swarm should punish a 5-energy siege unit');
  });

  it('keeps ground-only units unable to touch air', () => {
    const sim = arena();
    const ground = getCard('bastion-shell');
    const air = getCard('spark-drone');
    assert.ok(ground && air);

    const groundUnit = sim.spawnUnits(ground, Team.Blue, 'blue', 50, 95, { instant: true })[0];
    const airUnit = sim.spawnUnits(air, Team.Red, 'red', 50, 92, { instant: true })[0];
    assert.ok(groundUnit && airUnit);

    advance(sim, 20);

    // This is about targeting legality, not a damage race: the drone must be
    // completely untouched while the ground unit steadily bleeds.
    assert.equal(
      airUnit.health,
      airUnit.maxHealth,
      'a ground-only attacker must not be able to damage an air unit at all',
    );
    assert.ok(
      groundUnit.health < groundUnit.maxHealth,
      'the air unit should be freely damaging the ground unit',
    );
  });
});

describe('card cost curve', () => {
  it('keeps every collectible card inside the legal cost range', () => {
    for (const card of COLLECTIBLE_CARDS) {
      assert.ok(card.cost >= 1 && card.cost <= 9, `${card.id} costs ${card.cost}`);
    }
  });

  it('scales raw statline value with cost', () => {
    // Compare the cheapest third of units against the most expensive third.
    const units = COLLECTIBLE_CARDS.filter((c) => c.type === CardType.Unit).sort(
      (a, b) => a.cost - b.cost,
    );
    const third = Math.floor(units.length / 3);
    const cheap = units.slice(0, third);
    const pricey = units.slice(-third);

    const value = (c: CardDef): number => {
      const bodies = c.spawnAmount ?? 1;
      const dps = (c.damage ?? 0) * (c.attackSpeed ?? 0);
      return ((c.health ?? 0) + dps * 4) * bodies;
    };
    const mean = (list: CardDef[]): number =>
      list.reduce((sum, c) => sum + value(c), 0) / Math.max(1, list.length);

    assert.ok(
      mean(pricey) > mean(cheap),
      'expensive cards must carry more raw value than cheap ones',
    );
  });

  it('gives no card both top-tier durability and top-tier speed', () => {
    for (const card of COLLECTIBLE_CARDS) {
      if ((card.health ?? 0) >= 2000 && (card.movementSpeed ?? 0) >= 10) {
        assert.fail(`${card.id} is both a heavy tank and very fast`);
      }
    }
  });

  it('makes spells cost-effective against units but not against towers', () => {
    for (const card of COLLECTIBLE_CARDS) {
      if (card.type !== CardType.Spell || !card.spell) continue;
      const factor = card.spell.buildingDamageFactor ?? 0;
      if ((card.spell.damage ?? 0) > 0) {
        assert.ok(
          factor > 0 && factor <= 0.5,
          `${card.id} must be weak against structures (factor ${factor})`,
        );
      }
    }
  });
});

describe('status effects in play', () => {
  /**
   * The data test in simulation.test.ts proves every status is *declared* on
   * some card. This proves the engine actually applies them, which is a
   * different claim: a status can be attached to a card and still never
   * reach an entity if the ability path that carries it is not wired up.
   */
  function statusesSeen(run: (sim: Simulation) => void, seconds: number): Set<StatusKind> {
    const sim = arena();
    run(sim);
    const seen = new Set<StatusKind>();
    const steps = Math.round(seconds / TICK_SECONDS);
    for (let i = 0; i < steps; i++) {
      sim.step(TICK_SECONDS);
      for (const entity of sim.entities.values()) {
        for (const status of entity.statuses) seen.add(status.kind);
      }
    }
    return seen;
  }

  it('applies burning from chained plasma', () => {
    const seen = statusesSeen((sim) => {
      const bloom = getCard('plasma-bloom');
      const hound = getCard('shard-hound');
      assert.ok(bloom && hound);
      sim.spawnUnits(bloom, Team.Blue, 'blue', 50, 100, { instant: true });
      sim.spawnUnits(hound, Team.Red, 'red', 50, 88, { instant: true });
    }, 20);
    assert.ok(seen.has(StatusKind.Burning), 'plasma should set its targets alight');
  });

  it('applies shocked from a thunder strike', () => {
    const seen = statusesSeen((sim) => {
      const seed = getCard('thunder-seed');
      const tank = getCard('bastion-shell');
      assert.ok(seed && tank);
      // Both in the left lane, so the target does not path out of the blast.
      const seeds = sim.spawnUnits(seed, Team.Blue, 'blue', 24, 100, { instant: true });
      sim.spawnUnits(tank, Team.Red, 'red', 24, 98, { instant: true });
      const body = seeds[0];
      assert.ok(body);
      sim.killEntity(body, null);
    }, 6);
    assert.ok(seen.has(StatusKind.Shocked), 'the death strike should leave survivors shocked');
  });

  it('applies frozen and slowed from Time Fracture', () => {
    const seen = statusesSeen((sim) => {
      const tank = getCard('bastion-shell');
      assert.ok(tank);
      sim.spawnUnits(tank, Team.Red, 'red', 50, 88, { instant: true });
      const player = sim.getPlayer(Team.Blue);
      assert.ok(player);
      player.energy = 10;
      player.hand[0] = 'time-fracture';
      sim.playCard('blue', 0, 50, 88);
    }, 3);
    assert.ok(seen.has(StatusKind.Frozen), 'Time Fracture should stop its targets dead');
    assert.ok(seen.has(StatusKind.Slowed), 'Time Fracture should then slow them');
  });

  it('applies silenced and marked from Void Pulse', () => {
    const seen = statusesSeen((sim) => {
      const tank = getCard('bastion-shell');
      assert.ok(tank);
      sim.spawnUnits(tank, Team.Red, 'red', 50, 88, { instant: true });
      const player = sim.getPlayer(Team.Blue);
      assert.ok(player);
      player.energy = 10;
      player.hand[0] = 'void-pulse';
      sim.playCard('blue', 0, 50, 88);
    }, 3);
    assert.ok(seen.has(StatusKind.Silenced), 'Void Pulse should silence');
    assert.ok(seen.has(StatusKind.Marked), 'Void Pulse should mark');
  });

  it('applies the carrier statuses: shield, haste, cloak and poison', () => {
    const seen = statusesSeen((sim) => {
      for (const [id, x] of [
        ['void-architect', 40],
        ['aegis-drummer', 42],
        ['null-stalker', 44],
        ['venom-spore', 46],
      ] as Array<[string, number]>) {
        const card = getCard(id);
        assert.ok(card, id);
        sim.spawnUnits(card, Team.Blue, 'blue', x, 105, { instant: true });
      }
      const tank = getCard('bastion-shell');
      assert.ok(tank);
      sim.spawnUnits(tank, Team.Red, 'red', 46, 96, { instant: true });
    }, 20);
    assert.ok(seen.has(StatusKind.Shielded), 'the architect should shield');
    assert.ok(seen.has(StatusKind.Hasted), 'the drummer should haste');
    assert.ok(seen.has(StatusKind.Invisible), 'the stalker should cloak');
    assert.ok(seen.has(StatusKind.Poisoned), 'the spore should poison');
  });
});

describe('match pacing', () => {
  it('does not resolve a two-sided match in seconds', () => {
    // Both sides defend competently, so the match should go the distance
    // rather than collapsing in the first push.
    const sim = arena();
    for (let i = 0; i < 30 * 200; i++) {
      sim.step(TICK_SECONDS);
      // Both players answer every push with a defensive body near their core.
      if (i % 90 === 0) {
        const hound = getCard('shard-hound');
        if (hound) {
          sim.spawnUnits(hound, Team.Blue, 'blue', 24, 130, { instant: true });
          sim.spawnUnits(hound, Team.Red, 'red', 24, 50, { instant: true });
        }
      }
      if (sim.phase === MatchPhase.Finished) break;
    }
    assert.ok(
      sim.time > 30,
      `an evenly contested match ended after only ${sim.time.toFixed(1)}s`,
    );
  });
});
