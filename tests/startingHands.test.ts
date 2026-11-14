import assert from 'node:assert/strict';
import { test } from 'node:test';

import { freshDeck, isStartingHand, parseStartingHand, RANKS, startingHandWords } from '../src/engine/index.ts';
import type { Card } from '../src/engine/index.ts';
import { cards } from './helpers.ts';

/** Every two cards a player can be dealt. */
const EVERY_HAND: Card[][] = freshDeck().flatMap((first, index, deck) => deck.slice(index + 1).map((second) => [first, second]));

/** Every hand a bounty can be put on, in kept form. */
const EVERY_NOTATION: string[] = [...RANKS].reverse().flatMap((high, index, ranks) => [`${high}${high}`, ...ranks.slice(index + 1).flatMap((low) => [`${high}${low}`, `${high}${low}s`, `${high}${low}o`])]);

test('a hand is kept and shown one way, however it was typed: the higher rank first, then s or o, a ten as T', () => {
  for (const [typed, kept] of [
    ['72', '72'],
    ['27', '72'],
    ['72o', '72o'],
    ['27O', '72o'],
    ['j4s', 'J4s'],
    ['4JS', 'J4s'],
    [' 7 2 s ', '72s'],
    ['aa', 'AA'],
    ['10 9', 'T9'],
    ['910s', 'T9s'],
    ['t9o', 'T9o'],
    ['1010', 'TT'],
  ] as const) {
    assert.equal(parseStartingHand(typed), kept, typed);
  }
});

test('anything that is not two ranks with an s or an o, or a pair with neither, is refused in words that say what is allowed', () => {
  const allowed = 'Write two ranks, such as 72 or AA, with s after them for suited only or o for offsuit only, such as J4s or 72o. A ten is T or 10';

  for (const typed of ['7', '722', '72x', '7x', 'XYZ', '7h2c', '1', '11', '72so', 's72', '7-2']) {
    assert.throws(() => parseStartingHand(typed), { name: 'GameError', message: `“${typed}” isn't a hand. ${allowed}` }, typed);
  }

  assert.throws(() => parseStartingHand('  '), { name: 'GameError', message: `A bounty needs a hand. ${allowed}` });
  assert.throws(() => parseStartingHand('AAs'), { name: 'GameError', message: 'A pair is never suited or offsuit: write it as AA' });
  assert.throws(() => parseStartingHand('22o'), { name: 'GameError', message: 'A pair is never suited or offsuit: write it as 22' });
});

test('over all 1,326 hands a player can be dealt, each hand written down is exactly the cards it names', () => {
  assert.equal(EVERY_HAND.length, 1326);
  assert.equal(EVERY_NOTATION.length, 13 + 78 * 3);

  const count = (hand: string) => EVERY_HAND.filter((hole) => isStartingHand(hole, hand)).length;

  assert.deepEqual(['72', '72s', '72o', 'AA', 'J4s', 'T9o'].map(count), [16, 4, 12, 6, 4, 12]);

  // Every kind of hand matches as many hands as it should, and every hand is the one each kind says it is
  for (const notation of EVERY_NOTATION) {
    const expected = notation.length === 2 ? (notation[0] === notation[1] ? 6 : 16) : notation[2] === 's' ? 4 : 12;
    assert.equal(count(notation), expected, notation);
  }

  for (const hole of EVERY_HAND) {
    const matches = EVERY_NOTATION.filter((notation) => isStartingHand(hole, notation));
    const pair = hole[0]![0] === hole[1]![0];

    assert.equal(matches.length, pair ? 1 : 2, `${hole.join(' ')} is ${matches.join(', ')}`);
    assert.equal(isStartingHand([...hole].reverse(), matches[0]!), true, 'the order the cards were dealt in counts for nothing');
  }

  assert.equal(isStartingHand(cards('7h 2c'), '72s'), false);
  assert.equal(isStartingHand(cards('7h 2h'), '72o'), false);
  assert.equal(isStartingHand(cards('7h'), '72'), false, 'one card is no hand');
});

test('a hand is said aloud as players say it', () => {
  assert.deepEqual(['J4s', '72', '72o', '72s', 'AA', 'T9', 'K2o'].map(startingHandWords), [
    'jack-four suited',
    'seven-deuce',
    'seven-deuce offsuit',
    'seven-deuce suited',
    'pocket aces',
    'ten-nine',
    'king-deuce offsuit',
  ]);
});
