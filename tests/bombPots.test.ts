import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, TIMING } from '../src/engine/index.ts';
import type { TableConfig } from '../src/engine/index.ts';
import { ACES, BOARD, checkAround, chipsIn, handRecords, KINGS, options, QUEENS, TestTable } from './helpers.ts';
import type { DealOptions, TableOptions } from './helpers.ts';
import { assertChipsConserved, assertHandRecordsHold, assertInvariants } from './invariants.ts';

const FLOP = 'Flop: 2♣ 7♦ 9♥';

/** A table whose host has called a bomb pot, with that hand dealt. The amount is 100 unless the settings say otherwise. */
function bombPot(options: TableOptions, deal: DealOptions = {}): TestTable {
  const t = new TestTable(options);
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, ...deal });

  return t;
}

/** Deals the next hand, folds it out, and says whether it was a bomb pot, which the table has to have said beforehand. */
function nextHandIsBombPot(t: TestTable): boolean {
  const promised = t.view(1).nextBombPot !== null;

  t.deal();
  const was = t.state.hand!.bombPot !== null;
  assert.equal(was, promised, 'the table said otherwise before the hand was dealt');

  while (t.state.hand!.stage === 'betting') {
    t.fold(t.toAct!);
  }
  t.finishHand();

  return was;
}

/** Which of the next `count` hands are bomb pots, as a row of B and dots. */
function nextHands(t: TestTable, count: number): string {
  return Array.from({ length: count }, () => (nextHandIsBombPot(t) ? 'B' : '.')).join('');
}

test('a bomb pot: everyone dealt in posts the amount, no blinds, and the betting starts on the flop', () => {
  const t = bombPot({ stacks: [1000, 1000, 1000, 1000] }, { holes: { 0: ACES, 2: KINGS }, board: BOARD });
  const hand = t.state.hand!;

  assert.deepEqual(hand.bombPot, { amount: 100 });
  assert.deepEqual(t.stacks(), [900, 900, 900, 900]);
  assert.deepEqual(chipsIn(t), [[0, 100, 0], [0, 100, 0], [0, 100, 0], [0, 100, 0]], 'what is posted is staked, and no bet in front of anyone');
  assert.deepEqual(hand.log, ['Hand #1 · bomb pot 100 · P0 has the button', 'Everyone posts bomb pot 100', FLOP]);
  assert.deepEqual([hand.street, hand.stage, hand.boards], ['flop', 'betting', [['2c', '7d', '9h']]]);
  assert.deepEqual(hand.straddles, []);
  assert.ok(hand.players.every((p) => p.lastAction === null && !p.hasActed), 'nobody has a blind by their name or has acted');

  const view = t.view(3);
  assert.deepEqual([view.hand!.bombPot, view.hand!.pot, view.hand!.currentBet], [{ amount: 100 }, 400, 0]);
  assert.deepEqual(view.hand!.pots, [{ amount: 400, eligible: [0, 1, 2, 3] }]);
  assertInvariants(t.state, t.now);

  // The flop plays as any flop does: checking is free and the least bet is the big blind
  assert.equal(t.toAct, 1);
  assert.deepEqual({ check: options(t, 1).canCheck, call: options(t, 1).callAmount, bet: options(t, 1).minRaiseTo }, { check: true, call: 0, bet: 20 });
  t.check(1);
  t.raise(2, 200);
  t.fold(3);
  t.call(0);
  t.fold(1);
  checkAround(t, [2, 0], 2);

  assert.deepEqual(hand.result!.pots.map((pot) => [pot.amount, pot.eligible]), [[800, [0, 2]]]);
  assert.deepEqual(hand.result!.winnings, [{ seat: 0, amount: 800 }]);
  assert.deepEqual(t.stacks(), [1500, 900, 700, 900]);
  assertChipsConserved(t.state);

  t.finishHand();
  const [record] = handRecords(t.effects);
  assert.deepEqual(record!.bombPot, { amount: 100 }, 'the hand history knows the hand was a bomb pot');
  assert.equal(record!.summary.split('\n')[0], 'Hand #1 · bomb pot 100 · P0 has the button');
  assertHandRecordsHold(t.effects);
});

