import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateHand,
  freshDeck,
  rankOf,
  suitOf,
  HIGH_CARD,
  PAIR,
  TWO_PAIR,
  THREE_OF_A_KIND,
  STRAIGHT,
  FLUSH,
  FULL_HOUSE,
  FOUR_OF_A_KIND,
  STRAIGHT_FLUSH,
} from '../src/engine/index.ts';
import type { Card } from '../src/engine/index.ts';
import { cards, seededRng } from './helpers.ts';

function hand(text: string) {
  return evaluateHand(cards(text));
}

test('ranks the categories in order', () => {
  const ascending = [
    'Ac Kd Qh Js 9c',
    '2c 2d 3h 4s 5c',
    '2c 2d 3h 3s 4c',
    '2c 2d 2h 3s 4c',
    '5c 4d 3h 2s Ac',
    '2c 3c 4c 5c 7c',
    '2c 2d 2h 3s 3c',
    '2c 2d 2h 2s 3c',
    '5c 4c 3c 2c Ac',
  ].map(hand);

  ascending.forEach((value, category) => {
    assert.equal(value.category, category);
  });

  for (let i = 1; i < ascending.length; i++) {
    assert.ok(ascending[i]!.score > ascending[i - 1]!.score, `${ascending[i]!.cards.join(' ')} should beat ${ascending[i - 1]!.cards.join(' ')}`);
  }
});

test('breaks ties inside a category by the right cards', () => {
  const beats = (winner: string, loser: string) => {
    assert.ok(hand(winner).score > hand(loser).score, `${winner} should beat ${loser}`);
  };

  beats('Ac Kd Qh Js 9c', 'Ac Kd Qh Js 8c');
  beats('Ac Ad 3h 4s 5c', 'Kc Kd Ah Qs Jc');
  beats('Ac Ad Kh 4s 5c', 'Ac Ad Qh Js Tc');
  beats('Ac Ad 2h 2s 3c', 'Kc Kd Qh Qs Ac');
  beats('Kc Kd 3h 3s 2c', 'Kc Kd 2h 2s Ac');
  beats('Kc Kd 2h 2s Ac', 'Kc Kd 2h 2s Qc');
  beats('3c 3d 3h 4s 5c', '2c 2d 2h As Kc');
  beats('6c 5d 4h 3s 2c', '5c 4d 3h 2s Ac');
  beats('Ac Kc Qc Jc 9c', 'Ad Kd Qd Jd 8d');
  beats('3c 3d 3h 2s 2c', '2c 2d 2h As Ac');
  beats('3c 3d 3h 3s 2c', '2c 2d 2h 2s Ac');
  beats('2c 2d 2h 2s Ac', '2c 2d 2h 2s Kc');
  beats('6c 5c 4c 3c 2c', '5d 4d 3d 2d Ad');
});

test('suits never break a tie', () => {
  assert.equal(hand('Ac Kd Qh Js 9c').score, hand('Ad Kh Qs Jc 9d').score);
  assert.equal(hand('Ac Kc Qc Jc 9c').score, hand('Ad Kd Qd Jd 9d').score);
});

test('picks the best five of seven', () => {
  assert.deepEqual(hand('As Ah Kd Kc Qs Qh Jd').cards, cards('As Ah Kd Kc Qs'));
  assert.deepEqual(hand('2c 3c 4c 5c 6c 7c 8c').cards, cards('8c 7c 6c 5c 4c'));
  assert.deepEqual(hand('Ac Ad Ah Kc Kd Kh 2s').cards, cards('Ac Ad Ah Kc Kd'));
  assert.equal(hand('Ac Kc Qc 2c 3c 4d 5d').category, FLUSH);
  assert.deepEqual(hand('Ac 2d 3h 4s 5c 6d 9h').cards, cards('6d 5c 4s 3h 2d'));
  assert.deepEqual(hand('5c 4d 3h 2s Ac Kd Kh').cards, cards('5c 4d 3h 2s Ac'));
});

test('the board playing gives everyone the same hand', () => {
  const board = 'As Ks Qs Js Ts';

  assert.equal(hand(`${board} 2c 3d`).score, hand(`${board} 9h 9d`).score);
});

