/**
 * Player profile and progression.
 *
 * Persisted to localStorage. This is deliberately client-side only: it is
 * cosmetic progression, and nothing here is ever trusted by the server for
 * anything that affects a match (trophies are sent purely as a matchmaking
 * hint, which the server clamps).
 */

import {
  STARTER_DECK,
  sanitizeDeck,
  xpForLevel,
  type MatchRewards,
} from '@riftbound/shared';

const STORAGE_KEY = 'riftbound.profile.v1';

export interface SavedDeck {
  id: string;
  name: string;
  cards: string[];
}

export interface Settings {
  sfxVolume: number;
  musicVolume: number;
  muted: boolean;
  showDamageNumbers: boolean;
  showHealthBars: boolean;
  screenShake: boolean;
  /** Places a card on a single tap rather than tap-select-then-tap-place. */
  quickPlace: boolean;
}

export interface Profile {
  name: string;
  level: number;
  xp: number;
  coins: number;
  trophies: number;
  bestTrophies: number;
  wins: number;
  losses: number;
  draws: number;
  /** Cards the player has unlocked. */
  unlocked: string[];
  decks: SavedDeck[];
  activeDeckId: string;
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  sfxVolume: 0.7,
  musicVolume: 0.35,
  muted: false,
  showDamageNumbers: true,
  showHealthBars: true,
  screenShake: true,
  quickPlace: false,
};

/**
 * Cards available from the start. The rest unlock with levels, which gives
 * new players a smaller set to learn before the full roster opens up.
 */
const STARTING_UNLOCKS = [
  ...STARTER_DECK,
  'shard-hound',
  'spark-drone',
  'rift-runner',
  'thunder-seed',
  'bastion-shell',
  'echo-witch',
  'frost-lantern',
  'rift-blast',
  'mirror-mite',
  'venom-spore',
  'time-fracture',
  'aegis-drummer',
];

/** Which cards unlock at which level. */
export const LEVEL_UNLOCKS: Record<number, string[]> = {
  2: ['hollow-choir', 'void-pulse'],
  3: ['chrono-fox', 'plasma-bloom'],
  4: ['null-stalker', 'beacon-spire'],
  5: ['lumen-warden', 'meteor-shard'],
  6: ['quantum-twins', 'gravity-forge'],
  7: ['siege-crawler', 'bloom-mend'],
  8: ['void-architect', 'energy-surge'],
  9: ['phase-wraith', 'warp-lancer'],
  10: ['magnetic-golem', 'geode-titan'],
};

export function defaultProfile(): Profile {
  return {
    name: 'Challenger',
    level: 1,
    xp: 0,
    coins: 200,
    trophies: 0,
    bestTrophies: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    unlocked: [...new Set(STARTING_UNLOCKS)],
    decks: [{ id: 'deck-1', name: 'Starter', cards: [...STARTER_DECK] }],
    activeDeckId: 'deck-1',
    settings: { ...DEFAULT_SETTINGS },
  };
}

/**
 * Loads the profile, repairing anything missing or corrupt rather than
 * throwing. A bad save must never leave the player stuck at a blank screen.
 */