test('a bomb pot won before a showdown pays the pot out as any hand does', () => {
  const t = bombPot({ stacks: [1000, 1000, 1000] });

  t.raise(1, 50);
  t.fold(2);
  t.fold(0);

  assert.ok(t.feedText().includes('Uncalled bet of 50 returned to P1'));
  assert.deepEqual(t.state.hand!.result!.winnings, [{ seat: 1, amount: 300 }]);
  assert.equal(t.state.hand!.result!.uncontested, true);
  assert.deepEqual(t.stacks(), [900, 1200, 900]);
});

test('a bomb pot: a player all in on the post wins that much from each opponent, and the rest is a side pot for the others', () => {
  const t = bombPot({ stacks: [1000, 30, 1000, 1000] }, { holes: { 1: ACES, 3: KINGS, 0: QUEENS }, board: BOARD });
  const hand = t.state.hand!;

  assert.deepEqual(hand.log.slice(1), ['P1 posts bomb pot 30 and is all in', 'Everyone else posts bomb pot 100', FLOP]);
  assert.deepEqual(chipsIn(t), [[0, 100, 0], [0, 30, 0], [0, 100, 0], [0, 100, 0]]);
  assert.equal(hand.players[1]!.allIn, true);
  assert.deepEqual(t.view(0).hand!.pots, [{ amount: 120, eligible: [0, 1, 2, 3] }, { amount: 210, eligible: [0, 2, 3] }]);

  assert.equal(t.toAct, 2, 'the action passes over the player who is all in');
  t.check(2);
  t.raise(3, 100);
  t.call(0);
  t.fold(2);
  checkAround(t, [3, 0], 2);

  assert.deepEqual(hand.result!.pots.map((pot) => [pot.amount, pot.eligible]), [[120, [0, 1, 3]], [410, [0, 3]]]);
  assert.deepEqual(hand.result!.winnings, [{ seat: 1, amount: 120 }, { seat: 3, amount: 410 }]);
  assert.deepEqual(t.stacks(), [800, 120, 900, 1210]);
  assertChipsConserved(t.state);
});

test('a bomb pot that leaves everyone all in deals the flop, turns the hands up and runs the rest of the board out', () => {
  const t = bombPot({ stacks: [100, 60, 100] }, { holes: { 0: QUEENS, 1: ACES, 2: KINGS }, board: BOARD });
  const hand = t.state.hand!;

  assert.deepEqual(hand.log.slice(1), [
    'P1 posts bomb pot 60 and is all in',
    'P2 posts bomb pot 100 and is all in',
    'P0 posts bomb pot 100 and is all in',
    FLOP,
    'P0 shows Q♠ Q♥',
    'P1 shows A♠ A♥',
    'P2 shows K♠ K♥',
  ]);
  assert.deepEqual([hand.stage, hand.street, hand.toAct, hand.sharedBoardLength], ['runout', 'flop', null, 3]);
  assert.equal(hand.deadline, t.now + TIMING.runoutStepMs);
  assertInvariants(t.state, t.now);

  t.wait(TIMING.runoutStepMs);
  assert.deepEqual([hand.stage, hand.boards[0]!.length], ['runout', 4], 'the turn and the river come one at a time, as in any runout');

  t.runToResult();
  assert.deepEqual(hand.boards, [['2c', '7d', '9h', 'Jc', '3s']]);
  assert.deepEqual(hand.result!.pots.map((pot) => [pot.amount, pot.eligible]), [[180, [0, 1, 2]], [80, [0, 2]]]);
  assert.deepEqual(t.stacks(), [0, 180, 80]);

  t.finishHand();
  assertHandRecordsHold(t.effects);
});

