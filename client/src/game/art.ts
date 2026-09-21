/**
 * Procedural card and unit art.
 *
 * The game ships no image files. Every creature, structure and spell is drawn
 * from code into a canvas, which keeps the whole project self-contained and
 * means art scales cleanly to any resolution. Each card's `artwork` key
 * selects a shape function here.
 *
 * Shapes are drawn in a normalised space: the caller sets up the transform so
 * a shape draws into roughly a unit circle centred on the origin.
 */

import { Faction, type CardDef } from '@riftbound/shared';

export interface FactionPalette {
  primary: string;
  secondary: string;
  glow: string;
  dark: string;
}

/** Each faction reads as a distinct colour family at a glance. */
export const FACTION_PALETTE: Record<Faction, FactionPalette> = {
  [Faction.Forge]: {
    primary: '#ff9d4d',
    secondary: '#ffd28a',
    glow: 'rgba(255, 157, 77, 0.55)',
    dark: '#7a3f12',
  },
  [Faction.Rift]: {
    primary: '#b98cff',
    secondary: '#e2d0ff',
    glow: 'rgba(185, 140, 255, 0.55)',
    dark: '#3d2a66',
  },
  [Faction.Bloom]: {
    primary: '#5de6a8',
    secondary: '#c2ffe4',
    glow: 'rgba(93, 230, 168, 0.55)',
    dark: '#175e40',
  },
  [Faction.Chrono]: {
    primary: '#63c9ff',
    secondary: '#c9ecff',
    glow: 'rgba(99, 201, 255, 0.55)',
    dark: '#123f5e',
  },
};

/** Team tinting for units on the battlefield. */
export const TEAM_COLOR = {
  blue: { primary: '#4fa8ff', glow: 'rgba(79, 168, 255, 0.6)', dark: '#0d3a6b' },
  red: { primary: '#ff5f6d', glow: 'rgba(255, 95, 109, 0.6)', dark: '#6b1620' },
};

