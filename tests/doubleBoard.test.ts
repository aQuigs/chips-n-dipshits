import assert from 'node:assert/strict';
import { test } from 'node:test';

import { playerHand, replayHand, TIMING } from '../src/engine/index.ts';
import type { Card, HandEvent, HandRecord, TableConfig } from '../src/engine/index.ts';
import { ACES, BOARD, checkAround, handRecords, KINGS, QUEENS, seededRng, TestTable } from './helpers.ts';
import type { DealOptions, TableOptions } from './helpers.ts';
import { assertChipsConserved, assertHandRecordsHold, assertInvariants, assertViewsKeepSecrets } from './invariants.ts';
import { chance, randomStep } from './randomPlay.ts';

// On the first board aces beat kings beat queens; on the second a king makes the kings three of a kind
const SECOND = 'Kd 4c 5h 8s Td';
const BOARDS = [BOARD.split(' '), SECOND.split(' ')];
const FLOPS = ['First board, Flop: 2♣ 7♦ 9♥', 'Second board, Flop: K♦ 4♣ 5♥'];

/** A table that plays its bomb pots on two boards, with one the host called dealt. The amount is 100 unless the settings say otherwise. */
function doubleBoard(options: TableOptions, deal: DealOptions = {}): TestTable {
  const t = new TestTable({ ...options, config: { bombPotBoards: 'two', ...options.config } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, board: BOARD, secondBoard: SECOND, ...deal });

  return t;
}

const awardsOf = (t: TestTable) => t.state.hand!.result!.pots.map((pot) => pot.awards.map((award) => [award.seat, award.amount, award.run]));
const wins = (t: TestTable) => t.state.hand!.log.filter((line) => line.includes(' wins '));
const shows = (t: TestTable) => t.state.hand!.log.filter((line) => line.includes(' shows ') || line.includes(' mucks'));

test('a double-board bomb pot: two flops are dealt as the hand starts, each street adds a card to both, and there is one round of betting a street', () => {
  const t = doubleBoard({ stacks: [1000, 1000, 1000] }, { holes: { 0: ACES, 1: KINGS, 2: QUEENS } });
  const hand = t.state.hand!;

  assert.deepEqual(hand.bombPot, { amount: 100, boards: 2 });
  assert.deepEqual(hand.log, ['Hand #1 · double-board bomb pot 100 · P0 has the button', 'Everyone posts bomb pot 100', ...FLOPS]);
  assert.deepEqual([hand.street, hand.stage, hand.runs], ['flop', 'betting', 2]);
  assert.deepEqual(hand.boards, BOARDS.map((board) => board.slice(0, 3)));
  assert.deepEqual(t.stacks(), [900, 900, 900]);
  assertInvariants(t.state, t.now);

  // Everyone sees both boards, and each player's own hand is read on each
  for (const viewer of [0, 1, 2]) {
    assert.deepEqual(t.view(viewer).hand!.boards, hand.boards);
  }
  assert.deepEqual(t.view(1).hand!.holding!.reads.map((read) => read.name), ['Pair of kings', 'Three kings']);
  assert.deepEqual([t.view(1).hand!.bombPot, t.view(1).hand!.pot, t.view(1).hand!.runs], [{ amount: 100, boards: 2 }, 300, 2]);

  // One round on the flop, opened left of the button as in any bomb pot
  assert.equal(t.toAct, 1);
  t.check(1);
  t.raise(2, 40);
  t.call(0);
  t.call(1);

  assert.deepEqual([hand.street, t.toAct], ['turn', 1]);
  assert.deepEqual(hand.boards, BOARDS.map((board) => board.slice(0, 4)));
  assert.deepEqual(hand.log.slice(-2), ['First board, Turn: 2♣ 7♦ 9♥ J♣', 'Second board, Turn: K♦ 4♣ 5♥ 8♠']);
  assert.ok(hand.players.every((p) => p.bet === 0 && !p.hasActed), 'the turn is one new round of betting, not one a board');

  checkAround(t, [1, 2, 0], 1);
  assert.deepEqual([hand.street, hand.stage], ['river', 'betting']);
  assert.deepEqual(hand.boards, BOARDS);
  assert.deepEqual(hand.log.slice(-2), ['First board, River: 2♣ 7♦ 9♥ J♣ 3♠', 'Second board, River: K♦ 4♣ 5♥ 8♠ 10♦']);
  assertInvariants(t.state, t.now);

  checkAround(t, [1, 2, 0], 1);
  assert.equal(hand.stage, 'done');
  assert.equal(hand.deadline, t.now + TIMING.runTwicePauseMs, 'two boards get the longer look that a hand run twice gets');
  assertChipsConserved(t.state);

  t.finishHand();
  const [record] = handRecords(t.effects);
  assert.deepEqual([record!.bombPot, record!.boards], [{ amount: 100, boards: 2 }, BOARDS]);
  assertHandRecordsHold(t.effects);
});

