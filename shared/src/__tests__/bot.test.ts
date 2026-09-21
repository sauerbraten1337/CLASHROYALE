/**
 * Bot tests.
 *
 * The headline property is that the bot is *competent but fair*: it plays by
 * the same rules, it actually spends its energy, it answers threats, and a
 * harder difficulty genuinely beats an easier one over a run of matches.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  BOT_DECKS,
  BotDifficulty,
  BotStrategy,
  ENERGY_MAX,
  MatchPhase,
  STARTER_DECK,
  Simulation,
  Team,
  TICK_SECONDS,
} from '../index.js';
import { Bot } from '../ai/bot.js';
import { BotMatch, BOT_PLAYER_ID } from '../ai/BotMatch.js';
import { EntityKind } from '../types.js';

const DECK_NAMES = Object.keys(BOT_DECKS);

/**
 * Runs a bot-vs-bot match to completion and reports the winner.
 *
 * Deliberately mirrors real match conditions rather than a narrow fixture:
 * full-length matches and a deck that varies with the seed. A single deck at
 * half length measures one narrow matchup, not general skill, and the two
 * bots get well-separated RNG seeds so their streams are not correlated.
 */
function runBotDuel(
  blueDifficulty: BotDifficulty,
  redDifficulty: BotDifficulty,
  seed: number,
  matchSeconds = 180,
): Team | null {
  const deck = BOT_DECKS[DECK_NAMES[seed % DECK_NAMES.length] as string] as string[];
  const sim = new Simulation({
    matchId: `duel-${seed}`,
    seed,
    skipCountdown: true,
    matchSeconds,
    players: [
      { id: 'blue', name: 'Blue', team: Team.Blue, deck },
      { id: 'red', name: 'Red', team: Team.Red, deck },
    ],
  });

  const blue = new Bot({
    playerId: 'blue',
    team: Team.Blue,
    difficulty: blueDifficulty,
    strategy: BotStrategy.Aggressive,
    seed: seed * 3 + 1,
  });
  const red = new Bot({
    playerId: 'red',
    team: Team.Red,
    difficulty: redDifficulty,
    strategy: BotStrategy.Aggressive,
    seed: seed * 5 + 2,
  });

  // Hard cap the loop so a stalled match can never hang the suite.
  for (let i = 0; i < 30 * (matchSeconds + 90); i++) {
    sim.step(TICK_SECONDS);
    blue.update(sim, TICK_SECONDS);
    red.update(sim, TICK_SECONDS);
    if (sim.phase === MatchPhase.Finished) break;
  }
  return sim.result?.winner ?? null;
}

describe('bot fairness', () => {
  it('never exceeds the normal energy cap', () => {
    const match = new BotMatch({
      playerName: 'Tester',
      playerDeck: [...STARTER_DECK],
      difficulty: BotDifficulty.Hard,
      seed: 7,
      skipCountdown: true,
    });

    for (let i = 0; i < 30 * 90; i++) {
      match.advance(TICK_SECONDS);
      const bot = match.sim.players.get(BOT_PLAYER_ID);
      assert.ok(bot);
      assert.ok(
        bot.energy <= ENERGY_MAX + 0.001,
        `bot energy ${bot.energy} exceeded the cap`,
      );
      assert.ok(bot.energy >= -0.001, 'bot energy went negative');
      if (match.finished) break;
    }
  });

  it('plays only cards that were actually in its hand', () => {
    const sim = new Simulation({
      matchId: 'hand-check',
      seed: 21,
      skipCountdown: true,
      players: [
        { id: 'blue', name: 'Blue', team: Team.Blue, deck: [...STARTER_DECK] },
        { id: 'red', name: 'Red', team: Team.Red, deck: BOT_DECKS.swarm as string[] },
      ],
    });
    const bot = new Bot({
      playerId: 'red',
      team: Team.Red,
      difficulty: BotDifficulty.Hard,
      strategy: BotStrategy.Aggressive,
      seed: 3,
    });
    const legalCards = new Set(BOT_DECKS.swarm as string[]);

    for (let i = 0; i < 30 * 60; i++) {
      sim.step(TICK_SECONDS);
      bot.update(sim, TICK_SECONDS);
      // Anything the bot has put on the board must come from its own deck
      // (or be a token spawned by one of those cards).
      for (const e of sim.entities.values()) {
        if (e.team !== Team.Red) continue;
        if (e.kind === EntityKind.Tower) continue;
        if (e.card.collectible === false) continue;
        assert.ok(
          legalCards.has(e.card.id),
          `bot fielded ${e.card.id}, which is not in its deck`,
        );
      }
      if (sim.phase === MatchPhase.Finished) break;
    }
  });

  it('deploys only on its own half', () => {
    const sim = new Simulation({
      matchId: 'deploy-check',
      seed: 33,
      skipCountdown: true,
      players: [
        { id: 'blue', name: 'Blue', team: Team.Blue, deck: [...STARTER_DECK] },
        { id: 'red', name: 'Red', team: Team.Red, deck: BOT_DECKS.beatdown as string[] },
      ],
    });
    const bot = new Bot({
      playerId: 'red',
      team: Team.Red,
      difficulty: BotDifficulty.Hard,
      strategy: BotStrategy.Aggressive,
      seed: 4,
    });

    const seen = new Set<number>();
    for (let i = 0; i < 30 * 45; i++) {
      sim.step(TICK_SECONDS);
      bot.update(sim, TICK_SECONDS);
      for (const e of sim.entities.values()) {
        if (e.team !== Team.Red || e.kind === EntityKind.Tower) continue;
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        // Red defends the low-y end, so a fresh deploy must start there.
        // Only check units still in their deploy delay, before they walk.
        if (e.deployTimer > 0.5) {
          assert.ok(e.y < 90 + 6, `red deployed at y=${e.y}, which is the enemy half`);
        }
      }
      if (sim.phase === MatchPhase.Finished) break;
    }
  });
});

