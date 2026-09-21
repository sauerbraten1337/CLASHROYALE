/**
 * The battle screen.
 *
 * Owns the render loop, pointer input and the battle HUD. It drives a
 * `MatchSession`, so it is identical for practice and online play.
 *
 * Note that this screen never decides anything about the match. It sends
 * intents and draws whatever snapshot comes back; even in a local match the
 * simulation is the authority and can reject a play.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  CardType,
  ENERGY_MAX,
  FxKind,
  MatchPhase,
  Team,
  getCard,
  isOwnHalf,
  type CardDef,
  type FxEvent,
  type MatchResult,
  type MatchRewards,
  type MatchSnapshot,
  type PlayerState,
} from '@riftbound/shared';

import { Renderer } from '../game/Renderer.js';
import { ParticleSystem } from '../game/particles.js';
import { SoundEvent, audio } from '../game/audio.js';
import { CardArt } from '../ui/components.js';
import type { MatchSession, MatchSessionEvents } from '../net/session.js';
import type { Settings } from '../state/profile.js';

export interface BattleProps {
  /**
   * Builds the session for this match.
   *
   * A factory rather than a ready-made session, because a session needs its
   * event handlers at construction time and those handlers belong to this
   * component. Passing a factory keeps the wiring local instead of forcing a
   * shared mutable bridge between the parent and this screen.
   */
  createSession: (events: MatchSessionEvents) => MatchSession;
  settings: Settings;
  onFinished: (result: MatchResult, rewards: MatchRewards) => void;
  onQuit: () => void;
}

/** A card the player has picked up and is about to place. */
interface HeldCard {
  handIndex: number;
  card: CardDef;
}