test('a bomb pot only one player could cover gives back what nobody matched before the flop is dealt', () => {
  const t = bombPot({ stacks: [1000, 60, 50] }, { holes: { 0: QUEENS, 1: KINGS, 2: ACES }, board: BOARD });
  const hand = t.state.hand!;

  assert.deepEqual(hand.log.slice(1, 6), [
    'P1 posts bomb pot 60 and is all in',
    'P2 posts bomb pot 50 and is all in',
    'P0 posts bomb pot 100',
    '40 that nobody could match returned to P0',
    FLOP,
  ]);
  assert.deepEqual(chipsIn(t), [[0, 60, 0], [0, 60, 0], [0, 50, 0]]);
  assert.equal(hand.stage, 'runout', 'the one player with chips has nobody to bet against');

  t.runToResult();
  assert.deepEqual(hand.result!.pots.map((pot) => [pot.amount, pot.eligible]), [[150, [0, 1, 2]], [20, [0, 1]]]);
  assert.deepEqual(t.stacks(), [940, 20, 150]);

  t.finishHand();
  assertHandRecordsHold(t.effects);
});

test('a bomb pot heads-up: both post, nobody has a blind, and the button acts last', () => {
  const t = bombPot({ stacks: [1000, 1000] });

  assert.deepEqual(t.stacks(), [900, 900]);
  assert.equal(t.state.hand!.log[1], 'Everyone posts bomb pot 100');
  assert.equal(t.toAct, 1);

  t.check(1);
  assert.equal(t.toAct, 0);
  t.check(0);
  assert.deepEqual([t.state.hand!.street, t.toAct], ['turn', 1]);
});

test('a bomb pot starts with the first player left of the button who can act, and the button acts last', () => {
  const order = (t: TestTable) => {
    const acted: number[] = [];

    while (t.state.hand!.street === 'flop') {
      acted.push(t.toAct!);
      t.check(t.toAct!);
    }

    return acted;
  };

  assert.deepEqual(order(bombPot({ stacks: [1000, 1000, 1000, 1000] })), [1, 2, 3, 0]);
  assert.deepEqual(order(bombPot({ stacks: [1000, 1000, 1000, 1000] }, { button: 2 })), [3, 0, 1, 2], 'the order goes around the end of the table');
  assert.deepEqual(order(bombPot({ stacks: [1000, 100, 30, 1000] })), [3, 0], 'two players all in on the post are passed over');

  // A player sitting out is not dealt in and posts nothing
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.cmd(1, { type: 'sitOut' });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0 });
  assert.deepEqual(t.state.hand!.players.map((p) => p.seat), [0, 2, 3]);
  assert.deepEqual(t.stacks(), [900, 1000, 900, 900]);
  assert.deepEqual(order(t), [2, 3, 0]);
});

test('a bomb pot moves the button on a player, and the hand after it takes the blinds on from the last hand that had any', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.fold(0);
  t.fold(1);
  t.finishHand();

  t.cmd(0, { type: 'setBombPot', on: true });
  assert.equal(nextHandIsBombPot(t), true);
  assert.equal(t.state.buttonSeat, 1);
  assert.deepEqual(t.state.blinds, { small: 1, big: 2 }, 'a hand with no blinds moved them');

  // Nobody's blind was skipped for the bomb pot: the big blind goes on from seat 2 to seat 0
  t.deal();
  assert.deepEqual([t.state.hand!.button, t.state.hand!.sbSeat, t.state.hand!.bbSeat, t.state.hand!.bombPot], [1, 2, 0, null]);

  // One bomb pot after another, the button moves each time
  t.fold(1);
  t.fold(2);
  t.finishHand();
  t.cmd(0, { type: 'setBombPot', on: true });
  assert.equal(nextHandIsBombPot(t), true);
  t.cmd(0, { type: 'setBombPot', on: true });
  assert.equal(nextHandIsBombPot(t), true);
  assert.equal(t.state.buttonSeat, 0);
});

