import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPots, splitAmount } from '../src/engine/index.ts';

function player(seat: number, committed: number, folded = false) {
  return { seat, committed, folded };
}

test('one pot when everyone put in the same', () => {
  assert.deepEqual(buildPots([player(0, 100), player(1, 100), player(2, 100)]), [{ amount: 300, eligible: [0, 1, 2] }]);
});

test('a short all-in caps the main pot and the rest goes to a side pot', () => {
  assert.deepEqual(buildPots([player(0, 50), player(1, 200), player(2, 200)]), [
    { amount: 150, eligible: [0, 1, 2] },
    { amount: 300, eligible: [1, 2] },
  ]);
});

test('three different all-in sizes make three pots', () => {
  assert.deepEqual(buildPots([player(0, 100), player(1, 300), player(2, 500), player(3, 500)]), [
    { amount: 400, eligible: [0, 1, 2, 3] },
    { amount: 600, eligible: [1, 2, 3] },
    { amount: 400, eligible: [2, 3] },
  ]);
});

test("a folded player's chips stay in the pots they reached but win nothing", () => {
  assert.deepEqual(buildPots([player(0, 100), player(1, 60, true), player(2, 300), player(3, 300)]), [
    { amount: 360, eligible: [0, 2, 3] },
    { amount: 400, eligible: [2, 3] },
  ]);
});

test('dead money above the short stack lands in the pot only the bigger stacks can win', () => {
  // Seat 1 called 200 and later folded; seat 0 was all in for 50
  assert.deepEqual(buildPots([player(0, 50), player(1, 200, true), player(2, 400), player(3, 400)]), [
    { amount: 200, eligible: [0, 2, 3] },
    { amount: 850, eligible: [2, 3] },
  ]);
});

test('a lone remaining player gets a single pot with everything in it', () => {
  assert.deepEqual(buildPots([player(0, 20, true), player(1, 40, true), player(2, 40)]), [{ amount: 100, eligible: [2] }]);
});

test('pots always add up to the chips put in', () => {
  const contributions = [player(0, 13), player(1, 77, true), player(2, 250), player(3, 77), player(4, 250), player(5, 1, true)];
  const total = contributions.reduce((sum, c) => sum + c.committed, 0);

  assert.equal(buildPots(contributions).reduce((sum, pot) => sum + pot.amount, 0), total);
});

test('an even split gives everyone the same', () => {
  assert.deepEqual([...splitAmount(300, [4, 7, 1])], [[4, 100], [7, 100], [1, 100]]);
});

test('odd chips go to the winners first in the given order', () => {
  assert.deepEqual([...splitAmount(101, [4, 7])], [[4, 51], [7, 50]]);
  assert.deepEqual([...splitAmount(302, [4, 7, 1])], [[4, 101], [7, 101], [1, 100]]);
});

test('dead money is in the main pot, where a player all in for less can win all of it', () => {
  // Seat 0 was all in for 5; the 20 is an ante the big blind paid for the table
  assert.deepEqual(buildPots([player(0, 5), player(1, 20), { ...player(2, 20), dead: 20 }]), [
    { amount: 35, eligible: [0, 1, 2] },
    { amount: 30, eligible: [1, 2] },
  ]);
});

test('dead money stays in the main pot when the player who posted it folds, and goes with it to a lone winner', () => {
  assert.deepEqual(buildPots([player(0, 60), { ...player(1, 20, true), dead: 20 }, player(2, 60)]), [{ amount: 160, eligible: [0, 2] }]);
  assert.deepEqual(buildPots([player(0, 0, true), { ...player(1, 10, true), dead: 20 }, player(2, 10)]), [{ amount: 40, eligible: [2] }]);
});

test('with dead money in the middle, a player who has staked nothing is still in for the pot that holds it', () => {
  assert.deepEqual(buildPots([player(0, 0), player(1, 10), { ...player(2, 20), dead: 20 }]), [
    { amount: 20, eligible: [0, 1, 2] },
    { amount: 20, eligible: [1, 2] },
    { amount: 10, eligible: [2] },
  ]);
  assert.deepEqual(buildPots([player(0, 0), { ...player(1, 0), dead: 20 }]), [{ amount: 20, eligible: [0, 1] }]);

  // Without dead money there is no pot for them to be in
  assert.deepEqual(buildPots([player(0, 0), player(1, 10), player(2, 20)]), [
    { amount: 20, eligible: [1, 2] },
    { amount: 10, eligible: [2] },
  ]);
});

test('pots with dead money add up to the stakes and the dead money together', () => {
  const contributions = [player(0, 13), { ...player(1, 77, true), dead: 15 }, player(2, 250), { ...player(3, 77), dead: 25 }, player(4, 250), player(5, 1, true)];
  const staked = contributions.reduce((sum, c) => sum + c.committed, 0);

  assert.equal(buildPots(contributions).reduce((sum, pot) => sum + pot.amount, 0), staked + 40);
});
