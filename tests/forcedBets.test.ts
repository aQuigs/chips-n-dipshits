import assert from 'node:assert/strict';
import { test } from 'node:test';

import { forcedBets, openingBet, positionsOf } from '../src/engine/index.ts';
import type { BombPot, ForcedBet, TableConfig } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';

/** The list as short text, one entry per forced bet: who, what, how much and how it counts. */
function listed(bets: ForcedBet[]): string[] {
  return bets.map((bet) => `P${bet.seat} ${bet.what} ${bet.amount} ${bet.as}`);
}

/** The forced bets of the next hand at a table with these stacks, the button on seat 0 and blinds of 10 and 20. `bombPot` makes that hand one. */
function forcedAt(stacks: number[], config: Partial<TableConfig> = {}, straddlers: number[] = [], bombPot: BombPot | null = null): string[] {
  const t = new TestTable({ stacks, config });
  for (const seat of straddlers) {
    t.state.seats[seat]!.straddles = ['straddle'];
  }

  return listed(forcedBets(t.state, positionsOf(stacks.map((_stack, seat) => seat), 0), bombPot));
}

const FOUR = [1000, 1000, 1000, 1000];

test('the blinds fall left of the button, and heads-up the button has the small blind', () => {
  assert.deepEqual(positionsOf([0, 3, 5, 8], 5), { button: 5, order: [8, 0, 3, 5], sbSeat: 8, bbSeat: 0 });
  assert.deepEqual(positionsOf([2, 7], 7), { button: 7, order: [2, 7], sbSeat: 7, bbSeat: 2 });
});

test('with no ante and no straddle the forced bets are the two blinds, both live', () => {
  assert.deepEqual(forcedAt(FOUR), ['P1 small blind 10 live', 'P2 big blind 20 live']);
  assert.deepEqual(forcedAt([1000, 1000]), ['P0 small blind 10 live', 'P1 big blind 20 live']);

  // Who would pay an ante means nothing while there is none
  assert.deepEqual(forcedAt(FOUR, { ante: 0, anteFrom: 'bigBlind' }), ['P1 small blind 10 live', 'P2 big blind 20 live']);
});

test('when everyone antes, each player dealt in owes one before the blinds, clockwise from the left of the button', () => {
  assert.deepEqual(forcedAt(FOUR, { ante: 5 }), [
    'P1 ante 5 contribution',
    'P2 ante 5 contribution',
    'P3 ante 5 contribution',
    'P0 ante 5 contribution',
    'P1 small blind 10 live',
    'P2 big blind 20 live',
  ]);

  assert.deepEqual(forcedAt([1000, 1000], { ante: 5 }), ['P1 ante 5 contribution', 'P0 ante 5 contribution', 'P0 small blind 10 live', 'P1 big blind 20 live']);
});

test('a big-blind ante is one dead ante from the big blind, owed after the blind, heads-up too', () => {
  assert.deepEqual(forcedAt(FOUR, { ante: 20, anteFrom: 'bigBlind' }), ['P1 small blind 10 live', 'P2 big blind 20 live', 'P2 big blind ante 20 dead']);
  assert.deepEqual(forcedAt([1000, 1000], { ante: 20, anteFrom: 'bigBlind' }), ['P0 small blind 10 live', 'P1 big blind 20 live', 'P1 big blind ante 20 dead']);
});

test('a straddle is the last forced bet, from the player left of the big blind who asked for one', () => {
  assert.deepEqual(forcedAt(FOUR, {}, [3]), ['P1 small blind 10 live', 'P2 big blind 20 live', 'P3 straddle 40 live']);
  assert.deepEqual(forcedAt([1000, 1000, 1000], {}, [0]), ['P1 small blind 10 live', 'P2 big blind 20 live', 'P0 straddle 40 live'], 'three-handed the button is under the gun');

  assert.deepEqual(forcedAt(FOUR, { ante: 5 }, [3]).slice(4), ['P1 small blind 10 live', 'P2 big blind 20 live', 'P3 straddle 40 live']);
  assert.deepEqual(forcedAt(FOUR, { ante: 20, anteFrom: 'bigBlind' }, [3]), ['P1 small blind 10 live', 'P2 big blind 20 live', 'P2 big blind ante 20 dead', 'P3 straddle 40 live']);
});

