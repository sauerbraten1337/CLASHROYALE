/**
 * The deck builder.
 *
 * Shows the card pool, the current eight-card deck, and a live read-out of
 * what that deck actually does: cost curve, role balance, anti-air coverage
 * and the synergies the set was designed around.
 */

import { useMemo, useState } from 'react';
import {
  COLLECTIBLE_CARDS,
  DECK_SIZE,
  analyzeDeck,
  deckAdvice,
  getCard,
  synergiesIn,
  validateDeck,
  type CardDef,
} from '@riftbound/shared';

import { CardDetail, CardTile, TopBar } from '../ui/components.js';
import { SoundEvent, audio } from '../game/audio.js';
import { sortCards } from './Menus.js';
import type { Profile, SavedDeck } from '../state/profile.js';

export function DeckBuilder({
  profile,
  onSave,
  onBack,
}: {
  profile: Profile;
  onSave: (decks: SavedDeck[], activeDeckId: string) => void;
  onBack: () => void;
}): JSX.Element {
  const [decks, setDecks] = useState<SavedDeck[]>(() =>
    profile.decks.map((d) => ({ ...d, cards: [...d.cards] })),
  );
  const [activeId, setActiveId] = useState(profile.activeDeckId);
  const [inspected, setInspected] = useState<CardDef | null>(null);
  const [sort, setSort] = useState<'cost' | 'name' | 'rarity' | 'faction'>('cost');

  const unlocked = useMemo(() => new Set(profile.unlocked), [profile.unlocked]);
  const deck = decks.find((d) => d.id === activeId) ?? (decks[0] as SavedDeck);
  const deckSet = useMemo(() => new Set(deck.cards), [deck.cards]);

  const pool = useMemo(
    () => sortCards(COLLECTIBLE_CARDS.filter((c) => unlocked.has(c.id)), sort),
    [unlocked, sort],
  );

  const stats = useMemo(() => analyzeDeck(deck.cards), [deck.cards]);
  const advice = useMemo(() => deckAdvice(deck.cards), [deck.cards]);
  const synergies = useMemo(() => synergiesIn(deck.cards), [deck.cards]);
  const validation = useMemo(() => validateDeck(deck.cards), [deck.cards]);

  const mutateDeck = (cards: string[]): void => {
    setDecks((current) =>
      current.map((d) => (d.id === deck.id ? { ...d, cards } : d)),
    );
  };

  const toggleCard = (card: CardDef): void => {
    setInspected(card);
    if (deckSet.has(card.id)) {
      mutateDeck(deck.cards.filter((id) => id !== card.id));
      audio.play(SoundEvent.UiBack);
      return;
    }
    if (deck.cards.length >= DECK_SIZE) {
      audio.play(SoundEvent.CardInvalid);
      return;
    }
    mutateDeck([...deck.cards, card.id]);
    audio.play(SoundEvent.UiClick);
  };

  const removeAt = (index: number): void => {
    mutateDeck(deck.cards.filter((_, i) => i !== index));
    audio.play(SoundEvent.UiBack);
  };

  const addDeck = (): void => {
    const id = `deck-${Date.now().toString(36)}`;
    const created: SavedDeck = {
      id,
      name: `Deck ${decks.length + 1}`,
      cards: [...deck.cards],
    };
    setDecks([...decks, created]);
    setActiveId(id);
  };

  /** Fills the remaining slots with a sensible spread rather than at random. */
  const autoComplete = (): void => {
    const cards = [...deck.cards];
    const have = new Set(cards);
    const candidates = COLLECTIBLE_CARDS.filter((c) => unlocked.has(c.id) && !have.has(c.id));

    while (cards.length < DECK_SIZE && candidates.length > 0) {
      const current = analyzeDeck(cards);
      // Score each candidate by what the deck is currently missing.
      let best = candidates[0] as CardDef;
      let bestScore = -Infinity;
      for (const card of candidates) {
        let score = 0;
        if (current.antiAir < 3 && (card.targets === 'all' || card.targets === 'air')) score += 5;
        if (current.areaDamage < 2 && ((card.splashRadius ?? 0) > 0 || card.roles.includes('aoe' as never))) {
          score += 4;
        }
        if (current.spells < 2 && card.type === 'spell') score += 4;
        if (current.buildings < 1 && card.type === 'building') score += 3;
        // Keep the curve reasonable.
        const projected = (current.averageCost * cards.length + card.cost) / (cards.length + 1);
        score -= Math.abs(projected - 3.6) * 2;
        if (score > bestScore) {
          bestScore = score;
          best = card;
        }
      }
      cards.push(best.id);
      have.add(best.id);
      candidates.splice(candidates.indexOf(best), 1);
    }
    mutateDeck(cards);
    audio.play(SoundEvent.UiClick);
  };

  const save = (): void => {
    onSave(decks, activeId);
    audio.play(SoundEvent.UiClick);
  };

  return (
    <div className="screen">
      <TopBar title="Deck Builder" onBack={onBack}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={save}
          disabled={!validation.valid}
          title={validation.valid ? 'Save deck' : validation.errors[0]}
        >
          Save
        </button>
      </TopBar>

      <div className="topbar">
        <div style={{ display: 'flex', gap: 6, flex: 1, overflowX: 'auto' }}>
          {decks.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`btn ${d.id === activeId ? 'btn--primary' : 'btn--ghost'}`}
              style={{ padding: '7px 13px', fontSize: 13 }}
              onClick={() => setActiveId(d.id)}
            >
              {d.name}
            </button>
          ))}
          {decks.length < 5 && (
            <button
              type="button"
              className="btn btn--ghost"
              style={{ padding: '7px 13px', fontSize: 13 }}
              onClick={addDeck}
            >
              + New
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['cost', 'name', 'rarity', 'faction'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`btn ${sort === mode ? 'btn--primary' : 'btn--ghost'}`}
              style={{ padding: '7px 11px', fontSize: 12 }}
              onClick={() => setSort(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="deck-builder">
        <div className="deck-builder__pool">
          <div className="collection">
            {pool.map((card) => (
              <CardTile
                key={card.id}
                card={card}
                size={86}
                selected={deckSet.has(card.id)}
                onClick={() => toggleCard(card)}
              />
            ))}
          </div>
        </div>

        <div className="deck-builder__side">
          <div className="deck-slots">
            {Array.from({ length: DECK_SIZE }, (_, index) => {
              const cardId = deck.cards[index];
              const card = cardId ? getCard(cardId) : undefined;
              if (!card) {
                return (
                  <div className="deck-slot--empty" key={`empty-${index}`}>
                    +
                  </div>
                );
              }
              return (
                <CardTile
                  key={`${cardId}-${index}`}
                  card={card}
                  size={66}
                  showName={false}
                  onClick={() => removeAt(index)}
                />
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 8, padding: '0 14px 12px' }}>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ flex: 1, padding: '8px', fontSize: 13 }}
              onClick={autoComplete}
              disabled={deck.cards.length >= DECK_SIZE}
            >
              Auto-fill
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ flex: 1, padding: '8px', fontSize: 13 }}
              onClick={() => mutateDeck([])}
              disabled={deck.cards.length === 0}
            >
              Clear
            </button>
          </div>

          <div className="deck-stats">
            <div className="deck-stats__row">
              <span>Cards</span>
              <strong style={{ color: deck.cards.length === DECK_SIZE ? 'var(--green)' : 'var(--gold)' }}>
                {deck.cards.length} / {DECK_SIZE}
              </strong>
            </div>
            <div className="deck-stats__row">
              <span>Average energy</span>
              <strong>{stats.averageCost.toFixed(1)}</strong>
            </div>
            <div className="deck-stats__row">
              <span>Units / buildings / spells</span>
              <strong>
                {stats.units} / {stats.buildings} / {stats.spells}
              </strong>
            </div>
            <div className="deck-stats__row">
              <span>Offensive</span>
              <strong>{stats.offensive}</strong>
            </div>
            <div className="deck-stats__row">
              <span>Defensive</span>
              <strong>{stats.defensive}</strong>
            </div>
            <div className="deck-stats__row">
              <span>Support / utility</span>
              <strong>{stats.support}</strong>
            </div>
            <div className="deck-stats__row">
              <span>Can hit air</span>
              <strong style={{ color: stats.antiAir >= 2 ? 'var(--green)' : 'var(--red)' }}>
                {stats.antiAir}
              </strong>
            </div>
            <div className="deck-stats__row">
              <span>Area damage</span>
              <strong style={{ color: stats.areaDamage >= 1 ? 'var(--green)' : 'var(--red)' }}>
                {stats.areaDamage}
              </strong>
            </div>

            <div className="section-title">Cost curve</div>
            <CostCurve curve={stats.costCurve} />

            {synergies.length > 0 && (
              <>
                <div className="section-title">Synergies in this deck</div>
                {synergies.map((synergy) => (
                  <div className="synergy" key={synergy.cards.join('-')}>
                    <strong>
                      {getCard(synergy.cards[0])?.name} + {getCard(synergy.cards[1])?.name}
                    </strong>
                    <br />
                    {synergy.note}
                  </div>
                ))}
              </>
            )}

            {advice.length > 0 && (
              <>
                <div className="section-title">Notes</div>
                {advice.map((note) => (
                  <div className="advice" key={note}>
                    {note}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {inspected && <CardDetail card={inspected} />}
      </div>
    </div>
  );
}

/** A compact histogram of how many cards sit at each energy cost. */
function CostCurve({ curve }: { curve: Record<number, number> }): JSX.Element {
  const max = Math.max(1, ...Object.values(curve));
  const costs = Array.from({ length: 9 }, (_, i) => i + 1);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 54, marginTop: 4 }}>
      {costs.map((cost) => {
        const count = curve[cost] ?? 0;
        return (
          <div key={cost} style={{ flex: 1, textAlign: 'center' }}>
            <div
              style={{
                height: `${(count / max) * 36}px`,
                background: count > 0 ? 'linear-gradient(180deg, #c46cff, #8b45d8)' : 'transparent',
                borderRadius: 3,
                minHeight: count > 0 ? 4 : 0,
                transition: 'height 0.2s ease',
              }}
              title={`${count} card${count === 1 ? '' : 's'} at ${cost} energy`}
            />
            <div style={{ fontSize: 9, color: 'var(--text-faint)', marginTop: 3 }}>{cost}</div>
          </div>
        );
      })}
    </div>
  );
}
