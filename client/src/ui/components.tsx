/**
 * Shared UI pieces used across the screens.
 */

import { useEffect, useRef } from 'react';
import {
  CardType,
  Layer,
  TargetClass,
  type CardDef,
} from '@riftbound/shared';

import { drawEmblem, paletteFor } from '../game/art.js';

// ---------------------------------------------------------------------------
// Card art
// ---------------------------------------------------------------------------

/**
 * Renders a card's procedural emblem into a small canvas.
 * Animated cards keep a rAF loop; static ones draw once, which keeps a full
 * collection grid cheap.
 */
export function CardArt({
  card,
  size = 96,
  animated = false,
  className,
  fill = false,
}: {
  card: CardDef;
  size?: number;
  animated?: boolean;
  className?: string;
  /**
   * Stretch to the container instead of sitting at an intrinsic pixel size.
   * The canvas still renders at `size` and is scaled by CSS, which keeps the
   * drawing cost fixed however large the slot is.
   */
  fill?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const palette = paletteFor(card);
    let frame = 0;
    let running = true;

    const render = (time: number): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      // Backdrop wash in the faction colour.
      const gradient = ctx.createRadialGradient(
        size / 2,
        size / 2,
        size * 0.1,
        size / 2,
        size / 2,
        size * 0.72,
      );
      gradient.addColorStop(0, palette.dark);
      gradient.addColorStop(1, 'rgba(8, 12, 22, 1)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);

      drawEmblem(
        ctx,
        card.artwork,
        card.faction,
        size / 2,
        size / 2,
        size * 0.33,
        animated ? time / 1000 : 0.6,
        palette,
      );

      if (animated && running) frame = requestAnimationFrame(render);
    };

    render(performance.now());
    return () => {
      running = false;
      cancelAnimationFrame(frame);
    };
  }, [card, size, animated]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={
        fill
          ? { width: '100%', height: '100%', display: 'block', objectFit: 'contain' }
          : { width: size, height: size, display: 'block' }
      }
      aria-label={`${card.name} artwork`}
      role="img"
    />
  );
}

// ---------------------------------------------------------------------------
// Card tile
// ---------------------------------------------------------------------------