test('double board: every pot is split in two, half to the best hand on each board, and one player can win both halves', () => {
  const split = doubleBoard({ stacks: [1000, 1000, 1000] }, { holes: { 0: ACES, 1: KINGS, 2: QUEENS } });
  split.check(1);
  split.raise(2, 100);
  split.call(0);
  split.call(1);
  checkAround(split, [1, 2, 0], 2);

  assert.deepEqual(awardsOf(split), [[[0, 300, 0], [1, 300, 1]]]);
  assert.deepEqual(wins(split), ['P0 wins 300 on the first board with pair of aces', 'P1 wins 300 on the second board with three kings']);
  assert.deepEqual(split.state.hand!.result!.winnings, [{ seat: 0, amount: 300 }, { seat: 1, amount: 300 }]);
  assert.deepEqual(split.stacks(), [1100, 1100, 800]);
  assertChipsConserved(split.state);

  // Aces are best on both boards when nobody holds a king
  const scooped = doubleBoard({ stacks: [1000, 1000, 1000] }, { holes: { 0: ACES, 1: QUEENS, 2: '8c 6d' } });
  scooped.check(1);
  scooped.fold(2);
  scooped.raise(0, 100);
  scooped.call(1);
  checkAround(scooped, [1, 0], 2);

  assert.deepEqual(awardsOf(scooped), [[[0, 250, 0], [0, 250, 1]]]);
  assert.deepEqual(wins(scooped), ['P0 wins 250 on the first board with pair of aces', 'P0 wins 250 on the second board with pair of aces']);
  assert.deepEqual(scooped.state.hand!.result!.winnings, [{ seat: 0, amount: 500 }]);
  assert.deepEqual(scooped.stacks(), [1300, 800, 900]);
  assertChipsConserved(scooped.state);
});

test('double board: a tie on one board splits that board\'s half, and the other half is won outright', () => {
  // Everyone plays the second board, a royal flush
  const t = doubleBoard({ stacks: [1000, 1000, 1000] }, { holes: { 0: 'Ad Ac', 1: 'Kd Kc', 2: '8c 6d' }, secondBoard: 'As Ks Qs Js Ts' });
  t.check(1);
  t.fold(2);
  checkAround(t, [0], 1);
  checkAround(t, [1, 0], 2);

  assert.deepEqual(awardsOf(t), [[[0, 150, 0], [1, 75, 1], [0, 75, 1]]]);
  assert.deepEqual(wins(t), ['P0 wins 150 on the first board with pair of aces', 'P1 wins 75 on the second board with royal flush', 'P0 wins 75 on the second board with royal flush']);
  assert.deepEqual(t.stacks(), [1125, 975, 900]);
  assertChipsConserved(t.state);
});

test('double board: the odd chip of a pot goes to the first board, and the odd chip of a tied half to the first winner left of the button', () => {
  const t = doubleBoard({ stacks: [1000, 1000, 1000], config: { bombPotAmount: 25 } }, { holes: { 0: 'Ad Ac', 1: 'Kd Kc', 2: '8c 6d' }, secondBoard: 'As Ks Qs Js Ts' });
  t.check(1);
  t.fold(2);
  checkAround(t, [0], 1);
  checkAround(t, [1, 0], 2);

  // 75 in the pot: 38 on the first board and 37 on the second, where 37 between two is 19 and 18
  assert.deepEqual(awardsOf(t), [[[0, 38, 0], [1, 19, 1], [0, 18, 1]]]);
  assert.deepEqual(t.stacks(), [1031, 994, 975]);
  assertChipsConserved(t.state);
});

