/**
 * Generates the balance table in docs/BALANCE.md from the card data.
 *
 * Generated rather than hand-written so it can never drift from the actual
 * numbers the simulation uses. Run with:
 *
 *   npm run balance
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { COLLECTIBLE_CARDS } from '../data/cards.js';
import { SYNERGIES } from '../data/decks.js';
import { towerLayout } from '../constants.js';
import {
  CardType,
  Layer,
  TargetClass,
  Team,
  TowerSlot,
  type CardDef,
} from '../types.js';

/** Total damage per second across every body the card deploys. */
function totalDps(card: CardDef): number {
  const bodies = card.spawnAmount ?? 1;
  return Math.round((card.damage ?? 0) * (card.attackSpeed ?? 0) * bodies);
}

/** Total effective health across every body the card deploys. */
function totalHealth(card: CardDef): number {
  return (card.health ?? 0) * (card.spawnAmount ?? 1);
}

/**
 * A rough "value per energy" figure, used only to spot outliers.
 *
 * It deliberately undercounts abilities, so a card sitting below the pack on
 * this number is not necessarily weak - it usually means its value is in an
 * ability rather than its statline. What it is good for is catching a card
 * that is ahead on raw stats *and* has an ability.
 */
function valuePerEnergy(card: CardDef): number {
  if (card.type === CardType.Spell) {
    const spell = card.spell;
    if (!spell) return 0;
    const area = Math.PI * spell.radius * spell.radius;
    return Math.round(((spell.damage ?? spell.heal ?? 0) * area) / 100 / Math.max(1, card.cost));
  }
  return Math.round((totalHealth(card) + totalDps(card) * 4) / Math.max(1, card.cost));
}

function targetLabel(card: CardDef): string {
  switch (card.targets) {
    case TargetClass.All:
      return 'Ground + Air';
    case TargetClass.Air:
      return 'Air';
    case TargetClass.BuildingsOnly:
      return 'Buildings';
    default:
      return 'Ground';
  }
}

