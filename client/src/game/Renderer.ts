/**
 * The arena renderer.
 *
 * Draws a `MatchSnapshot` onto a canvas. Two things matter here:
 *
 *  1. Snapshots arrive at 15 Hz but we render at up to 60 fps, so entity
 *     positions are interpolated between the last two snapshots. Without
 *     this, everything visibly stutters.
 *  2. The view is always drawn from the local player's perspective, with
 *     their side at the bottom, so both players see a familiar arena.
 */

import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  BRIDGE_HALF_WIDTH,
  CENTER_ZONE,
  EntityKind,
  Layer,
  LEFT_BRIDGE_X,
  OBSTACLES,
  RIGHT_BRIDGE_X,
  RIVER_HALF_HEIGHT,
  RIVER_Y,
  StatusKind,
  Team,
  TowerSlot,
  getCard,
  type EntityState,
  type MatchSnapshot,
  type ProjectileState,
} from '@riftbound/shared';

import { FACTION_PALETTE, TEAM_COLOR, drawEmblem, teamPalette } from './art.js';
import type { ParticleSystem } from './particles.js';

export interface RenderOptions {
  /** The local player's team. The arena is flipped so this side is at the bottom. */
  viewTeam: Team;
  /** Arena-space position of the player's pointer, when placing a card. */
  placement: { x: number; y: number; valid: boolean; radius: number } | null;
  /** Highlights the legal deployment region while a card is held. */
  showDeployZone: boolean;
  /** Draws entity ids, target lines and collision radii. */
  debug: boolean;
  showHealthBars: boolean;
}

/** Interpolation state for one entity. */
interface Interpolated {
  x: number;
  y: number;
  facing: number;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  /** The two most recent snapshots, for interpolation. */
  private previous: MatchSnapshot | null = null;
  private current: MatchSnapshot | null = null;
  /** Wall-clock time each was received. */
  private previousAt = 0;
  private currentAt = 0;

  /** Cached per-entity interpolation, keyed by entity id. */
  private lerped = new Map<number, Interpolated>();

  /** Viewport transform, recomputed on resize. */
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private cssWidth = 0;
  private cssHeight = 0;

  /** Animation clock, drives idle motion in the art. */
  private clock = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  /** Recomputes the transform for the canvas's current CSS size. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssWidth = Math.max(1, rect.width);
    this.cssHeight = Math.max(1, rect.height);

    this.canvas.width = Math.round(this.cssWidth * dpr);
    this.canvas.height = Math.round(this.cssHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fit the arena while preserving its aspect ratio.
    this.scale = Math.min(this.cssWidth / ARENA_WIDTH, this.cssHeight / ARENA_HEIGHT);
    this.offsetX = (this.cssWidth - ARENA_WIDTH * this.scale) / 2;
    this.offsetY = (this.cssHeight - ARENA_HEIGHT * this.scale) / 2;
  }

  /** Feeds in a new authoritative snapshot. */
  pushSnapshot(snapshot: MatchSnapshot): void {
    this.previous = this.current;
    this.previousAt = this.currentAt;
    this.current = snapshot;
    this.currentAt = performance.now();
    if (!this.previous) {
      this.previous = snapshot;
      this.previousAt = this.currentAt;
    }
  }

