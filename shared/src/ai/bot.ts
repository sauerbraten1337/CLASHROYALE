/**
 * The bot opponent.
 *
 * The bot is not privileged. It holds no extra energy, sees no hidden state,
 * and plays its cards through exactly the same `Simulation.playCard` entry
 * point a human client uses - so every validation that applies to a player
 * applies to it. Its only inputs are what a player could see on screen: the
 * entities on the board, its own hand, and its own energy.
 *
 * Decision making is a scored candidate search: it enumerates
 * (card, position) options, scores each against the current board, and plays
 * the best one if it clears a threshold that depends on difficulty.
 */

import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  ENERGY_MAX,
  LANE_LEFT_X,
  LANE_RIGHT_X,
  RIVER_Y,
  forwardSign,
  isOwnHalf,
} from '../constants.js';
import {
  BotDifficulty,
  BotStrategy,
  CardRole,
  CardType,
  EntityKind,
  Layer,
  MatchPhase,
  StatusKind,
  TargetClass,
  TowerSlot,
  Team,
  opposingTeam,
  type CardDef,
  type PlayerId,
} from '../types.js';
import type { SimEntity } from '../sim/entity.js';
import type { Simulation } from '../sim/Simulation.js';
import { Rng } from '../sim/rng.js';
import { distance } from '../sim/geometry.js';

/** Per-difficulty behaviour knobs. */
interface DifficultyProfile {
  /** Seconds between decisions. Slower bots miss windows. */
  thinkInterval: number;
  /** Minimum score a play must reach before the bot commits to it. */
  playThreshold: number;
  /** Chance per decision of deliberately picking a worse option. */
  mistakeChance: number;
  /** How much energy the bot tries to keep in reserve for defence. */
  reserveEnergy: number;
  /** Scales how strongly the bot reacts to incoming threats. */
  defenseWeight: number;
  /** Placement scatter in arena units. Sloppier bots place less precisely. */
  placementNoise: number;
  /**
   * Minimum energy before the bot will *open* a push.
   *
   * This is what converts fast reactions into actual skill. Without it a
   * quick-thinking bot spends every point the instant it arrives, dribbling
   * out one cheap card at a time and never assembling a threat. Defensive
   * plays ignore this floor entirely - answering a push is always allowed.
   */
  pushEnergyFloor: number;
  /**
   * Probability that the bot simply fails to notice the incoming push on a
   * given decision and plays as though the board were clear.
   *
   * This is the single most human way to be bad at this genre: not misplaying
   * the counter, but not answering at all. It is also the cleanest skill dial,
   * because unlike the timing knobs its effect is strictly monotonic.
   */
  threatBlindness: number;
}

const PROFILES: Record<BotDifficulty, DifficultyProfile> = {
  // Note: the threshold is deliberately NOT what separates the difficulties.
  // Raising it makes a bot passive, and a passive bot simply loses to one that
  // spends its energy. Skill comes from reacting faster, countering correctly,
  // placing precisely and blundering less.
  // These were tuned by running bot-vs-bot ablations on each knob. Only two
  // of them meaningfully encode skill: how often the bot blunders, and how
  // quickly it reacts. Holding energy back and raising the play threshold
  // both measurably *lose* games, so the harder profiles do neither.
  [BotDifficulty.Easy]: {
    thinkInterval: 2.2,
    playThreshold: 14,
    mistakeChance: 0.58,
    reserveEnergy: 0,
    defenseWeight: 0.5,
    placementNoise: 9,
    pushEnergyFloor: 0,
    threatBlindness: 0.45,
  },
  [BotDifficulty.Normal]: {
    thinkInterval: 1.05,
    playThreshold: 15,
    mistakeChance: 0.3,
    reserveEnergy: 1,
    defenseWeight: 1,
    placementNoise: 4.5,
    pushEnergyFloor: 7,
    threatBlindness: 0.15,
  },
  [BotDifficulty.Hard]: {
    thinkInterval: 0.4,
    playThreshold: 14,
    mistakeChance: 0.02,
    reserveEnergy: 0.5,
    defenseWeight: 1.3,
    placementNoise: 1.5,
    pushEnergyFloor: 7,
    threatBlindness: 0,
  },
};

/** Per-strategy weighting of the score terms. */
interface StrategyProfile {
  /** Multiplier on the value of answering a threat. */
  defense: number;
  /** Multiplier on the value of starting or extending a push. */
  offense: number;
  /** How much the bot dislikes spending its last energy. */
  thrift: number;
  /** Preference for holding cards until a big energy bank is built. */
  patience: number;
}

