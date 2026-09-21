/**
 * Core type vocabulary for Riftbound Rivals.
 *
 * Everything in here is transport-safe (plain JSON, no class instances, no
 * functions) because these structures travel over the wire between the
 * authoritative simulation host and the rendering clients.
 */

/** Which side of the arena a thing belongs to. */
export enum Team {
  /** The player whose core sits at the bottom of the screen. */
  Blue = 'blue',
  /** The player whose core sits at the top of the screen. */
  Red = 'red',
}

export function opposingTeam(team: Team): Team {
  return team === Team.Blue ? Team.Red : Team.Blue;
}

/** Broad gameplay category. Drives how a card is resolved when played. */
export enum CardType {
  /** Spawns one or more mobile units. */
  Unit = 'unit',
  /** Spawns a stationary structure with health that decays over time. */
  Building = 'building',
  /** Resolves an instant effect at a point, then is consumed. */
  Spell = 'spell',
}

/** Designer-facing role tag. Used by the deck builder and the bot's heuristics. */
export enum CardRole {
  Tank = 'tank',
  Assassin = 'assassin',
  Swarm = 'swarm',
  Ranged = 'ranged',
  Support = 'support',
  Siege = 'siege',
  Control = 'control',
  Defensive = 'defensive',
  AreaDamage = 'aoe',
  SingleTarget = 'single-target',
  Utility = 'utility',
}

export enum Rarity {
  Common = 'common',
  Rare = 'rare',
  Epic = 'epic',
  Mythic = 'mythic',
}

/** Movement layer. Determines what can legally be attacked. */
export enum Layer {
  Ground = 'ground',
  Air = 'air',
}

/** What an attacker is *allowed* to hit. */
export enum TargetClass {
  Ground = 'ground',
  Air = 'air',
  /** Both layers. */
  All = 'all',
  /** Ignores units entirely, walks past them to structures. */
  BuildingsOnly = 'buildings-only',
}

/** How an attacker picks among the legal targets in range. */
export enum TargetPriority {
  Nearest = 'nearest',
  LowestHealth = 'lowest-health',
  HighestThreat = 'highest-threat',
  Buildings = 'buildings',
  Ranged = 'ranged',
  Support = 'support',
}

/** Status effects. Stackable and independently timed. */
export enum StatusKind {
  Burning = 'burning',
  Frozen = 'frozen',
  Slowed = 'slowed',
  Shocked = 'shocked',
  Poisoned = 'poisoned',
  Shielded = 'shielded',
  Invisible = 'invisible',
  Hasted = 'hasted',
  Silenced = 'silenced',
  Marked = 'marked',
}

/** A status effect currently riding on an entity. */
export interface StatusEffect {
  kind: StatusKind;
  /** Seconds left before it falls off. */
  remaining: number;
  /** Meaning depends on kind: damage-per-second, slow fraction, shield pool, ... */
  magnitude: number;
  /** Entity that applied it, for damage attribution. */
  sourceId?: EntityId;
}

/** Named special behaviours wired into the simulation's ability system. */
export enum AbilityKind {
  /** Periodically untargetable, then bursts on re-entry. */
  PhaseShift = 'phase-shift',
  /** Pulses a zone that drags enemies toward its centre. */
  GravityWell = 'gravity-well',
  /** On hit, spawns a weaker short-lived copy of itself. */
  MirrorClone = 'mirror-clone',
  /** Projects a projectile-blocking barrier over nearby allies. */
  Barrier = 'barrier',
  /** On death, charges up and calls down a strike on its grave. */
  DeathCharge = 'death-charge',
  /** After attacking, rewinds to a position it held moments ago. */
  Rewind = 'rewind',
  /** Absorbs incoming projectiles, converting them into bonus attack damage. */
  Magnetize = 'magnetize',
  /** One-shot blink forward past blockers. */
  Blink = 'blink',
  /** Attacks chain a fraction of their damage to nearby enemies. */
  ChainSplash = 'chain-splash',
  /** Attacks repeat at reduced power after a delay. */
  Echo = 'echo',
  /** Heals nearby damaged allies on a timer. */
  MendPulse = 'mend-pulse',
  /** Grants nearby allies a speed buff. */
  RallyAura = 'rally-aura',
  /** Deals damage to everything around it when it dies. */
  DeathBlast = 'death-blast',
  /** Splits into smaller units on death. */
  Split = 'split',
  /** Periodically spawns units while alive. */
  Spawner = 'spawner',
  /** Attacks apply a slow. */
  ChillTouch = 'chill-touch',
  /** Attacks apply a damage-over-time. */
  VenomTouch = 'venom-touch',
  /** Takes reduced damage from non-spell sources. */
  Armored = 'armored',
  /** Deals bonus damage to structures. */
  SiegeSpecialist = 'siege-specialist',
  /** Becomes invisible while not attacking. */
  Cloak = 'cloak',
}