  /** Converts a screen point (CSS pixels) into arena coordinates. */
  screenToArena(clientX: number, clientY: number, viewTeam: Team): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let x = (px - this.offsetX) / this.scale;
    let y = (py - this.offsetY) / this.scale;
    // Undo the perspective flip for the player defending the top of the map.
    if (viewTeam === Team.Red) {
      x = ARENA_WIDTH - x;
      y = ARENA_HEIGHT - y;
    }
    return { x, y };
  }

  /** Converts arena coordinates into screen (CSS pixel) space. */
  arenaToScreen(x: number, y: number, viewTeam: Team): { x: number; y: number } {
    let ax = x;
    let ay = y;
    if (viewTeam === Team.Red) {
      ax = ARENA_WIDTH - ax;
      ay = ARENA_HEIGHT - ay;
    }
    return {
      x: this.offsetX + ax * this.scale,
      y: this.offsetY + ay * this.scale,
    };
  }

  /**
   * Draws a frame.
   *
   * `dt` advances the animation clock; particles are owned by the caller so
   * that they survive across snapshots.
   */
  draw(dt: number, particles: ParticleSystem, options: RenderOptions): void {
    this.clock += dt;
    const ctx = this.ctx;
    const snapshot = this.current;

    this.drawBackdrop(ctx);
    if (!snapshot) return;

    // How far we are between the last two snapshots, clamped so a late
    // packet extrapolates a little rather than snapping.
    const span = Math.max(1, this.currentAt - this.previousAt);
    const alpha = Math.min(1.25, (performance.now() - this.currentAt) / span + 1);

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    // Perspective flip, plus screen shake.
    if (options.viewTeam === Team.Red) {
      ctx.translate(ARENA_WIDTH / 2, ARENA_HEIGHT / 2);
      ctx.rotate(Math.PI);
      ctx.translate(-ARENA_WIDTH / 2, -ARENA_HEIGHT / 2);
    }
    ctx.translate(particles.shakeX, particles.shakeY);

    this.drawArena(ctx, options);
    if (options.showDeployZone) this.drawDeployZone(ctx, options.viewTeam, snapshot);

    // Ground-layer bodies first, then air, so flyers read as above.
    const entities = [...snapshot.entities].sort((a, b) => layerOrder(a) - layerOrder(b));

    for (const entity of entities) {
      const pos = this.interpolate(entity, alpha);
      this.drawEntity(ctx, entity, pos, options);
    }

    for (const projectile of snapshot.projectiles) {
      this.drawProjectile(ctx, projectile);
    }

    particles.draw(ctx);

    if (options.placement) this.drawPlacement(ctx, options.placement);

    ctx.restore();

    // Health bars and numbers are drawn unrotated so text is always upright.
    if (options.showHealthBars) {
      for (const entity of entities) {
        const pos = this.interpolate(entity, alpha);
        this.drawHealthBar(ctx, entity, pos, options.viewTeam);
      }
    }
    particles.drawNumbers(ctx, (x, y) => this.arenaToScreen(x, y, options.viewTeam));

    if (options.debug) this.drawDebug(ctx, snapshot, options, alpha);

    this.pruneInterpolation(snapshot);
  }

  // =========================================================================
  // Interpolation
  // =========================================================================

  /**
   * Blends an entity's position between the previous and current snapshot.
   * New entities appear at their exact position rather than sliding in from
   * wherever they happened to be last frame.
   */
  private interpolate(entity: EntityState, alpha: number): Interpolated {
    const before = this.previous?.entities.find((e) => e.id === entity.id);
    let result: Interpolated;

    if (!before) {
      result = { x: entity.x, y: entity.y, facing: entity.facing };
    } else {
      result = {
        x: before.x + (entity.x - before.x) * alpha,
        y: before.y + (entity.y - before.y) * alpha,
        facing: lerpAngle(before.facing, entity.facing, alpha),
      };
    }
    this.lerped.set(entity.id, result);
    return result;
  }

  private pruneInterpolation(snapshot: MatchSnapshot): void {
    if (this.lerped.size < 256) return;
    const live = new Set(snapshot.entities.map((e) => e.id));
    for (const id of this.lerped.keys()) {
      if (!live.has(id)) this.lerped.delete(id);
    }
  }

  // =========================================================================
  // Arena
  // =========================================================================

  /**
   * Fills the whole canvas before the arena is drawn.
   *
   * The arena is a fixed portrait aspect, so on a wide screen there is space
   * on either side of it. Leaving that flat black reads as a broken viewport,
   * so it gets a deep-space wash with drifting motes and a vignette, and the
   * arena itself is given an outer glow to sit it in the scene.
   */
  private drawBackdrop(ctx: CanvasRenderingContext2D): void {
    const w = this.cssWidth;
    const h = this.cssHeight;

    const wash = ctx.createLinearGradient(0, 0, 0, h);
    wash.addColorStop(0, '#0a0f20');
    wash.addColorStop(0.5, '#070b16');
    wash.addColorStop(1, '#0a1220');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h);

    const arenaLeft = this.offsetX;
    const arenaWidth = ARENA_WIDTH * this.scale;
    const margin = arenaLeft;

    // Only bother with the surround when there is a meaningful amount of it.
    if (margin > 24) {
      // Slow drifting motes, seeded off the clock so they are stable.
      ctx.save();
      for (let i = 0; i < 40; i++) {
        const seed = i * 97.13;
        const side = i % 2 === 0 ? 0 : 1;
        const bandWidth = margin;
        const x = side === 0
          ? ((seed * 13.7) % bandWidth)
          : arenaLeft + arenaWidth + ((seed * 9.3) % bandWidth);
        const drift = (this.clock * (6 + (i % 5) * 2) + seed * 31) % (h + 80);
        const y = h + 40 - drift;
        const alpha = 0.06 + ((i % 7) / 7) * 0.1;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = i % 3 === 0 ? '#b98cff' : '#63c9ff';
        ctx.beginPath();
        ctx.arc(x, y, 0.8 + (i % 4) * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // A soft glow hugging the arena edges.
      const glow = ctx.createRadialGradient(w / 2, h / 2, arenaWidth * 0.4, w / 2, h / 2, arenaWidth * 1.4);
      glow.addColorStop(0, 'rgba(90, 120, 220, 0.09)');
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
    }

    // Vignette, which also stops the surround feeling flat on small screens.
    const vignette = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.35,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.75,
    );
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  private drawArena(ctx: CanvasRenderingContext2D, options: RenderOptions): void {
    // Ground, with a subtle gradient so the two halves read differently.
    const gradient = ctx.createLinearGradient(0, 0, 0, ARENA_HEIGHT);
    gradient.addColorStop(0, '#221a33');
    gradient.addColorStop(0.5, '#141a2c');
    gradient.addColorStop(1, '#152437');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    // Lane guides.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
    ctx.lineWidth = 0.5;
    for (const x of [LEFT_BRIDGE_X, RIGHT_BRIDGE_X]) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ARENA_HEIGHT);
      ctx.stroke();
    }

    // Contested centre zone.
    const pulse = 0.05 + Math.sin(this.clock * 1.2) * 0.02;
    ctx.fillStyle = `rgba(150, 120, 255, ${pulse})`;
    ctx.beginPath();
    ctx.arc(CENTER_ZONE.x, CENTER_ZONE.y, CENTER_ZONE.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(160, 130, 255, 0.16)';
    ctx.lineWidth = 0.4;
    ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    // The rift.
    const riftTop = RIVER_Y - RIVER_HALF_HEIGHT;
    const riftHeight = RIVER_HALF_HEIGHT * 2;
    const rift = ctx.createLinearGradient(0, riftTop, 0, riftTop + riftHeight);
    rift.addColorStop(0, 'rgba(60, 30, 110, 0.9)');
    rift.addColorStop(0.5, 'rgba(130, 90, 220, 0.75)');
    rift.addColorStop(1, 'rgba(60, 30, 110, 0.9)');
    ctx.fillStyle = rift;
    ctx.fillRect(0, riftTop, ARENA_WIDTH, riftHeight);

    // Drifting rift energy.
    ctx.strokeStyle = 'rgba(200, 170, 255, 0.22)';
    ctx.lineWidth = 0.35;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      for (let x = 0; x <= ARENA_WIDTH; x += 4) {
        const y =
          RIVER_Y +
          Math.sin(x * 0.12 + this.clock * (1 + i * 0.35) + i * 2) * (1.6 - i * 0.4);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Bridges.
    for (const bx of [LEFT_BRIDGE_X, RIGHT_BRIDGE_X]) {
      ctx.fillStyle = '#3b3550';
      ctx.fillRect(bx - BRIDGE_HALF_WIDTH, riftTop - 1, BRIDGE_HALF_WIDTH * 2, riftHeight + 2);
      ctx.fillStyle = '#4b4468';
      ctx.fillRect(bx - BRIDGE_HALF_WIDTH, riftTop - 1, BRIDGE_HALF_WIDTH * 2, 1.2);
      ctx.fillRect(bx - BRIDGE_HALF_WIDTH, riftTop + riftHeight - 0.2, BRIDGE_HALF_WIDTH * 2, 1.2);
      // Plank detail.
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.lineWidth = 0.3;
      ctx.beginPath();
      for (let i = 1; i < 5; i++) {
        const x = bx - BRIDGE_HALF_WIDTH + (i / 5) * BRIDGE_HALF_WIDTH * 2;
        ctx.moveTo(x, riftTop);
        ctx.lineTo(x, riftTop + riftHeight);
      }
      ctx.stroke();
    }

    // Obstacles.
    for (const obstacle of OBSTACLES) {
      this.drawObstacle(ctx, obstacle);
    }

    if (options.debug) {
      ctx.strokeStyle = 'rgba(255, 80, 80, 0.5)';
      ctx.lineWidth = 0.3;
      for (const o of OBSTACLES) {
        ctx.beginPath();
        ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private drawObstacle(
    ctx: CanvasRenderingContext2D,
    obstacle: { x: number; y: number; radius: number; art: string },
  ): void {
    ctx.save();
    ctx.translate(obstacle.x, obstacle.y);

    // Shadow.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    ctx.ellipse(0, obstacle.radius * 0.5, obstacle.radius, obstacle.radius * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    if (obstacle.art === 'crystal-spire') {
      ctx.fillStyle = '#4a3d7a';
      ctx.beginPath();
      ctx.moveTo(0, -obstacle.radius * 1.5);
      ctx.lineTo(obstacle.radius * 0.8, obstacle.radius * 0.4);
      ctx.lineTo(-obstacle.radius * 0.8, obstacle.radius * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#6d5aa8';
      ctx.beginPath();
      ctx.moveTo(0, -obstacle.radius * 1.5);
      ctx.lineTo(obstacle.radius * 0.28, obstacle.radius * 0.3);
      ctx.lineTo(-obstacle.radius * 0.18, obstacle.radius * 0.3);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = '#2f3c52';
      ctx.fillRect(-obstacle.radius * 0.7, -obstacle.radius * 1.2, obstacle.radius * 1.4, obstacle.radius * 1.9);
      ctx.fillStyle = 'rgba(120, 180, 255, 0.5)';
      ctx.fillRect(-obstacle.radius * 0.2, -obstacle.radius * 0.9, obstacle.radius * 0.4, obstacle.radius * 1.2);
    }
    ctx.restore();
  }

  /** Shades the half of the arena the player may deploy into. */
  private drawDeployZone(
    ctx: CanvasRenderingContext2D,
    viewTeam: Team,
    _snapshot: MatchSnapshot,
  ): void {
    const top = viewTeam === Team.Blue ? RIVER_Y : 0;
    const height = ARENA_HEIGHT / 2;
    ctx.fillStyle = 'rgba(90, 200, 255, 0.07)';
    ctx.fillRect(0, top, ARENA_WIDTH, height);
    ctx.strokeStyle = 'rgba(120, 220, 255, 0.28)';
    ctx.lineWidth = 0.4;
    ctx.setLineDash([2.5, 2]);
    ctx.beginPath();
    ctx.moveTo(0, viewTeam === Team.Blue ? RIVER_Y : RIVER_Y);
    ctx.lineTo(ARENA_WIDTH, RIVER_Y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // =========================================================================
  // Entities
  // =========================================================================

  private drawEntity(
    ctx: CanvasRenderingContext2D,
    entity: EntityState,
    pos: Interpolated,
    options: RenderOptions,
  ): void {
    const card = getCard(entity.cardId);
    const teamKey = entity.team === Team.Red ? 'red' : 'blue';
    const tint = TEAM_COLOR[teamKey];
    const basePalette = card ? FACTION_PALETTE[card.faction] : FACTION_PALETTE.forge;
    const palette = teamPalette(basePalette, teamKey);

    const isTower = entity.kind === EntityKind.Tower;
    const radius = entity.radius;

    ctx.save();
    ctx.translate(pos.x, pos.y);

    // Phasing units are ghosted rather than hidden, so the player can follow
    // them even while they cannot be targeted.
    const invisible = entity.statuses.some((s) => s.kind === StatusKind.Invisible);
    if (entity.phased) ctx.globalAlpha = 0.35;
    else if (invisible) ctx.globalAlpha = 0.45;

    // Drop shadow. Air units cast theirs further away to read as airborne.
    const airLift = entity.layer === Layer.Air ? radius * 0.9 : 0;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.beginPath();
    ctx.ellipse(0, radius * 0.55 + airLift, radius * 0.85, radius * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(0, -airLift);

    // Team ring.
    ctx.strokeStyle = tint.primary;
    ctx.lineWidth = isTower ? 0.7 : 0.45;
    ctx.globalAlpha *= 0.85;
    ctx.beginPath();
    ctx.arc(0, 0, radius * (isTower ? 1.02 : 0.98), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = entity.phased ? 0.35 : invisible ? 0.45 : 1;

    // Glow under the body.
    const glow = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius * 1.5);
    glow.addColorStop(0, tint.glow);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.globalAlpha *= 0.5;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = entity.phased ? 0.35 : invisible ? 0.45 : 1;

    // The card's own emblem.
    const artwork = card?.artwork ?? (entity.slot === TowerSlot.Core ? 'core' : 'guard');
    const faction = card?.faction ?? basePalette;
    // Units face their direction of travel; structures stay upright.
    if (!isTower && entity.kind !== EntityKind.Building) {
      ctx.rotate(pos.facing + Math.PI / 2);
    }
    drawEmblem(
      ctx,
      artwork,
      card?.faction ?? (faction as never),
      0,
      0,
      radius * 0.95,
      this.clock,
      palette,
    );
    if (!isTower && entity.kind !== EntityKind.Building) {
      ctx.rotate(-(pos.facing + Math.PI / 2));
    }

    // Attack flash.
    if (entity.attacking) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    this.drawStatusRing(ctx, entity, radius);

    ctx.restore();
  }

  /** Status effects render as coloured arcs around the body. */
  private drawStatusRing(
    ctx: CanvasRenderingContext2D,
    entity: EntityState,
    radius: number,
  ): void {
    const colors: Record<string, string> = {
      [StatusKind.Burning]: '#ff8a3d',
      [StatusKind.Frozen]: '#9be8ff',
      [StatusKind.Slowed]: '#7fd4ff',
      [StatusKind.Shocked]: '#ffe45e',
      [StatusKind.Poisoned]: '#8ee86b',
      [StatusKind.Shielded]: '#8ad8ff',
      [StatusKind.Hasted]: '#ffd24a',
      [StatusKind.Silenced]: '#b39ddb',
      [StatusKind.Marked]: '#ff6b8a',
    };

    const visible = entity.statuses.filter((s) => colors[s.kind]);
    if (visible.length === 0) return;

    const arc = (Math.PI * 2) / visible.length;
    ctx.lineWidth = 0.4;
    visible.forEach((status, index) => {
      ctx.strokeStyle = colors[status.kind] as string;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.25, index * arc + 0.1, (index + 1) * arc - 0.1);
      ctx.stroke();
    });

    // A shield gets a full bubble so it is unmistakable.
    const shield = entity.statuses.find((s) => s.kind === StatusKind.Shielded);
    if (shield) {
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#8ad8ff';
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private drawHealthBar(
    ctx: CanvasRenderingContext2D,
    entity: EntityState,
    pos: Interpolated,
    viewTeam: Team,
  ): void {
    if (entity.health >= entity.maxHealth && entity.kind !== EntityKind.Tower) return;

    const screen = this.arenaToScreen(pos.x, pos.y, viewTeam);
    const isTower = entity.kind === EntityKind.Tower;
    const width = (isTower ? entity.radius * 2.6 : entity.radius * 2.2) * this.scale;
    const height = isTower ? 6 : 4;
    const lift = (entity.radius + (isTower ? 3.5 : 2.4)) * this.scale;
    const x = screen.x - width / 2;
    const y = screen.y - lift;
    const pct = Math.max(0, Math.min(1, entity.health / entity.maxHealth));

    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    ctx.fillRect(x - 1, y - 1, width + 2, height + 2);

    const friendly = entity.team === viewTeam;
    ctx.fillStyle = friendly ? '#4fd07a' : '#ff5f6d';
    ctx.fillRect(x, y, width * pct, height);

    if (isTower) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 0.5, y - 0.5, width + 1, height + 1);
    }
  }

  private drawProjectile(ctx: CanvasRenderingContext2D, projectile: ProjectileState): void {
    const teamKey = projectile.team === Team.Red ? 'red' : 'blue';
    const tint = TEAM_COLOR[teamKey];

    // Trail.
    const dx = projectile.targetX - projectile.x;
    const dy = projectile.targetY - projectile.y;
    const length = Math.hypot(dx, dy);
    if (length > 0.01) {
      const nx = dx / length;
      const ny = dy / length;
      ctx.strokeStyle = tint.glow;
      ctx.lineWidth = 0.55;
      ctx.beginPath();
      ctx.moveTo(projectile.x - nx * 2.4, projectile.y - ny * 2.4);
      ctx.lineTo(projectile.x, projectile.y);
      ctx.stroke();
    }

    ctx.fillStyle = tint.primary;
    ctx.beginPath();
    ctx.arc(projectile.x, projectile.y, 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(projectile.x, projectile.y, 0.38, 0, Math.PI * 2);
    ctx.fill();
  }

  /** The ghost shown under the pointer while a card is being placed. */
  private drawPlacement(
    ctx: CanvasRenderingContext2D,
    placement: { x: number; y: number; valid: boolean; radius: number },
  ): void {
    const color = placement.valid ? '#5de6a8' : '#ff5f6d';
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.6;
    ctx.globalAlpha = 0.9;
    ctx.setLineDash([1.5, 1.2]);
    ctx.beginPath();
    ctx.arc(placement.x, placement.y, placement.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.globalAlpha = 0.16;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(placement.x, placement.y, placement.radius, 0, Math.PI * 2);
    ctx.fill();

    // Crosshair.
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    ctx.moveTo(placement.x - placement.radius * 1.4, placement.y);
    ctx.lineTo(placement.x + placement.radius * 1.4, placement.y);
    ctx.moveTo(placement.x, placement.y - placement.radius * 1.4);
    ctx.lineTo(placement.x, placement.y + placement.radius * 1.4);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawDebug(
    ctx: CanvasRenderingContext2D,
    snapshot: MatchSnapshot,
    options: RenderOptions,
    alpha: number,
  ): void {
    ctx.save();
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (const entity of snapshot.entities) {
      const pos = this.interpolate(entity, alpha);
      const screen = this.arenaToScreen(pos.x, pos.y, options.viewTeam);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fillText(`#${entity.id}`, screen.x + 6, screen.y - 4);

      // Aim line to the current target.
      if (entity.targetId !== undefined) {
        const target = snapshot.entities.find((e) => e.id === entity.targetId);
        if (target) {
          const targetScreen = this.arenaToScreen(target.x, target.y, options.viewTeam);
          ctx.strokeStyle = 'rgba(255, 210, 74, 0.32)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(screen.x, screen.y);
          ctx.lineTo(targetScreen.x, targetScreen.y);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  get viewportScale(): number {
    return this.scale;
  }
}

/** Ground bodies draw under air bodies. */
function layerOrder(entity: EntityState): number {
  if (entity.kind === EntityKind.Tower || entity.kind === EntityKind.Building) return 0;
  return entity.layer === Layer.Air ? 2 : 1;
}

/** Shortest-path angle interpolation, so facing never spins the long way. */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * Math.min(1, t);
}