const STRATEGIES: Record<BotStrategy, StrategyProfile> = {
  [BotStrategy.Aggressive]: { defense: 0.75, offense: 1.5, thrift: 0.6, patience: 0.4 },
  [BotStrategy.Defensive]: { defense: 1.5, offense: 0.7, thrift: 1.2, patience: 1.0 },
  [BotStrategy.Control]: { defense: 1.2, offense: 0.9, thrift: 1.4, patience: 1.3 },
  [BotStrategy.Randomized]: { defense: 1.0, offense: 1.0, thrift: 0.9, patience: 0.7 },
};

export interface BotConfig {
  playerId: PlayerId;
  team: Team;
  difficulty: BotDifficulty;
  strategy: BotStrategy;
  seed?: number;
}

/** A single (card, position) option under consideration. */
interface Candidate {
  handIndex: number;
  card: CardDef;
  x: number;
  y: number;
  score: number;
  /** Why it was chosen, surfaced in the debug overlay. */
  rationale: string;
}

/** A read of the current board, computed once per decision. */
interface BoardRead {
  /** Enemy bodies on our half, or about to cross - the things to answer. */
  threats: SimEntity[];
  /** Our own units still alive. */
  ownUnits: SimEntity[];
  /** Total threat value bearing down on us. */
  threatValue: number;
  /** Where that threat is concentrated. */
  threatX: number;
  threatY: number;
  /** The enemy tower we are closest to taking. */
  weakestEnemyTower: SimEntity | null;
  /** Our own most endangered tower. */
  endangeredTower: SimEntity | null;
  /** True when we already have a push running in the enemy half. */
  pushActive: boolean;
}

export class Bot {
  readonly playerId: PlayerId;
  readonly team: Team;
  readonly difficulty: BotDifficulty;
  readonly strategy: BotStrategy;

  private readonly profile: DifficultyProfile;
  private readonly weights: StrategyProfile;
  private readonly rng: Rng;

  /** Seconds until the next decision. */
  private thinkTimer = 0;
  /** The last decision made, for the debug overlay. */
  lastDecision: string = 'idle';

  constructor(config: BotConfig) {
    this.playerId = config.playerId;
    this.team = config.team;
    this.difficulty = config.difficulty;
    this.strategy = config.strategy;
    this.profile = PROFILES[config.difficulty];
    this.weights = STRATEGIES[config.strategy];
    this.rng = new Rng(config.seed ?? 0x5eed);
    // Stagger the first decision so the bot does not open on the same tick
    // every single match.
    this.thinkTimer = this.rng.range(0.2, this.profile.thinkInterval);
  }

  /**
   * Advances the bot's decision clock and plays at most one card per
   * decision. Call this once per simulation step, after `sim.step()`.
   */
  update(sim: Simulation, dt: number): void {
    if (sim.phase === MatchPhase.Countdown || sim.phase === MatchPhase.Finished) return;

    this.thinkTimer -= dt;
    if (this.thinkTimer > 0) return;
    this.thinkTimer = this.profile.thinkInterval;

    const player = sim.players.get(this.playerId);
    if (!player) return;

    let board = this.readBoard(sim);
    // A weaker bot sometimes just does not register the push at all.
    if (board.threats.length > 0 && this.rng.chance(this.profile.threatBlindness)) {
      board = { ...board, threats: [], threatValue: 0 };
      this.lastDecision = 'missed the push';
    }
    const candidates = this.enumerate(sim, board);
    if (candidates.length === 0) {
      this.lastDecision = 'no playable option';
      return;
    }

    candidates.sort((a, b) => b.score - a.score);

    // Deliberate imperfection: sometimes take a worse option. This is what
    // stops the bot feeling robotic, and it scales with difficulty.
    let chosen = candidates[0] as Candidate;
    if (candidates.length > 1 && this.rng.chance(this.profile.mistakeChance)) {
      // Pick uniformly from every worse option rather than the next-best few,
      // so a blunder is a genuinely poor play and not a near-miss.
      const alt = this.rng.int(1, candidates.length - 1);
      chosen = { ...(candidates[alt] as Candidate) };
      chosen.rationale = `${chosen.rationale} (misread)`;
    }

    if (chosen.score < this.profile.playThreshold) {
      this.lastDecision = `holding (best ${Math.round(chosen.score)} < ${this.profile.playThreshold})`;
      return;
    }

    const noise = this.profile.placementNoise;
    const x = chosen.x + this.rng.range(-noise, noise);
    const y = chosen.y + this.rng.range(-noise, noise);

    const outcome = sim.playCard(this.playerId, chosen.handIndex, x, y);
    if (outcome.ok) {
      this.lastDecision = `${chosen.card.name}: ${chosen.rationale}`;
    } else {
      // A rejected play is not an error - the board may have moved under us.
      // Try again on the next decision rather than forcing anything.
      this.lastDecision = `rejected (${outcome.code})`;
    }
  }

