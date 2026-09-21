/**
 * The authoritative match simulation.
 *
 * This class owns the entire truth of a match: entities, energy, hands,
 * timers and the win condition. It is deliberately host-agnostic - the
 * dedicated server runs it for online matches, and the client runs an
 * instance locally for practice against the bot. Neither host is allowed to
 * mutate its internals directly; they drive it through `step()` and
 * `playCard()` and read it through `snapshot()`.
 *
 * Determinism: the only randomness comes from the seeded `Rng`, so the same
 * seed plus the same ordered inputs always produces the same match.
 */

import {
  COUNTDOWN_SECONDS,
  DECK_SIZE,
  ENERGY_MAX,
  ENERGY_REGEN_SECONDS,
  ENERGY_START,
  HAND_SIZE,
  MATCH_SECONDS,
  OVERCHARGE_MULTIPLIER,
  OVERCHARGE_SECONDS,
  SUDDEN_DEATH_SECONDS,
  TICK_SECONDS,
  forwardSign,
  isOwnHalf,
  towerLayout,
} from '../constants.js';
import { STARTER_DECK, getCard } from '../data/cards.js';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
} from '../constants.js';
import {
  CardType,
  EntityKind,
  FxKind,
  Layer,
  MatchPhase,
  StatusKind,
  Team,
  TowerSlot,
  opposingTeam,
  type CardDef,
  type EntityId,
  type EntityState,
  type FxEvent,
  type MatchResult,
  type MatchSnapshot,
  type PlayerId,
  type PlayerState,
  type ProjectileState,
} from '../types.js';
import { SimEntity } from './entity.js';
import { clamp, clampToArena, distance, isGroundPassable } from './geometry.js';
import { Rng } from './rng.js';
import { updateTargeting } from './systems/targeting.js';
import { updateMovement } from './systems/movement.js';
import { updateCombat, updateProjectiles, type SimProjectile } from './systems/combat.js';
import { updateAbilities, runDeathEffects } from './systems/abilities.js';
import { castSpell, updatePendingSpells, type PendingSpell } from './systems/spells.js';
import { updateStatuses } from './systems/statuses.js';

export interface SimPlayerConfig {
  id: PlayerId;
  name: string;
  team: Team;
  deck: string[];
}

export interface SimulationConfig {
  matchId: string;
  players: [SimPlayerConfig, SimPlayerConfig];
  seed: number;
  /** Overrides match length, for tests. */
  matchSeconds?: number;
  /** Skips the pre-match countdown, for tests. */
  skipCountdown?: boolean;
}

/** Mutable per-player runtime state. */
export interface PlayerRuntime {
  id: PlayerId;
  name: string;
  team: Team;
  deck: string[];
  /** The four cards currently playable. */
  hand: string[];
  /** Cards waiting to rotate in, front of the queue first. */
  cycle: string[];
  energy: number;
  /** Active Energy Surge, if any. */
  energyBoost: { multiplier: number; remaining: number } | null;
  /** Towers this player has destroyed. */
  towersDestroyed: number;
  disconnected: boolean;
}

/** Result of attempting to play a card. Rejections carry a machine-readable code. */
export type PlayCardOutcome =
  | { ok: true; cardId: string }
  | { ok: false; code: PlayRejection; message: string };

export enum PlayRejection {
  NoSuchPlayer = 'no-such-player',
  MatchNotActive = 'match-not-active',
  BadHandIndex = 'bad-hand-index',
  UnknownCard = 'unknown-card',
  NotEnoughEnergy = 'not-enough-energy',
  IllegalPosition = 'illegal-position',
}

export class Simulation {
  readonly matchId: string;
  readonly rng: Rng;

  /** Seconds elapsed since the match left the countdown. */
  time = 0;
  /** Whole simulation steps executed. */
  tick = 0;
  phase: MatchPhase = MatchPhase.Countdown;
  /** Seconds left of the pre-match countdown. */
  countdown: number;
  /** Seconds left in the current period. */
  timeRemaining: number;
  result: MatchResult | null = null;

  readonly entities = new Map<EntityId, SimEntity>();
  readonly projectiles: SimProjectile[] = [];
  readonly pendingSpells: PendingSpell[] = [];
  readonly players = new Map<PlayerId, PlayerRuntime>();

  /** Fx accumulated since the last snapshot. Drained by `snapshot()`. */
  private pendingFx: FxEvent[] = [];
  private nextEntityId = 1;
  private readonly matchSeconds: number;
  /** True once sudden death has started, so it is only entered once. */
  private suddenDeathStarted = false;