export function loadProfile(): Profile {
  const base = defaultProfile();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return base;
  }
  if (!raw) return base;

  try {
    const parsed = JSON.parse(raw) as Partial<Profile>;
    const decks = Array.isArray(parsed.decks) && parsed.decks.length > 0
      ? parsed.decks
          .filter((d): d is SavedDeck => Boolean(d && typeof d.id === 'string'))
          .map((d) => ({
            id: d.id,
            name: typeof d.name === 'string' ? d.name.slice(0, 24) : 'Deck',
            cards: sanitizeDeck(d.cards),
          }))
      : base.decks;

    const unlocked = Array.isArray(parsed.unlocked)
      ? [...new Set([...base.unlocked, ...parsed.unlocked.filter((c) => typeof c === 'string')])]
      : base.unlocked;

    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.slice(0, 24) : base.name,
      level: clampInt(parsed.level, 1, 999, base.level),
      xp: clampInt(parsed.xp, 0, Number.MAX_SAFE_INTEGER, base.xp),
      coins: clampInt(parsed.coins, 0, Number.MAX_SAFE_INTEGER, base.coins),
      trophies: clampInt(parsed.trophies, 0, Number.MAX_SAFE_INTEGER, base.trophies),
      bestTrophies: clampInt(parsed.bestTrophies, 0, Number.MAX_SAFE_INTEGER, base.bestTrophies),
      wins: clampInt(parsed.wins, 0, Number.MAX_SAFE_INTEGER, 0),
      losses: clampInt(parsed.losses, 0, Number.MAX_SAFE_INTEGER, 0),
      draws: clampInt(parsed.draws, 0, Number.MAX_SAFE_INTEGER, 0),
      unlocked,
      decks,
      activeDeckId: decks.some((d) => d.id === parsed.activeDeckId)
        ? (parsed.activeDeckId as string)
        : (decks[0] as SavedDeck).id,
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
    };
  } catch {
    // Corrupt save: start clean rather than crashing.
    return base;
  }
}

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Storage full or blocked. Progression is lost but play continues.
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** The deck the player currently has selected. */
export function activeDeck(profile: Profile): string[] {
  const deck = profile.decks.find((d) => d.id === profile.activeDeckId) ?? profile.decks[0];
  return sanitizeDeck(deck?.cards);
}

export interface ProgressionResult {
  profile: Profile;
  /** Levels gained, for the result screen to celebrate. */
  levelsGained: number;
  /** Cards unlocked by those levels. */
  newCards: string[];
}

/**
 * Applies match rewards, handling level-ups and the unlocks they grant.
 * Trophies never drop below zero, so a losing streak cannot bury a player.
 */
export function applyRewards(
  profile: Profile,
  rewards: MatchRewards,
  outcome: 'win' | 'loss' | 'draw',
): ProgressionResult {
  const next: Profile = {
    ...profile,
    xp: profile.xp + Math.max(0, rewards.xp),
    coins: profile.coins + Math.max(0, rewards.coins),
    trophies: Math.max(0, profile.trophies + rewards.trophies),
    unlocked: [...profile.unlocked],
    decks: profile.decks.map((d) => ({ ...d, cards: [...d.cards] })),
    settings: { ...profile.settings },
  };

  next.bestTrophies = Math.max(next.bestTrophies, next.trophies);
  if (outcome === 'win') next.wins++;
  else if (outcome === 'loss') next.losses++;
  else next.draws++;

  // Spend XP upward through as many levels as it covers.
  let levelsGained = 0;
  const newCards: string[] = [];
  let needed = xpForLevel(next.level);
  while (next.xp >= needed && next.level < 50) {
    next.xp -= needed;
    next.level++;
    levelsGained++;
    for (const card of LEVEL_UNLOCKS[next.level] ?? []) {
      if (!next.unlocked.includes(card)) {
        next.unlocked.push(card);
        newCards.push(card);
      }
    }
    needed = xpForLevel(next.level);
  }

  return { profile: next, levelsGained, newCards };
}

/** Progress toward the next level, 0..1. */
export function levelProgress(profile: Profile): number {
  const needed = xpForLevel(profile.level);
  return needed > 0 ? Math.min(1, profile.xp / needed) : 0;
}

/** A readable rank title derived from trophies. */
export function rankTitle(trophies: number): string {
  if (trophies >= 3000) return 'Riftlord';
  if (trophies >= 2000) return 'Ascendant';
  if (trophies >= 1400) return 'Voidbreaker';
  if (trophies >= 900) return 'Warden';
  if (trophies >= 500) return 'Duelist';
  if (trophies >= 200) return 'Adept';
  return 'Initiate';
}