export function CardTile({
  card,
  selected = false,
  locked = false,
  unaffordable = false,
  onClick,
  size = 96,
  showName = true,
  animated = false,
}: {
  card: CardDef;
  selected?: boolean;
  locked?: boolean;
  unaffordable?: boolean;
  onClick?: () => void;
  size?: number;
  showName?: boolean;
  animated?: boolean;
}): JSX.Element {
  const classes = [
    'card-tile',
    selected ? 'card-tile--selected' : '',
    locked ? 'card-tile--locked' : '',
    unaffordable ? 'card-tile--unaffordable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      disabled={locked || !onClick}
      title={locked ? `${card.name} (locked)` : card.name}
      aria-pressed={selected}
    >
      <span className={`card-tile__rarity rarity--${card.rarity}`} aria-hidden="true" />
      <span className="card-tile__cost">{card.cost}</span>
      <span className="card-tile__art">
        <CardArt card={card} size={size} animated={animated} />
      </span>
      {showName && <span className="card-tile__name">{card.name}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Card detail panel
// ---------------------------------------------------------------------------

/** A readable one-line summary of what a card can attack. */
function targetSummary(card: CardDef): string {
  switch (card.targets) {
    case TargetClass.All:
      return 'Ground and air';
    case TargetClass.Air:
      return 'Air only';
    case TargetClass.BuildingsOnly:
      return 'Buildings only';
    default:
      return 'Ground only';
  }
}

export function CardDetail({ card }: { card: CardDef }): JSX.Element {
  const isSpell = card.type === CardType.Spell;

  return (
    <div className="card-detail">
      <CardArt card={card} size={150} animated />
      <h2 className="card-detail__name">{card.name}</h2>
      <div className="card-detail__type">
        {card.rarity} &middot; {card.faction} &middot; {card.type} &middot; {card.cost} energy
      </div>
      <p className="card-detail__text">{card.description}</p>
      {card.flavor && <p className="card-detail__flavor">{card.flavor}</p>}

      <div className="tag-row">
        {card.roles.map((role) => (
          <span className="tag" key={role}>
            {role}
          </span>
        ))}
      </div>

      <div className="statline">
        {!isSpell && (
          <>
            <span className="statline__label">Health</span>
            <span className="statline__value">
              {card.health}
              {(card.spawnAmount ?? 1) > 1 ? ` x${card.spawnAmount}` : ''}
            </span>

            <span className="statline__label">Damage</span>
            <span className="statline__value">{card.damage}</span>

            <span className="statline__label">Attack speed</span>
            <span className="statline__value">{card.attackSpeed?.toFixed(2)}/s</span>

            <span className="statline__label">Damage per second</span>
            <span className="statline__value">
              {Math.round((card.damage ?? 0) * (card.attackSpeed ?? 0))}
            </span>

            <span className="statline__label">Range</span>
            <span className="statline__value">
              {(card.range ?? 0) <= 2.5 ? 'Melee' : card.range?.toFixed(0)}
            </span>

            {card.type !== CardType.Building && (
              <>
                <span className="statline__label">Speed</span>
                <span className="statline__value">{card.movementSpeed?.toFixed(1)}</span>
              </>
            )}

            <span className="statline__label">Layer</span>
            <span className="statline__value">
              {card.layer === Layer.Air ? 'Air' : 'Ground'}
            </span>

            <span className="statline__label">Targets</span>
            <span className="statline__value">{targetSummary(card)}</span>

            {(card.splashRadius ?? 0) > 0 && (
              <>
                <span className="statline__label">Splash radius</span>
                <span className="statline__value">{card.splashRadius}</span>
              </>
            )}

            {(card.armor ?? 0) > 0 && (
              <>
                <span className="statline__label">Armor</span>
                <span className="statline__value">{card.armor}</span>
              </>
            )}

            {card.lifetime !== undefined && (
              <>
                <span className="statline__label">Lifetime</span>
                <span className="statline__value">{card.lifetime}s</span>
              </>
            )}
          </>
        )}

        {isSpell && card.spell && (
          <>
            <span className="statline__label">Radius</span>
            <span className="statline__value">{card.spell.radius}</span>

            {card.spell.damage !== undefined && (
              <>
                <span className="statline__label">Damage</span>
                <span className="statline__value">{card.spell.damage}</span>

                <span className="statline__label">vs structures</span>
                <span className="statline__value">
                  {Math.round((card.spell.buildingDamageFactor ?? 0.4) * 100)}%
                </span>
              </>
            )}

            {card.spell.heal !== undefined && (
              <>
                <span className="statline__label">Healing</span>
                <span className="statline__value">{card.spell.heal}</span>
              </>
            )}

            {card.spell.delay !== undefined && (
              <>
                <span className="statline__label">Delay</span>
                <span className="statline__value">{card.spell.delay}s</span>
              </>
            )}

            {card.spell.impacts !== undefined && card.spell.impacts > 1 && (
              <>
                <span className="statline__label">Impacts</span>
                <span className="statline__value">{card.spell.impacts}</span>
              </>
            )}
          </>
        )}
      </div>

      {card.abilities && card.abilities.length > 0 && (
        <>
          <div className="section-title">Abilities</div>
          <div className="tag-row">
            {card.abilities.map((ability) => (
              <span className="tag" key={ability.kind}>
                {ability.kind.replace(/-/g, ' ')}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`toggle ${value ? 'toggle--on' : ''}`}
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      aria-label={label}
    >
      <span className="toggle__knob" />
    </button>
  );
}

export function Stat({ value, label }: { value: string | number; label: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

export function TopBar({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="topbar">
      <button type="button" className="btn btn--ghost" onClick={onBack}>
        &larr; Back
      </button>
      <h1 className="topbar__title">{title}</h1>
      <div className="topbar__meta">{children}</div>
    </div>
  );
}