/** Ability configuration attached to a card. */
export interface AbilitySpec {
  kind: AbilityKind;
  /** Seconds between activations, where the ability is periodic. */
  cooldown?: number;
  /** Primary scalar: damage, heal, slow fraction, radius multiplier, ... */
  value?: number;
  /** Secondary scalar: duration, count, ... */
  duration?: number;
  /** Effect radius in arena units. */
  radius?: number;
  /** Card id spawned by Spawner / Split / MirrorClone. */
  spawns?: string;
  /** How many to spawn. */
  spawnCount?: number;
}

/** What a spell does where it lands. */
export interface SpellSpec {
  radius: number;
  damage?: number;
  /** Damage multiplier applied when the spell hits a structure. */
  buildingDamageFactor?: number;
  /** Seconds before the effect resolves (telegraphed spells). */
  delay?: number;
  /** Number of separate impacts (e.g. a barrage). */
  impacts?: number;
  /** Seconds between impacts when impacts > 1. */
  impactInterval?: number;
  /** Statuses applied to enemies in the radius. */
  applies?: Array<{ kind: StatusKind; duration: number; magnitude: number }>;
  /** Statuses applied to allies in the radius. */
  appliesToAllies?: Array<{ kind: StatusKind; duration: number; magnitude: number }>;
  /** Pushes units away from the impact point by this many arena units. */
  knockback?: number;
  /** Strips positive statuses from enemies caught in the radius. */
  dispel?: boolean;
  /** Grants the caster bonus energy regeneration. */
  energyBoost?: { multiplier: number; duration: number };
  /** Heals allies for this much. */
  heal?: number;
  /** Spawns units at the impact point. */
  summons?: { cardId: string; count: number };
}

/**
 * A card definition. Pure data — the simulation reads these, it never contains
 * per-card branching logic.
 */
export interface CardDef {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  /** Energy cost to play. */
  cost: number;
  type: CardType;
  roles: CardRole[];
  /** Faction flavour grouping, used for art tinting and synergy text. */
  faction: Faction;

  // --- Unit / building combat stats (absent on spells) ---
  health?: number;
  damage?: number;
  /** Attacks per second. */
  attackSpeed?: number;
  /** Arena units travelled per second. */
  movementSpeed?: number;
  /** Attack reach in arena units, measured surface-to-surface. */
  range?: number;
  /** Collision footprint radius in arena units. */
  radius?: number;
  layer?: Layer;
  targets?: TargetClass;
  priority?: TargetPriority;
  /** Splash radius on each attack. 0 means single target. */
  splashRadius?: number;
  /** Units per second for projectiles; absent means a melee/instant hit. */
  projectileSpeed?: number;
  /** How many bodies this card deploys. */
  spawnAmount?: number;
  /** Structures only: seconds of life before they expire. */
  lifetime?: number;
  /** Flat damage reduction applied before shields. */
  armor?: number;
  /** Chance (0..1) an attack deals critMultiplier damage. */
  critChance?: number;
  critMultiplier?: number;
  /** Distance the target is pushed on hit. */
  knockback?: number;

  abilities?: AbilitySpec[];
  spell?: SpellSpec;

  /** Deployment restriction, if any. */
  deploy?: DeployRule;

  /**
   * False for summon-only tokens (split fragments, spawner minions, clones).
   * Tokens exist in the simulation but never appear in the collection or the
   * deck builder, and may not be played directly.
   */
  collectible?: boolean;

  // --- Presentation ---
  /** Key into the client's procedural art table. */
  artwork: string;
  /** Key into the client's sound bank. */
  sound: string;
  /** Free-text designer note shown in the collection. */
  flavor?: string;
}