test('double board, dollars and cents: the odd cent of a pot goes to the first board, and the play-by-play reads in dollars', () => {
  const t = doubleBoard(
    { stacks: [10_000, 10_000, 10_000], config: { unit: 'cents', smallBlind: 25, bigBlind: 50, bombPotAmount: 125 } },
    { holes: { 0: ACES, 1: KINGS, 2: QUEENS } },
  );
  checkAround(t, [1, 2, 0], 3);

  assert.equal(t.state.hand!.log[0], 'Hand #1 · double-board bomb pot 1.25 · P0 has the button');
  assert.deepEqual(awardsOf(t), [[[0, 188, 0], [1, 187, 1]]]);
  assert.deepEqual(wins(t), ['P0 wins 1.88 on the first board with pair of aces', 'P1 wins 1.87 on the second board with three kings']);
  assert.deepEqual(t.stacks(), [10_063, 10_062, 9875]);
  assertChipsConserved(t.state);
});

test('double board: a side pot is split between the boards like the main pot, each half among the players in for it', () => {
  // The short stack's aces are best on the first board, and are in for the main pot only
  const t = doubleBoard({ stacks: [1000, 1000, 40] }, { holes: { 0: QUEENS, 1: KINGS, 2: ACES } });
  const hand = t.state.hand!;

  assert.deepEqual(hand.log.slice(1, 3), ['P2 posts bomb pot 40 and is all in', 'Everyone else posts bomb pot 100']);
  assert.deepEqual(t.view(0).hand!.pots, [{ amount: 120, eligible: [0, 1, 2] }, { amount: 120, eligible: [0, 1] }]);

  checkAround(t, [1, 0], 3);

  assert.deepEqual(hand.result!.pots, [
    { amount: 120, eligible: [0, 1, 2], awards: [{ seat: 2, amount: 60, run: 0 }, { seat: 1, amount: 60, run: 1 }] },
    { amount: 120, eligible: [0, 1], awards: [{ seat: 1, amount: 60, run: 0 }, { seat: 1, amount: 60, run: 1 }] },
  ]);
  assert.deepEqual(wins(t), [
    'P2 wins 60 from the main pot on the first board with pair of aces',
    'P1 wins 60 from the main pot on the second board with three kings',
    'P1 wins 60 from side pot 1 on the first board with pair of kings',
    'P1 wins 60 from side pot 1 on the second board with three kings',
  ]);
  assert.deepEqual(t.stacks(), [900, 1080, 60]);
  assertChipsConserved(t.state);

  t.finishHand();
  assertHandRecordsHold(t.effects);
});

test('double board: with everyone all in on the posts both boards are dealt out together, a street at a time, and nobody is asked to run it twice', () => {
  const t = doubleBoard({ stacks: [100, 60, 100], config: { allowRunItTwice: true } }, { holes: { 0: QUEENS, 1: ACES, 2: KINGS } });
  const hand = t.state.hand!;

  assert.deepEqual(hand.log.slice(1), [
    'P1 posts bomb pot 60 and is all in',
    'P2 posts bomb pot 100 and is all in',
    'P0 posts bomb pot 100 and is all in',
    ...FLOPS,
    'P0 shows Q♠ Q♥',
    'P1 shows A♠ A♥',
    'P2 shows K♠ K♥',
  ]);
  assert.deepEqual([hand.stage, hand.runs, hand.toAct], ['runout', 2, null], 'the boards are two already, so there is no vote');
  assert.ok([0, 1, 2].every((seat) => !t.view(seat).hand!.canVote));
  assert.throws(() => t.cmd(0, { type: 'ritVote', agree: true }), { name: 'GameError', message: 'There is no run-it-twice vote for you right now' });
  assert.deepEqual(hand.events.at(-1), ['runs', 2]);
  assertInvariants(t.state, t.now);

  t.wait(TIMING.runoutStepMs);
  assert.deepEqual([hand.stage, hand.boards], ['runout', BOARDS.map((board) => board.slice(0, 4))], 'the turn comes on both boards in one step');
  assert.deepEqual(hand.log.slice(-2), ['First board, Turn: 2♣ 7♦ 9♥ J♣', 'Second board, Turn: K♦ 4♣ 5♥ 8♠']);
  assertInvariants(t.state, t.now);

  t.wait(TIMING.runoutStepMs);
  assert.deepEqual([hand.stage, hand.boards], ['done', BOARDS]);
  assert.deepEqual(hand.result!.pots, [
    { amount: 180, eligible: [0, 1, 2], awards: [{ seat: 1, amount: 90, run: 0 }, { seat: 2, amount: 90, run: 1 }] },
    { amount: 80, eligible: [0, 2], awards: [{ seat: 2, amount: 40, run: 0 }, { seat: 2, amount: 40, run: 1 }] },
  ]);
  assert.deepEqual(t.stacks(), [0, 90, 170]);
  assert.ok(!t.feedText().some((line) => /run it twice|runs once/.test(line)), 'nothing is said about running it twice');

  t.finishHand();
  assertHandRecordsHold(t.effects);
});