test('a bomb pot every so many hands: the count is of hands dealt since the last one, and a called one starts it again', () => {
  const t = new TestTable({ stacks: [100_000, 100_000, 100_000], config: { bombPotEvery: 3 } });

  assert.equal(nextHands(t, 7), '..B..B.');
  assert.equal(t.state.handsSinceBombPot, 1);

  // One hand into the count, the host calls one: it is the next hand, and the third after it is the next by count
  t.cmd(0, { type: 'setBombPot', on: true });
  assert.equal(nextHands(t, 4), 'B..B');

  // Changed mid-count, the new number is counted from the last bomb pot all the same
  assert.equal(nextHands(t, 1), '.');
  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 5 } });
  assert.equal(nextHands(t, 5), '...B.');
  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 2 } });
  assert.equal(nextHands(t, 4), 'B.B.');

  // A count the table is already past makes the very next hand one
  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 6 } });
  assert.equal(nextHands(t, 3), '...');
  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 3 } });
  assert.deepEqual(t.view(1).nextBombPot, { amount: 100 });
  assert.equal(nextHands(t, 4), 'B..B');

  assert.equal(nextHands(new TestTable({ stacks: [100_000, 100_000], config: { bombPotEvery: 1 } }), 3), 'BBB', 'every hand can be one');
});

test('with no count set there are bomb pots only when called, and switching a count on starts it from the next hand', () => {
  const t = new TestTable({ stacks: [100_000, 100_000, 100_000] });

  assert.equal(nextHands(t, 6), '......');
  assert.equal(t.state.handsSinceBombPot, 0, 'nothing is counted while nothing comes by count');

  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 2 } });
  assert.equal(t.view(0).nextBombPot, null, 'the six hands already played are not counted against the new setting');
  assert.equal(nextHands(t, 4), '.B.B');

  // Switched off one hand into the count and on again, the count has started over
  assert.equal(nextHands(t, 1), '.');
  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 0 } });
  assert.equal(nextHands(t, 2), '..');
  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 2 } });
  assert.equal(nextHands(t, 2), '.B');
});

test('the host calls a bomb pot for the next hand, takes it back and calls it again, and everyone sees which it is', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id);
  const seen = () => [0, 1, 3].map((who) => [t.view(who).nextBombPot, t.view(who).bombPotCalled]);

  assert.deepEqual(seen(), [[null, false], [null, false], [null, false]]);

  t.cmd(0, { type: 'setBombPot', on: true });
  assert.deepEqual(seen(), Array(3).fill([{ amount: 100 }, true]), 'the host, a player and someone watching all see it');
  assert.equal(t.feedText().at(-1), 'The host called a bomb pot for the next hand');

  // Said once, however often it is asked for
  const lines = t.state.feed.length;
  t.cmd(0, { type: 'setBombPot', on: true });
  assert.equal(t.state.feed.length, lines);

  t.cmd(0, { type: 'setBombPot', on: false });
  assert.deepEqual(seen(), Array(3).fill([null, false]));
  assert.equal(t.feedText().at(-1), 'The host called off the bomb pot');
  t.cmd(0, { type: 'setBombPot', on: false });
  assert.equal(t.state.feed.length, lines + 1);
  assert.equal(nextHandIsBombPot(t), false, 'one that was taken back is not dealt');

  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal();
  assert.deepEqual(t.state.hand!.bombPot, { amount: 100 });
  assert.deepEqual(seen(), Array(3).fill([null, false]), 'the call is used up by the hand it made');
  assert.deepEqual([0, 1, 3].map((who) => t.view(who).hand!.bombPot), Array(3).fill({ amount: 100 }));

  assert.throws(() => t.cmd(0, { type: 'setBombPot', on: 'yes' } as never), { name: 'GameError', message: 'A bomb pot must be on or off' });
});

test('a bomb pot called during a hand is the hand after it, and one can be called for the hand after a bomb pot', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });
  const dealt = JSON.stringify(t.state.hand);

  t.cmd(0, { type: 'setBombPot', on: true });
  assert.equal(JSON.stringify(t.state.hand), dealt, 'the hand in play is left as it was dealt');
  assert.deepEqual(t.view(2).nextBombPot, { amount: 100 });

  t.fold(0);
  t.fold(1);
  t.finishHand();
  t.deal();
  assert.deepEqual(t.state.hand!.bombPot, { amount: 100 });

  t.cmd(0, { type: 'setBombPot', on: true });
  assert.deepEqual([t.view(1).hand!.bombPot, t.view(1).nextBombPot], [{ amount: 100 }, { amount: 100 }]);
});