function rangeLabel(card: CardDef): string {
  const range = card.range ?? 0;
  if (range <= 0) return '-';
  return range <= 2.5 ? 'Melee' : String(Math.round(range));
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function buildTable(): string {
  const lines: string[] = [];

  lines.push('# Riftbound Rivals - Balance Table');
  lines.push('');
  lines.push(
    'Generated from the card data by `npm run balance`. Do not edit by hand:',
  );
  lines.push('regenerate it instead, so it always matches what the simulation runs.');
  lines.push('');

  // --- Towers -------------------------------------------------------------
  lines.push('## Towers');
  lines.push('');
  lines.push(
    'The defensive baseline everything else is balanced against. A guard tower is tuned',
  );
  lines.push(
    'to survive the cheapest swarm in the set (three Shard Hounds, 2 energy, ~370 combined',
  );
  lines.push(
    'dps) with roughly 30% health left, so unanswered cheap pressure is genuinely',
  );
  lines.push('threatening but any real defensive answer wins the exchange.');
  lines.push('');
  lines.push('| Tower | Health | Damage | Attack speed | DPS | Range |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const tower of towerLayout(Team.Blue)) {
    const name = tower.slot === TowerSlot.Core ? 'Rift Core' : 'Guard Spire';
    // Both guard towers are identical, so only list one.
    if (tower.slot === TowerSlot.RightGuard) continue;
    lines.push(
      `| ${name} | ${tower.health} | ${tower.damage} | ${tower.attackSpeed.toFixed(2)}/s | ` +
        `${Math.round(tower.damage * tower.attackSpeed)} | ${tower.range} |`,
    );
  }
  lines.push('');

  // --- Units and buildings ------------------------------------------------
  const units = COLLECTIBLE_CARDS.filter((c) => c.type !== CardType.Spell).sort(
    (a, b) => a.cost - b.cost || a.name.localeCompare(b.name),
  );

  lines.push('## Units and buildings');
  lines.push('');
  lines.push(
    '`Health` and `DPS` are totals across every body the card deploys, so a three-body',
  );
  lines.push('swarm is compared fairly against a single tank.');
  lines.push('');
  lines.push(
    '`Value/energy` counts only the raw statline, so it reads high for cheap swarms and',
  );
  lines.push(
    'low for cards whose value sits in an ability. Shard Hound tops the column by a wide',
  );
  lines.push(
    'margin and is deliberately left there: it is the cheap baseline the rest of the set',
  );
  lines.push(
    'answers. Measured head-to-head it beats the 3-cost bodies but loses to every card at',
  );
  lines.push(
    '4 energy or above, and to a 3-cost assassin, because the column cannot see that it is',
  );
  lines.push('melee, ground-only and has no answer to splash.');
  lines.push('');
  lines.push(
    '| Card | Cost | Faction | Bodies | Health | DPS | Range | Targets | Layer | Value/energy |',
  );
  lines.push('| --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- | ---: |');

  for (const card of units) {
    const cells = [
      escapePipes(card.name),
      card.cost,
      card.faction,
      card.spawnAmount ?? 1,
      totalHealth(card),
      totalDps(card),
      rangeLabel(card),
      targetLabel(card),
      card.layer === Layer.Air ? 'Air' : 'Ground',
      valuePerEnergy(card),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');

  // --- Spells -------------------------------------------------------------
  const spells = COLLECTIBLE_CARDS.filter((c) => c.type === CardType.Spell).sort(
    (a, b) => a.cost - b.cost,
  );

  lines.push('## Spells');
  lines.push('');
  lines.push(
    'Every damaging spell is deliberately weak against structures, so no deck can burn',
  );
  lines.push('a tower down from hand.');
  lines.push('');
  lines.push('| Card | Cost | Radius | Damage | vs structures | Effect |');
  lines.push('| --- | ---: | ---: | ---: | ---: | --- |');
  for (const card of spells) {
    const spell = card.spell;
    if (!spell) continue;
    const effects: string[] = [];
    if (spell.heal) effects.push(`heals ${spell.heal}`);
    if (spell.knockback) effects.push(`knockback ${spell.knockback}`);
    if (spell.dispel) effects.push('dispels buffs');
    if (spell.energyBoost) {
      effects.push(`${spell.energyBoost.multiplier}x energy for ${spell.energyBoost.duration}s`);
    }
    for (const status of spell.applies ?? []) {
      effects.push(`${status.kind} ${status.duration}s`);
    }
    for (const status of spell.appliesToAllies ?? []) {
      effects.push(`ally ${status.kind} ${status.duration}s`);
    }
    if (spell.impacts && spell.impacts > 1) effects.push(`${spell.impacts} impacts`);
    if (spell.delay) effects.push(`${spell.delay}s delay`);

    lines.push(
      `| ${escapePipes(card.name)} | ${card.cost} | ${spell.radius} | ${spell.damage ?? '-'} | ` +
        `${spell.damage ? `${Math.round((spell.buildingDamageFactor ?? 0.4) * 100)}%` : '-'} | ` +
        `${effects.join(', ') || '-'} |`,
    );
  }
  lines.push('');

  // --- Cost curve ---------------------------------------------------------
  lines.push('## Cost distribution');
  lines.push('');
  const byCost = new Map<number, string[]>();
  for (const card of COLLECTIBLE_CARDS) {
    const list = byCost.get(card.cost) ?? [];
    list.push(card.name);
    byCost.set(card.cost, list);
  }
  lines.push('| Cost | Count | Cards |');
  lines.push('| ---: | ---: | --- |');
  for (const cost of [...byCost.keys()].sort((a, b) => a - b)) {
    const list = (byCost.get(cost) ?? []).sort();
    lines.push(`| ${cost} | ${list.length} | ${list.join(', ')} |`);
  }
  lines.push('');

  // --- Role coverage ------------------------------------------------------
  lines.push('## Role coverage');
  lines.push('');
  const roleCounts = new Map<string, number>();
  for (const card of COLLECTIBLE_CARDS) {
    for (const role of card.roles) {
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
  }
  lines.push('| Role | Cards |');
  lines.push('| --- | ---: |');
  for (const [role, count] of [...roleCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${role} | ${count} |`);
  }
  lines.push('');

  // --- Counters -----------------------------------------------------------
  lines.push('## Design counters');
  lines.push('');
  lines.push('The relationships the set is built on, each pinned by a test in');
  lines.push('`shared/src/__tests__/balance.test.ts`:');
  lines.push('');
  lines.push('- **Area damage beats swarms.** Splash carriers (Geode Titan, Siege Crawler,');
  lines.push('  Plasma Bloom, Meteor Shard) clear multi-body cards efficiently.');
  lines.push('- **Swarms beat single-target heavies.** A 2-energy swarm punishes a 5-energy');
  lines.push('  single-target unit, so expensive cards are not simply better.');
  lines.push('- **Air beats ground-only.** Ground-only attackers cannot touch a flyer at all,');
  lines.push('  which is why every deck needs at least two cards that hit air.');
  lines.push('- **Buildings-only units ignore defenders.** Siege Crawler walks past everything');
  lines.push('  alive, so it must be answered with bodies rather than out-traded.');
  lines.push('- **Towers anchor defence.** No single card takes a guard tower alone.');
  lines.push('');

  // --- Synergies ----------------------------------------------------------
  lines.push('## Intended synergies');
  lines.push('');
  lines.push('| Pairing | Why it works |');
  lines.push('| --- | --- |');
  for (const synergy of SYNERGIES) {
    const a = COLLECTIBLE_CARDS.find((c) => c.id === synergy.cards[0]);
    const b = COLLECTIBLE_CARDS.find((c) => c.id === synergy.cards[1]);
    if (!a || !b) continue;
    lines.push(`| ${a.name} + ${b.name} | ${escapePipes(synergy.note)} |`);
  }
  lines.push('');

  return lines.join('\n');
}

const output = buildTable();
const target = resolve(process.cwd(), 'docs/BALANCE.md');
writeFileSync(target, output, 'utf8');
console.log(`Wrote ${target} (${COLLECTIBLE_CARDS.length} cards)`);