test('double board: a player all in during the hand makes a side pot, and once nobody can bet the rest of both boards is dealt out without a vote', () => {
  const sidePot = doubleBoard({ stacks: [1000, 1000, 300] }, { holes: { 0: QUEENS, 1: KINGS, 2: ACES } });
  sidePot.raise(1, 300);
  sidePot.call(2);
  sidePot.call(0);
  assert.equal(sidePot.state.hand!.players[2]!.allIn, true);
  assert.deepEqual([sidePot.state.hand!.street, sidePot.state.hand!.stage, sidePot.toAct], ['turn', 'betting', 1], 'the two with chips play on');

  sidePot.raise(1, 100);
  sidePot.call(0);
  checkAround(sidePot, [1, 0], 1);

  assert.deepEqual(awardsOf(sidePot), [[[2, 450, 0], [1, 450, 1]], [[1, 200, 0], [1, 200, 1]]]);
  assert.deepEqual(sidePot.stacks(), [500, 1350, 450]);
  assertChipsConserved(sidePot.state);

  const allIn = doubleBoard({ stacks: [1000, 1000, 300], config: { allowRunItTwice: true } }, { holes: { 0: QUEENS, 1: KINGS, 2: ACES } });
  allIn.raise(1, 900);
  allIn.call(2);
  allIn.call(0);

  const hand = allIn.state.hand!;
  assert.deepEqual([hand.stage, hand.street, hand.runs], ['runout', 'flop', 2]);
  assert.deepEqual(hand.log.slice(-3), ['P0 shows Q♠ Q♥', 'P1 shows K♠ K♥', 'P2 shows A♠ A♥']);
  assertInvariants(allIn.state, allIn.now);

  allIn.wait(TIMING.runoutStepMs);
  assert.deepEqual(hand.boards.map((board) => board.length), [4, 4]);
  allIn.runToResult();

  assert.deepEqual(hand.boards, BOARDS);
  assert.deepEqual(awardsOf(allIn), [[[2, 450, 0], [1, 450, 1]], [[1, 700, 0], [1, 700, 1]]]);
  assert.deepEqual(allIn.stacks(), [0, 1850, 450]);

  allIn.finishHand();
  assertHandRecordsHold(allIn.effects);
});

test('double board: when everyone else folds, the last player takes every pot whole, with no word of boards', () => {
  const t = doubleBoard({ stacks: [1000, 1000, 1000] });
  checkAround(t, [1, 2, 0], 1);
  t.raise(1, 50);
  t.fold(2);
  t.fold(0);

  const hand = t.state.hand!;
  assert.deepEqual(hand.log.slice(-2), ['Uncalled bet of 50 returned to P1', 'P1 wins 300']);
  assert.deepEqual(hand.result, { uncontested: true, pots: [{ amount: 300, eligible: [1], awards: [{ seat: 1, amount: 300, run: 0 }] }], winnings: [{ seat: 1, amount: 300 }], hands: [], bounty: null });
  assert.deepEqual(hand.boards.map((board) => board.length), [4, 4], 'the hand ended on the turn of both boards');
  assert.equal(hand.deadline, t.now + TIMING.uncontestedPauseMs);
  assert.deepEqual(t.stacks(), [900, 1200, 900]);

  t.finishHand();
  assertHandRecordsHold(t.effects);
});

test('double board: at showdown a player shows who can still win a pot on either board, and one beaten on both mucks', () => {
  // Shown in turn from the left of the button: aces, then kings, which lose the first board and win the second, then queens
  const t = doubleBoard({ stacks: [1000, 1000, 1000] }, { holes: { 0: QUEENS, 1: ACES, 2: KINGS } });
  checkAround(t, [1, 2, 0], 3);

  assert.deepEqual(shows(t), ['P1 shows A♠ A♥ (Pair of aces / Pair of aces)', 'P2 shows K♠ K♥ (Pair of kings / Three kings)', 'P0 mucks']);
  assert.deepEqual(t.view(1).seats.slice(0, 3).map((seat) => seat!.cards), [[null, null], ['As', 'Ah'], ['Ks', 'Kh']]);
  assert.deepEqual(
    t.state.hand!.result!.hands.map((shown) => [shown.seat, shown.run, shown.name]),
    [[1, 0, 'Pair of aces'], [2, 0, 'Pair of kings'], [1, 1, 'Pair of aces'], [2, 1, 'Three kings']],
  );
  assert.deepEqual(awardsOf(t), [[[1, 150, 0], [2, 150, 1]]]);
});