test('a called bomb pot can be called off only while the call is what makes the next hand one', () => {
  const t = new TestTable({ stacks: [100_000, 100_000, 100_000], config: { bombPotEvery: 5 } });
  const seen = () => [t.view(1).nextBombPot !== null, t.view(1).bombPotCalled];

  assert.equal(nextHands(t, 2), '..');
  t.cmd(0, { type: 'setBombPot', on: true });
  assert.deepEqual(seen(), [true, true]);

  // The count now brings one for the next hand anyway, so calling this one off would change nothing
  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 3 } });
  assert.deepEqual(seen(), [true, false]);

  // The call still stands when the count no longer does
  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 5 } });
  assert.deepEqual(seen(), [true, true]);

  t.cmd(0, { type: 'setBombPot', on: false });
  assert.deepEqual(seen(), [false, false]);
  assert.equal(nextHands(t, 3), '..B', 'called off, the count goes on from where it was');
});

test('a bomb pot is played for the amount the table has when it is dealt, and a change after that waits for the next one', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.cmd(0, { type: 'updateConfig', config: { bombPotAmount: 300 } });
  assert.equal(t.feedText().at(-1), 'A bomb pot is 300 and comes only when called');
  assert.deepEqual(t.view(1).nextBombPot, { amount: 300 });

  t.deal({ button: 0 });
  assert.deepEqual(t.stacks(), [700, 700, 700]);

  t.cmd(0, { type: 'updateConfig', config: { bombPotAmount: 50, bombPotEvery: 4 } });
  assert.equal(t.feedText().at(-1), 'A bomb pot of 50 comes every 4 hands, from the next hand');
  assert.equal(t.view(1).hand!.bombPot!.amount, 300);

  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 1 } });
  assert.equal(t.feedText().at(-1), 'Every hand is a bomb pot of 50, from the next hand');

  const lines = t.state.feed.length;
  t.cmd(0, { type: 'updateConfig', config: { bigBlind: 40 } });
  assert.ok(!t.feedText().slice(lines).some((line) => /bomb pot/i.test(line)), 'the chat says nothing about bomb pots when they were not changed');
});

test('the bomb pot amount is any amount from the smallest the table can write, and the count has a ceiling', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  const set = (config: Partial<TableConfig>) => () => t.cmd(0, { type: 'updateConfig', config });

  assert.throws(set({ bombPotAmount: 0 }), { name: 'GameError', message: 'The bomb pot must be a whole number from 1 to 1,000,000,000' });
  assert.throws(set({ bombPotAmount: 2.5 }), { message: /The bomb pot must be a whole number/ });
  assert.throws(set({ bombPotEvery: -1 }), { message: 'The number of hands per bomb pot must be a whole number from 0 to 100' });
  assert.throws(set({ bombPotEvery: 101 }), { message: 'The number of hands per bomb pot must be a whole number from 0 to 100' });

  // No tie to the blinds or the buy-in: an amount nobody can cover puts everyone all in
  set({ bombPotAmount: 1_000_000, bombPotEvery: 100 })();
  assert.deepEqual([t.state.config.bombPotAmount, t.state.config.bombPotEvery], [1_000_000, 100]);
});

test('a called bomb pot waits through a pause, and through a table too short to play, for the next hand that is dealt', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.cmd(0, { type: 'start' });
  t.wait(TIMING.startDelayMs);
  assert.equal(t.state.hand!.bombPot, null);

  t.cmd(0, { type: 'setBombPot', on: true });
  t.cmd(0, { type: 'pause' });
  t.fold(t.toAct!);
  t.fold(t.toAct!);
  t.finishHand();
  assert.deepEqual([t.state.hand, t.state.bombPotCalled], [null, true]);
  assert.deepEqual(t.view(1).nextBombPot, { amount: 100 });

  // Two of the three sit out, so no hand can be dealt even with the game on again
  t.cmd(1, { type: 'sitOut' });
  t.cmd(2, { type: 'sitOut' });
  t.cmd(0, { type: 'start' });
  t.wait(TIMING.startDelayMs);
  assert.deepEqual([t.state.hand, t.state.bombPotCalled], [null, true]);

  t.cmd(1, { type: 'sitIn' });
  t.wait(TIMING.startDelayMs);
  assert.deepEqual(t.state.hand!.bombPot, { amount: 100 });
  assert.deepEqual(t.state.hand!.players.map((p) => p.seat), [0, 1]);
  assert.equal(t.state.bombPotCalled, false);
});