/** Where a card may be placed. */
export enum DeployRule {
  /** Anywhere on the caster's own half (plus captured territory). */
  OwnHalf = 'own-half',
  /** Anywhere at all — spells and a few infiltration units. */
  Anywhere = 'anywhere',
}

export enum Faction {
  /** Machine-cult constructs. */
  Forge = 'forge',
  /** Rift-touched phantoms. */
  Rift = 'rift',
  /** Living crystal growths. */
  Bloom = 'bloom',
  /** Time-benders. */
  Chrono = 'chrono',
}

// ---------------------------------------------------------------------------
// Runtime simulation state
// ---------------------------------------------------------------------------

export type EntityId = number;
export type PlayerId = string;

export enum EntityKind {
  Unit = 'unit',
  Building = 'building',
  /** A player structure: core or guard tower. */
  Tower = 'tower',
  Projectile = 'projectile',
}

export enum TowerSlot {
  Core = 'core',
  LeftGuard = 'left-guard',
  RightGuard = 'right-guard',
}

export interface Vec2 {
  x: number;
  y: number;
}

/** A live combat entity, as broadcast to clients. */
export interface EntityState {
  id: EntityId;
  kind: EntityKind;
  team: Team;
  /** Card that produced this entity; empty for projectiles. */
  cardId: string;
  x: number;
  y: number;
  /** Facing angle in radians, for rendering. */
  facing: number;
  health: number;
  maxHealth: number;
  radius: number;
  layer: Layer;
  /** Active status effects, trimmed to what the client needs to draw. */
  statuses: StatusEffect[];
  /** Tower slot, when kind === Tower. */
  slot?: TowerSlot;
  /** Set while the entity is playing its attack animation. */
  attacking?: boolean;
  /** Untargetable (phasing / blinking). */
  phased?: boolean;
  /** Current target, for renderer aim lines and debug. */
  targetId?: EntityId;
}

/** A projectile in flight. */
export interface ProjectileState {
  id: EntityId;
  team: Team;
  cardId: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  /** Homing projectiles track a live entity. */
  targetId?: EntityId;
  speed: number;
  /** Visual key. */
  art: string;
}

/** Transient presentation events the client turns into particles and sound. */
export enum FxKind {
  Spawn = 'spawn',
  Hit = 'hit',
  Death = 'death',
  SpellImpact = 'spell-impact',
  TowerHit = 'tower-hit',
  TowerDestroyed = 'tower-destroyed',
  Heal = 'heal',
  Phase = 'phase',
  Blink = 'blink',
  Shield = 'shield',
  LevelBanner = 'level-banner',
}

export interface FxEvent {
  kind: FxKind;
  x: number;
  y: number;
  /** Damage/heal amount, for floating numbers. */
  amount?: number;
  team?: Team;
  cardId?: string;
  /** Effect scale hint. */
  scale?: number;
  /** True for critical hits, so the client can emphasise them. */
  crit?: boolean;
}

export enum MatchPhase {
  /** Pre-match countdown. */
  Countdown = 'countdown',
  /** Normal play. */
  Active = 'active',
  /** Doubled energy regeneration. */
  Overcharge = 'overcharge',
  /** Tie-breaker: first tower to fall loses. */
  SuddenDeath = 'sudden-death',
  Finished = 'finished',
}

/** Per-player state visible in the battle HUD. */
export interface PlayerState {
  id: PlayerId;
  name: string;
  team: Team;
  energy: number;
  /** Cards currently playable. */
  hand: string[];
  /** The card shown as "coming up next". */
  nextCard: string;
  /** Towers still standing. */
  towersRemaining: number;
  /** True when the socket has dropped but the match is holding a slot open. */
  disconnected?: boolean;
}

/** The full authoritative snapshot broadcast each network tick. */
export interface MatchSnapshot {
  matchId: string;
  tick: number;
  /** Seconds elapsed since FIGHT. */
  time: number;
  /** Seconds left in the match. */
  timeRemaining: number;
  phase: MatchPhase;
  entities: EntityState[];
  projectiles: ProjectileState[];
  /** Fx generated since the previous snapshot. */
  fx: FxEvent[];
  players: PlayerState[];
  /** Set once the match has ended. */
  result?: MatchResult;
}