test('double board, seven-deuce bounty: paid for winning the whole main pot on both boards or without a showdown, never for one board', () => {
  const config = { sevenDeuceBounty: 50 };
  const sevenDeuce = { 0: '7h 2s', 1: 'Ah Kc', 2: 'Qc Jd' };

  // Two pair on both boards
  const both = doubleBoard({ stacks: [1000, 1000, 1000], config }, { holes: sevenDeuce, secondBoard: '7s 2h Qd 5c 9s' });
  assert.equal(both.view(0).hand!.holding!.bounty, true);
  both.check(1);
  both.fold(2);
  checkAround(both, [0], 1);
  checkAround(both, [1, 0], 2);

  assert.deepEqual(awardsOf(both), [[[0, 150, 0], [0, 150, 1]]]);
  assert.deepEqual(both.state.hand!.result!.bounty, { seat: 0, payments: [{ seat: 1, amount: 50 }, { seat: 2, amount: 50 }] });
  assert.deepEqual(both.stacks(), [1300, 850, 850]);
  assertChipsConserved(both.state);

  // Two pair on the first board, and a king for the ace-king on the second
  const one = doubleBoard({ stacks: [1000, 1000, 1000], config }, { holes: sevenDeuce });
  one.check(1);
  one.fold(2);
  checkAround(one, [0], 1);
  checkAround(one, [1, 0], 2);

  assert.deepEqual(awardsOf(one), [[[0, 150, 0], [1, 150, 1]]]);
  assert.equal(one.state.hand!.result!.bounty, null, 'half the main pot is not the whole of it');
  assert.ok(!one.feedText().some((line) => line.includes('bounty')));
  assert.deepEqual(one.stacks(), [1050, 1050, 900]);

  const unseen = doubleBoard({ stacks: [1000, 1000, 1000], config }, { holes: sevenDeuce });
  unseen.check(1);
  unseen.check(2);
  unseen.raise(0, 60);
  unseen.fold(1);
  unseen.fold(2);

  assert.deepEqual(unseen.state.hand!.result!.bounty!.payments, [{ seat: 1, amount: 50 }, { seat: 2, amount: 50 }]);
  assert.deepEqual(unseen.stacks(), [1300, 850, 850]);
  assertChipsConserved(unseen.state);
});

test('double board heads-up: both post, the button acts last on every street, and the boards split the pot', () => {
  const t = doubleBoard({ stacks: [1000, 1000] }, { holes: { 0: ACES, 1: KINGS } });

  assert.deepEqual(t.state.hand!.log.slice(1), ['Everyone posts bomb pot 100', ...FLOPS]);
  assert.equal(t.toAct, 1);
  t.raise(1, 50);
  t.raise(0, 150);
  t.call(1);
  checkAround(t, [1, 0], 2);

  assert.deepEqual(awardsOf(t), [[[0, 250, 0], [1, 250, 1]]]);
  assert.deepEqual(t.stacks(), [1000, 1000]);
});

test('one board or two is settled when the bomb pot is dealt: a change waits for the next one, and the table says which is coming', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  assert.equal(t.state.config.bombPotBoards, 'one', 'a table plays its bomb pots on one board until the host says otherwise');

  t.cmd(0, { type: 'setBombPot', on: true });
  assert.deepEqual(t.view(1).nextBombPot, { amount: 100 });

  t.cmd(0, { type: 'updateConfig', config: { bombPotBoards: 'two' } });
  assert.equal(t.feedText().at(-1), 'A double-board bomb pot is 100 and comes only when called');
  assert.deepEqual([0, 1].map((viewer) => t.view(viewer).nextBombPot), Array(2).fill({ amount: 100, boards: 2 }));

  t.deal({ button: 0, board: BOARD, secondBoard: SECOND });
  const dealt = JSON.stringify(t.state.hand);
  assert.equal(t.state.hand!.boards.length, 2);

  t.cmd(0, { type: 'updateConfig', config: { bombPotBoards: 'one', bombPotEvery: 1 } });
  assert.equal(t.feedText().at(-1), 'Every hand is a bomb pot of 100, from the next hand');
  assert.equal(JSON.stringify(t.state.hand), dealt, 'the hand in play stays on its two boards');
  assert.deepEqual([t.view(1).hand!.bombPot, t.view(1).nextBombPot], [{ amount: 100, boards: 2 }, { amount: 100 }]);

  checkAround(t, [1, 2, 0], 3);
  assert.equal(t.state.hand!.result!.pots[0]!.awards.some((award) => award.run === 1), true, 'and is paid out on both');
  t.finishHand();

  t.deal();
  assert.deepEqual([t.state.hand!.bombPot, t.state.hand!.boards.length, t.state.hand!.runs], [{ amount: 100 }, 1, 1]);

  t.cmd(0, { type: 'updateConfig', config: { bombPotBoards: 'two', bombPotEvery: 4 } });
  assert.equal(t.feedText().at(-1), 'A double-board bomb pot of 100 comes every 4 hands, from the next hand');
  t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 1 } });
  assert.equal(t.feedText().at(-1), 'Every hand is a double-board bomb pot of 100, from the next hand');

  assert.throws(() => t.cmd(0, { type: 'updateConfig', config: { bombPotBoards: 'three' } as never }), { name: 'GameError', message: 'The boards of a bomb pot must be one of: One board, Two boards' });
});