test('seven-deuce bounty in a bomb pot: the pot is won as ever, and the bounty is paid on top by everyone dealt in', () => {
  const uncontested = bombPot({ stacks: [1000, 1000, 1000], config: { sevenDeuceBounty: 50 } }, { holes: { 0: '7h 2c' } });
  assert.equal(uncontested.view(0).hand!.holding!.bounty, true);

  uncontested.check(1);
  uncontested.check(2);
  uncontested.raise(0, 60);
  uncontested.fold(1);
  uncontested.fold(2);

  assert.deepEqual(uncontested.state.hand!.result!.winnings, [{ seat: 0, amount: 300 }]);
  assert.deepEqual(uncontested.state.hand!.result!.bounty!.payments, [{ seat: 1, amount: 50 }, { seat: 2, amount: 50 }]);
  assert.deepEqual(uncontested.stacks(), [1300, 850, 850]);
  assertChipsConserved(uncontested.state);

  // At a showdown, from a player the bomb pot left with less than the bounty too
  const shown = bombPot({ stacks: [1000, 130, 1000], config: { sevenDeuceBounty: 50 } }, { holes: { 0: '7h 2c', 1: ACES }, board: '7s 2d 9h Jc 3s' });
  checkAround(shown, [1, 2, 0], 3);

  assert.deepEqual(shown.state.hand!.result!.bounty!.payments, [{ seat: 1, amount: 30 }, { seat: 2, amount: 50 }]);
  assert.deepEqual(shown.stacks(), [1280, 0, 850]);
  assertChipsConserved(shown.state);
});

test('a table that plays an ante does not post it in a bomb pot, and posts it again in the hand after', () => {
  for (const config of [{ ante: 5 }, { ante: 20, anteFrom: 'bigBlind' }] as Partial<TableConfig>[]) {
    const t = bombPot({ stacks: [1000, 1000, 1000], config });
    const hand = t.state.hand!;

    assert.deepEqual(hand.log.slice(0, 2), ['Hand #1 · bomb pot 100 · P0 has the button', 'Everyone posts bomb pot 100']);
    assert.deepEqual(t.stacks(), [900, 900, 900]);
    assert.deepEqual(chipsIn(t), [[0, 100, 0], [0, 100, 0], [0, 100, 0]], 'nothing on top of the bomb pot, as stake or as dead money');
    assert.equal(t.view(0).hand!.pot, 300);

    checkAround(t, [1, 2, 0], 3);
    t.finishHand();

    t.deal();
    assert.match(t.state.hand!.log[0]!, /^Hand #2 · blinds 10\/20 · (BB )?ante /);
    assert.equal(t.view(0).hand!.pot, config.anteFrom === 'bigBlind' ? 50 : 45);
  }
});

test('nobody straddles a bomb pot, and the straddle is back in the hand after', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.cmd(3, { type: 'setStraddle', kind: 'straddle', on: true });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0 });

  assert.deepEqual(t.stacks(), [900, 900, 900, 900]);
  assert.deepEqual([t.state.hand!.straddles, t.state.hand!.passedOver], [[], []]);
  assert.deepEqual(t.state.seats[3]!.straddles, ['straddle'], 'the player still wants to straddle');

  // The button moves to seat 1, which puts seat 0 under the gun
  t.cmd(0, { type: 'setStraddle', kind: 'straddle', on: true });
  checkAround(t, [1, 2, 3, 0], 3);
  t.finishHand();
  t.deal();
  assert.deepEqual(t.state.hand!.straddles, [{ seat: 0, what: 'straddle', amount: 40 }]);
});

