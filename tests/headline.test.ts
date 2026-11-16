import assert from 'node:assert/strict';
import test from 'node:test';

import { headline } from '../src/client/headline.ts';
import { TIMING } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';

const HOST = 0;

const says = (table: TestTable): string => headline(table.view(HOST)).says;

/** Three players with the game on and the first hand on the table. */
function going(): TestTable {
  const table = new TestTable({ stacks: [1000, 1000, 1000] });

  table.cmd(HOST, { type: 'start' });
  table.deal({ button: 0 });

  return table;
}

/** Plays the hand on the table out by folding, and clears it away: a game that is on deals the next one as it does. */
function playOut(table: TestTable): void {
  const { number } = table.state.hand!;

  while (table.state.hand?.number === number && table.state.hand.stage === 'betting') {
    table.fold(table.playerIn(table.toAct!));
  }

  table.runToResult();
  table.wait(table.state.hand!.deadline! - table.now);
}

test('with nothing else to say the pill numbers the hand, and is the only one drawn plainly', () => {
  const table = new TestTable({ stacks: [1000, 1000, 1000] });

  assert.deepEqual(headline(table.view(HOST)), { says: 'Not started', news: true });

  table.cmd(HOST, { type: 'start' });
  assert.deepEqual(headline(table.view(HOST)), { says: 'Next hand', news: false });

  table.wait(TIMING.startDelayMs);
  assert.deepEqual(headline(table.view(HOST)), { says: 'Hand #1', news: false });
});

test('a game that is not dealing says why: not started, pausing after this hand, paused', () => {
  const table = new TestTable({ stacks: [1000, 1000, 1000] });

  assert.equal(says(table), 'Not started');

  table.cmd(HOST, { type: 'start' });
  table.deal({ button: 0 });
  table.cmd(HOST, { type: 'pause' });
  assert.equal(says(table), 'Pausing');

  table.cmd(HOST, { type: 'start' });
  assert.equal(says(table), 'Hand #1', 'the pause was called off');

  table.cmd(HOST, { type: 'pause' });
  playOut(table);
  assert.equal(says(table), 'Paused');
});

test('a game that is on with nobody to deal to says it is waiting', () => {
  const table = new TestTable({ stacks: [1000, 1000] });

  table.cmd(1, { type: 'sitOut' });
  table.cmd(HOST, { type: 'start' });

  assert.equal(table.view(HOST).running, true);
  assert.equal(says(table), 'Waiting');

  table.cmd(1, { type: 'sitIn' });
  assert.equal(says(table), 'Next hand');
});

test('a bomb pot called for the next hand is said until that hand is dealt, or the call is taken back', () => {
  const table = new TestTable({ stacks: [1000, 1000, 1000] });

  table.cmd(HOST, { type: 'start' });
  table.cmd(HOST, { type: 'setBombPot', on: true });
  assert.equal(says(table), 'Bomb pot next');

  table.cmd(HOST, { type: 'setBombPot', on: false });
  assert.equal(says(table), 'Next hand');

  table.deal({ button: 0 });
  table.cmd(HOST, { type: 'setBombPot', on: true });
  assert.equal(says(table), 'Bomb pot next');

  playOut(table);
  assert.equal(says(table), 'Hand #2', 'the bomb pot is the hand on the table');
});

test('the last hands are counted down in the words the bar counts them in, to the last hand and the end of the night', () => {
  const table = going();

  table.cmd(HOST, { type: 'setLastHands', hands: 2 });
  assert.equal(says(table), '2 more hands');

  playOut(table);
  assert.equal(says(table), '1 more hand');

  playOut(table);
  assert.equal(says(table), 'Last hand');

  playOut(table);
  assert.equal(says(table), 'Night over');
});

test('of several things at once the pill says the one that changes what happens soonest', () => {
  const table = going();

  table.cmd(HOST, { type: 'setLastHands', hands: 2 });
  table.cmd(HOST, { type: 'setBombPot', on: true });
  assert.equal(says(table), 'Bomb pot next', 'the next hand before the ones after it');

  table.cmd(HOST, { type: 'pause' });
  assert.equal(says(table), 'Pausing', 'no next hand comes until the game is on again');

  table.cmd(HOST, { type: 'setBombPot', on: false });
  table.cmd(HOST, { type: 'setLastHands', hands: 0 });
  assert.equal(says(table), 'Last hand', 'the night ends with this hand, paused or not');
});