export function Battle({ createSession, settings, onFinished, onQuit }: BattleProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const particlesRef = useRef(new ParticleSystem());

  // Mutable refs for values the render loop reads: keeping these out of React
  // state avoids re-rendering the whole screen 60 times a second.
  const snapshotRef = useRef<MatchSnapshot | null>(null);
  const heldRef = useRef<HeldCard | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const settingsRef = useRef(settings);
  const seenFxTickRef = useRef(-1);
  const debugRef = useRef(false);

  // State that the HUD actually renders from, updated at a modest rate.
  const [hud, setHud] = useState<MatchSnapshot | null>(null);
  const [held, setHeld] = useState<HeldCard | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [fps, setFps] = useState(0);

  settingsRef.current = settings;
  debugRef.current = debug;

  // --- Toasts -------------------------------------------------------------

  // Held in a ref as well so the session's handlers, which are created once,
  // always call the current implementation.
  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2200);
  }, []);

  // Late-bound handlers, so the session can be built exactly once while still
  // calling through to the latest callbacks.
  const handlers = useRef({ showToast, onFinished });
  handlers.current = { showToast, onFinished };

  /**
   * The session is created once, on the first render, with handlers that
   * forward into this component. Creating it in a lazy initializer (rather
   * than an effect) guarantees it exists before the render loop starts.
   */
  const [session] = useState<MatchSession>(() =>
    createSession({
      onSnapshot: (snapshot) => {
        snapshotRef.current = snapshot;
        rendererRef.current?.pushSnapshot(snapshot);

        // Turn fx into particles and sound exactly once per snapshot.
        if (snapshot.tick !== seenFxTickRef.current) {
          seenFxTickRef.current = snapshot.tick;
          for (const fx of snapshot.fx) {
            particlesRef.current.emit(fx, settingsRef.current.showDamageNumbers);
            playFxSound(fx);
          }
        }
        if (!settingsRef.current.screenShake) {
          particlesRef.current.shakeX = 0;
          particlesRef.current.shakeY = 0;
        }
      },
      onNotice: (message) => {
        handlers.current.showToast(message);
        audio.play(SoundEvent.CardInvalid);
      },
      onEnd: (result, rewards) => {
        audio.stopMusic();
        const won = result.winner === sessionRef.current.team;
        audio.play(
          result.winner === null
            ? SoundEvent.UiBack
            : won
              ? SoundEvent.Victory
              : SoundEvent.Defeat,
        );
        handlers.current.onFinished(result, rewards);
      },
    }),
  );

  const sessionRef = useRef(session);
  sessionRef.current = session;

  // --- Session lifetime ---------------------------------------------------

  useEffect(() => {
    particlesRef.current.clear();
    seenFxTickRef.current = -1;
    return () => session.dispose();
  }, [session]);

  // --- Canvas setup and the render loop ------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new Renderer(canvas);
    rendererRef.current = renderer;

    const onResize = (): void => renderer.resize();
    window.addEventListener('resize', onResize);
    // Also catch orientation changes and mobile browser chrome resizing.
    const observer = new ResizeObserver(onResize);
    observer.observe(canvas);

    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsClock = 0;
    let hudClock = 0;

    const loop = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      // Local matches are stepped here; online ones are driven by snapshots.
      sessionRef.current.advance(dt);

      particlesRef.current.update(dt);
      renderer.draw(dt, particlesRef.current, {
        viewTeam: sessionRef.current.team,
        placement: computePlacement(
          heldRef.current,
          pointerRef.current,
          sessionRef.current.team,
        ),
        showDeployZone: heldRef.current !== null,
        debug: debugRef.current,
        showHealthBars: settingsRef.current.showHealthBars,
      });

      // Refresh the HUD ~12 times a second rather than every frame.
      hudClock += dt;
      if (hudClock >= 1 / 12) {
        hudClock = 0;
        setHud(snapshotRef.current);
      }

      frames++;
      fpsClock += dt;
      if (fpsClock >= 0.5) {
        setFps(Math.round(frames / fpsClock));
        frames = 0;
        fpsClock = 0;
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      observer.disconnect();
      rendererRef.current = null;
    };
  }, []);

  // --- Leaving the match --------------------------------------------------

  /**
   * Quitting an online match must concede it: the socket stays open when the
   * player navigates away, so without an explicit forfeit the opponent would
   * be left fighting an absent player until the match timed out.
   */
  const quit = useCallback(() => {
    const current = sessionRef.current;
    if (!current.isLocal) {
      // eslint-disable-next-line no-alert
      const confirmed = window.confirm('Leave the match? This counts as a loss.');
      if (!confirmed) return;
      current.forfeit();
    }
    audio.play(SoundEvent.UiBack);
    onQuit();
  }, [onQuit]);

  // --- Music --------------------------------------------------------------

  useEffect(() => {
    audio.startMusic();
    return () => audio.stopMusic();
  }, []);

  // --- Countdown and phase cues -------------------------------------------

  const phase = hud?.phase ?? MatchPhase.Countdown;
  const lastPhaseRef = useRef<MatchPhase | null>(null);
  useEffect(() => {
    if (lastPhaseRef.current === phase) return;
    const previous = lastPhaseRef.current;
    lastPhaseRef.current = phase;
    if (previous === MatchPhase.Countdown && phase === MatchPhase.Active) {
      audio.play(SoundEvent.Fight);
    } else if (phase === MatchPhase.Overcharge) {
      audio.play(SoundEvent.Overcharge);
      showToast('Overcharge! Energy regenerates twice as fast.');
    } else if (phase === MatchPhase.SuddenDeath) {
      audio.play(SoundEvent.Overcharge);
      showToast('Sudden death! The next tower decides it.');
    }
  }, [phase, showToast]);

  // --- Input --------------------------------------------------------------

  const localPlayer = useMemo<PlayerState | null>(() => {
    if (!hud) return null;
    return hud.players.find((p) => p.team === session.team) ?? null;
  }, [hud, session.team]);

  const enemyPlayer = useMemo<PlayerState | null>(() => {
    if (!hud) return null;
    return hud.players.find((p) => p.team !== session.team) ?? null;
  }, [hud, session.team]);

  const selectCard = useCallback(
    (handIndex: number) => {
      const player = snapshotRef.current?.players.find((p) => p.team === sessionRef.current.team);
      const cardId = player?.hand[handIndex];
      const card = cardId ? getCard(cardId) : undefined;
      if (!card) return;

      audio.unlock();

      // Tapping the held card again puts it back down.
      if (heldRef.current?.handIndex === handIndex) {
        heldRef.current = null;
        setHeld(null);
        audio.play(SoundEvent.UiBack);
        return;
      }

      if ((player?.energy ?? 0) < card.cost) {
        showToast(`${card.name} needs ${card.cost} energy.`);
        audio.play(SoundEvent.CardInvalid);
        return;
      }

      const next = { handIndex, card };
      heldRef.current = next;
      setHeld(next);
      audio.play(SoundEvent.UiClick);
    },
    [showToast],
  );

  const attemptPlay = useCallback(
    (clientX: number, clientY: number) => {
      const renderer = rendererRef.current;
      const holding = heldRef.current;
      if (!renderer || !holding) return;

      const point = renderer.screenToArena(clientX, clientY, sessionRef.current.team);
      if (!isPlacementLegal(holding.card, point, sessionRef.current.team)) {
        showToast(
          holding.card.type === CardType.Spell
            ? 'Cannot target outside the arena.'
            : 'Units deploy on your own half.',
        );
        audio.play(SoundEvent.CardInvalid);
        return;
      }

      sessionRef.current.play(holding.handIndex, point.x, point.y);
      audio.play(
        holding.card.type === CardType.Spell ? SoundEvent.Spell : SoundEvent.CardPlayed,
      );
      heldRef.current = null;
      setHeld(null);
    },
    [showToast],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (!renderer || !heldRef.current) {
      pointerRef.current = null;
      return;
    }
    pointerRef.current = renderer.screenToArena(
      event.clientX,
      event.clientY,
      sessionRef.current.team,
    );
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      audio.unlock();
      if (!heldRef.current) return;
      const renderer = rendererRef.current;
      if (renderer) {
        pointerRef.current = renderer.screenToArena(
          event.clientX,
          event.clientY,
          sessionRef.current.team,
        );
      }
      attemptPlay(event.clientX, event.clientY);
    },
    [attemptPlay],
  );

  const onPointerLeave = useCallback(() => {
    pointerRef.current = null;
  }, []);

  // --- Keyboard: hand slots plus developer shortcuts ----------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Hand slots on 1-4.
      if (event.key >= '1' && event.key <= '4') {
        selectCard(Number(event.key) - 1);
        return;
      }
      if (event.key === 'Escape') {
        heldRef.current = null;
        setHeld(null);
        return;
      }

      switch (event.key) {
        case 'F1':
          event.preventDefault();
          setDebug((d) => !d);
          break;

        // The remaining shortcuts mutate the match, so they are only ever
        // available in a local practice match. In online play the server
        // would reject them anyway, but they are not even offered.
        case 'F2':
          if (!sessionRef.current.allowsDevTools) return;
          event.preventDefault();
          sessionRef.current.devSpawnTestUnit?.();
          showToast('Debug: spawned test unit');
          break;

        case 'F3':
          if (!sessionRef.current.allowsDevTools) return;
          event.preventDefault();
          sessionRef.current.devAddEnergy?.(3);
          showToast('Debug: +3 energy');
          break;

        case 'F4':
          if (!sessionRef.current.allowsDevTools) return;
          event.preventDefault();
          showToast('Debug: restarting match');
          onQuit();
          break;

        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectCard, showToast, onQuit]);

  // --- Render -------------------------------------------------------------

  const energy = localPlayer?.energy ?? 0;
  const overcharged = phase === MatchPhase.Overcharge || phase === MatchPhase.SuddenDeath;
  const timeRemaining = hud?.timeRemaining ?? 0;
  const countingDown = phase === MatchPhase.Countdown;

  return (
    <div className="screen battle">
      <BattleHud
        enemy={enemyPlayer}
        local={localPlayer}
        timeRemaining={timeRemaining}
        phase={phase}
        opponentName={session.opponentName}
        onQuit={quit}
      />

      <div className="battle__arena">
        <canvas
          ref={canvasRef}
          className="battle__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
        />

        {countingDown && <CountdownOverlay snapshot={hud} />}

        {toast && <div className="toast">{toast}</div>}

        {debug && (
          <DebugOverlay
            fps={fps}
            snapshot={hud}
            session={session}
            particles={particlesRef.current.count}
          />
        )}
      </div>

      <Hand
        player={localPlayer}
        heldIndex={held?.handIndex ?? null}
        energy={energy}
        overcharged={overcharged}
        onSelect={selectCard}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// HUD pieces
// ---------------------------------------------------------------------------

function BattleHud({
  enemy,
  local,
  timeRemaining,
  phase,
  opponentName,
  onQuit,
}: {
  enemy: PlayerState | null;
  local: PlayerState | null;
  timeRemaining: number;
  phase: MatchPhase;
  opponentName: string;
  onQuit: () => void;
}): JSX.Element {
  const minutes = Math.floor(Math.max(0, timeRemaining) / 60);
  const seconds = Math.floor(Math.max(0, timeRemaining) % 60);
  const urgent = timeRemaining <= 30 && phase !== MatchPhase.Countdown;

  return (
    <div className="hud">
      <button type="button" className="btn btn--ghost" onClick={onQuit} title="Leave match">
        &#10005;
      </button>

      <span className="hud__name">{enemy?.name ?? opponentName}</span>
      <TowerPips count={enemy?.towersRemaining ?? 3} team={enemy?.team ?? Team.Red} />
      {enemy?.disconnected && <span className="hud__phase">Disconnected</span>}

      {phase === MatchPhase.Overcharge && <span className="hud__phase">Overcharge x2</span>}
      {phase === MatchPhase.SuddenDeath && <span className="hud__phase">Sudden death</span>}

      <span className={`hud__timer ${urgent ? 'hud__timer--urgent' : ''}`}>
        {minutes}:{seconds.toString().padStart(2, '0')}
      </span>

      <TowerPips count={local?.towersRemaining ?? 3} team={local?.team ?? Team.Blue} />
      <span className="hud__name">{local?.name ?? 'You'}</span>
    </div>
  );
}

function TowerPips({ count, team }: { count: number; team: Team }): JSX.Element {
  const suffix = team === Team.Blue ? 'blue' : 'red';
  return (
    <span className="hud__towers" title={`${count} towers remaining`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`tower-pip ${i < count ? `tower-pip--alive-${suffix}` : ''}`}
        />
      ))}
    </span>
  );
}

