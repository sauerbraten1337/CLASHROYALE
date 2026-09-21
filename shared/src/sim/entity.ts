/**
 * The runtime combat entity.
 *
 * This is the mutable, engine-internal form. It is never sent over the wire
 * directly - `Simulation.snapshot()` projects it into the plain `EntityState`
 * structures the clients consume.
 */

import { DEFAULT_CRIT_MULTIPLIER, DEPLOY_DELAY } from '../constants.js';
import {
  AbilityKind,
  EntityKind,
  Layer,
  StatusKind,
  TargetClass,
  TargetPriority,
  Team,
  TowerSlot,
  type AbilitySpec,
  type CardDef,
  type EntityId,
  type PlayerId,
  type StatusEffect,
  type Vec2,
} from '../types.js';

export interface SimEntityInit {
  id: EntityId;
  kind: EntityKind;
  team: Team;
  owner: PlayerId;
  card: CardDef;
  x: number;
  y: number;
  /** Overrides the card's health, used by towers. */
  health?: number;
  damage?: number;
  attackSpeed?: number;
  range?: number;
  radius?: number;
  projectileSpeed?: number;
  slot?: TowerSlot;
  /** Seconds of life, for temporary bodies. */
  lifetime?: number;
  /** Skip the usual deployment delay (split fragments, clones). */
  instant?: boolean;
}

