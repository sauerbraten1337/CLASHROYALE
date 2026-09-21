/**
 * Particles, floating damage numbers and screen shake.
 *
 * Purely cosmetic and entirely client-side: the simulation emits `FxEvent`s
 * describing *what happened*, and this module decides what that looks like.
 * Nothing here can affect the outcome of a match.
 */

import { FxKind, type FxEvent } from '@riftbound/shared';
import { TEAM_COLOR } from './art.js';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  /** Shrink toward zero as the particle ages. */
  shrink: boolean;
  /** Draw as a ring rather than a dot. */
  ring: boolean;
  drag: number;
}

interface FloatingNumber {
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  text: string;
  color: string;
  size: number;
}

/** Hard cap so a chaotic moment cannot tank the frame rate. */
const MAX_PARTICLES = 700;
const MAX_NUMBERS = 60;

export class ParticleSystem {
  private particles: Particle[] = [];
  private numbers: FloatingNumber[] = [];
  private shake = 0;
  private shakeDecay = 0;

  /** Current screen shake offset, in arena units. */
  shakeX = 0;
  shakeY = 0;

  /** Turns a simulation fx event into particles, numbers and shake. */
  emit(event: FxEvent, damageNumbersEnabled: boolean): void {
    const team = event.team === 'red' ? TEAM_COLOR.red : TEAM_COLOR.blue;
    const scale = event.scale ?? 1;

    switch (event.kind) {
      case FxKind.Spawn:
        this.burst(event.x, event.y, 14, {
          color: team.primary,
          speed: 9,
          life: 0.45,
          size: 0.7 * scale,
          ring: false,
        });
        this.ringPulse(event.x, event.y, team.primary, 0.4, scale * 3);
        break;

      case FxKind.Hit:
        this.burst(event.x, event.y, 5, {
          color: '#ffd9a0',
          speed: 11,
          life: 0.22,
          size: 0.5,
          ring: false,
        });
        if (damageNumbersEnabled && event.amount && event.amount > 0) {
          this.addNumber(event.x, event.y, `${event.amount}`, event.crit ? '#ffd24a' : '#ffffff', event.crit ? 1.5 : 1);
        }
        break;

      case FxKind.TowerHit:
        this.burst(event.x, event.y, 7, {
          color: '#ffb066',
          speed: 13,
          life: 0.3,
          size: 0.6,
          ring: false,
        });
        if (damageNumbersEnabled && event.amount && event.amount > 0) {
          this.addNumber(event.x, event.y - 4, `${event.amount}`, '#ffc46b', 1.15);
        }
        this.addShake(0.35, 0.18);
        break;

      case FxKind.Death:
        this.burst(event.x, event.y, 18, {
          color: team.primary,
          speed: 14,
          life: 0.55,
          size: 0.8,
          ring: false,
        });
        break;

      case FxKind.SpellImpact:
        this.burst(event.x, event.y, Math.min(46, 16 + scale * 10), {
          color: '#ffe08a',
          speed: 16 * scale,
          life: 0.6,
          size: 0.9 * scale,
          ring: false,
        });
        this.ringPulse(event.x, event.y, '#fff1c2', 0.5, scale * 6);
        this.addShake(0.5 * scale, 0.3);
        break;

      case FxKind.TowerDestroyed:
        this.burst(event.x, event.y, 70, {
          color: '#ffb347',
          speed: 24,
          life: 1.1,
          size: 1.3 * scale,
          ring: false,
        });
        this.burst(event.x, event.y, 30, {
          color: '#ffffff',
          speed: 15,
          life: 0.8,
          size: 0.9 * scale,
          ring: false,
        });
        this.ringPulse(event.x, event.y, '#ffd9a0', 0.9, scale * 14);
        this.addShake(2.2 * scale, 0.7);
        break;

      case FxKind.Heal:
        this.burst(event.x, event.y, 8, {
          color: '#7dffc0',
          speed: 6,
          life: 0.6,
          size: 0.6,
          ring: false,
          upward: true,
        });
        if (damageNumbersEnabled && event.amount && event.amount > 0) {
          this.addNumber(event.x, event.y, `+${event.amount}`, '#7dffc0', 0.95);
        }
        break;

      case FxKind.Phase:
      case FxKind.Blink:
        this.ringPulse(event.x, event.y, '#c9a8ff', 0.4, (scale || 1) * 4);
        this.burst(event.x, event.y, 10, {
          color: '#c9a8ff',
          speed: 10,
          life: 0.35,
          size: 0.6,
          ring: false,
        });
        break;

      case FxKind.Shield:
        this.ringPulse(event.x, event.y, '#8ad8ff', 0.35, (scale || 1) * 3.5);
        break;

      case FxKind.LevelBanner:
        this.ringPulse(event.x, event.y, '#ffd24a', 1.1, 40);
        this.addShake(1, 0.5);
        break;
    }
  }