function Hand({
  player,
  heldIndex,
  energy,
  overcharged,
  onSelect,
}: {
  player: PlayerState | null;
  heldIndex: number | null;
  energy: number;
  overcharged: boolean;
  onSelect: (index: number) => void;
}): JSX.Element {
  const nextCard = player?.nextCard ? getCard(player.nextCard) : undefined;
  const pct = Math.min(100, (energy / ENERGY_MAX) * 100);

  return (
    <div className="hand">
      <div className="energy">
        <div className="energy__track">
          <div
            className={`energy__fill ${overcharged ? 'energy__fill--overcharge' : ''}`}
            style={{ width: `${pct}%` }}
          />
          <div className="energy__ticks">
            {Array.from({ length: ENERGY_MAX }, (_, i) => (
              <span className="energy__tick" key={i} />
            ))}
          </div>
        </div>
        <span className="energy__value">{energy.toFixed(1)}</span>
      </div>

      <div className="hand__cards">
        {(player?.hand ?? ['', '', '', '']).map((cardId, index) => {
          const card = cardId ? getCard(cardId) : undefined;
          if (!card) {
            return <div className="hand__slot" key={index} />;
          }
          return (
            <div className="hand__slot" key={`${cardId}-${index}`}>
              <CardTileCompact
                card={card}
                selected={heldIndex === index}
                affordable={energy >= card.cost}
                onClick={() => onSelect(index)}
                slotNumber={index + 1}
              />
            </div>
          );
        })}
      </div>

      {nextCard && (
        <div className="hand__next">
          <span>Next</span>
          <span className="hand__next-art">
            <CardArt card={nextCard} size={24} />
          </span>
          <span>{nextCard.name}</span>
        </div>
      )}
    </div>
  );
}