  // =========================================================================
  // Board reading
  // =========================================================================

  /** Builds the bot's picture of the board. Only public information is used. */
  private readBoard(sim: Simulation): BoardRead {
    const enemyTeam = opposingTeam(this.team);
    const threats: SimEntity[] = [];
    const ownUnits: SimEntity[] = [];
    let threatValue = 0;
    let weightedX = 0;
    let weightedY = 0;
    let pushActive = false;

    for (const entity of sim.entities.values()) {
      if (!entity.isAlive) continue;

      if (entity.team === this.team) {
        if (entity.kind === EntityKind.Unit) {
          ownUnits.push(entity);
          // A push is running if we have bodies in the enemy half.
          if (!isOwnHalf(this.team, entity.y)) pushActive = true;
        }
        continue;
      }
      if (entity.team !== enemyTeam) continue;
      if (entity.isStructure) continue;
      // Invisible units genuinely cannot be seen - the bot does not cheat.
      if (entity.hasStatus(StatusKind.Invisible)) continue;

      // A threat is an enemy body on our half or within reach of crossing.
      const onOurHalf = isOwnHalf(this.team, entity.y);
      const nearRiver = Math.abs(entity.y - RIVER_Y) < 18;
      if (!onOurHalf && !nearRiver) continue;

      const value = this.threatValue(entity);
      threats.push(entity);
      threatValue += value;
      weightedX += entity.x * value;
      weightedY += entity.y * value;
    }

    const threatX = threatValue > 0 ? weightedX / threatValue : ARENA_WIDTH / 2;
    const threatY = threatValue > 0 ? weightedY / threatValue : RIVER_Y;

    return {
      threats,
      ownUnits,
      threatValue,
      threatX,
      threatY,
      weakestEnemyTower: this.weakestTower(sim, enemyTeam),
      endangeredTower: this.mostEndangeredTower(sim, threatX, threatY),
      pushActive,
    };
  }

  /** How dangerous an enemy body is: damage output weighted by survivability. */
  private threatValue(entity: SimEntity): number {
    const dps = entity.damage * Math.max(0.2, entity.attackSpeed);
    const effectiveHealth = entity.health + (entity.armor * 8);
    // Normalised so a typical mid-cost unit scores around 10.
    return (dps / 60) * Math.sqrt(effectiveHealth / 400) * 10;
  }

  private weakestTower(sim: Simulation, team: Team): SimEntity | null {
    let best: SimEntity | null = null;
    for (const e of sim.teamEntities(team)) {
      if (e.kind !== EntityKind.Tower) continue;
      // Ignore the core while guards still stand - it cannot be reached anyway.
      if (e.slot === TowerSlot.Core && sim.towersRemaining(team) > 1) continue;
      if (best === null || e.health / e.maxHealth < best.health / best.maxHealth) best = e;
    }
    return best;
  }

