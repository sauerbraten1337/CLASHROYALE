/**
 * Deck validation and analysis.
 *
 * Shared between the client's deck builder (which shows the numbers live) and
 * the server (which validates any deck a client claims to be using).
 */

import { DECK_SIZE } from '../constants.js';
import { CARD_BY_ID, STARTER_DECK, getCard } from './cards.js';
import { CardRole, CardType, type CardDef } from '../types.js';

export interface DeckStats {
  /** Mean energy cost across the deck. */
  averageCost: number;
  /** Count of each card type. */
  units: number;
  buildings: number;
  spells: number;
  /** Role counts, used for the deck builder's balance read-out. */
  offensive: number;
  defensive: number;
  support: number;
  /** Cards that can hit air targets. */
  antiAir: number;
  /** Cards that deal area damage. */
  areaDamage: number;
  /** Cheapest and most expensive cards, for the cost curve. */
  costCurve: Record<number, number>;
}

export interface DeckValidation {
  valid: boolean;
  errors: string[];
}

/** Checks a deck is exactly the right size, all real, all unique, all playable. */
export function validateDeck(deck: string[]): DeckValidation {
  const errors: string[] = [];

  if (!Array.isArray(deck)) {
    return { valid: false, errors: ['Deck must be a list of card ids.'] };
  }
  if (deck.length !== DECK_SIZE) {
    errors.push(`A deck must hold exactly ${DECK_SIZE} cards (got ${deck.length}).`);
  }

  const seen = new Set<string>();
  for (const id of deck) {
    const card = CARD_BY_ID.get(id);
    if (!card) {
      errors.push(`Unknown card: ${id}`);
      continue;
    }
    if (card.collectible === false) {
      errors.push(`${card.name} cannot be placed in a deck.`);
    }
    if (seen.has(id)) {
      errors.push(`Duplicate card: ${card.name}`);
    }
    seen.add(id);
  }

  return { valid: errors.length === 0, errors };
}

/** Falls back to the starter deck when the supplied deck is not usable. */
export function sanitizeDeck(deck: string[] | undefined | null): string[] {
  if (!deck || !Array.isArray(deck)) return [...STARTER_DECK];
  const out: string[] = [];
  for (const id of deck) {
    const card = CARD_BY_ID.get(id);
    if (card && card.collectible !== false && !out.includes(id) && out.length < DECK_SIZE) {
      out.push(id);
    }
  }
  for (const filler of STARTER_DECK) {
    if (out.length >= DECK_SIZE) break;
    if (!out.includes(filler)) out.push(filler);
  }
  return out;
}

/** Computes the numbers the deck builder displays. */
export function analyzeDeck(deck: string[]): DeckStats {
  const cards = deck.map((id) => getCard(id)).filter((c): c is CardDef => c !== undefined);

  const stats: DeckStats = {
    averageCost: 0,
    units: 0,
    buildings: 0,
    spells: 0,
    offensive: 0,
    defensive: 0,
    support: 0,
    antiAir: 0,
    areaDamage: 0,
    costCurve: {},
  };

  if (cards.length === 0) return stats;

  let total = 0;
  for (const card of cards) {
    total += card.cost;
    stats.costCurve[card.cost] = (stats.costCurve[card.cost] ?? 0) + 1;

    switch (card.type) {
      case CardType.Unit:
        stats.units++;
        break;
      case CardType.Building:
        stats.buildings++;
        break;
      case CardType.Spell:
        stats.spells++;
        break;
    }

    if (
      card.roles.includes(CardRole.Assassin) ||
      card.roles.includes(CardRole.Siege) ||
      card.roles.includes(CardRole.Tank)
    ) {
      stats.offensive++;
    }
    if (
      card.roles.includes(CardRole.Defensive) ||
      card.roles.includes(CardRole.Control) ||
      card.type === CardType.Building
    ) {
      stats.defensive++;
    }
    if (card.roles.includes(CardRole.Support) || card.roles.includes(CardRole.Utility)) {
      stats.support++;
    }
    if (card.targets === 'all' || card.targets === 'air') stats.antiAir++;
    if (card.roles.includes(CardRole.AreaDamage) || (card.splashRadius ?? 0) > 0) {
      stats.areaDamage++;
    }
  }

  stats.averageCost = Math.round((total / cards.length) * 10) / 10;
  return stats;
}

/**
 * Plain-language warnings about a deck's composition. These are advisory -
 * a deck is still legal without addressing them.
 */
export function deckAdvice(deck: string[]): string[] {
  const stats = analyzeDeck(deck);
  const advice: string[] = [];

  if (stats.averageCost > 4.4) {
    advice.push('Heavy curve: you will often be stuck with nothing you can afford.');
  }
  if (stats.averageCost < 2.9 && deck.length === DECK_SIZE) {
    advice.push('Very cheap curve: strong tempo, but little to stop a big push.');
  }
  if (stats.antiAir < 2) {
    advice.push('Thin on anti-air. Airborne cards will be hard to answer.');
  }
  if (stats.areaDamage === 0) {
    advice.push('No area damage. Swarm decks will overrun you.');
  }
  if (stats.spells === 0) {
    advice.push('No spells. You will have no reach against defensive structures.');
  }
  if (stats.defensive === 0) {
    advice.push('Nothing defensive. Consider a building or a control card.');
  }
  return advice;
}

/**
 * Card pairings the set is designed around. Surfaced in the deck builder so
 * players can find the combos rather than having to discover them blind.
 */
export const SYNERGIES: Array<{ cards: [string, string]; note: string }> = [
  {
    cards: ['magnetic-golem', 'echo-witch'],
    note: 'The golem eats the projectiles aimed at it while the witch fires over its shoulder.',
  },
  {
    cards: ['gravity-forge', 'meteor-shard'],
    note: 'The well bunches attackers into one knot; the barrage lands on all of them at once.',
  },
  {
    cards: ['gravity-forge', 'plasma-bloom'],
    note: 'Pulled-in targets sit inside the plasma splash radius.',
  },
  {
    cards: ['chrono-fox', 'aegis-drummer'],
    note: 'The drummer haste turns an already evasive attacker into something untouchable.',
  },
  {
    cards: ['void-architect', 'hollow-choir'],
    note: 'The barrier absorbs the anti-air fire the choir cannot survive on its own.',
  },
  {
    cards: ['thunder-seed', 'frost-lantern'],
    note: 'Slowed enemies cannot leave the seed zone before the strike lands.',
  },
  {
    cards: ['geode-titan', 'lumen-warden'],
    note: 'Sustained healing on the heaviest body in the set, and four shards after it falls.',
  },
  {
    cards: ['siege-crawler', 'bastion-shell'],
    note: 'The shell absorbs everything sent to stop the crawler reaching the tower.',
  },
  {
    cards: ['null-stalker', 'void-pulse'],
    note: 'Strip the shields off the back line, then remove it.',
  },
  {
    cards: ['beacon-spire', 'aegis-drummer'],
    note: 'An endless drone stream, all of it moving at haste.',
  },
];

/** Synergy notes relevant to the given deck. */
export function synergiesIn(deck: string[]): Array<{ cards: [string, string]; note: string }> {
  const set = new Set(deck);
  return SYNERGIES.filter((s) => set.has(s.cards[0]) && set.has(s.cards[1]));
}