test('every five-card hand lands in the right category', () => {
  // The well-known counts of each hand type among the 2,598,960 five-card hands
  const expected: Record<number, number> = {
    [HIGH_CARD]: 1_302_540,
    [PAIR]: 1_098_240,
    [TWO_PAIR]: 123_552,
    [THREE_OF_A_KIND]: 54_912,
    [STRAIGHT]: 10_200,
    [FLUSH]: 5_108,
    [FULL_HOUSE]: 3_744,
    [FOUR_OF_A_KIND]: 624,
    [STRAIGHT_FLUSH]: 40,
  };

  const deck = freshDeck();
  const counts: Record<number, number> = {};

  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      for (let c = b + 1; c < 52; c++) {
        for (let d = c + 1; d < 52; d++) {
          for (let e = d + 1; e < 52; e++) {
            const category = evaluateHand([deck[a]!, deck[b]!, deck[c]!, deck[d]!, deck[e]!]).category;
            counts[category] = (counts[category] ?? 0) + 1;
          }
        }
      }
    }
  }

  assert.deepEqual(counts, expected);
});

/**
 * A second evaluator written a different way: it reads the hand straight off the rank and suit counts
 * instead of trying every five-card subset. Returns the category followed by the tiebreak ranks.
 */
function referenceValue(hand: readonly Card[]): number[] {
  const ranksDesc = (list: readonly Card[]) => list.map(rankOf).sort((a, b) => b - a);

  const straightHigh = (ranks: readonly number[]): number => {
    const present = new Set(ranks);
    if (present.has(14)) {
      present.add(1);
    }

    for (let high = 14; high >= 5; high--) {
      if ([0, 1, 2, 3, 4].every((step) => present.has(high - step))) {
        return high;
      }
    }

    return 0;
  };

  const suited = ['c', 'd', 'h', 's'].map((suit) => hand.filter((card) => suitOf(card) === suit)).find((group) => group.length >= 5);
  if (suited) {
    const high = straightHigh(ranksDesc(suited));
    if (high) {
      return [STRAIGHT_FLUSH, high];
    }
  }

  const ranks = ranksDesc(hand);
  const count = (rank: number) => ranks.filter((r) => r === rank).length;
  const distinct = [...new Set(ranks)];
  const withCount = (n: number) => distinct.filter((rank) => count(rank) === n);
  const kickers = (exclude: readonly number[], n: number) => distinct.filter((rank) => !exclude.includes(rank)).slice(0, n);

  const quads = withCount(4);
  if (quads.length > 0) {
    return [FOUR_OF_A_KIND, quads[0]!, ...kickers([quads[0]!], 1)];
  }

  const trips = withCount(3);
  const pairs = withCount(2);
  const fullHousePair = [...trips.slice(1), ...pairs].sort((a, b) => b - a)[0];
  if (trips.length > 0 && fullHousePair !== undefined) {
    return [FULL_HOUSE, trips[0]!, fullHousePair];
  }

  if (suited) {
    return [FLUSH, ...ranksDesc(suited).slice(0, 5)];
  }

  const high = straightHigh(ranks);
  if (high) {
    return [STRAIGHT, high];
  }

  if (trips.length > 0) {
    return [THREE_OF_A_KIND, trips[0]!, ...kickers([trips[0]!], 2)];
  }

  if (pairs.length >= 2) {
    return [TWO_PAIR, pairs[0]!, pairs[1]!, ...kickers([pairs[0]!, pairs[1]!], 1)];
  }

  if (pairs.length === 1) {
    return [PAIR, pairs[0]!, ...kickers([pairs[0]!], 3)];
  }

  return [HIGH_CARD, ...distinct.slice(0, 5)];
}

function compareValues(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }

  return 0;
}

test('agrees with an independently written evaluator on random seven-card hands', () => {
  const rng = seededRng(2024);
  const deck = freshDeck();

  const randomSeven = (): Card[] => {
    const pool = [...deck];
    const picked: Card[] = [];
    for (let i = 0; i < 7; i++) {
      picked.push(pool.splice(rng.int(pool.length), 1)[0]!);
    }

    return picked;
  };

  for (let i = 0; i < 10_000; i++) {
    const first = randomSeven();
    const second = randomSeven();
    const firstValue = evaluateHand(first);
    const secondValue = evaluateHand(second);

    assert.equal(firstValue.category, referenceValue(first)[0], `category of ${first.join(' ')}`);
    assert.equal(
      Math.sign(firstValue.score - secondValue.score),
      compareValues(referenceValue(first), referenceValue(second)),
      `${first.join(' ')} against ${second.join(' ')}`,
    );
  }
});