test('there is no straddle from another seat, heads-up, with straddles off, or from a stack that cannot cover it', () => {
  const blinds = ['P1 small blind 10 live', 'P2 big blind 20 live'];

  assert.deepEqual(forcedAt(FOUR, {}, [0, 1, 2]), blinds, 'only the seat left of the big blind may straddle');
  assert.deepEqual(forcedAt([1000, 1000], {}, [0, 1]), ['P0 small blind 10 live', 'P1 big blind 20 live']);
  assert.deepEqual(forcedAt(FOUR, { allowStraddle: false }, [3]), blinds);
  assert.deepEqual(forcedAt([1000, 1000, 1000, 39], {}, [3]), blinds);
  assert.deepEqual(forcedAt([1000, 1000, 1000, 40], {}, [3]).slice(2), ['P3 straddle 40 live']);
});

test('a straddle has to be covered by what the ante leaves', () => {
  assert.equal(forcedAt([1000, 1000, 1000, 44], { ante: 5 }, [3]).includes('P3 straddle 40 live'), false);
  assert.equal(forcedAt([1000, 1000, 1000, 45], { ante: 5 }, [3]).includes('P3 straddle 40 live'), true);

  // The big blind's ante is not the straddler's to pay
  assert.equal(forcedAt([1000, 1000, 1000, 40], { ante: 20, anteFrom: 'bigBlind' }, [3]).includes('P3 straddle 40 live'), true);
});

test('the list asks for the whole of each bet whatever the stacks, and working it out moves no chips', () => {
  const t = new TestTable({ stacks: [3, 1, 25, 1000], config: { ante: 5 } });
  const before = JSON.stringify(t.state);

  assert.deepEqual(listed(forcedBets(t.state, positionsOf([0, 1, 2, 3], 0))), [
    'P1 ante 5 contribution',
    'P2 ante 5 contribution',
    'P3 ante 5 contribution',
    'P0 ante 5 contribution',
    'P1 small blind 10 live',
    'P2 big blind 20 live',
  ]);
  assert.equal(JSON.stringify(t.state), before);
});

test('the betting starts from the biggest live bet, and from the later of two the same size', () => {
  const opening = (config: Partial<TableConfig>, straddlers: number[] = []) => {
    const t = new TestTable({ stacks: FOUR, config });
    for (const seat of straddlers) {
      t.state.seats[seat]!.straddles = ['straddle'];
    }

    const { seat, what, amount } = openingBet(forcedBets(t.state, positionsOf([0, 1, 2, 3], 0)));

    return `P${seat} ${what} ${amount}`;
  };

  assert.equal(opening({}), 'P2 big blind 20');
  assert.equal(opening({}, [3]), 'P3 straddle 40');
  assert.equal(opening({ smallBlind: 20, bigBlind: 20 }), 'P2 big blind 20');

  // An ante is no bet, however big it is
  assert.equal(opening({ ante: 500 }), 'P2 big blind 20');
  assert.equal(opening({ ante: 500, anteFrom: 'bigBlind' }, [3]), 'P3 straddle 40');
});

test('a bomb pot is one stake from everyone dealt in, clockwise from the left of the button, and nothing else', () => {
  const everyone = ['P1 bomb pot 100 contribution', 'P2 bomb pot 100 contribution', 'P3 bomb pot 100 contribution', 'P0 bomb pot 100 contribution'];

  assert.deepEqual(forcedAt(FOUR, {}, [], { amount: 100 }), everyone);
  assert.deepEqual(forcedAt([1000, 1000], {}, [], { amount: 250 }), ['P1 bomb pot 250 contribution', 'P0 bomb pot 250 contribution']);

  // No blinds, so no straddle either, and the bomb pot takes the place of whichever ante the table plays
  assert.deepEqual(forcedAt(FOUR, { ante: 5 }, [3], { amount: 100 }), everyone);
  assert.deepEqual(forcedAt(FOUR, { ante: 20, anteFrom: 'bigBlind' }, [0, 1, 2, 3], { amount: 100 }), everyone);

  // The list asks for the whole amount from a stack that cannot cover it, as for any forced bet
  assert.deepEqual(forcedAt([1000, 3, 1000, 100], {}, [], { amount: 100 }), everyone);
});