export interface MatchResult {
  winner: Team | null;
  reason: 'core-destroyed' | 'tower-count' | 'timeout' | 'forfeit' | 'sudden-death';
  /** Towers destroyed by each side. */
  towersDestroyed: Record<Team, number>;
  durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Client -> host intents, host -> client messages
// ---------------------------------------------------------------------------

export enum ClientMessageType {
  Hello = 'hello',
  QueueJoin = 'queue-join',
  QueueLeave = 'queue-leave',
  CreatePrivate = 'create-private',
  JoinPrivate = 'join-private',
  LeavePrivate = 'leave-private',
  PlayCard = 'play-card',
  Forfeit = 'forfeit',
  Reconnect = 'reconnect',
  Ping = 'ping',
}

export enum ServerMessageType {
  Welcome = 'welcome',
  QueueStatus = 'queue-status',
  MatchFound = 'match-found',
  Snapshot = 'snapshot',
  MatchEnd = 'match-end',
  PrivateRoom = 'private-room',
  Error = 'error',
  Pong = 'pong',
  OpponentLeft = 'opponent-left',
  OpponentReturned = 'opponent-returned',
}

export interface HelloMessage {
  type: ClientMessageType.Hello;
  name: string;
  /** Stable id persisted client-side, used to reclaim a match after a drop. */
  playerId: PlayerId;
}

export interface QueueJoinMessage {
  type: ClientMessageType.QueueJoin;
  deck: string[];
  trophies: number;
}

export interface PlayCardMessage {
  type: ClientMessageType.PlayCard;
  /** Index into the player's hand. The server resolves it to a card itself. */
  handIndex: number;
  x: number;
  y: number;
  /** Client tick estimate, for latency diagnostics only — never trusted. */
  clientTick?: number;
}

export interface CreatePrivateMessage {
  type: ClientMessageType.CreatePrivate;
  deck: string[];
}

export interface JoinPrivateMessage {
  type: ClientMessageType.JoinPrivate;
  code: string;
  deck: string[];
}

export type ClientMessage =
  | HelloMessage
  | QueueJoinMessage
  | { type: ClientMessageType.QueueLeave }
  | CreatePrivateMessage
  | JoinPrivateMessage
  | { type: ClientMessageType.LeavePrivate }
  | PlayCardMessage
  | { type: ClientMessageType.Forfeit }
  | { type: ClientMessageType.Reconnect; matchId: string; playerId: PlayerId }
  | { type: ClientMessageType.Ping; t: number };

export interface WelcomeMessage {
  type: ServerMessageType.Welcome;
  playerId: PlayerId;
  serverTickRate: number;
  /** Set when the player has a match in progress they can rejoin. */
  resumableMatchId?: string;
}

export interface MatchFoundMessage {
  type: ServerMessageType.MatchFound;
  matchId: string;
  team: Team;
  opponentName: string;
  opponentTrophies: number;
  /** Seconds of countdown before FIGHT. */
  countdown: number;
}

export interface SnapshotMessage {
  type: ServerMessageType.Snapshot;
  snapshot: MatchSnapshot;
}

export interface MatchEndMessage {
  type: ServerMessageType.MatchEnd;
  result: MatchResult;
  rewards: MatchRewards;
}

export interface PrivateRoomMessage {
  type: ServerMessageType.PrivateRoom;
  code: string;
  /** Number of players currently in the room. */
  occupants: number;
}

export type ServerMessage =
  | WelcomeMessage
  | { type: ServerMessageType.QueueStatus; searching: boolean; queued: number; waitedSeconds: number }
  | MatchFoundMessage
  | SnapshotMessage
  | MatchEndMessage
  | PrivateRoomMessage
  | { type: ServerMessageType.Error; code: string; message: string }
  | { type: ServerMessageType.Pong; t: number; serverTime: number }
  | { type: ServerMessageType.OpponentLeft; graceSeconds: number }
  | { type: ServerMessageType.OpponentReturned };

export interface MatchRewards {
  xp: number;
  coins: number;
  trophies: number;
}

// ---------------------------------------------------------------------------
// Bot configuration
// ---------------------------------------------------------------------------

export enum BotDifficulty {
  Easy = 'easy',
  Normal = 'normal',
  Hard = 'hard',
}

export enum BotStrategy {
  Aggressive = 'aggressive',
  Defensive = 'defensive',
  Control = 'control',
  Randomized = 'randomized',
}