test('a bomb pot on one board is played as before at a table that could play two, and so is a called one that comes by count', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bombPotBoards: 'one', allowRunItTwice: true } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD });
  const hand = t.state.hand!;

  assert.deepEqual(hand.bombPot, { amount: 100 }, 'a bomb pot on one board says nothing of boards, as one saved before there were two');
  assert.deepEqual(hand.log, ['Hand #1 · bomb pot 100 · P0 has the button', 'Everyone posts bomb pot 100', 'Flop: 2♣ 7♦ 9♥']);
  assert.deepEqual([hand.boards, hand.runs], [[['2c', '7d', '9h']], 1]);
  assert.deepEqual(hand.events.at(-1), ['street', 0, ['2c', '7d', '9h']]);

  checkAround(t, [1, 2, 0], 3);
  assert.deepEqual(awardsOf(t), [[[0, 300, 0]]]);
  assert.deepEqual(wins(t), ['P0 wins 300 with pair of aces']);
  assert.equal(hand.deadline, t.now + TIMING.showdownPauseMs);

  // Every hand a bomb pot, on two boards: the count brings them as it brings any other
  const counted = new TestTable({ stacks: [100_000, 100_000], config: { bombPotBoards: 'two', bombPotEvery: 2 } });
  const kinds: (number | null)[] = [];
  for (let dealt = 0; dealt < 4; dealt++) {
    counted.deal();
    kinds.push(counted.state.hand!.bombPot?.boards ?? null);
    counted.fold(counted.toAct!);
    counted.finishHand();
  }
  assert.deepEqual(kinds, [null, 2, null, 2]);
});

test('an ordinary hand at a table that plays double-board bomb pots is on one board, and is run twice as before: one board after the other', () => {
  const t = new TestTable({ stacks: [500, 500], config: { bombPotBoards: 'two', allowRunItTwice: true } });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD, secondBoard: SECOND });
  const hand = t.state.hand!;

  assert.deepEqual([hand.bombPot, hand.boards, hand.runs], [null, [[]], 1]);
  t.raise(0, 500);
  t.call(1);
  assert.equal(hand.stage, 'ritVote');

  t.cmd(0, { type: 'ritVote', agree: true });
  t.cmd(1, { type: 'ritVote', agree: true });
  assert.deepEqual([hand.stage, hand.runs, hand.boards], ['runout', 2, [[]]]);

  t.runToResult();
  assert.deepEqual(hand.log.slice(-9), [
    'Everyone agreed to run it twice',
    'First board, Flop: 2♣ 7♦ 9♥',
    'First board, Turn: 2♣ 7♦ 9♥ J♣',
    'First board, River: 2♣ 7♦ 9♥ J♣ 3♠',
    'Second board, Flop: K♦ 4♣ 5♥',
    'Second board, Turn: K♦ 4♣ 5♥ 8♠',
    'Second board, River: K♦ 4♣ 5♥ 8♠ 10♦',
    'P0 wins 500 on the first board with pair of aces',
    'P1 wins 500 on the second board with three kings',
  ]);
  assert.deepEqual(hand.events.slice(-9), [
    ['runs', 2],
    ['street', 0, ['2c', '7d', '9h']],
    ['street', 0, ['Jc']],
    ['street', 0, ['3s']],
    ['street', 1, ['Kd', '4c', '5h']],
    ['street', 1, ['8s']],
    ['street', 1, ['Td']],
    ['win', 0, 500, 0, 0],
    ['win', 1, 500, 0, 1],
  ]);
  assert.deepEqual(t.stacks(), [500, 500]);
});