  constructor(config: SimulationConfig) {
    this.matchId = config.matchId;
    this.rng = new Rng(config.seed);
    this.matchSeconds = config.matchSeconds ?? MATCH_SECONDS;
    this.timeRemaining = this.matchSeconds;
    this.countdown = config.skipCountdown ? 0 : COUNTDOWN_SECONDS;
    if (config.skipCountdown) this.phase = MatchPhase.Active;

    for (const p of config.players) {
      this.players.set(p.id, this.createPlayerRuntime(p));
      this.spawnTowers(p);
    }
  }

  // =========================================================================
  // Setup
  // =========================================================================

  private createPlayerRuntime(config: SimPlayerConfig): PlayerRuntime {
    // Only known, collectible cards make it into the runtime deck. A malformed
    // deck is padded rather than rejected, so a bad client cannot wedge a match.
    // Keep only known, collectible, non-duplicate cards. A malformed deck is
    // repaired rather than rejected, so a bad client cannot wedge a match.
    const deck: string[] = [];
    for (const id of config.deck) {
      const card = getCard(id);
      if (card && card.collectible !== false && !deck.includes(id) && deck.length < DECK_SIZE) {
        deck.push(id);
      }
    }
    for (const filler of STARTER_DECK) {
      if (deck.length >= DECK_SIZE) break;
      if (!deck.includes(filler)) deck.push(filler);
    }

    const order = this.rng.shuffle([...deck]);
    return {
      id: config.id,
      name: config.name,
      team: config.team,
      deck,
      hand: order.slice(0, HAND_SIZE),
      cycle: order.slice(HAND_SIZE),
      energy: ENERGY_START,
      energyBoost: null,
      towersDestroyed: 0,
      disconnected: false,
    };
  }

  private spawnTowers(config: SimPlayerConfig): void {
    for (const layout of towerLayout(config.team)) {
      // Towers borrow a synthetic card definition so they flow through the
      // same targeting and combat systems as everything else.
      const card: CardDef = {
        id: layout.slot === TowerSlot.Core ? 'core-tower' : 'guard-tower',
        name: layout.slot === TowerSlot.Core ? 'Rift Core' : 'Guard Spire',
        description: '',
        rarity: 'common' as CardDef['rarity'],
        cost: 0,
        type: CardType.Building,
        roles: [],
        faction: 'forge' as CardDef['faction'],
        collectible: false,
        artwork: layout.slot === TowerSlot.Core ? 'core' : 'guard',
        sound: 'tower',
        targets: 'all' as CardDef['targets'],
        priority: 'nearest' as CardDef['priority'],
        layer: Layer.Ground,
      };
      const entity = new SimEntity({
        id: this.nextEntityId++,
        kind: EntityKind.Tower,
        team: config.team,
        owner: config.id,
        card,
        x: layout.pos.x,
        y: layout.pos.y,
        health: layout.health,
        damage: layout.damage,
        attackSpeed: layout.attackSpeed,
        range: layout.range,
        radius: layout.radius,
        projectileSpeed: layout.projectileSpeed,
        slot: layout.slot,
        instant: true,
      });
      this.entities.set(entity.id, entity);
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Advances the match by one fixed step. */
  step(dt: number = TICK_SECONDS): void {
    if (this.phase === MatchPhase.Finished) return;

    if (this.phase === MatchPhase.Countdown) {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = MatchPhase.Active;
      }
      this.tick++;
      return;
    }

    this.tick++;
    this.time += dt;
    this.timeRemaining = Math.max(0, this.timeRemaining - dt);

    this.updateEnergy(dt);
    updateStatuses(this, dt);
    updatePendingSpells(this, dt);
    updateAbilities(this, dt);
    updateTargeting(this, dt);
    updateMovement(this, dt);
    updateCombat(this, dt);
    updateProjectiles(this, dt);
    this.updateLifetimes(dt);
    this.reapDead();
    this.updatePhase();
    this.checkVictory();
  }

  /**
   * Validates and executes a card play. This is the single entry point for
   * player intent, and every check that matters happens here - the caller is
   * never trusted to have done any of them.
   */
  playCard(playerId: PlayerId, handIndex: number, x: number, y: number): PlayCardOutcome {
    const player = this.players.get(playerId);
    if (!player) {
      return { ok: false, code: PlayRejection.NoSuchPlayer, message: 'Unknown player.' };
    }
    if (this.phase === MatchPhase.Countdown || this.phase === MatchPhase.Finished) {
      return { ok: false, code: PlayRejection.MatchNotActive, message: 'Match is not accepting plays.' };
    }
    if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= player.hand.length) {
      return { ok: false, code: PlayRejection.BadHandIndex, message: 'Hand slot out of range.' };
    }
    const cardId = player.hand[handIndex] as string;
    const card = getCard(cardId);
    if (!card) {
      return { ok: false, code: PlayRejection.UnknownCard, message: 'Card not recognised.' };
    }
    if (player.energy < card.cost) {
      return { ok: false, code: PlayRejection.NotEnoughEnergy, message: 'Not enough energy.' };
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, code: PlayRejection.IllegalPosition, message: 'Position is not a number.' };
    }
    const pos = clampToArena({ x, y }, 1);
    if (!this.isDeployLegal(player, card, pos.x, pos.y)) {
      return { ok: false, code: PlayRejection.IllegalPosition, message: 'Cannot deploy there.' };
    }