  private burst(
    x: number,
    y: number,
    count: number,
    options: {
      color: string;
      speed: number;
      life: number;
      size: number;
      ring: boolean;
      upward?: boolean;
    },
  ): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) return;
      const angle = options.upward
        ? -Math.PI / 2 + (Math.random() - 0.5) * 1.2
        : Math.random() * Math.PI * 2;
      const speed = options.speed * (0.35 + Math.random() * 0.75);
      const life = options.life * (0.7 + Math.random() * 0.6);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life,
        maxLife: life,
        size: options.size * (0.6 + Math.random() * 0.7),
        color: options.color,
        shrink: true,
        ring: options.ring,
        drag: 2.6,
      });
    }
  }

  /** An expanding ring, drawn as a single growing particle. */
  private ringPulse(x: number, y: number, color: string, life: number, size: number): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    this.particles.push({
      x,
      y,
      vx: 0,
      vy: 0,
      life,
      maxLife: life,
      size,
      color,
      shrink: false,
      ring: true,
      drag: 0,
    });
  }

  private addNumber(x: number, y: number, text: string, color: string, size: number): void {
    if (this.numbers.length >= MAX_NUMBERS) this.numbers.shift();
    this.numbers.push({
      x: x + (Math.random() - 0.5) * 2.5,
      y,
      vy: -9,
      life: 0.9,
      maxLife: 0.9,
      text,
      color,
      size,
    });
  }

  addShake(amount: number, duration: number): void {
    this.shake = Math.min(4, Math.max(this.shake, amount));
    this.shakeDecay = Math.max(this.shakeDecay, duration);
  }

  update(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i] as Particle;
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = Math.max(0, 1 - p.drag * dt);
      p.vx *= drag;
      p.vy *= drag;
    }

    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i] as FloatingNumber;
      n.life -= dt;
      if (n.life <= 0) {
        this.numbers.splice(i, 1);
        continue;
      }
      n.y += n.vy * dt;
      n.vy *= Math.max(0, 1 - 1.8 * dt);
    }

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - (dt / Math.max(0.05, this.shakeDecay)) * this.shake * 3);
      this.shakeX = (Math.random() - 0.5) * this.shake * 2;
      this.shakeY = (Math.random() - 0.5) * this.shake * 2;
      if (this.shake < 0.02) {
        this.shake = 0;
        this.shakeX = 0;
        this.shakeY = 0;
      }
    }
  }

  /** Draws particles in arena space. The caller sets up the transform. */
  draw(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.max(0, t);
      if (p.ring) {
        const radius = p.size * (1 - t) + 1;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 0.5 + t * 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const size = p.shrink ? p.size * t : p.size;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.05, size), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Draws floating numbers. Text is drawn in screen space for legibility. */
  drawNumbers(
    ctx: CanvasRenderingContext2D,
    toScreen: (x: number, y: number) => { x: number; y: number },
  ): void {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of this.numbers) {
      const t = n.life / n.maxLife;
      const pos = toScreen(n.x, n.y);
      const fontSize = 13 * n.size * (0.85 + t * 0.35);
      ctx.globalAlpha = Math.min(1, t * 1.8);
      ctx.font = `700 ${fontSize.toFixed(1)}px "Segoe UI", system-ui, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.strokeText(n.text, pos.x, pos.y);
      ctx.fillStyle = n.color;
      ctx.fillText(n.text, pos.x, pos.y);
    }
    ctx.globalAlpha = 1;
  }

  get count(): number {
    return this.particles.length + this.numbers.length;
  }

  clear(): void {
    this.particles.length = 0;
    this.numbers.length = 0;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }
}