/** A hand card: bigger tap target, no name, always shows its cost. */
function CardTileCompact({
  card,
  selected,
  affordable,
  onClick,
  slotNumber,
}: {
  card: CardDef;
  selected: boolean;
  affordable: boolean;
  onClick: () => void;
  slotNumber: number;
}): JSX.Element {
  const classes = [
    'card-tile',
    selected ? 'card-tile--selected' : '',
    affordable ? '' : 'card-tile--unaffordable',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      style={{ height: '100%' }}
      title={`${card.name} - ${card.cost} energy (key ${slotNumber})`}
      aria-pressed={selected}
    >
      <span className={`card-tile__rarity rarity--${card.rarity}`} aria-hidden="true" />
      <span className="card-tile__cost">{card.cost}</span>
      <span className="card-tile__art card-tile__art--fill">
        <CardArt card={card} size={96} animated={selected} fill />
      </span>
      <span className="card-tile__name">{card.name}</span>
    </button>
  );
}

function CountdownOverlay({ snapshot }: { snapshot: MatchSnapshot | null }): JSX.Element {
  // The simulation counts down internally; derive the display number from the
  // phase rather than running a second clock that could drift out of step.
  const [shown, setShown] = useState(3);
  const lastRef = useRef(3);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setShown((value) => {
        const next = Math.max(0, value - 1);
        if (next !== lastRef.current) {
          lastRef.current = next;
          if (next > 0) audio.play(SoundEvent.Countdown);
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  void snapshot;

  return (
    <div className="overlay">
      <div className="countdown" key={shown}>
        {shown > 0 ? shown : 'FIGHT!'}
      </div>
      <p style={{ color: 'var(--text-dim)', margin: 0 }}>
        Tap a card, then tap your half of the arena to deploy.
      </p>
    </div>
  );
}

function DebugOverlay({
  fps,
  snapshot,
  session,
  particles,
}: {
  fps: number;
  snapshot: MatchSnapshot | null;
  session: MatchSession;
  particles: number;
}): JSX.Element {
  const info = session.debugInfo();
  return (
    <div className="debug">
      <div>
        <span className="debug__key">fps </span>
        {fps}
      </div>
      <div>
        <span className="debug__key">tick </span>
        {snapshot?.tick ?? 0}
      </div>
      <div>
        <span className="debug__key">entities </span>
        {snapshot?.entities.length ?? 0}
      </div>
      <div>
        <span className="debug__key">projectiles </span>
        {snapshot?.projectiles.length ?? 0}
      </div>
      <div>
        <span className="debug__key">particles </span>
        {particles}
      </div>
      <div>
        <span className="debug__key">ping </span>
        {info.ping === null ? 'local' : `${info.ping}ms`}
      </div>
      <div>
        <span className="debug__key">phase </span>
        {snapshot?.phase ?? '-'}
      </div>
      {info.botDecision && (
        <div>
          <span className="debug__key">bot </span>
          {info.botDecision}
        </div>
      )}
      <div style={{ marginTop: 6, color: 'var(--text-faint)' }}>
        F1 debug
        {session.allowsDevTools ? ' | F2 spawn | F3 energy | F4 restart' : ' | dev keys off (online)'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Client-side placement preview. The authority still decides for real. */
function isPlacementLegal(
  card: CardDef,
  point: { x: number; y: number },
  team: Team,
): boolean {
  if (point.x < 0 || point.x > ARENA_WIDTH || point.y < 0 || point.y > ARENA_HEIGHT) {
    return false;
  }
  if (card.type === CardType.Spell) return true;
  return isOwnHalf(team, point.y);
}

function computePlacement(
  held: HeldCard | null,
  pointer: { x: number; y: number } | null,
  team: Team,
): { x: number; y: number; valid: boolean; radius: number } | null {
  if (!held || !pointer) return null;
  return {
    x: pointer.x,
    y: pointer.y,
    valid: isPlacementLegal(held.card, pointer, team),
    radius:
      held.card.type === CardType.Spell
        ? (held.card.spell?.radius ?? 8)
        : Math.max(3, (held.card.radius ?? 2) * 2),
  };
}

/** Maps a simulation fx event onto a sound. */
function playFxSound(fx: FxEvent): void {
  switch (fx.kind) {
    case FxKind.Spawn:
      audio.play(SoundEvent.UnitSpawn);
      break;
    case FxKind.Hit:
      audio.play(SoundEvent.Hit);
      break;
    case FxKind.Death:
      audio.play(SoundEvent.Death);
      break;
    case FxKind.SpellImpact:
      audio.play(SoundEvent.Spell, 0.8);
      break;
    case FxKind.TowerHit:
      audio.play(SoundEvent.TowerDamage);
      break;
    case FxKind.TowerDestroyed:
      audio.play(SoundEvent.TowerDestroyed);
      break;
    default:
      break;
  }
}
