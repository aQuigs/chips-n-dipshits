import { formatAmount } from './amounts.ts';
import type { TableConfig } from './types.ts';

/** What a hand costs before anyone chooses to bet. A table's settings hold them, and so does what a visitor is told about a table. */
export type Stakes = Pick<TableConfig, 'unit' | 'smallBlind' | 'bigBlind' | 'ante' | 'anteFrom'>;

export function blindsText(table: Stakes): string {
  return `${formatAmount(table.smallBlind, table)}/${formatAmount(table.bigBlind, table)}`;
}

/** The ante as the stakes name it: "ante 5" when everyone pays it, "BB ante 20" when the big blind pays it for the table, and nothing when there is none. */
export function anteText(table: Stakes): string {
  if (table.ante === 0) {
    return '';
  }

  return `${table.anteFrom === 'bigBlind' ? 'BB ante' : 'ante'} ${formatAmount(table.ante, table)}`;
}

/** The stakes as they are written wherever a table says what it plays: 10/20, and with an ante 10/20 · ante 5. */
export function stakesText(table: Stakes): string {
  const ante = anteText(table);

  return ante ? `${blindsText(table)} · ${ante}` : blindsText(table);
}
