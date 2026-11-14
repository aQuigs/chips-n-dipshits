/*
 * Every amount at a table is kept as a whole number of its smallest unit: a chip, or a cent at a
 * table that plays dollars and cents, where 1.50 is 150. This is the one place such a number is turned
 * into text, and the one place an amount someone typed is read. Both ask which table the amount
 * belongs to, so that 150 is never printed as 150 where it means 1.50.
 */
import { GameError } from './types.ts';
import type { Unit } from './types.ts';
import { isWholeIn, LIMITS } from './validate.ts';

/** Whatever says which kind of table an amount belongs to: the table's settings, or what a visitor is told about it. */
export interface Denominated {
  unit: Unit;
}

interface UnitStyle {
  /** Digits after the point. */
  decimals: number;
  /** What a refusal calls a value of this kind. */
  called: string;
  /** Said to someone who typed more decimals than that. */
  tooFine: string;
}

const STYLES: Record<Unit, UnitStyle> = {
  chips: { decimals: 0, called: 'a whole number', tooFine: 'This table plays whole chips, so an amount has no decimals' },
  cents: { decimals: 2, called: 'an amount to the cent', tooFine: 'This table plays to the cent, so an amount has at most two decimals' },
};

/** How many of the table's smallest unit make one of what it writes: 100 cents to the dollar. */
function perWhole(table: Denominated): number {
  return 10 ** STYLES[table.unit].decimals;
}

function written(amount: number, table: Denominated, grouped: boolean): string {
  const { decimals } = STYLES[table.unit];
  const size = Math.abs(amount);
  const whole = String(Math.floor(size / perWhole(table)));
  const fraction = decimals > 0 ? `.${String(size % perWhole(table)).padStart(decimals, '0')}` : '';

  return `${amount < 0 ? '-' : ''}${grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole}${fraction}`;
}

/** An amount as it is written everywhere, in the play-by-play and on the page: 12,500 in whole chips, 125.00 in dollars and cents. */
export function formatAmount(amount: number, table: Denominated): string {
  return written(amount, table, true);
}

/** An amount as it is put in a box to be typed over: the same digits without the commas. */
export function editableAmount(amount: number, table: Denominated): string {
  return written(amount, table, false);
}

export function signedAmount(amount: number, table: Denominated): string {
  return amount > 0 ? `+${formatAmount(amount, table)}` : formatAmount(amount, table);
}

// Nine characters are what a seat has room for: 9,999,999 in chips and 99,999.99 in dollars are the same count of the smallest unit
const SHORT_FROM = 10_000_000;
const SHORT_UNITS: [size: number, letter: string][] = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K'],
];

/**
 * An amount for a spot too narrow for more than nine characters, such as a seat. From there up it is
 * two decimals and a letter: 12.34M in chips, 123.45K in dollars. What a player has is cut off, so
 * nobody is shown more than they have; what a move costs is rounded `up`, so no button says less than
 * it takes.
 */
export function shortAmount(amount: number, table: Denominated, rounding: 'down' | 'up' = 'down'): string {
  if (amount < SHORT_FROM) {
    return formatAmount(amount, table);
  }

  const [letterSize, letter] = SHORT_UNITS.find(([unit]) => amount >= unit * perWhole(table))!;
  const size = letterSize * perWhole(table);
  const step = size / 100;
  const shown = (rounding === 'up' ? Math.ceil(amount / step) : Math.floor(amount / step)) * step;

  if (shown !== amount) {
    // Rounding up can reach the next unit: 999,999,999 is shown as 1B, not 1000M
    return shortAmount(shown, table);
  }

  const whole = Math.floor(amount / size);
  const fraction = String((amount % size) / step).padStart(2, '0').replace(/0+$/, '');

  return `${whole}${fraction ? `.${fraction}` : ''}${letter}`;
}

/**
 * The amount as a plain number of what the table writes, 1.5 for 150 cents, for a spreadsheet cell
 * that people add up. Anything a person reads as text goes through `formatAmount`.
 */
export function asNumber(amount: number, table: Denominated): number {
  return amount / perWhole(table);
}

/** Whether amounts at the table are typed with a decimal point, which decides the keypad a phone offers. */
export function hasDecimals(table: Denominated): boolean {
  return STYLES[table.unit].decimals > 0;
}

/** What came of reading something a person typed as an amount: the amount in the table's smallest unit, or what is wrong with it. */
export type TypedAmount = { ok: true; amount: number } | { ok: false; problem: string };

// Commas between every three digits, as in 1,000,000. A leading zero is no way to write a thousand, and "0,500" may have been meant as a half
const GROUPED = /^[1-9]\d{0,2}(,\d{3})+$/;

// A single comma before the last one or two digits can't be a thousands comma. It is the decimal point
// that the number pad of a phone set to most European languages types, and that pad has no other
const DECIMAL_COMMA = /^(\d*),(\d{1,2})$/;
const DECIMAL_POINT = /^([\d,]*)(?:\.(\d*))?$/;

/**
 * Reads an amount someone typed: 0.5, .5, 1,000.50. More decimals than the table plays are refused,
 * never rounded: a player who types 1.555 has not asked for 1.55 or 1.56, and one who types 1.500
 * where others write a thousand five hundred that way has not asked for 1.50.
 */
export function parseAmount(typed: string, table: Denominated): TypedAmount {
  const { decimals, tooFine } = STYLES[table.unit];
  const text = typed.trim();
  const [, whole = '', fraction = ''] = DECIMAL_COMMA.exec(text) ?? DECIMAL_POINT.exec(text) ?? [];
  const digits = GROUPED.test(whole) ? whole.replaceAll(',', '') : whole;

  if (!/^\d*$/.test(digits) || digits + fraction === '') {
    return { ok: false, problem: `Type the amount in digits, like ${formatAmount(125_050, table)}` };
  }

  if (fraction.length > decimals) {
    return { ok: false, problem: tooFine };
  }

  const amount = Number(digits) * perWhole(table) + Number(fraction.padEnd(decimals, '0'));

  // Past this a number no longer holds every digit that was typed
  if (!Number.isSafeInteger(amount)) {
    return { ok: false, problem: 'That is more than any table holds' };
  }

  return { ok: true, amount };
}

/** An amount a request carries, which must be a whole number of the table's smallest unit; the refusal gives the range as the table writes it. */
export function validAmount(value: unknown, what: string, table: Denominated, min: number, max = LIMITS.chips): number {
  if (!isWholeIn(value, min, max)) {
    throw new GameError(`${what} must be ${STYLES[table.unit].called} from ${formatAmount(min, table)} to ${formatAmount(max, table)}`);
  }

  return value;
}
