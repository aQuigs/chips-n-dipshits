import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asNumber, editableAmount, formatAmount, hasDecimals, LIMITS, parseAmount, shortAmount, signedAmount, validAmount } from '../src/engine/index.ts';
import type { Denominated } from '../src/engine/index.ts';
import { seededRng } from './helpers.ts';

const CHIPS: Denominated = { unit: 'chips' };
const CENTS: Denominated = { unit: 'cents' };

// The most a table can hold: every seat at the limit
const TABLE_FULL = 10 * LIMITS.chips;

const read = (typed: string, table: Denominated): number | string => {
  const result = parseAmount(typed, table);

  return result.ok ? result.amount : result.problem;
};

test('an amount is written in whole chips at one kind of table and in dollars and cents at the other', () => {
  const written = (amount: number) => [formatAmount(amount, CHIPS), formatAmount(amount, CENTS)];

  assert.deepEqual(written(0), ['0', '0.00']);
  assert.deepEqual(written(5), ['5', '0.05']);
  assert.deepEqual(written(50), ['50', '0.50']);
  assert.deepEqual(written(150), ['150', '1.50']);
  assert.deepEqual(written(12_500), ['12,500', '125.00']);
  assert.deepEqual(written(100_000_000), ['100,000,000', '1,000,000.00']);
  assert.deepEqual(written(LIMITS.chips), ['1,000,000,000', '10,000,000.00']);
  assert.deepEqual(written(-650), ['-650', '-6.50']);
  assert.deepEqual(written(-5), ['-5', '-0.05']);

  assert.deepEqual([editableAmount(123_456_789, CHIPS), editableAmount(123_456_789, CENTS)], ['123456789', '1234567.89'], 'a box to type in has no commas');
  assert.deepEqual([signedAmount(150, CENTS), signedAmount(-150, CENTS), signedAmount(0, CENTS), signedAmount(150, CHIPS)], ['+1.50', '-1.50', '0.00', '+150']);
  assert.deepEqual([asNumber(150, CHIPS), asNumber(150, CENTS), asNumber(-650, CENTS)], [150, 1.5, -6.5]);
  assert.deepEqual([hasDecimals(CHIPS), hasDecimals(CENTS)], [false, true]);
});

test('what a person types is read into the smallest unit, however they wrote it', () => {
  assert.equal(read('0.5', CENTS), 50);
  assert.equal(read('.5', CENTS), 50);
  assert.equal(read('1,000.50', CENTS), 100_050);
  assert.equal(read('1,000,000.00', CENTS), 100_000_000);
  assert.equal(read('1.', CENTS), 100);
  assert.equal(read('12', CENTS), 1200);
  assert.equal(read('  3.07 ', CENTS), 307);
  assert.equal(read('007', CENTS), 700);
  assert.equal(read('1,000', CENTS), 100_000, 'a comma before three digits is a thousands comma');
  assert.equal(read('0', CENTS), 0);

  // The decimal comma of a phone's number pad, where it can be nothing else
  assert.equal(read('0,50', CENTS), 50);
  assert.equal(read('1,5', CENTS), 150);
  assert.equal(read(',5', CENTS), 50);

  assert.equal(read('1,000', CHIPS), 1000);
  assert.equal(read('12', CHIPS), 12);
  assert.equal(read('5.', CHIPS), 5);
  assert.equal(read('1,234,567', CHIPS), 1_234_567);
});

test('an amount finer than the table plays is refused, never rounded', () => {
  const toTheCent = 'This table plays to the cent, so an amount has at most two decimals';
  const wholeChips = 'This table plays whole chips, so an amount has no decimals';

  for (const typed of ['1.555', '0.001', '1.500', '.125', '1,000.999']) {
    assert.equal(read(typed, CENTS), toTheCent, typed);
  }

  for (const typed of ['1.5', '1.0', '0.50', '0,5', '1,50', '.5']) {
    assert.equal(read(typed, CHIPS), wholeChips, typed);
  }
});

test('what cannot be an amount is refused with a way to write one', () => {
  const unreadable = ['', ' ', '.', ',', 'abc', '-5', '+5', '$5', '5$', '1e3', '0x10', '1 000', '1.2.3', '1,2,3', '1,00,000', '0,555', '01,000', '1,0000', '1.000,50', '12,345,67', '１２', 'Infinity', 'NaN'];

  for (const typed of unreadable) {
    assert.equal(read(typed, CENTS), 'Type the amount in digits, like 1,250.50', `"${typed}" at a table that plays cents`);
    assert.equal(read(typed, CHIPS), 'Type the amount in digits, like 125,050', `"${typed}" at a table that plays chips`);
  }

  assert.equal(read('99999999999999999999', CHIPS), 'That is more than any table holds');
  assert.equal(read('99999999999999.99', CENTS), 'That is more than any table holds');
});