test('a bomb pot that puts everyone all in is run twice when the table plays that and everyone agrees, from the flop', () => {
  const t = bombPot(
    { stacks: [100, 100, 40], config: { allowRunItTwice: true } },
    { holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD, secondBoard: 'Kd 4c' },
  );
  const hand = t.state.hand!;

  assert.deepEqual([hand.stage, hand.street, hand.boards], ['ritVote', 'flop', [['2c', '7d', '9h']]], 'the question comes with the flop out and the hands up');
  assert.ok(hand.players.every((p) => p.shown));
  assert.equal(t.view(2).hand!.canVote, true);

  for (const voter of [0, 1, 2]) {
    t.cmd(voter, { type: 'ritVote', agree: true });
  }
  t.runToResult();

  assert.deepEqual(hand.boards, [['2c', '7d', '9h', 'Jc', '3s'], ['2c', '7d', '9h', 'Kd', '4c']], 'both boards keep the flop');
  assert.deepEqual(hand.result!.pots, [
    { amount: 120, eligible: [0, 1, 2], awards: [{ seat: 0, amount: 60, run: 0 }, { seat: 1, amount: 60, run: 1 }] },
    { amount: 120, eligible: [0, 1], awards: [{ seat: 0, amount: 60, run: 0 }, { seat: 1, amount: 60, run: 1 }] },
  ]);
  assert.deepEqual(t.stacks(), [120, 120, 0]);

  t.finishHand();
  assertHandRecordsHold(t.effects);

  // One no and it runs once, as in any hand
  const once = bombPot({ stacks: [100, 100], config: { allowRunItTwice: true } }, { holes: { 0: ACES, 1: KINGS }, board: BOARD });
  once.cmd(1, { type: 'ritVote', agree: false });
  once.runToResult();
  assert.deepEqual(once.state.hand!.boards, [['2c', '7d', '9h', 'Jc', '3s']]);
  assert.deepEqual(once.stacks(), [200, 0]);
});

test('dollars and cents: a bomb pot reads in dollars, and a new table starts at an amount that suits its blinds', () => {
  const t = bombPot({ stacks: [10_000, 10_000, 3], config: { unit: 'cents', smallBlind: 25, bigBlind: 50 } }, { board: BOARD });

  assert.deepEqual(t.state.hand!.log, ['Hand #1 · bomb pot 2.50 · P0 has the button', 'P2 posts bomb pot 0.03 and is all in', 'Everyone else posts bomb pot 2.50', FLOP]);
  assert.deepEqual(t.stacks(), [9750, 9750, 0]);
  assert.equal(options(t, 1).minRaiseTo, 50, 'the least bet is the big blind, in cents');

  t.cmd(0, { type: 'updateConfig', config: { bombPotAmount: 1000, bombPotEvery: 3 } });
  assert.equal(t.feedText().at(-1), 'A bomb pot of 10.00 comes every 3 hands, from the next hand');
});

test('a timeout, a player leaving and chips asked for mid-hand work in a bomb pot as in any hand', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { actionSeconds: 20, maxBuyIn: 2000 } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0 });

  // Out of time with nothing to call is a check, and the player sits out from then on
  t.wait(20_000 + TIMING.actionGraceMs);
  assert.deepEqual([t.state.hand!.players[1]!.lastAction, t.state.seats[1]!.away, t.toAct], ['check', true, 2]);

  t.cmd(2, { type: 'requestRebuy', amount: 500 });
  t.cmd(0, { type: 'approve', playerId: t.ids[2]! });
  assert.equal(t.state.seats[2]!.pendingAdd, 500, 'chips wait for the hand to end');

  t.cmd(2, { type: 'standUp' });
  assert.deepEqual([t.state.hand!.players[2]!.lastAction, t.state.seats[2]!.leaving, t.toAct], ['check', true, 0]);

  t.raise(0, 40);
  assert.deepEqual(t.state.hand!.result!.winnings, [{ seat: 0, amount: 300 }], 'the two who are away fold to a bet');
  t.finishHand();
  assert.equal(t.state.seats[2], null);
  assert.deepEqual(t.stacks(), [1200, 900, 0]);
});