export class SimEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly team: Team;
  readonly owner: PlayerId;
  readonly card: CardDef;

  x: number;
  y: number;
  facing: number;

  health: number;
  maxHealth: number;

  readonly damage: number;
  readonly attackSpeed: number;
  readonly range: number;
  readonly radius: number;
  readonly moveSpeed: number;
  readonly layer: Layer;
  readonly targets: TargetClass;
  readonly priority: TargetPriority;
  readonly splashRadius: number;
  readonly projectileSpeed: number;
  readonly armor: number;
  readonly critChance: number;
  readonly critMultiplier: number;
  readonly knockback: number;
  readonly slot?: TowerSlot;

  /** Seconds until this entity can act after being deployed. */
  deployTimer: number;
  /** Seconds until the next attack is allowed. */
  attackCooldown: number;
  /** Seconds until the target is re-evaluated. */
  targetRefresh: number;
  /** Remaining life for temporary bodies; Infinity for permanent ones. */
  lifetime: number;

  targetId: EntityId | null = null;
  statuses: StatusEffect[] = [];
  /** Per-ability cooldown timers, keyed by ability kind. */
  abilityTimers = new Map<AbilityKind, number>();

  /** True while untargetable (phasing). */
  phased = false;
  /** Seconds left of the current phase window. */
  phaseTimer = 0;
  /** Set once a one-shot blink has been spent. */
  blinkUsed = false;
  /** Damage banked by Magnetize, released on the next attack. */
  magnetCharge = 0;
  /** Recent positions, for Rewind. Oldest first. */
  positionHistory: Array<{ t: number; x: number; y: number }> = [];
  /** Set during the tick the entity dies, so death effects run exactly once. */
  dead = false;
  /** True while the entity is mid-attack, for the renderer. */
  attacking = false;
  /** Countdown that keeps `attacking` true long enough to be seen. */
  attackAnim = 0;

  constructor(init: SimEntityInit) {
    const c = init.card;
    this.id = init.id;
    this.kind = init.kind;
    this.team = init.team;
    this.owner = init.owner;
    this.card = c;

    this.x = init.x;
    this.y = init.y;
    // Towers and buildings face down-field; units get their facing from motion.
    this.facing = init.team === Team.Blue ? -Math.PI / 2 : Math.PI / 2;

    this.maxHealth = init.health ?? c.health ?? 1;
    this.health = this.maxHealth;
    this.damage = init.damage ?? c.damage ?? 0;
    this.attackSpeed = init.attackSpeed ?? c.attackSpeed ?? 0;
    this.range = init.range ?? c.range ?? 0;
    this.radius = init.radius ?? c.radius ?? 2;
    this.moveSpeed = c.movementSpeed ?? 0;
    this.layer = c.layer ?? Layer.Ground;
    this.targets = c.targets ?? TargetClass.Ground;
    this.priority = c.priority ?? TargetPriority.Nearest;
    this.splashRadius = c.splashRadius ?? 0;
    this.projectileSpeed = init.projectileSpeed ?? c.projectileSpeed ?? 0;
    this.armor = c.armor ?? 0;
    this.critChance = c.critChance ?? 0;
    this.critMultiplier = c.critMultiplier ?? DEFAULT_CRIT_MULTIPLIER;
    this.knockback = c.knockback ?? 0;
    if (init.slot !== undefined) this.slot = init.slot;

    this.deployTimer = init.instant ? 0 : DEPLOY_DELAY;
    this.attackCooldown = 0;
    this.targetRefresh = 0;
    this.lifetime = init.lifetime ?? c.lifetime ?? Infinity;

    for (const ability of c.abilities ?? []) {
      // Periodic abilities start ready; one-shots are driven by their own flags.
      this.abilityTimers.set(ability.kind, 0);
    }
  }

  /** True for structures that cannot move. */
  get isStructure(): boolean {
    return this.kind === EntityKind.Tower || this.kind === EntityKind.Building;
  }

  get isAlive(): boolean {
    return !this.dead && this.health > 0;
  }

  /** True once the deploy delay has elapsed. */
  get isActive(): boolean {
    return this.deployTimer <= 0;
  }

  ability(kind: AbilityKind): AbilitySpec | undefined {
    return this.card.abilities?.find((a) => a.kind === kind);
  }

  hasAbility(kind: AbilityKind): boolean {
    return this.ability(kind) !== undefined;
  }

  // --- Status helpers -------------------------------------------------------

  status(kind: StatusKind): StatusEffect | undefined {
    return this.statuses.find((s) => s.kind === kind);
  }

  hasStatus(kind: StatusKind): boolean {
    return this.statuses.some((s) => s.kind === kind);
  }

  /**
   * Applies a status. Re-applying an existing status refreshes it rather than
   * stacking a second copy, except for shields, whose pools add together.
   */
  applyStatus(kind: StatusKind, duration: number, magnitude: number, sourceId?: EntityId): void {
    const existing = this.status(kind);
    if (existing) {
      existing.remaining = Math.max(existing.remaining, duration);
      existing.magnitude =
        kind === StatusKind.Shielded
          ? existing.magnitude + magnitude
          : Math.max(existing.magnitude, magnitude);
      if (sourceId !== undefined) existing.sourceId = sourceId;
      return;
    }
    const effect: StatusEffect = { kind, remaining: duration, magnitude };
    if (sourceId !== undefined) effect.sourceId = sourceId;
    this.statuses.push(effect);
  }

  removeStatus(kind: StatusKind): void {
    this.statuses = this.statuses.filter((s) => s.kind !== kind);
  }

  /** Strips beneficial statuses. Used by Void Pulse. */
  dispelBuffs(): boolean {
    const buffs = new Set([StatusKind.Shielded, StatusKind.Hasted, StatusKind.Invisible]);
    const before = this.statuses.length;
    this.statuses = this.statuses.filter((s) => !buffs.has(s.kind));
    return this.statuses.length !== before;
  }

  /** Effective movement speed after slows, freezes and hastes. */
  currentSpeed(): number {
    if (this.hasStatus(StatusKind.Frozen)) return 0;
    let speed = this.moveSpeed;
    const slow = this.status(StatusKind.Slowed);
    if (slow) speed *= 1 - Math.min(0.85, slow.magnitude);
    const haste = this.status(StatusKind.Hasted);
    if (haste) speed *= 1 + haste.magnitude;
    return speed;
  }

  /** Effective attacks per second after freezes, shocks and hastes. */
  currentAttackSpeed(): number {
    if (this.hasStatus(StatusKind.Frozen)) return 0;
    let rate = this.attackSpeed;
    // Shocked interrupts the attack rhythm without stopping it outright.
    if (this.hasStatus(StatusKind.Shocked)) rate *= 0.55;
    const haste = this.status(StatusKind.Hasted);
    if (haste) rate *= 1 + haste.magnitude;
    return rate;
  }

  /** Silenced entities cannot fire their special abilities. */
  canUseAbilities(): boolean {
    return !this.hasStatus(StatusKind.Silenced);
  }

  /** True when this entity may legally be chosen as a target by `attacker`. */
  isTargetableBy(attacker: SimEntity): boolean {
    if (!this.isAlive) return false;
    if (this.phased) return false;
    if (this.team === attacker.team) return false;
    if (this.hasStatus(StatusKind.Invisible)) return false;

    switch (attacker.targets) {
      case TargetClass.All:
        return true;
      case TargetClass.Ground:
        return this.layer === Layer.Ground;
      case TargetClass.Air:
        return this.layer === Layer.Air;
      case TargetClass.BuildingsOnly:
        return this.isStructure;
      default:
        return false;
    }
  }

  /** Surface-to-surface distance, so big bodies engage at sensible reach. */
  gapTo(other: SimEntity): number {
    return Math.hypot(this.x - other.x, this.y - other.y) - this.radius - other.radius;
  }

  /** Records a position sample for Rewind, trimming anything too old. */
  recordPosition(now: number, keepSeconds: number): void {
    this.positionHistory.push({ t: now, x: this.x, y: this.y });
    while (this.positionHistory.length > 0 && now - (this.positionHistory[0] as { t: number }).t > keepSeconds) {
      this.positionHistory.shift();
    }
  }

  /** The recorded position closest to `secondsAgo` in the past. */
  positionAt(now: number, secondsAgo: number): Vec2 | null {
    const want = now - secondsAgo;
    let best: { t: number; x: number; y: number } | null = null;
    for (const sample of this.positionHistory) {
      if (best === null || Math.abs(sample.t - want) < Math.abs(best.t - want)) best = sample;
    }
    return best ? { x: best.x, y: best.y } : null;
  }
}