test('whatever is written out reads back as the same amount', () => {
  const rng = seededRng(41);
  const amounts = [0, 1, 9, 10, 99, 100, 101, 999, 1000, 99_999, 100_000, LIMITS.chips, TABLE_FULL];

  for (let draw = 0; draw < 2000; draw++) {
    amounts.push(rng.int(10 ** (1 + rng.int(10))));
  }

  for (const table of [CHIPS, CENTS]) {
    for (const amount of amounts) {
      assert.equal(read(formatAmount(amount, table), table), amount, `${amount} as ${formatAmount(amount, table)}`);
      assert.equal(read(editableAmount(amount, table), table), amount, `${amount} as ${editableAmount(amount, table)}`);
    }
  }
});

test('a short amount keeps to nine characters without ever flattering a stack or understating a price', () => {
  assert.deepEqual([shortAmount(9_999_999, CHIPS), shortAmount(9_999_999, CENTS)], ['9,999,999', '99,999.99']);
  assert.deepEqual([shortAmount(10_000_000, CHIPS), shortAmount(10_000_000, CENTS)], ['10M', '100K']);
  assert.deepEqual([shortAmount(12_345_678, CHIPS), shortAmount(12_345_678, CENTS)], ['12.34M', '123.45K']);
  assert.deepEqual([shortAmount(12_345_678, CHIPS, 'up'), shortAmount(12_345_678, CENTS, 'up')], ['12.35M', '123.46K']);
  assert.deepEqual([shortAmount(999_999_999, CHIPS), shortAmount(99_999_999, CENTS)], ['999.99M', '999.99K']);
  assert.deepEqual([shortAmount(999_999_999, CHIPS, 'up'), shortAmount(99_999_999, CENTS, 'up')], ['1B', '1M'], 'rounding up reaches the next letter');
  assert.deepEqual([shortAmount(LIMITS.chips, CHIPS), shortAmount(LIMITS.chips, CENTS)], ['1B', '10M']);
  assert.deepEqual([shortAmount(TABLE_FULL, CHIPS), shortAmount(TABLE_FULL, CENTS)], ['10B', '100M']);

  const LETTERS: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
  const worth = (short: string, table: Denominated): number => {
    const letter = LETTERS[short.slice(-1)];

    // Hundredths of a letter are whole numbers of the smallest unit, so this is exact
    return letter ? Math.round(Number(short.slice(0, -1)) * 100) * (letter / 100) * (hasDecimals(table) ? 100 : 1) : (read(short, table) as number);
  };

  const rng = seededRng(43);

  for (let draw = 0; draw < 4000; draw++) {
    const amount = rng.int(10 ** (6 + rng.int(5)));

    for (const table of [CHIPS, CENTS]) {
      const [down, up] = [shortAmount(amount, table), shortAmount(amount, table, 'up')];

      assert.ok(down.length <= 9 && up.length <= 9, `${amount} is written ${down} and ${up}`);
      assert.ok(worth(down, table) <= amount && worth(up, table) >= amount, `${amount} is written ${down} and ${up}`);
      assert.ok(amount - worth(down, table) < amount / 100 + 1 && worth(up, table) - amount < amount / 100 + 1, `${amount} as ${down} or ${up} is off by more than a hundredth`);
    }
  }
});

test('an amount sent to the table must be a whole number of its smallest unit, and the refusal gives the range as the table writes it', () => {
  assert.equal(validAmount(150, 'Your buy-in', CENTS, 100, 200), 150);
  assert.equal(validAmount(LIMITS.chips, 'The stack', CHIPS, 0), LIMITS.chips);

  for (const value of [99, 201, 150.5, '150', null, undefined, Number.NaN, Infinity]) {
    assert.throws(() => validAmount(value, 'Your buy-in', CENTS, 100, 200), { name: 'GameError', message: 'Your buy-in must be an amount to the cent from 1.00 to 2.00' });
    assert.throws(() => validAmount(value, 'Your buy-in', CHIPS, 100, 200), { name: 'GameError', message: 'Your buy-in must be a whole number from 100 to 200' });
  }

  assert.throws(() => validAmount(LIMITS.chips + 1, 'The stack', CENTS, 0), { message: 'The stack must be an amount to the cent from 0.00 to 10,000,000.00' });
});