test('a double-board hand is told in events that name each street\'s board, replays from them alone, and never holds a card still face down', () => {
  const t = doubleBoard({ stacks: [1000, 30, 1000, 1000] }, { holes: { 0: QUEENS, 1: ACES, 3: KINGS } });
  const events = t.state.hand!.events;

  assert.deepEqual(events, [
    ['start', 1, 0, 10, 20, [[0, 'P0', 1000], [1, 'P1', 30], [2, 'P2', 1000], [3, 'P3', 1000]], 0, 'everyone', { amount: 100, boards: 2 }],
    ['post', 1, 'bomb pot', 30, 0, 'contribution'],
    ['post', 2, 'bomb pot', 100, 900, 'contribution'],
    ['post', 3, 'bomb pot', 100, 900, 'contribution'],
    ['post', 0, 'bomb pot', 100, 900, 'contribution'],
    ['deal'],
    ['street', 0, ['2c', '7d', '9h']],
    ['street', 1, ['Kd', '4c', '5h']],
  ] satisfies HandEvent[]);
  assert.deepEqual(t.view(2).hand!.events, events);

  // A replay has both boards from the first event, empty until their flops come
  assert.deepEqual(replayHand(events, 1)!.boards, [[], []]);
  assert.deepEqual(replayHand(events, 7)!.boards, [['2c', '7d', '9h'], []]);
  assert.deepEqual([replayHand(events)!.boards, replayHand(events)!.pot], [[['2c', '7d', '9h'], ['Kd', '4c', '5h']], 330]);

  t.check(2);
  t.raise(3, 100);
  t.call(0);
  t.fold(2);
  assertViewsKeepSecrets(t.state, t.now);
  assert.deepEqual(events.slice(-2), [['street', 0, ['Jc']], ['street', 1, ['8s']]]);

  checkAround(t, [3, 0], 2);
  assert.deepEqual(events.slice(-11), [
    ['street', 0, ['3s']],
    ['street', 1, ['Td']],
    ['check', 3],
    ['check', 0],
    ['show', 1, ['As', 'Ah']],
    ['show', 3, ['Ks', 'Kh']],
    ['muck', 0],
    ['win', 1, 60, 0, 0],
    ['win', 3, 60, 0, 1],
    ['win', 3, 205, 1, 0],
    ['win', 3, 205, 1, 1],
  ] satisfies HandEvent[]);

  const faceDown = [...t.state.hand!.deck, ...t.state.hand!.players.filter((p) => !p.shown).flatMap((p) => p.cards)];
  assert.ok(faceDown.length > 0 && faceDown.every((card) => !JSON.stringify(events).includes(`"${card}"`)), 'an event holds a card nobody was shown');

  t.finishHand();
  const [record] = handRecords(t.effects);
  assert.deepEqual(replayHand(record!.events)!.boards, BOARDS);
  assertHandRecordsHold(t.effects);
});

test('a timeout and a player leaving work in a double-board hand as in any other, and the hand still pays both boards', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bombPotBoards: 'two', actionSeconds: 20 } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD, secondBoard: SECOND });

  t.wait(20_000 + TIMING.actionGraceMs);
  assert.deepEqual([t.state.hand!.players[1]!.lastAction, t.state.seats[1]!.away, t.toAct], ['check', true, 2]);

  t.cmd(2, { type: 'standUp' });
  assert.deepEqual([t.state.seats[2]!.leaving, t.toAct], [true, 0]);

  // Nobody bets, so the two who are away check all the way to the showdown
  checkAround(t, [0], 3);
  assert.deepEqual(awardsOf(t), [[[0, 150, 0], [1, 150, 1]]]);

  t.finishHand();
  assert.equal(t.state.seats[2], null);
  assert.deepEqual(t.stacks(), [1050, 1050, 0]);
  assertHandRecordsHold(t.effects);
});

/** Every card each player was dealt in each hand a table plays, by hand number: a record keeps only the cards that were shown. */
function playAndRemember(t: TestTable, rng: ReturnType<typeof seededRng>, steps: number): Map<number, Map<number, Card[]>> {
  const dealt = new Map<number, Map<number, Card[]>>();

  for (let step = 0; step < steps; step++) {
    randomStep(t, rng);
    assertChipsConserved(t.state);

    const hand = t.state.hand;
    if (hand && !dealt.has(hand.number)) {
      dealt.set(hand.number, new Map(hand.players.map((p) => [p.seat, [...p.cards]])));
    }
  }

  return dealt;
}

