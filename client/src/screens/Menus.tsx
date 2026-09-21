/**
 * Menu screens: main menu, collection, profile, settings, bot setup,
 * matchmaking and the post-match result.
 *
 * These are grouped in one module because they are all thin presentational
 * screens over the same profile object; the battle screen and deck builder,
 * which carry real logic, live in their own files.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  BotDifficulty,
  COLLECTIBLE_CARDS,
  CardType,
  Team,
  getCard,
  xpForLevel,
  type CardDef,
  type MatchResult,
  type MatchRewards,
} from '@riftbound/shared';

import { CardDetail, CardTile, Stat, Toggle, TopBar } from '../ui/components.js';
import { SoundEvent, audio } from '../game/audio.js';
import {
  activeDeck,
  levelProgress,
  rankTitle,
  type Profile,
  type Settings,
} from '../state/profile.js';
import type { ConnectionStatus } from '../net/Connection.js';

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

export function MainMenu({
  profile,
  connectionStatus,
  onPlayOnline,
  onPlayBot,
  onPrivate,
  onDeck,
  onCollection,
  onProfile,
  onSettings,
}: {
  profile: Profile;
  connectionStatus: ConnectionStatus;
  onPlayOnline: () => void;
  onPlayBot: () => void;
  onPrivate: () => void;
  onDeck: () => void;
  onCollection: () => void;
  onProfile: () => void;
  onSettings: () => void;
}): JSX.Element {
  const progress = levelProgress(profile);

  return (
    <div className="screen menu">
      <div>
        <h1 className="menu__title">Riftbound Rivals</h1>
        <p className="menu__subtitle">
          Two rifts. Two cores. Spend your energy well.
        </p>
      </div>

      <div className="menu__profile">
        <Stat value={profile.level} label="Level" />
        <Stat value={profile.trophies} label="Trophies" />
        <Stat value={profile.coins} label="Coins" />
        <Stat value={rankTitle(profile.trophies)} label="Rank" />
      </div>

      <div style={{ width: 'min(420px, 90vw)' }}>
        <div className="xp-bar">
          <div className="xp-bar__fill" style={{ width: `${progress * 100}%` }} />
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-faint)',
            marginTop: 5,
            textAlign: 'center',
          }}
        >
          {profile.xp} / {xpForLevel(profile.level)} XP to level {profile.level + 1}
        </div>
      </div>

      <div className="menu__actions">
        <button type="button" className="btn btn--primary btn--large btn--block" onClick={onPlayOnline}>
          Play Online
        </button>
        <button type="button" className="btn btn--large btn--block" onClick={onPlayBot}>
          Play vs Bot
        </button>
        <div className="menu__row">
          <button type="button" className="btn" onClick={onPrivate}>
            Private Match
          </button>
          <button type="button" className="btn" onClick={onDeck}>
            Deck
          </button>
        </div>
        <div className="menu__row">
          <button type="button" className="btn" onClick={onCollection}>
            Collection
          </button>
          <button type="button" className="btn" onClick={onProfile}>
            Profile
          </button>
          <button type="button" className="btn" onClick={onSettings}>
            Settings
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: 'var(--text-faint)',
        }}
      >
        <span className={`conn-dot conn-dot--${statusClass(connectionStatus)}`} />
        {statusLabel(connectionStatus)}
      </div>
    </div>
  );
}

function statusClass(status: ConnectionStatus): string {
  if (status === 'connected') return 'connected';
  if (status === 'connecting' || status === 'reconnecting') return 'connecting';
  if (status === 'failed') return 'failed';
  return 'idle';
}

function statusLabel(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected to server';
    case 'connecting':
      return 'Connecting...';
    case 'reconnecting':
      return 'Reconnecting...';
    case 'failed':
      return 'Server unreachable - practice mode still works';
    default:
      return 'Offline - practice mode available';
  }
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

type SortMode = 'cost' | 'name' | 'rarity' | 'faction';

export function Collection({
  profile,
  onBack,
}: {
  profile: Profile;
  onBack: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<CardDef | null>(COLLECTIBLE_CARDS[0] ?? null);
  const [sort, setSort] = useState<SortMode>('cost');
  const [filter, setFilter] = useState<'all' | 'unlocked' | 'locked'>('all');

  const unlocked = useMemo(() => new Set(profile.unlocked), [profile.unlocked]);

  const cards = useMemo(() => {
    const list = COLLECTIBLE_CARDS.filter((card) => {
      if (filter === 'unlocked') return unlocked.has(card.id);
      if (filter === 'locked') return !unlocked.has(card.id);
      return true;
    });
    return sortCards(list, sort);
  }, [sort, filter, unlocked]);

  return (
    <div className="screen">
      <TopBar title="Collection" onBack={onBack}>
        <span>
          {unlocked.size} / {COLLECTIBLE_CARDS.length} unlocked
        </span>
      </TopBar>

      <div className="topbar" style={{ borderBottom: '1px solid var(--border)' }}>
        <SortControls sort={sort} onSort={setSort} />
        <div style={{ display: 'flex', gap: 6 }}>
          {(['all', 'unlocked', 'locked'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`btn ${filter === mode ? 'btn--primary' : 'btn--ghost'}`}
              style={{ padding: '7px 13px', fontSize: 13 }}
              onClick={() => setFilter(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="collection" style={{ flex: 1, overflowY: 'auto' }}>
          {cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              size={88}
              selected={selected?.id === card.id}
              locked={!unlocked.has(card.id)}
              onClick={() => {
                setSelected(card);
                audio.play(SoundEvent.UiClick);
              }}
            />
          ))}
        </div>
        {selected && <CardDetail card={selected} />}
      </div>
    </div>
  );
}

function SortControls({
  sort,
  onSort,
}: {
  sort: SortMode;
  onSort: (mode: SortMode) => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 6, flex: 1 }}>
      <span style={{ fontSize: 12, color: 'var(--text-faint)', alignSelf: 'center' }}>Sort</span>
      {(['cost', 'name', 'rarity', 'faction'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className={`btn ${sort === mode ? 'btn--primary' : 'btn--ghost'}`}
          style={{ padding: '7px 13px', fontSize: 13 }}
          onClick={() => onSort(mode)}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

const RARITY_ORDER: Record<string, number> = { common: 0, rare: 1, epic: 2, mythic: 3 };

export function sortCards(cards: CardDef[], mode: SortMode): CardDef[] {
  const sorted = [...cards];
  switch (mode) {
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'rarity':
      sorted.sort(
        (a, b) =>
          (RARITY_ORDER[a.rarity] ?? 0) - (RARITY_ORDER[b.rarity] ?? 0) ||
          a.cost - b.cost,
      );
      break;
    case 'faction':
      sorted.sort((a, b) => a.faction.localeCompare(b.faction) || a.cost - b.cost);
      break;
    default:
      sorted.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
      break;
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export function ProfileScreen({
  profile,
  onBack,
  onRename,
}: {
  profile: Profile;
  onBack: () => void;
  onRename: (name: string) => void;
}): JSX.Element {
  const [name, setName] = useState(profile.name);
  const total = profile.wins + profile.losses + profile.draws;
  const winRate = total > 0 ? Math.round((profile.wins / total) * 100) : 0;

  return (
    <div className="screen screen--scroll">
      <TopBar title="Profile" onBack={onBack} />
      <div className="settings">
        <div className="section-title">Name</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            type="text"
            value={name}
            maxLength={24}
            onChange={(event) => setName(event.target.value)}
            aria-label="Player name"
          />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              const trimmed = name.trim();
              if (trimmed) onRename(trimmed);
            }}
            disabled={!name.trim() || name.trim() === profile.name}
          >
            Save
          </button>
        </div>

        <div className="section-title">Record</div>
        <div className="menu__profile" style={{ justifyContent: 'space-around' }}>
          <Stat value={profile.wins} label="Wins" />
          <Stat value={profile.losses} label="Losses" />
          <Stat value={profile.draws} label="Draws" />
          <Stat value={`${winRate}%`} label="Win rate" />
        </div>

        <div className="section-title">Progress</div>
        <div className="deck-stats__row">
          <span>Level</span>
          <strong>{profile.level}</strong>
        </div>
        <div className="deck-stats__row">
          <span>Rank</span>
          <strong>{rankTitle(profile.trophies)}</strong>
        </div>
        <div className="deck-stats__row">
          <span>Trophies</span>
          <strong>{profile.trophies}</strong>
        </div>
        <div className="deck-stats__row">
          <span>Best trophies</span>
          <strong>{profile.bestTrophies}</strong>
        </div>
        <div className="deck-stats__row">
          <span>Coins</span>
          <strong>{profile.coins}</strong>
        </div>
        <div className="deck-stats__row">
          <span>Cards unlocked</span>
          <strong>
            {profile.unlocked.length} / {COLLECTIBLE_CARDS.length}
          </strong>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function SettingsScreen({
  settings,
  onChange,
  onBack,
  onReset,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onBack: () => void;
  onReset: () => void;
}): JSX.Element {
  const update = <K extends keyof Settings>(key: K, value: Settings[K]): void => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div className="screen screen--scroll">
      <TopBar title="Settings" onBack={onBack} />
      <div className="settings">
        <div className="section-title">Audio</div>

        <div className="setting-row">
          <div>
            <div className="setting-row__label">Mute all</div>
            <div className="setting-row__hint">Silences music and effects.</div>
          </div>
          <Toggle
            label="Mute all audio"
            value={settings.muted}
            onChange={(value) => update('muted', value)}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row__label">Effects volume</div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.sfxVolume}
            onChange={(event) => update('sfxVolume', Number(event.target.value))}
            aria-label="Effects volume"
          />
        </div>

        <div className="setting-row">
          <div className="setting-row__label">Music volume</div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.musicVolume}
            onChange={(event) => update('musicVolume', Number(event.target.value))}
            aria-label="Music volume"
          />
        </div>

        <div className="section-title">Display</div>

        <div className="setting-row">
          <div>
            <div className="setting-row__label">Damage numbers</div>
            <div className="setting-row__hint">Floating numbers on every hit.</div>
          </div>
          <Toggle
            label="Damage numbers"
            value={settings.showDamageNumbers}
            onChange={(value) => update('showDamageNumbers', value)}
          />
        </div>

        <div className="setting-row">
          <div>
            <div className="setting-row__label">Health bars</div>
            <div className="setting-row__hint">Shown above damaged units and all towers.</div>
          </div>
          <Toggle
            label="Health bars"
            value={settings.showHealthBars}
            onChange={(value) => update('showHealthBars', value)}
          />
        </div>

        <div className="setting-row">
          <div>
            <div className="setting-row__label">Screen shake</div>
            <div className="setting-row__hint">Camera kick on heavy impacts.</div>
          </div>
          <Toggle
            label="Screen shake"
            value={settings.screenShake}
            onChange={(value) => update('screenShake', value)}
          />
        </div>

        <div className="section-title">Danger zone</div>
        <button type="button" className="btn btn--danger btn--block" onClick={onReset}>
          Reset all progress
        </button>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          Clears your level, trophies, coins, decks and unlocks. This cannot be undone.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

const DIFFICULTY_BLURB: Record<BotDifficulty, string> = {
  [BotDifficulty.Easy]: 'Slow to react and often misses your push entirely.',
  [BotDifficulty.Normal]: 'Answers most pushes and saves energy for a real attack.',
  [BotDifficulty.Hard]: 'Reacts fast, counters correctly and rarely blunders.',
};

export function BotSetup({
  profile,
  onStart,
  onBack,
}: {
  profile: Profile;
  onStart: (difficulty: BotDifficulty) => void;
  onBack: () => void;
}): JSX.Element {
  const [difficulty, setDifficulty] = useState<BotDifficulty>(BotDifficulty.Normal);
  const deck = activeDeck(profile);

  return (
    <div className="screen menu">
      <h2 style={{ margin: 0, fontSize: 28 }}>Practice Match</h2>
      <p className="menu__subtitle">
        Runs entirely in your browser against the same engine as online play.
      </p>

      <div className="difficulty-grid">
        {[BotDifficulty.Easy, BotDifficulty.Normal, BotDifficulty.Hard].map((level) => (
          <button
            key={level}
            type="button"
            className={`difficulty ${difficulty === level ? 'difficulty--selected' : ''}`}
            onClick={() => {
              setDifficulty(level);
              audio.play(SoundEvent.UiClick);
            }}
          >
            <div className="difficulty__name">
              {level.charAt(0).toUpperCase() + level.slice(1)}
            </div>
            <div className="difficulty__desc">{DIFFICULTY_BLURB[level]}</div>
          </button>
        ))}
      </div>

      <div>
        <div className="section-title" style={{ textAlign: 'center' }}>
          Your deck
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
          {deck.map((id) => {
            const card = getCard(id);
            return card ? (
              <div key={id} style={{ width: 62 }}>
                <CardTile card={card} size={62} showName={false} />
              </div>
            ) : null;
          })}
        </div>
      </div>

      <div className="menu__actions">
        <button
          type="button"
          className="btn btn--primary btn--large btn--block"
          onClick={() => onStart(difficulty)}
        >
          Start Match
        </button>
        <button type="button" className="btn btn--ghost btn--block" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------

export function Matchmaking({
  status,
  queued,
  onCancel,
}: {
  status: ConnectionStatus;
  queued: number;
  onCancel: () => void;
}): JSX.Element {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="screen menu">
      <div className="searching">
        <div className="spinner" />
        <h2 style={{ margin: 0 }}>Searching for opponent...</h2>
        <p className="menu__subtitle">
          {status === 'connected'
            ? `${elapsed}s elapsed${queued > 1 ? ` - ${queued} players searching` : ''}`
            : 'Connecting to the server...'}
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', maxWidth: '40ch' }}>
          If nobody is available after a few seconds you will be matched against
          an AI opponent so you always get a game.
        </p>
      </div>
      <button type="button" className="btn btn--ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Private room
// ---------------------------------------------------------------------------

export function PrivateRoom({
  code,
  onCreate,
  onJoin,
  onBack,
  status,
  error,
}: {
  code: string | null;
  onCreate: () => void;
  onJoin: (code: string) => void;
  onBack: () => void;
  status: ConnectionStatus;
  error: string | null;
}): JSX.Element {
  const [entered, setEntered] = useState('');
  const online = status === 'connected';

  return (
    <div className="screen menu">
      <h2 style={{ margin: 0, fontSize: 28 }}>Private Match</h2>

      {!online && (
        <p className="menu__subtitle" style={{ color: 'var(--red)' }}>
          A private match needs a connection to the server.
        </p>
      )}

      {code ? (
        <>
          <p className="menu__subtitle">Share this code with your opponent.</p>
          <div className="room-code">{code}</div>
          <div className="searching">
            <div className="spinner" />
            <p style={{ color: 'var(--text-dim)', margin: 0 }}>Waiting for them to join...</p>
          </div>
        </>
      ) : (
        <div className="menu__actions">
          <button
            type="button"
            className="btn btn--primary btn--large btn--block"
            onClick={onCreate}
            disabled={!online}
          >
            Create Room
          </button>

          <div className="section-title" style={{ textAlign: 'center' }}>
            or join with a code
          </div>
          <input
            type="text"
            value={entered}
            maxLength={8}
            placeholder="ABCDE"
            onChange={(event) => setEntered(event.target.value.toUpperCase())}
            style={{ textAlign: 'center', letterSpacing: 5, fontSize: 20 }}
            aria-label="Room code"
          />
          <button
            type="button"
            className="btn btn--block"
            onClick={() => onJoin(entered)}
            disabled={!online || entered.length < 4}
          >
            Join Room
          </button>
        </div>
      )}

      {error && <p style={{ color: 'var(--red)', fontSize: 14 }}>{error}</p>}

      <button type="button" className="btn btn--ghost" onClick={onBack}>
        Back
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export function ResultScreen({
  result,
  rewards,
  team,
  levelsGained,
  newCards,
  onContinue,
  onRematch,
}: {
  result: MatchResult;
  rewards: MatchRewards;
  team: Team;
  levelsGained: number;
  newCards: string[];
  onContinue: () => void;
  onRematch: () => void;
}): JSX.Element {
  const won = result.winner === team;
  const drew = result.winner === null;
  const banner = drew ? 'Draw' : won ? 'Victory!' : 'Defeat';
  const bannerClass = drew ? 'banner--draw' : won ? 'banner--victory' : 'banner--defeat';

  return (
    <div className="screen menu">
      <div className={`banner ${bannerClass}`}>{banner}</div>
      <p className="menu__subtitle">{describeReason(result, team)}</p>

      <div className="result-card">
        <div className="reward-row">
          <span>Towers destroyed</span>
          <span className="reward-row__value">
            {result.towersDestroyed[team]} - {result.towersDestroyed[team === Team.Blue ? Team.Red : Team.Blue]}
          </span>
        </div>
        <div className="reward-row">
          <span>Match length</span>
          <span className="reward-row__value">
            {Math.floor(result.durationSeconds / 60)}:
            {Math.floor(result.durationSeconds % 60)
              .toString()
              .padStart(2, '0')}
          </span>
        </div>
        <div className="reward-row">
          <span>XP</span>
          <span className="reward-row__value reward-row__value--positive">+{rewards.xp}</span>
        </div>
        <div className="reward-row">
          <span>Coins</span>
          <span className="reward-row__value reward-row__value--positive">+{rewards.coins}</span>
        </div>
        <div className="reward-row">
          <span>Trophies</span>
          <span
            className={`reward-row__value ${
              rewards.trophies >= 0 ? 'reward-row__value--positive' : 'reward-row__value--negative'
            }`}
          >
            {rewards.trophies >= 0 ? '+' : ''}
            {rewards.trophies}
          </span>
        </div>

        {levelsGained > 0 && (
          <div className="advice" style={{ marginTop: 14 }}>
            Level up! You gained {levelsGained} level{levelsGained > 1 ? 's' : ''}.
          </div>
        )}

        {newCards.length > 0 && (
          <>
            <div className="section-title">New cards unlocked</div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {newCards.map((id) => {
                const card = getCard(id);
                return card ? (
                  <div key={id} style={{ width: 66 }}>
                    <CardTile card={card} size={66} showName={false} />
                  </div>
                ) : null;
              })}
            </div>
          </>
        )}
      </div>

      <div className="menu__actions">
        <button type="button" className="btn btn--primary btn--large btn--block" onClick={onRematch}>
          Play Again
        </button>
        <button type="button" className="btn btn--block" onClick={onContinue}>
          Main Menu
        </button>
      </div>
    </div>
  );
}

function describeReason(result: MatchResult, team: Team): string {
  const won = result.winner === team;
  switch (result.reason) {
    case 'core-destroyed':
      return won ? 'You destroyed the enemy core.' : 'Your core was destroyed.';
    case 'tower-count':
      return won ? 'You held more towers when time ran out.' : 'They held more towers at time.';
    case 'sudden-death':
      return won ? 'You took the first tower in sudden death.' : 'They took the first tower in sudden death.';
    case 'forfeit':
      return won ? 'Your opponent left the match.' : 'You forfeited the match.';
    default:
      return 'Time ran out with the arena level.';
  }
}

/** Shared by the deck builder and collection for consistent card ordering. */
export function isSpell(card: CardDef): boolean {
  return card.type === CardType.Spell;
}