    // All checks passed: charge the player and resolve.
    player.energy -= card.cost;
    this.rotateHand(player, handIndex);

    if (card.type === CardType.Spell) {
      castSpell(this, player, card, pos.x, pos.y);
    } else {
      this.deployCard(player, card, pos.x, pos.y);
    }
    return { ok: true, cardId };
  }

  /** Places a unit or building card that has already passed validation. */
  private deployCard(player: PlayerRuntime, card: CardDef, x: number, y: number): void {
    this.spawnUnits(card, player.team, player.id, x, y);
  }

  /** Marks a player as disconnected; their towers keep fighting. */
  setDisconnected(playerId: PlayerId, disconnected: boolean): void {
    const player = this.players.get(playerId);
    if (player) player.disconnected = disconnected;
  }

  /** Ends the match immediately in favour of the other side. */
  forfeit(playerId: PlayerId): void {
    const player = this.players.get(playerId);
    if (!player || this.phase === MatchPhase.Finished) return;
    this.finish(opposingTeam(player.team), 'forfeit');
  }

  /** Projects the authoritative state into the wire format and drains fx. */
  snapshot(): MatchSnapshot {
    const entities: EntityState[] = [];
    for (const e of this.entities.values()) {
      if (!e.isAlive) continue;
      const state: EntityState = {
        id: e.id,
        kind: e.kind,
        team: e.team,
        cardId: e.card.id,
        x: round2(e.x),
        y: round2(e.y),
        facing: round2(e.facing),
        health: Math.max(0, Math.round(e.health)),
        maxHealth: Math.round(e.maxHealth),
        radius: e.radius,
        layer: e.layer,
        statuses: e.statuses.map((s) => ({
          kind: s.kind,
          remaining: round2(s.remaining),
          magnitude: round2(s.magnitude),
        })),
      };
      if (e.slot !== undefined) state.slot = e.slot;
      if (e.attacking) state.attacking = true;
      if (e.phased) state.phased = true;
      if (e.targetId !== null) state.targetId = e.targetId;
      entities.push(state);
    }

    const projectiles: ProjectileState[] = this.projectiles.map((p) => ({
      id: p.id,
      team: p.team,
      cardId: p.cardId,
      x: round2(p.x),
      y: round2(p.y),
      targetX: round2(p.targetX),
      targetY: round2(p.targetY),
      ...(p.targetId !== null ? { targetId: p.targetId } : {}),
      speed: p.speed,
      art: p.art,
    }));

    const players: PlayerState[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      energy: round2(p.energy),
      hand: [...p.hand],
      nextCard: p.cycle[0] ?? '',
      towersRemaining: this.towersRemaining(p.team),
      ...(p.disconnected ? { disconnected: true } : {}),
    }));

    const fx = this.pendingFx;
    this.pendingFx = [];

    const snap: MatchSnapshot = {
      matchId: this.matchId,
      tick: this.tick,
      time: round2(this.time),
      timeRemaining: round2(this.phase === MatchPhase.Countdown ? this.matchSeconds : this.timeRemaining),
      phase: this.phase,
      entities,
      projectiles,
      fx,
      players,
    };
    if (this.result) snap.result = this.result;
    return snap;
  }

  // =========================================================================
  // Engine services used by the systems
  // =========================================================================

  allocateId(): EntityId {
    return this.nextEntityId++;
  }

  /** Card lookup, exposed so systems need not import the data module. */
  cardLookup(id: string): CardDef | undefined {
    return getCard(id);
  }

  addFx(event: FxEvent): void {
    // Keep the buffer bounded: a pathological frame must never blow up a packet.
    if (this.pendingFx.length < 400) this.pendingFx.push(event);
  }

  /** Every live entity on the given team. */
  *teamEntities(team: Team): Generator<SimEntity> {
    for (const e of this.entities.values()) {
      if (e.isAlive && e.team === team) yield e;
    }
  }

  /** Every live entity within `radius` of a point, optionally team-filtered. */
  entitiesInRadius(x: number, y: number, radius: number, team?: Team): SimEntity[] {
    const out: SimEntity[] = [];
    for (const e of this.entities.values()) {
      if (!e.isAlive) continue;
      if (team !== undefined && e.team !== team) continue;
      if (distance(x, y, e.x, e.y) <= radius + e.radius) out.push(e);
    }
    return out;
  }

  getPlayer(team: Team): PlayerRuntime | undefined {
    for (const p of this.players.values()) if (p.team === team) return p;
    return undefined;
  }

  towersRemaining(team: Team): number {
    let count = 0;
    for (const e of this.entities.values()) {
      if (e.isAlive && e.kind === EntityKind.Tower && e.team === team) count++;
    }
    return count;
  }

  /**
   * Applies damage with the full mitigation chain: armor, then shields, then
   * health. Returns the health actually removed.
   */
  dealDamage(
    target: SimEntity,
    amount: number,
    source: SimEntity | null,
    options: { isSpell?: boolean; crit?: boolean; ignoreArmor?: boolean } = {},
  ): number {
    if (!target.isAlive || amount <= 0) return 0;
    if (target.phased) return 0;

    let damage = amount;

    // Armor reduces sustained non-spell damage; spells cut straight through.
    if (!options.isSpell && !options.ignoreArmor && target.armor > 0) {
      damage = Math.max(damage * 0.15, damage - target.armor);
    }

    // Marked targets take extra damage from everything.
    const marked = target.status(StatusKind.Marked);
    if (marked) damage *= 1 + marked.magnitude;

    // Structures inside the contested centre are not protected; units are.
    const shield = target.status(StatusKind.Shielded);
    if (shield) {
      const absorbed = Math.min(shield.magnitude, damage);
      shield.magnitude -= absorbed;
      damage -= absorbed;
      if (shield.magnitude <= 0.01) target.removeStatus(StatusKind.Shielded);
      this.addFx({ kind: FxKind.Shield, x: target.x, y: target.y, team: target.team });
    }

    if (damage <= 0) return 0;

    const before = target.health;
    target.health -= damage;
    const dealt = before - Math.max(0, target.health);

    this.addFx({
      kind: target.kind === EntityKind.Tower ? FxKind.TowerHit : FxKind.Hit,
      x: target.x,
      y: target.y,
      amount: Math.round(dealt),
      team: target.team,
      cardId: source?.card.id ?? '',
      ...(options.crit ? { crit: true } : {}),
    });

    if (target.health <= 0) this.killEntity(target, source);
    return dealt;
  }

  heal(target: SimEntity, amount: number): number {
    if (!target.isAlive || amount <= 0) return 0;
    const before = target.health;
    target.health = Math.min(target.maxHealth, target.health + amount);
    const healed = target.health - before;
    if (healed > 0) {
      this.addFx({
        kind: FxKind.Heal,
        x: target.x,
        y: target.y,
        amount: Math.round(healed),
        team: target.team,
      });
    }
    return healed;
  }

  /** Marks an entity dead and fires its on-death behaviour. */
  killEntity(entity: SimEntity, killer: SimEntity | null): void {
    if (entity.dead) return;
    entity.dead = true;
    entity.health = 0;

    if (entity.kind === EntityKind.Tower) {
      this.addFx({
        kind: FxKind.TowerDestroyed,
        x: entity.x,
        y: entity.y,
        team: entity.team,
        scale: entity.slot === TowerSlot.Core ? 2 : 1.4,
      });
      const scorer = this.getPlayer(opposingTeam(entity.team));
      if (scorer) scorer.towersDestroyed++;
    } else {
      this.addFx({
        kind: FxKind.Death,
        x: entity.x,
        y: entity.y,
        team: entity.team,
        cardId: entity.card.id,
      });
    }

    runDeathEffects(this, entity, killer);
  }

  /**
   * Spawns one or more bodies for a card at a point.
   * Used by card plays, spawners, splits and spell summons alike.
   */
  spawnUnits(
    card: CardDef,
    team: Team,
    owner: PlayerId,
    x: number,
    y: number,
    options: { count?: number; instant?: boolean; lifetime?: number } = {},
  ): SimEntity[] {
    const count = options.count ?? card.spawnAmount ?? 1;
    const spawned: SimEntity[] = [];
    const kind = card.type === CardType.Building ? EntityKind.Building : EntityKind.Unit;

    for (let i = 0; i < count; i++) {
      const offset = this.formationOffset(i, count, card.radius ?? 2);
      const placed = this.findSpawnSpot(
        x + offset.x,
        y + offset.y,
        card.radius ?? 2,
        card.layer ?? Layer.Ground,
      );
      const init: ConstructorParameters<typeof SimEntity>[0] = {
        id: this.allocateId(),
        kind,
        team,
        owner,
        card,
        x: placed.x,
        y: placed.y,
      };
      if (options.instant) init.instant = true;
      if (options.lifetime !== undefined) init.lifetime = options.lifetime;
      const entity = new SimEntity(init);
      this.entities.set(entity.id, entity);
      spawned.push(entity);
      this.addFx({
        kind: FxKind.Spawn,
        x: entity.x,
        y: entity.y,
        team,
        cardId: card.id,
        scale: entity.radius,
      });
    }
    return spawned;
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /** Spreads multiple bodies of one card into a small readable formation. */
  private formationOffset(index: number, count: number, radius: number): { x: number; y: number } {
    if (count <= 1) return { x: 0, y: 0 };
    const spacing = radius * 2.4;
    if (count === 2) return { x: (index === 0 ? -1 : 1) * spacing * 0.5, y: 0 };
    // Ring formation for three or more.
    const angle = (index / count) * Math.PI * 2;
    const ringRadius = spacing * 0.75;
    return { x: Math.cos(angle) * ringRadius, y: Math.sin(angle) * ringRadius };
  }

  /** Nudges a spawn point out of walls and water so nothing spawns stuck. */
  private findSpawnSpot(x: number, y: number, radius: number, layer: Layer): { x: number; y: number } {
    const base = clampToArena({ x, y }, radius);
    if (layer === Layer.Air || isGroundPassable(base.x, base.y, radius)) return base;

    // Spiral outward for a legal tile.
    for (let ring = 1; ring <= 6; ring++) {
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        const candidate = clampToArena(
          { x: base.x + Math.cos(angle) * ring * 3, y: base.y + Math.sin(angle) * ring * 3 },
          radius,
        );
        if (isGroundPassable(candidate.x, candidate.y, radius)) return candidate;
      }
    }
    return base;
  }

  /** Replaces the played slot with the next queued card and re-queues it. */
  private rotateHand(player: PlayerRuntime, handIndex: number): void {
    const played = player.hand[handIndex] as string;
    const incoming = player.cycle.shift();
    if (incoming !== undefined) {
      player.hand[handIndex] = incoming;
    }
    player.cycle.push(played);
  }

  /**
   * Deploy legality. Units land on the owner's half; destroying an enemy guard
   * tower opens up that lane's forward quadrant, which rewards taking a tower.
   */
  private isDeployLegal(player: PlayerRuntime, card: CardDef, x: number, y: number): boolean {
    if (x < 0 || x > ARENA_WIDTH || y < 0 || y > ARENA_HEIGHT) return false;
    if (card.type === CardType.Spell) return true;
    if (isOwnHalf(player.team, y)) return true;

    // Forward deployment into a lane whose guard tower has fallen.
    const enemy = opposingTeam(player.team);
    const fallen = this.fallenGuardSlots(enemy);
    if (fallen.size === 0) return false;

    const leftLane = x < ARENA_WIDTH / 2;
    const slotNeeded = leftLane ? TowerSlot.LeftGuard : TowerSlot.RightGuard;
    if (!fallen.has(slotNeeded)) return false;

    // Only as far forward as the fallen tower's own row.
    const guardY = this.guardRowY(enemy);
    return player.team === Team.Blue ? y >= guardY : y <= guardY;
  }

  private fallenGuardSlots(team: Team): Set<TowerSlot> {
    const standing = new Set<TowerSlot>();
    for (const e of this.entities.values()) {
      if (e.isAlive && e.kind === EntityKind.Tower && e.team === team && e.slot) standing.add(e.slot);
    }
    const fallen = new Set<TowerSlot>();
    for (const slot of [TowerSlot.LeftGuard, TowerSlot.RightGuard]) {
      if (!standing.has(slot)) fallen.add(slot);
    }
    return fallen;
  }

  private guardRowY(team: Team): number {
    const layout = towerLayout(team).find((l) => l.slot === TowerSlot.LeftGuard);
    return layout ? layout.pos.y : ARENA_HEIGHT / 2;
  }

  private updateEnergy(dt: number): void {
    const phaseMultiplier =
      this.phase === MatchPhase.Overcharge || this.phase === MatchPhase.SuddenDeath
        ? OVERCHARGE_MULTIPLIER
        : 1;

    for (const player of this.players.values()) {
      let multiplier = phaseMultiplier;
      if (player.energyBoost) {
        player.energyBoost.remaining -= dt;
        if (player.energyBoost.remaining <= 0) player.energyBoost = null;
        else multiplier *= player.energyBoost.multiplier;
      }
      player.energy = clamp(
        player.energy + (dt / ENERGY_REGEN_SECONDS) * multiplier,
        0,
        ENERGY_MAX,
      );
    }
  }

  private updateLifetimes(dt: number): void {
    for (const e of this.entities.values()) {
      if (!e.isAlive || e.lifetime === Infinity) continue;
      e.lifetime -= dt;
      if (e.lifetime <= 0) this.killEntity(e, null);
    }
  }

  /** Drops dead entities and stale projectiles from the live collections. */
  private reapDead(): void {
    for (const [id, e] of this.entities) {
      if (!e.isAlive) this.entities.delete(id);
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if ((this.projectiles[i] as SimProjectile).done) this.projectiles.splice(i, 1);
    }
  }

  private updatePhase(): void {
    if (this.phase === MatchPhase.Active && this.timeRemaining <= OVERCHARGE_SECONDS) {
      this.phase = MatchPhase.Overcharge;
      this.addFx({ kind: FxKind.LevelBanner, x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2, scale: 2 });
    }
  }

  private checkVictory(): void {
    if (this.phase === MatchPhase.Finished) return;

    // A destroyed core ends the match immediately, in every phase.
    for (const team of [Team.Blue, Team.Red]) {
      const coreAlive = [...this.entities.values()].some(
        (e) => e.isAlive && e.kind === EntityKind.Tower && e.team === team && e.slot === TowerSlot.Core,
      );
      if (!coreAlive) {
        this.finish(opposingTeam(team), 'core-destroyed');
        return;
      }
    }

    const blue = this.getPlayer(Team.Blue);
    const red = this.getPlayer(Team.Red);
    const blueScore = blue?.towersDestroyed ?? 0;
    const redScore = red?.towersDestroyed ?? 0;

    if (this.phase === MatchPhase.SuddenDeath) {
      // Overtime is decided the instant the deadlock breaks, not at time-up.
      if (blueScore !== redScore) {
        this.finish(blueScore > redScore ? Team.Blue : Team.Red, 'sudden-death');
        return;
      }
      if (this.timeRemaining <= 0) this.finish(null, 'timeout');
      return;
    }

    if (this.timeRemaining > 0) return;

    if (blueScore !== redScore) {
      this.finish(blueScore > redScore ? Team.Blue : Team.Red, 'tower-count');
      return;
    }

    // Level on towers: play overtime, where the next tower decides it.
    if (!this.suddenDeathStarted) {
      this.suddenDeathStarted = true;
      this.phase = MatchPhase.SuddenDeath;
      this.timeRemaining = SUDDEN_DEATH_SECONDS;
      this.addFx({ kind: FxKind.LevelBanner, x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2, scale: 3 });
    }
  }

  /**
   * In sudden death the first tower to fall decides the match, so the
   * tower-count comparison is re-checked every tick rather than only at time.
   */
  private finish(winner: Team | null, reason: MatchResult['reason']): void {
    if (this.phase === MatchPhase.Finished) return;
    this.phase = MatchPhase.Finished;
    const blue = this.getPlayer(Team.Blue);
    const red = this.getPlayer(Team.Red);
    this.result = {
      winner,
      reason,
      towersDestroyed: {
        [Team.Blue]: blue?.towersDestroyed ?? 0,
        [Team.Red]: red?.towersDestroyed ?? 0,
      },
      durationSeconds: round2(this.time),
    };
  }
}

/** Trims float noise so snapshots compress well on the wire. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export { forwardSign };