describe('bot competence', () => {
  it('actually spends its energy rather than sitting on it', () => {
    const match = new BotMatch({
      playerName: 'Tester',
      playerDeck: [...STARTER_DECK],
      difficulty: BotDifficulty.Normal,
      seed: 11,
      skipCountdown: true,
    });

    // Count the bot's plays directly rather than inferring them from its
    // card cycle, which cannot distinguish a replay of the same card.
    let cardsPlayed = 0;
    const realPlayCard = match.sim.playCard.bind(match.sim);
    match.sim.playCard = (playerId, handIndex, x, y) => {
      const outcome = realPlayCard(playerId, handIndex, x, y);
      if (outcome.ok && playerId === BOT_PLAYER_ID) cardsPlayed++;
      return outcome;
    };

    for (let i = 0; i < 30 * 90; i++) {
      match.advance(TICK_SECONDS);
      const bot = match.sim.players.get(BOT_PLAYER_ID);
      assert.ok(bot);
      if (match.finished) break;
    }
    // At one energy per 2.6s a bot that uses its income well gets well into
    // double figures over 90 seconds; anything under 10 means it is idling.
    assert.ok(cardsPlayed >= 10, `bot only played ${cardsPlayed} cards in 90s`);
  });

  it('responds to a threat on its half', () => {
    const match = new BotMatch({
      playerName: 'Tester',
      playerDeck: [...STARTER_DECK],
      difficulty: BotDifficulty.Hard,
      seed: 5,
      skipCountdown: true,
    });

    // Drop a heavy attacker right on the bot's doorstep.
    const tank = match.sim.cardLookup('bastion-shell');
    assert.ok(tank);
    match.sim.spawnUnits(tank, Team.Blue, 'local-player', 24, 60, { instant: true });

    // Give it time to notice and answer.
    for (let i = 0; i < 30 * 12; i++) match.advance(TICK_SECONDS);

    const defenders = [...match.sim.entities.values()].filter(
      (e) => e.team === Team.Red && e.kind !== EntityKind.Tower,
    );
    assert.ok(defenders.length > 0, 'bot put nothing on the board against a tank');
  });

  it('finishes matches without throwing, across every difficulty and strategy', () => {
    const difficulties = [BotDifficulty.Easy, BotDifficulty.Normal, BotDifficulty.Hard];
    const strategies = [
      BotStrategy.Aggressive,
      BotStrategy.Defensive,
      BotStrategy.Control,
      BotStrategy.Randomized,
    ];

    for (const difficulty of difficulties) {
      for (const strategy of strategies) {
        const match = new BotMatch({
          playerName: 'Tester',
          playerDeck: [...STARTER_DECK],
          difficulty,
          strategy,
          seed: 100 + difficulties.indexOf(difficulty) * 10 + strategies.indexOf(strategy),
          matchSeconds: 60,
          skipCountdown: true,
        });
        for (let i = 0; i < 30 * 200; i++) {
          match.advance(TICK_SECONDS);
          if (match.finished) break;
        }
        assert.ok(
          match.finished,
          `${difficulty}/${strategy} did not resolve`,
        );
      }
    }
  });
});

describe('bot difficulty scaling', () => {
  /**
   * Plays a difficulty against another over many seeds, alternating sides so
   * any positional advantage cancels out. Everything is seeded, so this is
   * reproducible rather than flaky - it either passes or fails consistently.
   */
  function ladderScore(
    stronger: BotDifficulty,
    weaker: BotDifficulty,
    seeds = 24,
  ): { strongWins: number; weakWins: number; draws: number } {
    let strongWins = 0;
    let weakWins = 0;
    let draws = 0;

    for (let seed = 1; seed <= seeds; seed++) {
      const asBlue = runBotDuel(stronger, weaker, seed);
      if (asBlue === Team.Blue) strongWins++;
      else if (asBlue === Team.Red) weakWins++;
      else draws++;

      const asRed = runBotDuel(weaker, stronger, seed);
      if (asRed === Team.Red) strongWins++;
      else if (asRed === Team.Blue) weakWins++;
      else draws++;
    }
    return { strongWins, weakWins, draws };
  }

  it('has Hard beat Easy', () => {
    const r = ladderScore(BotDifficulty.Hard, BotDifficulty.Easy);
    assert.ok(
      r.strongWins > r.weakWins,
      `Hard should beat Easy, got hard=${r.strongWins} easy=${r.weakWins} draws=${r.draws}`,
    );
  });

  it('has Hard beat Normal', () => {
    // The narrowest rung on the ladder (~61% of decisive games), and the one
    // with the most draws, so it needs a bigger sample to separate cleanly.
    const r = ladderScore(BotDifficulty.Hard, BotDifficulty.Normal, 60);
    assert.ok(
      r.strongWins > r.weakWins,
      `Hard should beat Normal, got hard=${r.strongWins} normal=${r.weakWins} draws=${r.draws}`,
    );
  });

  it('has Normal beat Easy', () => {
    const r = ladderScore(BotDifficulty.Normal, BotDifficulty.Easy);
    assert.ok(
      r.strongWins > r.weakWins,
      `Normal should beat Easy, got normal=${r.strongWins} easy=${r.weakWins} draws=${r.draws}`,
    );
  });
});