/** That each board's half of each pot went, in equal parts but for its odd chips, to exactly the best hands on that board among the players in for the pot. */
function assertBestHandsWonEachBoard(record: HandRecord, cards: Map<number, Card[]>): void {
  for (const pot of record.result.pots) {
    record.boards.forEach((board, run) => {
      const half = Math.floor(pot.amount / 2) + (run === 0 ? pot.amount % 2 : 0);
      const score = (seat: number) => playerHand(cards.get(seat)!, board).score;
      const best = Math.max(...pot.eligible.map(score));
      const winners = pot.eligible.filter((seat) => score(seat) === best);
      const paid = pot.awards.filter((award) => award.run === run);

      assert.equal(paid.reduce((sum, award) => sum + award.amount, 0), half, `hand ${record.number}: board ${run + 1} did not play for its half of a pot of ${pot.amount}`);

      for (const award of paid) {
        assert.ok(winners.includes(award.seat), `hand ${record.number}: seat ${award.seat} was paid on board ${run + 1} without the best hand there among ${pot.eligible}`);
        assert.ok(award.amount === Math.floor(half / winners.length) || award.amount === Math.ceil(half / winners.length), `hand ${record.number}: a board's half was not split evenly`);
      }

      // A winner goes unpaid only when the half has fewer chips than winners
      assert.ok(paid.length === winners.length || half < winners.length, `hand ${record.number}: a best hand on board ${run + 1} got nothing`);
    });
  }
}

test('over random double-board hands no chip is made or lost, and each board\'s half of every pot goes only to the best hands there among the players in for it', () => {
  const TABLES = 60;
  const reached = { shownDown: 0, sidePots: 0, tiedBoards: 0, oddPots: 0, splitBetweenPlayers: 0, allInRunouts: 0, cents: 0 };

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 104_729);
    const players = 2 + rng.int(8);
    const stacks = Array.from({ length: players }, () => (chance(rng, 25) ? 1 + rng.int(120) : 200 + rng.int(1800)));
    const config: Partial<TableConfig> = {
      unit: chance(rng, 50) ? 'cents' : 'chips',
      bombPotBoards: 'two',
      bombPotEvery: 1,
      bombPotAmount: 1 + rng.int(150),
      allowRunItTwice: chance(rng, 50),
      sevenDeuceBounty: chance(rng, 30) ? 25 : 0,
    };

    const t = new TestTable({ stacks, seed, config });
    t.cmd(0, { type: 'start' });

    const dealt = playAndRemember(t, rng, 400);
    assertHandRecordsHold(t.effects);

    for (const record of handRecords(t.effects)) {
      // The settings are changed along the way, so not every hand is a double-board one
      if (record.bombPot?.boards !== 2 || record.result.uncontested) {
        continue;
      }

      assert.deepEqual(record.boards.map((board) => board.length), [5, 5], `hand ${record.number} was shown down short of two whole boards`);
      assert.equal(new Set(record.boards.flat()).size, 10, `hand ${record.number}: the boards share a card`);
      assertBestHandsWonEachBoard(record, dealt.get(record.number)!);

      const { pots } = record.result;
      reached.shownDown += 1;
      reached.sidePots += pots.length > 1 ? 1 : 0;
      reached.tiedBoards += pots.some((pot) => [0, 1].some((run) => pot.awards.filter((award) => award.run === run).length > 1)) ? 1 : 0;
      reached.oddPots += pots.some((pot) => pot.amount % 2 === 1) ? 1 : 0;
      reached.splitBetweenPlayers += new Set(pots[0]!.awards.map((award) => award.seat)).size > 1 ? 1 : 0;
      reached.allInRunouts += record.events.some((event) => event[0] === 'runs') ? 1 : 0;
      reached.cents += t.state.config.unit === 'cents' ? 1 : 0;
    }
  }

  // The property only says something if the hands got to the places where it could fail
  const summary = JSON.stringify(reached);
  assert.ok(reached.shownDown >= TABLES * 5, summary);
  assert.ok(reached.sidePots >= TABLES && reached.oddPots >= TABLES && reached.splitBetweenPlayers >= TABLES && reached.allInRunouts >= TABLES, summary);
  assert.ok(reached.tiedBoards >= 5 && reached.cents >= TABLES, summary);
});