  private mostEndangeredTower(sim: Simulation, threatX: number, threatY: number): SimEntity | null {
    let best: SimEntity | null = null;
    let bestDist = Infinity;
    for (const e of sim.teamEntities(this.team)) {
      if (e.kind !== EntityKind.Tower) continue;
      const d = distance(e.x, e.y, threatX, threatY);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  // =========================================================================
  // Candidate generation and scoring
  // =========================================================================

  /** Enumerates and scores every affordable play available this decision. */
  private enumerate(sim: Simulation, board: BoardRead): Candidate[] {
    const player = sim.players.get(this.playerId);
    if (!player) return [];

    const candidates: Candidate[] = [];
    const energy = player.energy;

    for (let handIndex = 0; handIndex < player.hand.length; handIndex++) {
      const cardId = player.hand[handIndex];
      if (!cardId) continue;
      const card = sim.cardLookup(cardId);
      if (!card) continue;
      if (card.cost > energy) continue;

      for (const spot of this.placementsFor(sim, card, board)) {
        const score = this.scorePlay(sim, card, spot, board, energy);
        if (score <= 0) continue;
        candidates.push({
          handIndex,
          card,
          x: spot.x,
          y: spot.y,
          score,
          rationale: spot.rationale,
        });
      }
    }
    return candidates;
  }

  /** The positions worth considering for a given card. */
  private placementsFor(
    sim: Simulation,
    card: CardDef,
    board: BoardRead,
  ): Array<{ x: number; y: number; intent: 'defend' | 'attack' | 'support'; rationale: string }> {
    const sign = forwardSign(this.team);
    const spots: Array<{
      x: number;
      y: number;
      intent: 'defend' | 'attack' | 'support';
      rationale: string;
    }> = [];

    if (card.type === CardType.Spell) {
      return this.spellPlacements(sim, card, board);
    }

    // --- Defensive placements: intercept the incoming push -----------------
    if (board.threats.length > 0) {
      // Drop in front of the threat, between it and the tower it is heading for.
      const interceptY = board.threatY + sign * -6;
      const clampedY = this.clampToOwnHalf(interceptY);
      spots.push({
        x: board.threatX,
        y: clampedY,
        intent: 'defend',
        rationale: `intercept ${board.threats.length} attacker(s)`,
      });

      // Buildings pull attackers off-lane, so place them toward the middle.
      if (card.type === CardType.Building) {
        spots.push({
          x: (board.threatX + ARENA_WIDTH / 2) / 2,
          y: this.clampToOwnHalf(RIVER_Y + sign * -22),
          intent: 'defend',
          rationale: 'building pulls the push off-lane',
        });
      }
    }

    // --- Offensive placements: start or extend a push ----------------------
    const targetTower = board.weakestEnemyTower;
    const pushLane = targetTower ? targetTower.x : this.rng.pick([LANE_LEFT_X, LANE_RIGHT_X]) ?? LANE_LEFT_X;

    // Behind our own line, so the unit arrives with energy banked behind it.
    spots.push({
      x: pushLane,
      y: this.clampToOwnHalf(RIVER_Y + sign * -14),
      intent: 'attack',
      rationale: 'open a push at the bridge',
    });

    // Tanks lead from further back so support can form up behind them.
    if (card.roles.includes(CardRole.Tank)) {
      spots.push({
        x: pushLane,
        y: this.clampToOwnHalf(RIVER_Y + sign * -30),
        intent: 'attack',
        rationale: 'tank leads from the back',
      });
    }

    // Support and ranged units tuck in behind an existing push.
    if (board.pushActive && (card.range ?? 0) > 6) {
      const lead = this.leadUnit(board);
      if (lead) {
        spots.push({
          x: lead.x,
          y: this.clampToOwnHalf(lead.y + sign * -10),
          intent: 'support',
          rationale: 'reinforce the push from behind',
        });
      }
    }

    return spots;
  }

  /** Spells are aimed at clusters, not positions. */
  private spellPlacements(
    sim: Simulation,
    card: CardDef,
    board: BoardRead,
  ): Array<{ x: number; y: number; intent: 'defend' | 'attack' | 'support'; rationale: string }> {
    const spec = card.spell;
    if (!spec) return [];

    // A self-targeted utility spell (Energy Surge) just needs somewhere legal.
    if (spec.energyBoost && !spec.damage) {
      return [
        {
          x: ARENA_WIDTH / 2,
          y: this.clampToOwnHalf(RIVER_Y + forwardSign(this.team) * -20),
          intent: 'support',
          rationale: 'bank an energy advantage',
        },
      ];
    }

    const enemyTeam = opposingTeam(this.team);
    const radius = spec.radius || 8;

    // Find the densest cluster of enemy bodies worth hitting.
    let best: { x: number; y: number; value: number } | null = null;
    for (const entity of sim.teamEntities(enemyTeam)) {
      if (entity.isStructure) continue;
      const group = sim.entitiesInRadius(entity.x, entity.y, radius, enemyTeam);
      let value = 0;
      for (const member of group) {
        if (member.isStructure) continue;
        // A spell is worth most against things it can actually kill.
        const lethal = (spec.damage ?? 0) >= member.health;
        value += this.threatValue(member) * (lethal ? 1.8 : 1);
      }
      if (best === null || value > best.value) best = { x: entity.x, y: entity.y, value };
    }

    if (best === null) return [];
    if (spec.heal) {
      // Healing spells target our own densest group instead.
      return this.healPlacements(sim, radius);
    }

    return [
      {
        x: best.x,
        y: best.y,
        intent: isOwnHalf(this.team, best.y) ? 'defend' : 'attack',
        rationale: 'catch the biggest cluster',
      },
    ];
  }

  private healPlacements(
    sim: Simulation,
    radius: number,
  ): Array<{ x: number; y: number; intent: 'defend' | 'attack' | 'support'; rationale: string }> {
    let best: { x: number; y: number; value: number } | null = null;
    for (const entity of sim.teamEntities(this.team)) {
      if (entity.isStructure) continue;
      if (entity.health >= entity.maxHealth) continue;
      const group = sim.entitiesInRadius(entity.x, entity.y, radius, this.team);
      let value = 0;
      for (const member of group) {
        if (member.isStructure) continue;
        value += (member.maxHealth - member.health) / 100;
      }
      if (best === null || value > best.value) best = { x: entity.x, y: entity.y, value };
    }
    if (best === null || best.value < 2) return [];
    return [{ x: best.x, y: best.y, intent: 'support', rationale: 'mend the push' }];
  }

  /** Our unit furthest into enemy territory. */
  private leadUnit(board: BoardRead): SimEntity | null {
    const sign = forwardSign(this.team);
    let best: SimEntity | null = null;
    for (const unit of board.ownUnits) {
      if (best === null || sign * (unit.y - best.y) < 0) best = unit;
    }
    return best;
  }

  /** Keeps a deploy point on our own half, clear of the river bank. */
  private clampToOwnHalf(y: number): number {
    const margin = 4;
    if (this.team === Team.Blue) {
      return Math.min(ARENA_HEIGHT - margin, Math.max(RIVER_Y + margin + 2, y));
    }
    return Math.max(margin, Math.min(RIVER_Y - margin - 2, y));
  }

  /**
   * Scores a candidate play. Higher is better; anything at or below zero is
   * discarded. The terms are deliberately readable rather than tuned to
   * death - the bot should feel like it has reasons, not like it is solving.
   */
  private scorePlay(
    sim: Simulation,
    card: CardDef,
    spot: { x: number; y: number; intent: 'defend' | 'attack' | 'support' },
    board: BoardRead,
    energy: number,
  ): number {
    let score = 0;

    // --- Defensive value ---------------------------------------------------
    if (spot.intent === 'defend') {
      if (board.threatValue <= 0) return 0;

      // Answering a push is worth roughly what the push threatens.
      score += board.threatValue * 4 * this.weights.defense * this.profile.defenseWeight;

      // Reward actually being able to hit what is coming.
      // Reading the counter correctly is a skill, so it scales with difficulty.
      score += this.counterBonus(card, board.threats) * this.profile.defenseWeight;

      // Defending a tower that is already hurt matters more.
      const tower = board.endangeredTower;
      if (tower) {
        const missing = 1 - tower.health / tower.maxHealth;
        score += missing * 40;
      }
    }

    // --- Offensive value ---------------------------------------------------
    if (spot.intent === 'attack') {
      // Discipline: do not open a push we cannot follow up on. In overcharge
      // energy comes twice as fast, so the floor relaxes.
      const floor =
        sim.phase === MatchPhase.Overcharge || sim.phase === MatchPhase.SuddenDeath
          ? this.profile.pushEnergyFloor * 0.6
          : this.profile.pushEnergyFloor;
      if (energy < floor) return 0;

      // Do not open a push while something is beating on our door.
      if (board.threatValue > 6) score -= board.threatValue * 3.5 * this.weights.defense;

      score += 22 * this.weights.offense;

      // Pushing is far better with an energy bank behind it.
      const surplus = energy - card.cost;
      score += surplus * 4 * this.weights.offense;

      // A wounded enemy tower is worth pressing.
      const tower = board.weakestEnemyTower;
      if (tower) {
        const missing = 1 - tower.health / tower.maxHealth;
        score += missing * 55 * this.weights.offense;
      }

      // Siege and tanks are what actually break towers.
      if (card.roles.includes(CardRole.Siege)) score += 25 * this.weights.offense;
      if (card.roles.includes(CardRole.Tank)) score += 18 * this.weights.offense;

      // Do not stack a second tank on top of an existing one.
      if (card.roles.includes(CardRole.Tank) && board.pushActive) score -= 12;
    }

    // --- Support value -----------------------------------------------------
    if (spot.intent === 'support') {
      if (!board.pushActive && card.type !== CardType.Spell) return 0;
      score += 20 * this.weights.offense;
      if (card.roles.includes(CardRole.Support)) score += 16;
    }

    // --- Economy -----------------------------------------------------------
    // Spending everything leaves nothing for the counter-push.
    const remaining = energy - card.cost;
    if (remaining < this.profile.reserveEnergy && spot.intent !== 'defend') {
      score -= (this.profile.reserveEnergy - remaining) * 9 * this.weights.thrift;
    }

    // Patience: sitting near the energy cap is pure waste, so bias toward
    // spending when the bank is full.
    if (energy >= ENERGY_MAX - 0.6) score += 18;
    else score -= (ENERGY_MAX - energy) * 1.5 * this.weights.patience;

    // Cheap cards are lower risk, so they clear the bar more easily.
    score += (6 - card.cost) * 2;

    // In overcharge, energy is cheap - play more freely.
    if (sim.phase === MatchPhase.Overcharge || sim.phase === MatchPhase.SuddenDeath) {
      score += 14;
    }

    return score;
  }

  /**
   * Rewards picking a card that can actually answer what is attacking.
   * This is the difference between the bot countering and the bot guessing.
   */
  private counterBonus(card: CardDef, threats: SimEntity[]): number {
    if (threats.length === 0) return 0;
    let bonus = 0;

    const airThreats = threats.filter((t) => t.layer === Layer.Air).length;
    const groundThreats = threats.length - airThreats;
    const swarmThreats = threats.filter((t) => t.radius <= 2).length;
    const bigThreats = threats.filter((t) => t.maxHealth >= 1500).length;

    const targets = card.targets ?? TargetClass.Ground;
    const hitsAir = targets === TargetClass.All || targets === TargetClass.Air;
    const hitsGround = targets === TargetClass.All || targets === TargetClass.Ground;

    // Anti-air is the single most common way a bot loses to a flyer.
    if (airThreats > 0) {
      bonus += hitsAir ? airThreats * 22 : -35;
    }
    if (groundThreats > 0 && !hitsGround && targets !== TargetClass.BuildingsOnly) {
      bonus -= 20;
    }

    // Splash answers swarms; single-target answers tanks.
    const splash = (card.splashRadius ?? 0) > 0 || card.roles.includes(CardRole.AreaDamage);
    if (swarmThreats >= 3) bonus += splash ? 30 : -12;
    if (bigThreats > 0) {
      const dps = (card.damage ?? 0) * (card.attackSpeed ?? 0);
      bonus += dps > 120 ? 22 : 0;
      // A swarm is a fine answer to one big body, too.
      if ((card.spawnAmount ?? 1) >= 3) bonus += 18;
    }

    // A unit that cannot attack anything at all is never a counter.
    if (targets === TargetClass.BuildingsOnly) bonus -= 40;

    return bonus;
  }
}

/** Picks a sensible bot deck and personality for a difficulty. */
export function pickBotLoadout(
  difficulty: BotDifficulty,
  rng: Rng,
  decks: Record<string, string[]>,
): { deck: string[]; strategy: BotStrategy } {
  const names = Object.keys(decks);
  const deckName = rng.pick(names) ?? (names[0] as string);
  const deck = decks[deckName] as string[];

  // Easy bots play the simpler, more forgiving personalities.
  const pool =
    difficulty === BotDifficulty.Easy
      ? [BotStrategy.Randomized, BotStrategy.Aggressive]
      : difficulty === BotDifficulty.Normal
        ? [BotStrategy.Aggressive, BotStrategy.Defensive, BotStrategy.Randomized]
        : [BotStrategy.Aggressive, BotStrategy.Defensive, BotStrategy.Control];

  return {
    deck: [...deck],
    strategy: rng.pick(pool) ?? BotStrategy.Aggressive,
  };
}

/** Human-readable label for the debug overlay and menus. */
export function describeBot(difficulty: BotDifficulty, strategy: BotStrategy): string {
  const diff = difficulty[0]?.toUpperCase() + difficulty.slice(1);
  const strat = strategy[0]?.toUpperCase() + strategy.slice(1);
  return `${diff} - ${strat}`;
}