type ShapeFn = (ctx: CanvasRenderingContext2D, p: FactionPalette, t: number) => void;

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function polygon(ctx: CanvasRenderingContext2D, sides: number, radius: number, rotation = 0): void {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i / sides) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function star(
  ctx: CanvasRenderingContext2D,
  points: number,
  outer: number,
  inner: number,
  rotation = 0,
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = rotation + (i / (points * 2)) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function blob(
  ctx: CanvasRenderingContext2D,
  radius: number,
  wobble: number,
  t: number,
  lobes = 5,
): void {
  ctx.beginPath();
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const r = radius * (1 + Math.sin(angle * lobes + t * 2) * wobble);
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function eye(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Shapes, one per artwork key
// ---------------------------------------------------------------------------

const SHAPES: Record<string, ShapeFn> = {
  // --- Rift ---------------------------------------------------------------
  wraith: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    ctx.globalAlpha = 0.85;
    blob(ctx, 0.7, 0.14, t, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    // Trailing wisps.
    ctx.strokeStyle = p.secondary;
    ctx.lineWidth = 0.09;
    ctx.beginPath();
    for (let i = -1; i <= 1; i++) {
      ctx.moveTo(i * 0.28, 0.35);
      ctx.quadraticCurveTo(i * 0.4, 0.75 + Math.sin(t * 3 + i) * 0.1, i * 0.2, 1);
    }
    ctx.stroke();
    eye(ctx, -0.22, -0.16, 0.1, p.secondary);
    eye(ctx, 0.22, -0.16, 0.1, p.secondary);
  },
  mite: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    polygon(ctx, 6, 0.62, t * 0.6);
    ctx.fill();
    ctx.fillStyle = p.secondary;
    polygon(ctx, 6, 0.3, -t * 0.9);
    ctx.fill();
  },
  'mite-echo': (ctx, p, t) => {
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = p.secondary;
    ctx.lineWidth = 0.1;
    polygon(ctx, 6, 0.6, t * 0.6);
    ctx.stroke();
    ctx.globalAlpha = 1;
  },
  architect: (ctx, p, t) => {
    ctx.strokeStyle = p.primary;
    ctx.lineWidth = 0.12;
    polygon(ctx, 3, 0.78, -Math.PI / 2);
    ctx.stroke();
    ctx.fillStyle = p.secondary;
    polygon(ctx, 3, 0.34, -Math.PI / 2 + t);
    ctx.fill();
    // Orbiting construction nodes.
    for (let i = 0; i < 3; i++) {
      const a = t * 1.4 + (i / 3) * Math.PI * 2;
      eye(ctx, Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.09, p.secondary);
    }
  },
  runner: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    ctx.beginPath();
    ctx.moveTo(0, -0.8);
    ctx.lineTo(0.45, 0.5);
    ctx.lineTo(0, 0.22);
    ctx.lineTo(-0.45, 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.45 + Math.sin(t * 8) * 0.2;
    ctx.fillStyle = p.secondary;
    ctx.beginPath();
    ctx.moveTo(0, -0.4);
    ctx.lineTo(0.2, 0.7);
    ctx.lineTo(-0.2, 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  },
  stalker: (ctx, p, t) => {
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = p.dark;
    blob(ctx, 0.66, 0.1, t, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = p.primary;
    ctx.lineWidth = 0.08;
    blob(ctx, 0.68, 0.1, t, 4);
    ctx.stroke();
    eye(ctx, 0, -0.1, 0.13, p.secondary);
  },
  choir: (ctx, p, t) => {
    for (let i = 0; i < 3; i++) {
      const a = t * 1.1 + (i / 3) * Math.PI * 2;
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = i === 0 ? p.secondary : p.primary;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * 0.36, Math.sin(a) * 0.3, 0.3, 0.38, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },

  // --- Forge --------------------------------------------------------------
  'gravity-forge': (ctx, p, t) => {
    ctx.strokeStyle = p.primary;
    ctx.lineWidth = 0.1;
    for (let ring = 0; ring < 3; ring++) {
      const r = 0.36 + ring * 0.22;
      ctx.globalAlpha = 0.85 - ring * 0.22;
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * (0.45 + Math.sin(t * 1.6 + ring) * 0.12), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.secondary;
    ctx.beginPath();
    ctx.arc(0, 0, 0.2, 0, Math.PI * 2);
    ctx.fill();
  },
  golem: (ctx, p, t) => {
    ctx.fillStyle = p.dark;
    polygon(ctx, 6, 0.82, Math.PI / 6);
    ctx.fill();
    ctx.fillStyle = p.primary;
    polygon(ctx, 6, 0.6, Math.PI / 6);
    ctx.fill();
    // Magnetic field lines.
    ctx.strokeStyle = p.secondary;
    ctx.lineWidth = 0.06;
    ctx.globalAlpha = 0.5 + Math.sin(t * 4) * 0.3;
    ctx.beginPath();
    ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    eye(ctx, 0, -0.08, 0.14, p.secondary);
  },
  bastion: (ctx, p) => {
    ctx.fillStyle = p.dark;
    ctx.fillRect(-0.74, -0.6, 1.48, 1.2);
    ctx.fillStyle = p.primary;
    ctx.fillRect(-0.58, -0.46, 1.16, 0.92);
    ctx.fillStyle = p.secondary;
    for (let i = -1; i <= 1; i++) ctx.fillRect(i * 0.34 - 0.07, -0.3, 0.14, 0.6);
  },
  drone: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.5, 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.secondary;
    ctx.lineWidth = 0.07;
    const spin = Math.sin(t * 14) * 0.5 + 0.6;
    ctx.beginPath();
    ctx.moveTo(-0.8 * spin, -0.3);
    ctx.lineTo(0.8 * spin, -0.3);
    ctx.stroke();
    eye(ctx, 0, 0.02, 0.11, p.secondary);
  },
  mote: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    star(ctx, 4, 0.5, 0.18, t * 2);
    ctx.fill();
  },
  crawler: (ctx, p, t) => {
    ctx.fillStyle = p.dark;
    ctx.fillRect(-0.7, -0.34, 1.4, 0.68);
    ctx.fillStyle = p.primary;
    ctx.fillRect(-0.55, -0.22, 1.1, 0.44);
    // Legs.
    ctx.strokeStyle = p.dark;
    ctx.lineWidth = 0.09;
    ctx.beginPath();
    for (let i = -2; i <= 2; i++) {
      const lift = Math.sin(t * 6 + i) * 0.1;
      ctx.moveTo(i * 0.26, 0.28);
      ctx.lineTo(i * 0.26, 0.62 + lift);
    }
    ctx.stroke();
    // Siege barrel.
    ctx.fillStyle = p.secondary;
    ctx.fillRect(-0.1, -0.76, 0.2, 0.44);
  },
  drummer: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    ctx.beginPath();
    ctx.arc(0, 0, 0.56, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.secondary;
    ctx.lineWidth = 0.08;
    const pulse = 0.68 + Math.abs(Math.sin(t * 3)) * 0.3;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.arc(0, 0, pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.secondary;
    ctx.fillRect(-0.06, -0.86, 0.12, 0.34);
  },
  spire: (ctx, p, t) => {
    ctx.fillStyle = p.dark;
    ctx.beginPath();
    ctx.moveTo(0, -0.9);
    ctx.lineTo(0.46, 0.72);
    ctx.lineTo(-0.46, 0.72);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = p.primary;
    ctx.beginPath();
    ctx.moveTo(0, -0.62);
    ctx.lineTo(0.28, 0.6);
    ctx.lineTo(-0.28, 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.5 + Math.sin(t * 3) * 0.4;
    eye(ctx, 0, -0.66, 0.14, p.secondary);
    ctx.globalAlpha = 1;
  },

  // --- Bloom --------------------------------------------------------------
  seed: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    ctx.beginPath();
    ctx.ellipse(0, 0.1, 0.42, 0.54, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.secondary;
    ctx.lineWidth = 0.08;
    ctx.beginPath();
    ctx.moveTo(0, -0.42);
    ctx.quadraticCurveTo(Math.sin(t * 2) * 0.3, -0.72, 0, -0.95);
    ctx.stroke();
    // Stored charge.
    ctx.globalAlpha = 0.4 + Math.abs(Math.sin(t * 5)) * 0.5;
    eye(ctx, 0, 0.1, 0.16, p.secondary);
    ctx.globalAlpha = 1;
  },
  'plasma-bloom': (ctx, p, t) => {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + t * 0.5;
      ctx.fillStyle = i % 2 === 0 ? p.primary : p.dark;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * 0.42, Math.sin(a) * 0.42, 0.26, 0.16, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = p.secondary;
    ctx.beginPath();
    ctx.arc(0, 0, 0.26 + Math.sin(t * 4) * 0.05, 0, Math.PI * 2);
    ctx.fill();
  },
  hound: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    ctx.beginPath();
    ctx.moveTo(-0.6, 0.3);
    ctx.lineTo(-0.2, -0.45);
    ctx.lineTo(0.35, -0.3);
    ctx.lineTo(0.62, 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = p.secondary;
    ctx.beginPath();
    ctx.moveTo(0.3, -0.32);
    ctx.lineTo(0.62, -0.72);
    ctx.lineTo(0.5, -0.2);
    ctx.closePath();
    ctx.fill();
    eye(ctx, 0.3, -0.06, 0.08, p.dark);
    // Running legs.
    ctx.strokeStyle = p.dark;
    ctx.lineWidth = 0.08;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const x = -0.4 + i * 0.4;
      ctx.moveTo(x, 0.3);
      ctx.lineTo(x + Math.sin(t * 9 + i) * 0.14, 0.66);
    }
    ctx.stroke();
  },
  warden: (ctx, p, t) => {
    ctx.strokeStyle = p.primary;
    ctx.lineWidth = 0.1;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + t * 0.7;
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.72, 0.3, a, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = p.secondary;
    ctx.beginPath();
    ctx.arc(0, 0, 0.24, 0, Math.PI * 2);
    ctx.fill();
  },
  spore: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    blob(ctx, 0.6, 0.12, t, 6);
    ctx.fill();
    ctx.fillStyle = p.dark;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + t * 0.4;
      eye(ctx, Math.cos(a) * 0.32, Math.sin(a) * 0.32, 0.1, p.dark);
    }
  },
  titan: (ctx, p, t) => {
    ctx.fillStyle = p.dark;
    polygon(ctx, 7, 0.88, t * 0.15);
    ctx.fill();
    ctx.fillStyle = p.primary;
    polygon(ctx, 7, 0.66, t * 0.15);
    ctx.fill();
    ctx.fillStyle = p.secondary;
    polygon(ctx, 3, 0.3, -t * 0.4);
    ctx.fill();
  },
  shard: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    polygon(ctx, 3, 0.52, t);
    ctx.fill();
  },

  // --- Chrono -------------------------------------------------------------
  fox: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    ctx.beginPath();
    ctx.moveTo(-0.55, 0.32);
    ctx.lineTo(-0.15, -0.38);
    ctx.lineTo(0.42, -0.26);
    ctx.lineTo(0.6, 0.34);
    ctx.closePath();
    ctx.fill();
    // Ears.
    ctx.fillStyle = p.secondary;
    for (const x of [0.12, 0.42]) {
      ctx.beginPath();
      ctx.moveTo(x, -0.34);
      ctx.lineTo(x + 0.1, -0.74);
      ctx.lineTo(x + 0.22, -0.3);
      ctx.closePath();
      ctx.fill();
    }
    // Afterimage tail.
    ctx.globalAlpha = 0.35 + Math.sin(t * 6) * 0.2;
    ctx.fillStyle = p.secondary;
    ctx.beginPath();
    ctx.ellipse(-0.7, 0.1, 0.32, 0.16, Math.sin(t * 3) * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  },
  witch: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    ctx.beginPath();
    ctx.moveTo(0, -0.82);
    ctx.lineTo(0.5, 0.6);
    ctx.lineTo(-0.5, 0.6);
    ctx.closePath();
    ctx.fill();
    // The echo, trailing behind.
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = p.secondary;
    ctx.beginPath();
    const off = Math.sin(t * 3) * 0.12;
    ctx.moveTo(off, -0.6);
    ctx.lineTo(0.36 + off, 0.5);
    ctx.lineTo(-0.36 + off, 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    eye(ctx, 0, -0.3, 0.1, p.secondary);
  },
  lantern: (ctx, p, t) => {
    ctx.strokeStyle = p.primary;
    ctx.lineWidth = 0.1;
    polygon(ctx, 6, 0.56, Math.PI / 6);
    ctx.stroke();
    ctx.globalAlpha = 0.45 + Math.sin(t * 2.4) * 0.3;
    ctx.fillStyle = p.secondary;
    polygon(ctx, 6, 0.44, Math.PI / 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    // Frost spikes.
    ctx.strokeStyle = p.secondary;
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + t * 0.3;
      ctx.moveTo(Math.cos(a) * 0.6, Math.sin(a) * 0.6);
      ctx.lineTo(Math.cos(a) * 0.92, Math.sin(a) * 0.92);
    }
    ctx.stroke();
  },
  twins: (ctx, p, t) => {
    for (const [dx, alpha] of [[-0.24, 1], [0.24, 0.75]] as Array<[number, number]>) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = alpha === 1 ? p.primary : p.secondary;
      ctx.beginPath();
      ctx.moveTo(dx, -0.62 + Math.sin(t * 4 + dx) * 0.05);
      ctx.lineTo(dx + 0.26, 0.5);
      ctx.lineTo(dx - 0.26, 0.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
  lancer: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    ctx.beginPath();
    ctx.ellipse(0, 0.16, 0.4, 0.46, 0, 0, Math.PI * 2);
    ctx.fill();
    // The lance, folding space.
    ctx.strokeStyle = p.secondary;
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    ctx.moveTo(-0.1, 0.1);
    ctx.lineTo(0.15 + Math.sin(t * 2) * 0.06, -0.95);
    ctx.stroke();
    ctx.fillStyle = p.secondary;
    polygon(ctx, 3, 0.16, -Math.PI / 2);
    ctx.fill();
  },

  // --- Spells -------------------------------------------------------------
  'rift-blast': (ctx, p, t) => {
    ctx.strokeStyle = p.primary;
    ctx.lineWidth = 0.12;
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.9 - i * 0.25;
      ctx.beginPath();
      ctx.arc(0, 0, 0.32 + i * 0.26 + Math.sin(t * 5) * 0.05, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.secondary;
    star(ctx, 6, 0.36, 0.13, t);
    ctx.fill();
  },
  'time-fracture': (ctx, p, t) => {
    ctx.strokeStyle = p.primary;
    ctx.lineWidth = 0.09;
    ctx.beginPath();
    ctx.arc(0, 0, 0.66, 0, Math.PI * 2);
    ctx.stroke();
    // Clock hands, running backwards.
    ctx.lineWidth = 0.1;
    ctx.strokeStyle = p.secondary;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(-t * 2) * 0.44, Math.sin(-t * 2) * 0.44);
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(-t * 0.6) * 0.6, Math.sin(-t * 0.6) * 0.6);
    ctx.stroke();
    // Fracture lines.
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.6;
      ctx.moveTo(Math.cos(a) * 0.66, Math.sin(a) * 0.66);
      ctx.lineTo(Math.cos(a) * 1, Math.sin(a) * 1);
    }
    ctx.stroke();
  },
  surge: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    ctx.beginPath();
    ctx.moveTo(-0.22, -0.9);
    ctx.lineTo(0.3, -0.12);
    ctx.lineTo(0.02, -0.12);
    ctx.lineTo(0.28, 0.9);
    ctx.lineTo(-0.34, 0.02);
    ctx.lineTo(-0.02, 0.02);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.3 + Math.abs(Math.sin(t * 6)) * 0.5;
    ctx.strokeStyle = p.secondary;
    ctx.lineWidth = 0.07;
    ctx.stroke();
    ctx.globalAlpha = 1;
  },
  'void-pulse': (ctx, p, t) => {
    ctx.fillStyle = p.dark;
    ctx.beginPath();
    ctx.arc(0, 0, 0.44, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.primary;
    ctx.lineWidth = 0.08;
    for (let i = 0; i < 3; i++) {
      const r = 0.5 + ((t * 0.7 + i / 3) % 1) * 0.5;
      ctx.globalAlpha = 1 - ((t * 0.7 + i / 3) % 1);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  meteor: (ctx, p, t) => {
    for (let i = 0; i < 3; i++) {
      const offset = ((t * 0.9 + i / 3) % 1) * 1.6 - 0.8;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = i === 1 ? p.secondary : p.primary;
      ctx.beginPath();
      ctx.arc(-0.3 + i * 0.3, offset, 0.17, 0, Math.PI * 2);
      ctx.fill();
      // Tail.
      ctx.strokeStyle = p.primary;
      ctx.lineWidth = 0.07;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(-0.3 + i * 0.3, offset);
      ctx.lineTo(-0.44 + i * 0.3, offset - 0.4);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  mend: (ctx, p, t) => {
    ctx.fillStyle = p.primary;
    const s = 0.2 + Math.sin(t * 2.5) * 0.02;
    ctx.fillRect(-s, -0.68, s * 2, 1.36);
    ctx.fillRect(-0.68, -s, 1.36, s * 2);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = p.secondary;
    ctx.lineWidth = 0.07;
    ctx.beginPath();
    ctx.arc(0, 0, 0.8 + Math.sin(t * 2) * 0.06, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  },

  // --- Towers -------------------------------------------------------------
  core: (ctx, p, t) => {
    ctx.fillStyle = p.dark;
    polygon(ctx, 8, 0.9, Math.PI / 8);
    ctx.fill();
    ctx.fillStyle = p.primary;
    polygon(ctx, 8, 0.68, Math.PI / 8);
    ctx.fill();
    ctx.globalAlpha = 0.6 + Math.sin(t * 2) * 0.3;
    ctx.fillStyle = p.secondary;
    polygon(ctx, 4, 0.34, t * 0.6);
    ctx.fill();
    ctx.globalAlpha = 1;
  },
  guard: (ctx, p, t) => {
    ctx.fillStyle = p.dark;
    polygon(ctx, 6, 0.86, Math.PI / 6);
    ctx.fill();
    ctx.fillStyle = p.primary;
    polygon(ctx, 6, 0.62, Math.PI / 6);
    ctx.fill();
    ctx.globalAlpha = 0.5 + Math.sin(t * 2.4) * 0.3;
    eye(ctx, 0, 0, 0.2, p.secondary);
    ctx.globalAlpha = 1;
  },
};

/** Fallback for any artwork key without a dedicated shape. */
const DEFAULT_SHAPE: ShapeFn = (ctx, p, t) => {
  ctx.fillStyle = p.primary;
  polygon(ctx, 5, 0.66, t * 0.4);
  ctx.fill();
  ctx.fillStyle = p.secondary;
  ctx.beginPath();
  ctx.arc(0, 0, 0.22, 0, Math.PI * 2);
  ctx.fill();
};

export function getShape(artwork: string): ShapeFn {
  return SHAPES[artwork] ?? DEFAULT_SHAPE;
}

/**
 * Draws a card's emblem centred at (x, y) with the given radius.
 * `time` animates the shape; pass a steady clock for idle motion.
 */
export function drawEmblem(
  ctx: CanvasRenderingContext2D,
  artwork: string,
  faction: Faction,
  x: number,
  y: number,
  radius: number,
  time: number,
  paletteOverride?: FactionPalette,
): void {
  const palette = paletteOverride ?? FACTION_PALETTE[faction] ?? FACTION_PALETTE[Faction.Forge];
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(radius, radius);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  getShape(artwork)(ctx, palette, time);
  ctx.restore();
}

/** Palette for a card, used by both the battlefield and the card tiles. */
export function paletteFor(card: CardDef): FactionPalette {
  return FACTION_PALETTE[card.faction] ?? FACTION_PALETTE[Faction.Forge];
}

/** Blends a faction palette toward a team colour for battlefield units. */
export function teamPalette(base: FactionPalette, team: 'blue' | 'red'): FactionPalette {
  const tint = TEAM_COLOR[team];
  return {
    primary: base.primary,
    secondary: base.secondary,
    glow: tint.glow,
    dark: tint.dark,
  };
}
