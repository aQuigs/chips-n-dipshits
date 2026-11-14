import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TIMING } from '../src/engine/index.ts';
import { ACES, BOARD, checkAround, chipsIn, handRecords, KINGS, options, QUEENS, TestTable } from './helpers.ts';
import { assertChipsConserved, assertInvariants } from './invariants.ts';

test('three-handed: blinds sit left of the button and the button acts first before the flop', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });
  const hand = t.state.hand!;

  assert.deepEqual([hand.button, hand.sbSeat, hand.bbSeat], [0, 1, 2]);
  assert.deepEqual(t.stacks(), [1000, 990, 980]);
  assert.equal(t.toAct, 0);

  t.call(0);
  assert.equal(t.toAct, 1);
  t.call(1);
  assert.equal(t.toAct, 2, 'the big blind gets the option');
  t.check(2);

  assert.equal(hand.street, 'flop');
  assert.equal(hand.boards[0]!.length, 3);
  assert.equal(t.toAct, 1, 'the small blind acts first after the flop');
  assertChipsConserved(t.state);
});

test('heads-up: the button posts the small blind, acts first before the flop and last after it', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });
  const hand = t.state.hand!;

  assert.deepEqual([hand.sbSeat, hand.bbSeat], [0, 1]);
  assert.deepEqual(t.stacks(), [990, 980]);
  assert.equal(t.toAct, 0);

  t.call(0);
  assert.equal(t.toAct, 1);
  t.check(1);

  assert.equal(hand.street, 'flop');
  assert.equal(t.toAct, 1);
});

test('everyone folds to the big blind, who wins the blinds without showing', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  t.fold(0);
  t.fold(1);

  const hand = t.state.hand!;
  assert.equal(hand.stage, 'done');
  assert.equal(hand.result!.uncontested, true);
  assert.deepEqual(hand.result!.winnings, [{ seat: 2, amount: 20 }]);
  assert.deepEqual(t.stacks(), [1000, 990, 1010]);
  assert.ok(t.feedText().includes('Uncalled bet of 10 returned to P2'));
  assert.deepEqual(t.view(0).seats[2]!.cards, [null, null]);
  assertChipsConserved(t.state);
});

test('the big blind may raise when the action is limped around', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  t.call(0);
  t.call(1);
  t.raise(2, 60);

  assert.equal(t.state.hand!.street, 'preflop');
  assert.equal(t.state.hand!.currentBet, 60);
  assert.equal(t.toAct, 0);
});

test('a raise before the flop must at least double the big blind, and a re-raise must match the last raise', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  assert.equal(options(t, 0).minRaiseTo, 40);
  assert.throws(() => t.raise(0, 39), /between 40 and 1,000/);
  t.raise(0, 60);

  assert.deepEqual(
    { call: options(t, 1).callAmount, min: options(t, 1).minRaiseTo, max: options(t, 1).maxRaiseTo },
    { call: 50, min: 100, max: 1000 },
  );
  assert.throws(() => t.raise(1, 99), /between 100 and 1,000/);
  t.raise(1, 100);

  assert.equal(options(t, 2).callAmount, 80);
  assert.equal(options(t, 2).minRaiseTo, 140);
});

test('a bet after the flop must be at least the big blind, and a raise must double it', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });
  t.call(0);
  t.check(1);

  assert.equal(options(t, 1).minRaiseTo, 20);
  assert.throws(() => t.raise(1, 19), /between 20 and 980/);
  t.raise(1, 50);

  assert.ok(t.feedText().includes('P1 bets 50'));
  assert.equal(options(t, 0).callAmount, 50);
  assert.equal(options(t, 0).minRaiseTo, 100);
});

test('rejects actions that are out of turn or impossible', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  assert.throws(() => t.call(1), /not your turn/);
  assert.throws(() => t.check(0), /can't check/);

  t.call(0);
  t.call(1);
  assert.throws(() => t.call(2), /nothing to call/);
  assert.throws(() => t.raise(2, 25.5), /between 40 and 1,000/);
});

test('an all-in for less than a full raise does not let players who already acted raise again', () => {
  const t = new TestTable({ stacks: [170, 1000, 1000] });
  t.deal({ button: 0 });
  t.call(0);
  t.call(1);
  t.check(2);

  t.raise(1, 100);
  t.call(2);

  assert.deepEqual({ min: options(t, 0).minRaiseTo, max: options(t, 0).maxRaiseTo }, { min: 150, max: 150 });
  t.raise(0, 150);
  assert.ok(t.feedText().includes('P0 raises to 150 and is all in'));

  assert.equal(options(t, 1).canRaise, false);
  assert.equal(options(t, 1).callAmount, 50);
  assert.throws(() => t.raise(1, 400), /can't raise/);
  t.call(1);

  assert.equal(options(t, 2).canRaise, false);
  t.call(2);

  assert.equal(t.state.hand!.street, 'turn');
  assertChipsConserved(t.state);
});

test('short all-ins that add up to a full raise reopen the betting, but only for players facing that much', () => {
  // The Tournament Directors Association's own example: A bets 100, B is all in for 125, C calls,
  // D is all in for 200, E calls. A faces a full raise of 100 and may raise; C faces 75 and may not.
  const t = new TestTable({ stacks: [1000, 145, 1000, 220, 1000] });
  t.deal({ button: 4 });
  for (const seat of [2, 3, 4, 0]) {
    t.call(seat);
  }
  t.check(1);
  assert.equal(t.state.hand!.street, 'flop');

  t.raise(0, 100);
  t.raise(1, 125);
  t.call(2);
  t.raise(3, 200);
  t.call(4);

  assert.equal(t.toAct, 0);
  assert.deepEqual(
    { canRaise: options(t, 0).canRaise, call: options(t, 0).callAmount, min: options(t, 0).minRaiseTo },
    { canRaise: true, call: 100, min: 300 },
  );
  t.call(0);

  assert.equal(t.toAct, 2);
  assert.deepEqual({ canRaise: options(t, 2).canRaise, call: options(t, 2).callAmount }, { canRaise: false, call: 75 });
  t.call(2);

  assert.equal(t.state.hand!.street, 'turn');
  assertChipsConserved(t.state);
});

test('a player who has not acted yet may raise over a short all-in', () => {
  const t = new TestTable({ stacks: [1000, 1000, 170] });
  t.deal({ button: 0 });
  t.call(0);
  t.call(1);
  t.check(2);

  t.raise(1, 100);
  t.raise(2, 150);

  assert.deepEqual({ canRaise: options(t, 0).canRaise, min: options(t, 0).minRaiseTo }, { canRaise: true, min: 250 });
  t.raise(0, 250);

  assert.equal(options(t, 1).canRaise, true, 'the original bettor now faces a full raise');
  assert.equal(options(t, 1).minRaiseTo, 350);
});

test('nobody can raise when every opponent is already all in', () => {
  const t = new TestTable({ stacks: [100, 1000] });
  t.deal({ button: 0 });
  t.raise(0, 100);

  assert.deepEqual({ canRaise: options(t, 1).canRaise, call: options(t, 1).callAmount }, { canRaise: false, call: 80 });
});

test('side pots: each all-in player can only win what they could match', () => {
  const t = new TestTable({ stacks: [100, 300, 500] });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD });

  t.raise(0, 100);
  t.raise(1, 300);
  t.call(2);

  assert.equal(t.state.hand!.stage, 'runout');
  t.runToResult();

  const result = t.state.hand!.result!;
  assert.deepEqual(result.pots.map((pot) => [pot.amount, pot.eligible]), [[300, [0, 1, 2]], [400, [1, 2]]]);
  assert.deepEqual(t.stacks(), [300, 400, 200]);
  assertChipsConserved(t.state);
});

test('the part of an all-in that nobody could call comes back', () => {
  const t = new TestTable({ stacks: [100, 300, 500] });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD });

  t.raise(0, 100);
  t.call(1);
  t.raise(2, 500);
  t.call(1);

  assert.ok(t.feedText().includes('Uncalled bet of 200 returned to P2'));
  t.runToResult();
  assert.deepEqual(t.stacks(), [300, 400, 200]);
});

test('a split pot gives the odd chip to the first winner left of the button', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { smallBlind: 5, bigBlind: 20 } });
  t.deal({ button: 0, holes: { 0: 'As Kd', 2: 'Ac Kh' }, board: BOARD });

  t.call(0);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);

  assert.equal(t.state.hand!.stage, 'done');
  assert.deepEqual(t.stacks(), [1002, 995, 1003]);
  assertChipsConserved(t.state);
});

test('showdown: the last player to bet on the river shows first, and a beaten hand mucks', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: ACES, 1: QUEENS, 2: KINGS }, board: BOARD });
  t.call(0);
  t.call(1);
  t.check(2);
  checkAround(t, [1, 2, 0], 2);

  t.check(1);
  t.raise(2, 40);
  t.call(0);
  t.call(1);

  const feed = t.feedText();
  const shows = feed.filter((line) => line.includes('shows') || line.includes('mucks'));
  assert.deepEqual(shows, ['P2 shows K♠ K♥ (Pair of kings)', 'P0 shows A♠ A♥ (Pair of aces)', 'P1 mucks']);
  assert.ok(feed.includes('P0 wins 180 with pair of aces'));
  assert.deepEqual(t.stacks(), [1120, 940, 940]);

  const seenByLoser = t.view(2).seats;
  assert.deepEqual(seenByLoser[0]!.cards, ['As', 'Ah']);
  assert.deepEqual(seenByLoser[1]!.cards, [null, null], 'a mucked hand stays face down for everyone else');
  assert.deepEqual(t.view(1).seats[1]!.cards, ['Qs', 'Qh'], 'but its owner still sees it');

  t.finishHand();
  const record = handRecords(t.effects)[0]!;
  assert.deepEqual(record.players.map((p) => p.cards), [['As', 'Ah'], null, ['Ks', 'Kh']]);
  assert.deepEqual(record.players.map((p) => p.endStack - p.startStack), [120, -60, -60]);
});

test('showdown after a checked river starts left of the button', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD });
  t.call(0);
  t.call(1);
  t.check(2);
  checkAround(t, [1, 2, 0], 3);

  const shows = t.feedText().filter((line) => line.includes('shows') || line.includes('mucks'));
  assert.deepEqual(shows, ['P1 shows K♠ K♥ (Pair of kings)', 'P2 mucks', 'P0 shows A♠ A♥ (Pair of aces)']);
});

test('a hand that loses the main pot still shows when it can win a side pot', () => {
  const t = new TestTable({ stacks: [100, 1000, 1000] });
  t.deal({ button: 2, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD });

  t.call(2);
  t.raise(0, 100);
  t.call(1);
  t.call(2);

  t.raise(1, 50);
  t.call(2);
  checkAround(t, [1, 2], 2);

  const shows = t.feedText().filter((line) => line.includes('shows') || line.includes('mucks'));
  assert.deepEqual(shows, ['P0 shows A♠ A♥ (Pair of aces)', 'P1 shows K♠ K♥ (Pair of kings)', 'P2 mucks']);
  assert.ok(t.feedText().includes('P0 wins 300 from the main pot with pair of aces'));
  assert.ok(t.feedText().includes('P1 wins 100 from side pot 1 with pair of kings'));
  assert.deepEqual(t.stacks(), [300, 950, 850]);
  assertChipsConserved(t.state);
});

test('a winner who was not called may show afterward, and so may anyone who folded', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 2: ACES } });
  t.fold(0);

  assert.throws(() => t.cmd(0, { type: 'showCards' }), /once the hand is over/);
  t.fold(1);

  assert.equal(t.view(2).hand!.canShow, true);
  t.cmd(2, { type: 'showCards' });

  assert.deepEqual(t.view(0).seats[2]!.cards, ['As', 'Ah']);
  assert.ok(t.feedText().includes('P2 shows A♠ A♥'));
  assert.throws(() => t.cmd(2, { type: 'showCards' }), /already showing/);

  t.cmd(0, { type: 'showCards' });
  assert.equal(t.view(1).seats[0]!.shown, true);
});

test('all in before the flop: hands turn face up and the board comes one street at a time', () => {
  const t = new TestTable({ stacks: [500, 500] });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD });

  t.raise(0, 500);
  t.call(1);

  const hand = t.state.hand!;
  assert.equal(hand.stage, 'runout');
  assert.deepEqual(t.view(1).seats[0]!.cards, ['As', 'Ah']);
  assert.equal(hand.boards[0]!.length, 0);

  t.wait(TIMING.runoutStepMs);
  assert.equal(hand.boards[0]!.length, 3);
  t.wait(TIMING.runoutStepMs);
  assert.equal(hand.boards[0]!.length, 4);
  assert.equal(hand.stage, 'runout');
  t.wait(TIMING.runoutStepMs);

  assert.equal(hand.stage, 'done');
  assert.deepEqual(hand.boards[0], BOARD.split(' '));
  assert.deepEqual(t.stacks(), [1000, 0]);
  assertChipsConserved(t.state);
});

test('run it twice: each board plays for half the pot and the first board gets the odd chip', () => {
  const t = new TestTable({ stacks: [500, 500, 500], config: { smallBlind: 5, bigBlind: 20, allowRunItTwice: true } });
  t.deal({ button: 0, holes: { 0: ACES, 2: KINGS }, board: BOARD, secondBoard: 'Kd 4c 5h 8s Td' });

  t.raise(0, 500);
  t.fold(1);
  t.call(2);

  const hand = t.state.hand!;
  assert.equal(hand.stage, 'ritVote');
  assert.equal(t.view(0).hand!.canVote, true);
  assert.equal(t.view(1).hand!.canVote, false, 'a folded player has no vote');

  t.cmd(0, { type: 'ritVote', agree: true });
  assert.equal(hand.stage, 'ritVote');
  assert.throws(() => t.cmd(0, { type: 'ritVote', agree: true }), /already voted/);
  t.cmd(2, { type: 'ritVote', agree: true });

  assert.equal(hand.stage, 'runout');
  assert.equal(hand.runs, 2);
  t.runToResult();

  assert.deepEqual(hand.boards, [BOARD.split(' '), 'Kd 4c 5h 8s Td'.split(' ')]);
  assert.deepEqual(hand.result!.pots[0]!.awards, [
    { seat: 0, amount: 503, run: 0 },
    { seat: 2, amount: 502, run: 1 },
  ]);
  assert.deepEqual(t.stacks(), [503, 495, 502]);
  assertChipsConserved(t.state);
});

test('run it twice from the flop keeps the flop and deals a second turn and river', () => {
  const t = new TestTable({ stacks: [500, 500], config: { allowRunItTwice: true } });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD, secondBoard: 'Kd Kc' });
  t.call(0);
  t.check(1);

  t.raise(1, 480);
  t.call(0);
  t.cmd(0, { type: 'ritVote', agree: true });
  t.cmd(1, { type: 'ritVote', agree: true });
  t.runToResult();

  const hand = t.state.hand!;
  assert.deepEqual(hand.boards, [BOARD.split(' '), ['2c', '7d', '9h', 'Kd', 'Kc']]);
  assert.deepEqual(t.stacks(), [500, 500]);
});

test('one no, or no answer in time, means the board runs once', () => {
  const declined = new TestTable({ stacks: [500, 500], config: { allowRunItTwice: true } });
  declined.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD });
  declined.raise(0, 500);
  declined.call(1);
  declined.cmd(1, { type: 'ritVote', agree: false });

  assert.equal(declined.state.hand!.stage, 'runout');
  assert.equal(declined.state.hand!.runs, 1);

  const ignored = new TestTable({ stacks: [500, 500], config: { allowRunItTwice: true } });
  ignored.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD });
  ignored.raise(0, 500);
  ignored.call(1);
  ignored.cmd(0, { type: 'ritVote', agree: true });
  ignored.wait(TIMING.ritVoteMs);

  assert.equal(ignored.state.hand!.stage, 'runout');
  assert.equal(ignored.state.hand!.runs, 1);
  assert.ok(ignored.feedText().includes('Not everyone voted in time, so it runs once'));
  ignored.runToResult();
  assert.deepEqual(ignored.stacks(), [1000, 0]);
});

test('a player who gives up their seat during the run-it-twice vote does not hold it up', () => {
  const allIn = (): TestTable => {
    const t = new TestTable({ stacks: [500, 500, 500], config: { allowRunItTwice: true } });
    t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD, secondBoard: 'Kd 4c 5h 8s Td' });
    t.raise(0, 500);
    t.call(1);
    t.call(2);
    assert.equal(t.state.hand!.stage, 'ritVote');

    return t;
  };

  const stoodUp = allIn();
  stoodUp.cmd(0, { type: 'ritVote', agree: true });
  stoodUp.cmd(2, { type: 'standUp' });
  assert.equal(stoodUp.state.hand!.stage, 'runout', 'nobody is left waiting for a vote that will not come');
  assert.equal(stoodUp.state.hand!.runs, 1);
  assert.ok(stoodUp.feedText().includes('P2 left without voting, so it runs once'));

  const removed = allIn();
  removed.cmd(0, { type: 'kick', playerId: removed.ids[1]! });
  assert.equal(removed.state.hand!.stage, 'runout');
  assert.equal(removed.state.hand!.runs, 1);

  const votedFirst = allIn();
  votedFirst.cmd(2, { type: 'ritVote', agree: true });
  votedFirst.cmd(2, { type: 'standUp' });
  assert.equal(votedFirst.state.hand!.stage, 'ritVote', 'a vote already given still counts');
  votedFirst.cmd(0, { type: 'ritVote', agree: true });
  votedFirst.cmd(1, { type: 'ritVote', agree: true });
  assert.equal(votedFirst.state.hand!.runs, 2);
  votedFirst.finishHand();
  assertChipsConserved(votedFirst.state);
});

test('seven-deuce bounty: winning without a showdown shows the hand and collects from everyone dealt in', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { sevenDeuceBounty: 50 } });
  t.deal({ button: 0, holes: { 0: '7h 2c' } });

  t.raise(0, 60);
  t.fold(1);
  t.fold(2);

  assert.deepEqual(t.state.hand!.result!.bounty, {
    seat: 0,
    payments: [
      { seat: 1, amount: 50 },
      { seat: 2, amount: 50 },
    ],
  });
  assert.deepEqual(t.stacks(), [1130, 940, 930]);
  assert.deepEqual(t.view(1).seats[0]!.cards, ['7h', '2c']);
  assertChipsConserved(t.state);
});

test('seven-deuce bounty: paid for winning a showdown, capped by what a player has left', () => {
  const t = new TestTable({ stacks: [1000, 1000, 110], config: { sevenDeuceBounty: 50 } });
  t.deal({ button: 0, holes: { 0: '7h 2c', 1: ACES }, board: '7d 7s 2h Kc 4d' });

  t.raise(0, 100);
  t.call(1);
  t.fold(2);
  checkAround(t, [1, 0], 3);

  assert.deepEqual(t.state.hand!.result!.bounty!.payments, [
    { seat: 1, amount: 50 },
    { seat: 2, amount: 50 },
  ]);
  assert.deepEqual(t.stacks(), [1000 + 100 + 20 + 100, 1000 - 100 - 50, 110 - 20 - 50]);

  const broke = new TestTable({ stacks: [1000, 1000, 50], config: { sevenDeuceBounty: 50 } });
  broke.deal({ button: 0, holes: { 0: '7h 2c' } });
  broke.raise(0, 60);
  broke.fold(1);
  broke.fold(2);
  assert.deepEqual(broke.state.hand!.result!.bounty!.payments, [
    { seat: 1, amount: 50 },
    { seat: 2, amount: 30 },
  ]);
});

test('seven-deuce bounty: none is announced when everyone who owes it has no chips left', () => {
  const t = new TestTable({ stacks: [1000, 500], config: { sevenDeuceBounty: 50 } });
  t.deal({ button: 0, holes: { 0: '7h 2c', 1: KINGS }, board: '7s 7d 2h 9c 4d' });
  t.raise(0, 500);
  t.call(1);
  t.runToResult();

  assert.equal(t.state.hand!.result!.bounty, null);
  assert.equal(t.feedText().some((line) => line.includes('bounty')), false);
  assert.deepEqual(t.stacks(), [1500, 0]);
});

test('seven-deuce bounty: a hand is played for the bounty it was dealt under', () => {
  const turnedOn = new TestTable({ stacks: [1000, 1000, 1000], config: { sevenDeuceBounty: 0 } });
  turnedOn.deal({ button: 0, holes: { 0: '7h 2c' } });
  turnedOn.cmd(0, { type: 'updateConfig', config: { sevenDeuceBounty: 100 } });
  turnedOn.raise(0, 60);
  turnedOn.fold(1);
  turnedOn.fold(2);

  assert.equal(turnedOn.state.hand!.result!.bounty, null, 'nobody agreed to a bounty when this hand was dealt');
  assert.ok(turnedOn.feedText().includes('The seven-deuce bounty is 100 from the next hand'));

  const turnedOff = new TestTable({ stacks: [1000, 1000, 1000], config: { sevenDeuceBounty: 50 } });
  turnedOff.deal({ button: 0, holes: { 0: '7h 2c' } });
  turnedOff.cmd(0, { type: 'updateConfig', config: { sevenDeuceBounty: 0 } });
  turnedOff.raise(0, 60);
  turnedOff.fold(1);
  turnedOff.fold(2);

  assert.deepEqual(turnedOff.stacks(), [1130, 940, 930]);
  assert.ok(turnedOff.feedText().includes('The seven-deuce bounty is off from the next hand'));
});

test('seven-deuce bounty: nothing for a split pot or a losing hand', () => {
  const split = new TestTable({ stacks: [1000, 1000], config: { sevenDeuceBounty: 50 } });
  split.deal({ button: 0, holes: { 0: '7h 2c', 1: '8h 3c' }, board: 'As Ks Qs Js Ts' });
  split.call(0);
  split.check(1);
  checkAround(split, [1, 0], 3);
  assert.equal(split.state.hand!.result!.bounty, null);
  assert.deepEqual(split.stacks(), [1000, 1000]);

  const lost = new TestTable({ stacks: [1000, 1000], config: { sevenDeuceBounty: 50 } });
  lost.deal({ button: 0, holes: { 0: '7h 2c', 1: ACES }, board: 'Kc 9d 5h Jc 3s' });
  lost.call(0);
  lost.check(1);
  checkAround(lost, [1, 0], 3);
  assert.equal(lost.state.hand!.result!.bounty, null);
  assert.deepEqual(lost.stacks(), [980, 1020]);
});

test('a straddle is a third blind: action starts to its left and the straddler acts last', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.cmd(3, { type: 'setStraddle', on: true });
  t.deal({ button: 0 });
  const hand = t.state.hand!;

  assert.equal(hand.straddleSeat, 3);
  assert.equal(hand.currentBet, 40);
  assert.deepEqual(t.stacks(), [1000, 990, 980, 960]);
  assert.equal(t.toAct, 0);

  assert.equal(options(t, 0).minRaiseTo, 80);
  t.call(0);
  t.call(1);
  t.call(2);

  assert.equal(t.toAct, 3);
  assert.deepEqual({ canCheck: options(t, 3).canCheck, canRaise: options(t, 3).canRaise }, { canCheck: true, canRaise: true });
  t.check(3);
  assert.equal(hand.street, 'flop');
  assert.equal(hand.minRaise, 20, 'bets after the flop go back to the big blind');
});

test('three-handed the button is under the gun and may straddle; heads-up nobody can', () => {
  const three = new TestTable({ stacks: [1000, 1000, 1000] });
  three.cmd(0, { type: 'setStraddle', on: true });
  three.deal({ button: 0 });
  assert.equal(three.state.hand!.straddleSeat, 0);
  assert.equal(three.toAct, 1);

  const two = new TestTable({ stacks: [1000, 1000] });
  two.cmd(0, { type: 'setStraddle', on: true });
  two.cmd(1, { type: 'setStraddle', on: true });
  two.deal({ button: 0 });
  assert.equal(two.state.hand!.straddleSeat, null);
});

test('a straddle is skipped when the player cannot cover it or the table turned it off', () => {
  const short = new TestTable({ stacks: [1000, 1000, 1000, 39] });
  short.cmd(3, { type: 'setStraddle', on: true });
  short.deal({ button: 0 });
  assert.equal(short.state.hand!.straddleSeat, null);

  const off = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: { allowStraddle: false } });
  assert.throws(() => off.cmd(3, { type: 'setStraddle', on: true }), /turned off/);
});

test('running out of time folds a player facing a bet and marks them away', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { actionSeconds: 10 } });
  t.deal({ button: 0 });
  assert.equal(t.state.hand!.deadline, t.now + 10_000 + TIMING.actionGraceMs);

  t.wait(10_000 + TIMING.actionGraceMs - 1);
  assert.equal(t.toAct, 0, 'not yet');
  t.wait(1);

  assert.equal(t.toAct, 1);
  assert.ok(t.feedText().includes('P0 ran out of time'));
  assert.ok(t.feedText().includes('P0 folds'));
  assert.deepEqual({ away: t.state.seats[0]!.away, sittingOut: t.state.seats[0]!.sittingOut }, { away: true, sittingOut: true });
});

test('running out of time checks when checking is free, and an away player is then skipped instantly', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { actionSeconds: 10 } });
  t.deal({ button: 0 });
  t.call(0);
  t.call(1);
  t.wait(12_000);

  assert.equal(t.state.hand!.street, 'flop');
  assert.ok(t.feedText().includes('P2 checks'));

  t.check(1);
  assert.equal(t.toAct, 0, 'the away player checked without being waited for');

  t.raise(0, 40);
  t.call(1);
  assert.equal(t.state.hand!.players.find((p) => p.seat === 2)!.folded, true, 'and folds as soon as there is a bet');
});

test('an away player who acts or sits back in is no longer away', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { actionSeconds: 10 } });
  t.deal({ button: 0 });
  t.wait(12_000);
  assert.equal(t.state.seats[0]!.away, true);

  t.cmd(0, { type: 'sitIn' });
  assert.deepEqual({ away: t.state.seats[0]!.away, sittingOut: t.state.seats[0]!.sittingOut }, { away: false, sittingOut: false });
});

test('standing up on your turn folds at once, and the seat is cashed out when the hand ends', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  t.cmd(0, { type: 'standUp' });
  assert.equal(t.toAct, 1);
  assert.notEqual(t.state.seats[0], null, 'the seat is held until the hand is over');

  t.fold(1);
  t.finishHand();

  assert.equal(t.state.seats[0], null);
  assert.equal(t.state.members[0]!.cashOut, 1000);
  assert.ok(t.effects.some((e) => e.type === 'ledger' && e.entry.kind === 'cash-out' && e.entry.amount === -1000));
  assertChipsConserved(t.state);
});

test('standing up out of turn checks or folds when the action arrives', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  t.cmd(2, { type: 'standUp' });
  assert.equal(t.toAct, 0);
  t.call(0);
  t.call(1);

  assert.equal(t.state.hand!.street, 'flop', 'the big blind checked its option automatically');
  t.raise(1, 40);
  assert.equal(t.toAct, 0, 'and folded to the bet without being waited for');
  assert.equal(t.state.hand!.players.find((p) => p.seat === 2)!.folded, true);
});

test('standing up between hands frees the seat immediately', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.cmd(1, { type: 'standUp' });

  assert.equal(t.state.seats[1], null);
  assert.equal(t.state.members[1]!.cashOut, 1000);
});

test('a big blind that cannot cover the blind is all in, and callers still owe the full blind', () => {
  const t = new TestTable({ stacks: [1000, 1000, 15] });
  t.deal({ button: 0 });

  assert.equal(options(t, 0).callAmount, 20);
  t.call(0);
  assert.equal(options(t, 1).callAmount, 10);
  t.call(1);

  const hand = t.state.hand!;
  assert.equal(hand.street, 'flop');
  assert.deepEqual(t.view(0).hand!.pots, [
    { amount: 45, eligible: [0, 1, 2] },
    { amount: 10, eligible: [0, 1] },
  ]);
});

test('heads-up against a short big blind, the call only costs what the blind can cover', () => {
  const t = new TestTable({ stacks: [1000, 15] });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD });

  assert.deepEqual({ call: options(t, 0).callAmount, cost: options(t, 0).callCost }, { call: 10, cost: 5 });
  t.call(0);

  assert.ok(t.feedText().includes('Uncalled bet of 5 returned to P0'));
  assert.equal(t.state.hand!.stage, 'runout');
  t.runToResult();
  assert.deepEqual(t.stacks(), [1015, 0]);
});

test('a small blind that is all in for less than the big blind leaves nothing to decide', () => {
  const t = new TestTable({ stacks: [5, 1000] });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD });

  const hand = t.state.hand!;
  assert.equal(hand.stage, 'runout');
  assert.equal(hand.toAct, null);
  assert.ok(t.feedText().includes('Uncalled bet of 15 returned to P1'));

  t.runToResult();
  assert.deepEqual(t.stacks(), [10, 995]);
});

test('chips approved during a hand wait for the hand to end', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });

  t.cmd(1, { type: 'requestRebuy', amount: 500 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });

  assert.deepEqual({ stack: t.state.seats[1]!.stack, pending: t.state.seats[1]!.pendingAdd }, { stack: 980, pending: 500 });
  assertChipsConserved(t.state);

  t.fold(0);
  t.finishHand();

  assert.deepEqual(t.stacks(), [990, 1510]);
  assertChipsConserved(t.state);
});

test('the button takes its turn on the seat of a player who stepped out, and the blinds move on as if they had not', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.fold(3);
  t.fold(0);
  t.fold(1);
  t.finishHand();

  t.cmd(1, { type: 'sitOut' });
  t.deal();

  const hand = t.state.hand!;
  assert.deepEqual([hand.button, hand.sbSeat, hand.bbSeat], [1, 2, 3]);
  assert.deepEqual(hand.players.map((p) => p.seat), [0, 2, 3]);
  assert.equal(hand.log[0], 'Hand #2 · blinds 10/20 · dead button on seat 2');
  assert.equal(t.toAct, 0, 'the action does not start left of the big blind');
});

test('with the game running, hands follow each other by themselves', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.cmd(0, { type: 'start' });
  assert.equal(t.state.nextHandAt, t.now + TIMING.startDelayMs);

  t.wait(TIMING.startDelayMs);
  assert.equal(t.state.hand!.number, 1);

  t.fold(t.toAct!);
  t.wait(TIMING.uncontestedPauseMs);
  assert.equal(t.state.hand!.number, 2);
  assert.equal(handRecords(t.effects).length, 1);

  t.cmd(0, { type: 'pause' });
  t.fold(t.toAct!);
  t.wait(TIMING.uncontestedPauseMs);
  assert.equal(t.state.hand, null);
  assert.equal(t.state.nextHandAt, null);
});

test('a player who busts is dealt out until they rebuy, and the game waits when one player is left', () => {
  const t = new TestTable({ stacks: [500, 500] });
  t.cmd(0, { type: 'start' });
  t.wait(TIMING.startDelayMs);

  const button = t.state.hand!.button;
  t.state.hand!.players[0]!.cards = ACES.split(' ');
  t.state.hand!.players[1]!.cards = KINGS.split(' ');
  t.state.hand!.deck = [...t.state.hand!.deck.filter((c) => ![...ACES.split(' '), ...KINGS.split(' '), ...BOARD.split(' ')].includes(c)), ...BOARD.split(' ').reverse()];

  t.raise(button, 500);
  t.call(1 - button);
  t.finishHand();

  assert.deepEqual(t.stacks(), [1000, 0]);
  assert.equal(t.state.hand, null);
  assert.equal(t.state.nextHandAt, null);

  t.cmd(1, { type: 'requestRebuy', amount: 500 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  assert.equal(t.state.nextHandAt, t.now + TIMING.startDelayMs);

  t.wait(TIMING.startDelayMs);
  assert.equal(t.state.hand!.number, 2);
});

test('chips asked for during a hand are bought when it ends, and only as far as the maximum then allows', () => {
  const won = new TestTable({ stacks: [2000, 2000], config: { maxBuyIn: 2000 } });
  won.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD });
  won.raise(0, 2000);
  won.call(1);

  won.cmd(0, { type: 'requestRebuy', amount: 2000 });
  won.cmd(1, { type: 'requestRebuy', amount: 2000 });
  won.cmd(0, { type: 'approve', playerId: won.ids[1]! });

  assert.deepEqual([won.state.seats[0]!.pendingAdd, won.state.seats[1]!.pendingAdd], [2000, 2000]);
  assert.deepEqual([won.state.members[0]!.buyIn, won.state.members[1]!.buyIn], [2000, 2000], 'nothing is bought until the chips arrive');
  assertChipsConserved(won.state);

  won.finishHand();

  assert.deepEqual(won.stacks(), [4000, 2000], 'the winner is over the maximum and gets none; the loser gets all of theirs');
  assert.deepEqual([won.state.members[0]!.buyIn, won.state.members[1]!.buyIn], [2000, 4000]);
  assert.ok(won.feedText().includes('P0 is over the table maximum, so no chips are added'));
  assertChipsConserved(won.state);

  const part = new TestTable({ stacks: [1000, 1000], config: { maxBuyIn: 2000 } });
  part.deal({ button: 0 });
  part.cmd(1, { type: 'requestRebuy', amount: 1000 });
  part.cmd(0, { type: 'approve', playerId: part.ids[1]! });
  part.fold(0);
  part.finishHand();

  assert.deepEqual(part.stacks(), [990, 2000], 'winning the blind left room for 990 of the 1,000');
  assert.equal(part.state.members[1]!.buyIn, 1990);
  assert.ok(part.feedText().includes('P1 adds 990, which brings them to the table maximum'));
  assertChipsConserved(part.state);
});

test('chips still waiting when a player gives up their seat are never bought', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });

  t.cmd(1, { type: 'requestRebuy', amount: 500 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  t.cmd(1, { type: 'standUp' });
  t.fold(0);
  t.finishHand();

  assert.equal(t.state.seats[1], null);
  assert.deepEqual({ buyIn: t.state.members[1]!.buyIn, cashOut: t.state.members[1]!.cashOut }, { buyIn: 1000, cashOut: 1010 });
  assertChipsConserved(t.state);
});

test('changing the action clock applies to the player already being waited for', () => {
  const on = new TestTable({ stacks: [1000, 1000, 1000] });
  on.deal({ button: 0 });
  assert.equal(on.state.hand!.deadline, null);

  on.cmd(0, { type: 'updateConfig', config: { actionSeconds: 30 } });
  assert.equal(on.state.hand!.deadline, on.now + 30_000 + TIMING.actionGraceMs);

  on.wait(30_000 + TIMING.actionGraceMs);
  assert.equal(on.toAct, 1, 'the player who was being waited for has now timed out');

  const off = new TestTable({ stacks: [1000, 1000, 1000], config: { actionSeconds: 30 } });
  off.deal({ button: 0 });

  off.cmd(0, { type: 'updateConfig', config: { actionSeconds: 0 } });
  assert.equal(off.state.hand!.deadline, null);

  off.wait(600_000);
  assert.equal(off.toAct, 0, 'nobody is timed out once the clock is off');
  assert.equal(off.state.seats[0]!.away, false);

  const untouched = new TestTable({ stacks: [1000, 1000, 1000], config: { actionSeconds: 30 } });
  untouched.deal({ button: 0 });
  const deadline = untouched.state.hand!.deadline;
  untouched.now += 10_000;
  untouched.cmd(0, { type: 'updateConfig', config: { sevenDeuceBounty: 5 } });
  assert.equal(untouched.state.hand!.deadline, deadline, 'another setting does not hand the player a fresh clock');
});

test('seven-deuce bounty: a tie on the second board is not winning outright, even when one chip cannot be split', () => {
  const t = new TestTable({
    stacks: [100, 100, 1],
    config: { smallBlind: 1, bigBlind: 2, allowRunItTwice: true, sevenDeuceBounty: 50 },
  });
  t.deal({
    button: 0,
    holes: { 0: 'Ac Ad', 1: '7h 2c', 2: '9c 8c' },
    board: '7d 7s 2h Kc 4d',
    secondBoard: 'As Ks Qs Js Ts',
  });

  t.raise(0, 100);
  t.call(1);

  for (const seat of [0, 1, 2]) {
    t.cmd(seat, { type: 'ritVote', agree: true });
  }

  t.runToResult();

  // The three-chip main pot puts one chip on the second board, where everyone plays the board
  assert.deepEqual(t.state.hand!.result!.pots[0]!.awards, [
    { seat: 1, amount: 2, run: 0 },
    { seat: 1, amount: 1, run: 1 },
  ]);
  assert.equal(t.state.hand!.result!.bounty, null);
  assertChipsConserved(t.state);
});

test('a raising war cannot grow the hand\'s log without end', () => {
  const t = new TestTable({ stacks: [1_000_000, 1_000_000] });
  t.deal({ button: 0 });
  const log = t.state.hand!.log;
  const opening = log[0];

  const raiseTimes = (from: number, count: number): void => {
    for (let i = from; i < from + count; i++) {
      t.raise(i % 2, 40 + 20 * i);
    }
  };

  raiseTimes(0, 300);
  const settled = log.length;
  raiseTimes(300, 200);

  assert.equal(log.length, settled, 'the log has stopped growing');
  assert.ok(settled < 300);
  assert.equal(log[0], opening, 'the start of the hand is kept');
  assert.equal(log.filter((line) => line.startsWith('…')).length, 1, 'one line stands in for what was left out');
  assert.equal(log.at(-1), `P1 raises to ${(40 + 20 * 499).toLocaleString('en-US')}`);
  assertChipsConserved(t.state);
});

test('an action that names the decision it answers is only played on that decision', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });
  const first = t.view(0).hand!.turn;

  // Heads-up the button acts first before the flop and second after it
  t.cmd(0, { type: 'call', turn: first });
  t.check(1);
  t.check(1);
  assert.equal(t.toAct, 0);

  // The same answer again, as a second tap or a resend would deliver it, now that it is this player's turn once more
  assert.throws(() => t.cmd(0, { type: 'call', turn: first }), /moved on/);
  assert.throws(() => t.cmd(0, { type: 'raise', to: 40, turn: first }), /moved on/);
  assert.throws(() => t.cmd(0, { type: 'check', turn: 1.5 }), /whole number/);
  assert.equal(t.toAct, 0, 'nothing was played');

  t.cmd(0, { type: 'check', turn: t.view(0).hand!.turn });
  assert.equal(t.state.hand!.street, 'turn');

  t.check(1);
  t.check(0);
  assert.equal(t.state.hand!.street, 'river', 'an action that names no decision is played on the open one');
});

test('an action that arrives after its hand is over is not played in the next hand', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });
  const lastHand = t.view(0).hand!.turn;

  t.fold(0);
  t.finishHand();

  // The same seat is first to act again, facing the first decision of a new hand
  t.deal({ button: 0 });
  assert.equal(t.toAct, 0);
  assert.throws(() => t.cmd(0, { type: 'call', turn: lastHand }), /moved on/);

  t.cmd(0, { type: 'call', turn: t.view(0).hand!.turn });
  assert.equal(t.toAct, 1);
});

test('dollars and cents: the play-by-play, the pots and the result of a split pot with an odd cent all read in dollars', () => {
  const t = new TestTable({ stacks: [10_000, 10_000, 10_000], config: { unit: 'cents', smallBlind: 25, bigBlind: 50 } });
  t.deal({ button: 0, holes: { 0: '2c 3d', 2: '4c 5d' }, board: 'As Ks Qs Js Ts' });

  assert.throws(() => t.check(0), { message: "You can't check, there is a bet of 0.50 to you" });
  assert.throws(() => t.raise(0, 99), { message: 'A raise here must be between 1.00 and 100.00' });

  t.raise(0, 150);
  t.fold(1);
  t.call(2);
  assert.deepEqual(t.view(0).hand!.pots, [{ amount: 325, eligible: [0, 2] }], 'the pot is still a whole number of cents');

  checkAround(t, [2, 0], 3);

  // 3.25 does not split: the odd cent goes to the first winner clockwise from the button
  const result = t.state.hand!.result!;
  assert.deepEqual(result.pots[0]!.awards, [
    { seat: 2, amount: 163, run: 0 },
    { seat: 0, amount: 162, run: 0 },
  ]);
  assert.deepEqual(t.stacks(), [10_012, 9975, 10_013]);
  assertChipsConserved(t.state);

  const log = t.state.hand!.log;
  assert.equal(log[0], 'Hand #1 · blinds 0.25/0.50 · P0 has the button');
  assert.deepEqual(log.slice(1, 6), ['P1 posts small blind 0.25', 'P2 posts big blind 0.50', 'P0 raises to 1.50', 'P1 folds', 'P2 calls 1.00']);
  assert.deepEqual(log.slice(-2), ['P2 wins 1.63 with royal flush', 'P0 wins 1.62 with royal flush']);

  t.finishHand();
  const [record] = handRecords(t.effects);
  assert.equal(record!.summary, log.join('\n'), 'the hand history keeps the same words');
  assert.deepEqual(record!.players.map((p) => p.endStack), [10_012, 9975, 10_013]);
});

test('dollars and cents: an uncalled bet, a short all-in and a seven-deuce bounty read in dollars', () => {
  const t = new TestTable({ stacks: [10_000, 40, 10_000], config: { unit: 'cents', smallBlind: 25, bigBlind: 50, sevenDeuceBounty: 500 } });
  t.deal({ button: 0, holes: { 0: '7h 2c', 1: 'As Ah', 2: 'Kd Kh' }, board: '7d 7s 2h 9c 4d' });

  t.raise(0, 150);
  t.call(1);
  t.fold(2);
  t.runToResult();

  // The small blind had 0.40 in all, so the last 0.10 of the big blind and of the raiser's matching 0.50 make a side pot
  const text = t.feedText();
  for (const line of ['P1 calls 0.15 and is all in', 'Uncalled bet of 1.00 returned to P0', 'P0 wins 1.20 from the main pot with full house, sevens over deuces', 'P0 wins 0.20 from side pot 1 with full house, sevens over deuces']) {
    assert.ok(text.includes(line), `"${line}" is missing from: ${text.join(' / ')}`);
  }

  // The player who lost their last cent in the hand has nothing to pay the bounty with
  assert.deepEqual(t.state.hand!.result!.bounty, { seat: 0, payments: [{ seat: 2, amount: 500 }] });
  assert.ok(text.includes('P0 won with seven-deuce and collects a bounty of 5.00'));
  assert.deepEqual(t.stacks(), [10_000 + 40 + 50 + 500, 0, 10_000 - 50 - 500]);
  assertChipsConserved(t.state);
});

const EVERYONE_ANTES = { ante: 5 } as const;
const BIG_BLIND_ANTE = { ante: 20, anteFrom: 'bigBlind' } as const;

test('everyone antes: each player dealt in puts one in the pot before the blinds, and calling the big blind costs what it did', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: EVERYONE_ANTES });
  t.deal({ button: 0, holes: { 0: ACES, 2: KINGS }, board: BOARD });
  const hand = t.state.hand!;

  assert.deepEqual(t.stacks(), [995, 985, 975, 995]);
  assert.deepEqual(chipsIn(t), [[0, 5, 0], [10, 15, 0], [20, 25, 0], [0, 5, 0]], 'an ante is staked, and no part of the bet in front of a player');
  assert.equal(t.view(0).hand!.pot, 50);
  assert.deepEqual(hand.log, ['Hand #1 · blinds 10/20 · ante 5 · P0 has the button', 'Everyone posts ante 5', 'P1 posts small blind 10', 'P2 posts big blind 20']);
  assertChipsConserved(t.state);

  assert.equal(t.toAct, 3);
  assert.deepEqual({ call: options(t, 3).callAmount, raise: options(t, 3).minRaiseTo }, { call: 20, raise: 40 });
  t.fold(3);
  t.call(0);
  assert.deepEqual(chipsIn(t)[0], [20, 25, 0]);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);

  assert.deepEqual(hand.result!.pots.map((pot) => [pot.amount, pot.eligible]), [[70, [0, 2]]]);
  assert.deepEqual(t.stacks(), [1045, 985, 975, 995]);
  assertChipsConserved(t.state);
});

test('everyone antes heads-up: both ante, and the button still posts the small blind and acts first', () => {
  const t = new TestTable({ stacks: [1000, 1000], config: EVERYONE_ANTES });
  t.deal({ button: 0 });

  assert.deepEqual(t.stacks(), [985, 975]);
  assert.deepEqual(t.state.hand!.log.slice(1), ['Everyone posts ante 5', 'P0 posts small blind 10', 'P1 posts big blind 20']);
  assert.equal(t.toAct, 0);
  assert.equal(options(t, 0).callAmount, 10);

  t.fold(0);
  assert.ok(t.feedText().includes('Uncalled bet of 10 returned to P1'));
  assert.deepEqual(t.state.hand!.result!.winnings, [{ seat: 1, amount: 30 }]);
  assert.deepEqual(t.stacks(), [985, 1015]);
});

test('everyone antes: a player all in on the ante wins that much from each opponent, and the rest is a side pot for the others', () => {
  const t = new TestTable({ stacks: [1000, 3, 1000, 1000], config: EVERYONE_ANTES });
  t.deal({ button: 0, holes: { 1: ACES, 3: KINGS, 0: QUEENS }, board: BOARD });
  const hand = t.state.hand!;

  // The small blind's whole stack went on the ante, so there is nothing left to post the blind with
  assert.deepEqual(hand.log.slice(1), ['P1 posts ante 3 and is all in', 'Everyone else posts ante 5', 'P2 posts big blind 20']);
  assert.deepEqual(chipsIn(t), [[0, 5, 0], [0, 3, 0], [20, 25, 0], [0, 5, 0]]);
  assert.equal(hand.players[1]!.allIn, true);
  assert.equal(options(t, 3).callAmount, 20, 'the price to call is the big blind, whoever is all in');

  t.raise(3, 60);
  t.call(0);
  t.fold(2);
  checkAround(t, [3, 0], 3);

  assert.deepEqual(hand.result!.pots.map((pot) => [pot.amount, pot.eligible]), [[12, [0, 1, 3]], [146, [0, 3]]]);
  assert.deepEqual(hand.result!.winnings, [{ seat: 1, amount: 12 }, { seat: 3, amount: 146 }]);
  assert.deepEqual(t.stacks(), [935, 12, 975, 1081]);
  assertChipsConserved(t.state);
});

test('everyone antes: players short of the ante put in what they have, and the part of an ante nobody could match comes back', () => {
  const short = new TestTable({ stacks: [1000, 5, 1000, 2], config: EVERYONE_ANTES });
  short.deal({ button: 0 });

  assert.deepEqual(short.state.hand!.log.slice(1), ['P1 posts ante 5 and is all in', 'P3 posts ante 2 and is all in', 'Everyone else posts ante 5', 'P2 posts big blind 20']);
  assert.deepEqual(short.stacks(), [995, 0, 975, 0]);
  assert.equal(short.toAct, 0, 'the action passes over the players who are all in');
  assert.equal(options(short, 0).callAmount, 20);

  // Heads-up, all that the short player can win from the other is their own 3: the rest of the ante and the whole blind go back
  const t = new TestTable({ stacks: [3, 1000], config: EVERYONE_ANTES });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD });
  const hand = t.state.hand!;

  assert.deepEqual(hand.log.slice(1), [
    'P0 posts ante 3 and is all in',
    'P1 posts ante 5',
    'P1 posts big blind 20',
    '22 that nobody could match returned to P1',
    'P0 shows A♠ A♥',
    'P1 shows K♠ K♥',
  ]);
  assert.deepEqual(chipsIn(t), [[0, 3, 0], [0, 3, 0]]);
  assert.equal(hand.stage, 'runout');
  assertChipsConserved(t.state);

  t.runToResult();
  assert.deepEqual(t.stacks(), [6, 997]);
});

test('big-blind ante: the big blind posts one ante for the table as dead money, and nobody else pays', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: BIG_BLIND_ANTE });
  t.deal({ button: 0, holes: { 2: KINGS, 3: ACES }, board: BOARD });
  const hand = t.state.hand!;

  assert.deepEqual(t.stacks(), [1000, 990, 960, 1000]);
  assert.deepEqual(chipsIn(t), [[0, 0, 0], [10, 10, 0], [20, 20, 20], [0, 0, 0]], 'the ante is neither bet nor staked');
  assert.equal(t.view(0).hand!.pot, 50);
  assert.deepEqual(hand.log, ['Hand #1 · blinds 10/20 · BB ante 20 · P0 has the button', 'P1 posts small blind 10', 'P2 posts big blind 20', 'P2 posts big blind ante 20']);
  assertChipsConserved(t.state);

  assert.equal(t.toAct, 3);
  assert.deepEqual({ call: options(t, 3).callAmount, raise: options(t, 3).minRaiseTo }, { call: 20, raise: 40 });
  t.call(3);
  t.fold(0);
  t.fold(1);
  assert.deepEqual({ check: options(t, 2).canCheck, raise: options(t, 2).minRaiseTo }, { check: true, raise: 40 }, 'the ante is no part of what the big blind has bet');
  t.check(2);
  checkAround(t, [2, 3], 3);

  assert.deepEqual(hand.result!.pots.map((pot) => [pot.amount, pot.eligible]), [[70, [2, 3]]]);
  assert.deepEqual(t.stacks(), [1000, 990, 960, 1050]);
  assertChipsConserved(t.state);
});

test('big-blind ante heads-up: it is still the big blind who pays', () => {
  const t = new TestTable({ stacks: [1000, 1000], config: BIG_BLIND_ANTE });
  t.deal({ button: 0 });

  assert.deepEqual(t.state.hand!.log.slice(1), ['P0 posts small blind 10', 'P1 posts big blind 20', 'P1 posts big blind ante 20']);
  assert.deepEqual(t.stacks(), [990, 960]);

  t.fold(0);
  assert.deepEqual(t.state.hand!.result!.winnings, [{ seat: 1, amount: 40 }]);
  assert.deepEqual(t.stacks(), [990, 1010]);
});

test('big-blind ante: a big blind who cannot cover both posts the blind first and puts what is left toward the ante', () => {
  const t = new TestTable({ stacks: [1000, 1000, 25, 1000], config: BIG_BLIND_ANTE });
  t.deal({ button: 0, holes: { 2: ACES, 3: KINGS }, board: BOARD });
  const hand = t.state.hand!;

  assert.deepEqual(hand.log.slice(1), ['P1 posts small blind 10', 'P2 posts big blind 20', 'P2 posts big blind ante 5 and is all in']);
  assert.deepEqual(chipsIn(t)[2], [20, 20, 5]);

  t.call(3);
  t.fold(0);
  t.fold(1);
  assert.equal(hand.stage, 'runout');
  t.runToResult();

  assert.deepEqual(hand.result!.pots.map((pot) => [pot.amount, pot.eligible]), [[55, [2, 3]]]);
  assert.deepEqual(t.stacks(), [1000, 990, 55, 980]);

  // With just the blind, or less, nothing is left for the ante, and the full blind is still the price to call
  for (const stack of [20, 15]) {
    const broke = new TestTable({ stacks: [1000, 1000, stack, 1000], config: BIG_BLIND_ANTE });
    broke.deal({ button: 0 });

    assert.deepEqual(broke.state.hand!.log.slice(1), ['P1 posts small blind 10', `P2 posts big blind ${stack} and is all in`]);
    assert.deepEqual(chipsIn(broke)[2], [stack, stack, 0]);
    assert.equal(options(broke, 3).callAmount, 20);
    assertChipsConserved(broke.state);
  }
});

test('big-blind ante: the ante is in the main pot, where a player all in for less than anyone can win all of it', () => {
  const t = new TestTable({ stacks: [1000, 5, 1000], config: BIG_BLIND_ANTE });
  t.deal({ button: 0, holes: { 1: ACES, 0: KINGS, 2: QUEENS }, board: BOARD });

  t.call(0);
  t.check(2);
  checkAround(t, [2, 0], 3);

  const result = t.state.hand!.result!;
  assert.deepEqual(result.pots.map((pot) => [pot.amount, pot.eligible]), [[35, [0, 1, 2]], [30, [0, 2]]]);
  assert.deepEqual(result.winnings, [{ seat: 1, amount: 35 }, { seat: 0, amount: 30 }]);
  assert.deepEqual(t.stacks(), [1010, 35, 960]);
  assertChipsConserved(t.state);
});

test('with an ante, everyone folding to the big blind leaves them the antes and the small blind', () => {
  const everyone = new TestTable({ stacks: [1000, 1000, 1000], config: EVERYONE_ANTES });
  everyone.deal({ button: 0 });
  everyone.fold(0);
  everyone.fold(1);

  assert.ok(everyone.feedText().includes('Uncalled bet of 10 returned to P2'));
  assert.deepEqual(everyone.state.hand!.result!.winnings, [{ seat: 2, amount: 35 }]);
  assert.deepEqual(everyone.stacks(), [995, 985, 1020]);

  const bigBlind = new TestTable({ stacks: [1000, 1000, 1000], config: BIG_BLIND_ANTE });
  bigBlind.deal({ button: 0 });
  bigBlind.fold(0);
  bigBlind.fold(1);

  assert.ok(bigBlind.feedText().includes('Uncalled bet of 10 returned to P2'));
  assert.deepEqual(bigBlind.state.hand!.result!.winnings, [{ seat: 2, amount: 40 }], 'their own ante comes back with the small blind');
  assert.deepEqual(bigBlind.stacks(), [1000, 990, 1010]);
  assertChipsConserved(bigBlind.state);
});

test('a hand is played with the ante it was dealt under, and a changed ante is posted from the next hand', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: EVERYONE_ANTES });
  t.deal({ button: 0 });
  t.call(3);

  const dealt = JSON.stringify(t.state.hand);
  t.cmd(0, { type: 'updateConfig', config: BIG_BLIND_ANTE });
  assert.equal(JSON.stringify(t.state.hand), dealt);
  assert.ok(t.feedText().includes('The ante is 20, paid by the big blind for the table from the next hand'));

  t.fold(0);
  t.fold(1);
  t.check(2);
  t.fold(2);
  assert.deepEqual(t.state.hand!.result!.winnings, [{ seat: 3, amount: 70 }], 'the antes everyone posted are still in the pot');
  assert.deepEqual(t.stacks(), [995, 985, 975, 1045]);

  t.finishHand();
  t.deal({ button: 1 });
  assert.deepEqual(t.state.hand!.log.slice(0, 4), ['Hand #2 · blinds 10/20 · BB ante 20 · P1 has the button', 'P2 posts small blind 10', 'P3 posts big blind 20', 'P3 posts big blind ante 20']);
  assert.deepEqual(t.stacks(), [995, 985, 965, 1005]);

  t.cmd(0, { type: 'updateConfig', config: { ante: 0 } });
  assert.ok(t.feedText().includes('The ante is off from the next hand'));
  t.fold(0);
  t.fold(1);
  t.fold(2);
  t.finishHand();
  t.deal({ button: 2 });
  assert.deepEqual(t.state.hand!.log.slice(0, 3), ['Hand #3 · blinds 10/20 · P2 has the button', 'P3 posts small blind 10', 'P0 posts big blind 20']);
});

test('seven-deuce bounty with an ante: the antes are won with the pot, and the bounty is paid on top as ever', () => {
  const everyone = new TestTable({ stacks: [1000, 1000, 1000], config: { ...EVERYONE_ANTES, sevenDeuceBounty: 50 } });
  everyone.deal({ button: 0, holes: { 0: '7h 2c' } });
  everyone.raise(0, 60);
  everyone.fold(1);
  everyone.fold(2);

  assert.deepEqual(everyone.state.hand!.result!.winnings, [{ seat: 0, amount: 65 }]);
  assert.deepEqual(everyone.state.hand!.result!.bounty!.payments, [{ seat: 1, amount: 50 }, { seat: 2, amount: 50 }]);
  assert.deepEqual(everyone.stacks(), [1140, 935, 925]);
  assertChipsConserved(everyone.state);

  const bigBlind = new TestTable({ stacks: [1000, 1000, 1000], config: { ...BIG_BLIND_ANTE, sevenDeuceBounty: 50 } });
  bigBlind.deal({ button: 0, holes: { 0: '7h 2c' } });
  bigBlind.raise(0, 60);
  bigBlind.fold(1);
  bigBlind.fold(2);

  assert.deepEqual(bigBlind.state.hand!.result!.winnings, [{ seat: 0, amount: 70 }]);
  assert.deepEqual(bigBlind.stacks(), [1150, 940, 910]);
  assertChipsConserved(bigBlind.state);
});

test('run it twice with a big-blind ante: the ante is split between the boards with the main pot it is in', () => {
  const t = new TestTable({ stacks: [100, 500, 500], config: { ante: 25, anteFrom: 'bigBlind', allowRunItTwice: true } });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD, secondBoard: 'Qd 4c 5h 8s Td' });

  t.raise(0, 100);
  t.raise(1, 500);
  t.call(2);
  assert.ok(t.feedText().includes('Uncalled bet of 25 returned to P1'), 'the big blind had 25 less to call with');

  for (const voter of [0, 1, 2]) {
    t.cmd(voter, { type: 'ritVote', agree: true });
  }
  t.runToResult();

  // 300 staked and the ante of 25 make the main pot, and the first board gets its odd chip
  assert.deepEqual(t.state.hand!.result!.pots, [
    { amount: 325, eligible: [0, 1, 2], awards: [{ seat: 0, amount: 163, run: 0 }, { seat: 2, amount: 162, run: 1 }] },
    { amount: 750, eligible: [1, 2], awards: [{ seat: 1, amount: 375, run: 0 }, { seat: 2, amount: 375, run: 1 }] },
  ]);
  assert.deepEqual(t.stacks(), [163, 400, 537]);
  assertChipsConserved(t.state);
});

test('a straddle with an ante: the antes go in first, and the straddle is still the bet to call', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: EVERYONE_ANTES });
  t.cmd(3, { type: 'setStraddle', on: true });
  t.deal({ button: 0 });
  const hand = t.state.hand!;

  assert.deepEqual(hand.log.slice(1), ['Everyone posts ante 5', 'P1 posts small blind 10', 'P2 posts big blind 20', 'P3 posts straddle 40']);
  assert.equal(hand.straddleSeat, 3);
  assert.deepEqual(t.stacks(), [995, 985, 975, 955]);
  assert.equal(t.toAct, 0);
  assert.deepEqual({ call: options(t, 0).callAmount, raise: options(t, 0).minRaiseTo }, { call: 40, raise: 80 });

  t.call(0);
  t.call(1);
  t.call(2);
  assert.equal(t.toAct, 3, 'the straddler acts last before the flop');
  assert.equal(options(t, 3).canCheck, true);

  const bigBlind = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: BIG_BLIND_ANTE });
  bigBlind.cmd(3, { type: 'setStraddle', on: true });
  bigBlind.deal({ button: 0 });
  assert.deepEqual(bigBlind.state.hand!.log.slice(1), ['P1 posts small blind 10', 'P2 posts big blind 20', 'P2 posts big blind ante 20', 'P3 posts straddle 40']);
  assert.deepEqual(bigBlind.stacks(), [1000, 990, 960, 960]);

  // 44 covers the straddle but not the straddle and the ante, and a straddle is posted whole or not at all
  const short = new TestTable({ stacks: [1000, 1000, 1000, 44], config: EVERYONE_ANTES });
  short.cmd(3, { type: 'setStraddle', on: true });
  short.deal({ button: 0 });
  assert.equal(short.state.hand!.straddleSeat, null);
  assert.deepEqual(short.stacks(), [995, 985, 975, 39]);
  assert.equal(short.toAct, 3);
});

test('an ante in the pot still counts as its player\'s chips in the ledger until the hand pays out', () => {
  for (const config of [EVERYONE_ANTES, BIG_BLIND_ANTE]) {
    const t = new TestTable({ stacks: [1000, 1000, 1000], config });
    t.deal({ button: 0 });

    assert.deepEqual(t.view(0).ledger.map((row) => [row.stack, row.net]), [[1000, 0], [1000, 0], [1000, 0]]);
    assert.equal(t.effects.filter((effect) => effect.type === 'ledger').length, 3, 'an ante is play, not a buy-in: the ledger has only the three buy-ins');
  }
});

test('dollars and cents: an ante reads in dollars in the play-by-play', () => {
  const t = new TestTable({ stacks: [10_000, 10_000, 3], config: { unit: 'cents', smallBlind: 25, bigBlind: 50, ante: 5 } });
  t.deal({ button: 0 });

  assert.deepEqual(t.state.hand!.log, ['Hand #1 · blinds 0.25/0.50 · ante 0.05 · P0 has the button', 'P2 posts ante 0.03 and is all in', 'Everyone else posts ante 0.05', 'P1 posts small blind 0.25']);

  const bigBlind = new TestTable({ stacks: [10_000, 10_000, 10_000], config: { unit: 'cents', smallBlind: 25, bigBlind: 50, ante: 50, anteFrom: 'bigBlind' } });
  bigBlind.deal({ button: 0 });
  assert.deepEqual(bigBlind.state.hand!.log, ['Hand #1 · blinds 0.25/0.50 · BB ante 0.50 · P0 has the button', 'P1 posts small blind 0.25', 'P2 posts big blind 0.50', 'P2 posts big blind ante 0.50']);
});

test('a move that waited for a hand to end is made before the next hand\'s forced bets are worked out', () => {
  const posts = (t: TestTable) => t.state.hand!.events.flatMap((event) => (event[0] === 'post' ? [event.slice(1).join(' ')] : []));

  for (const config of [EVERYONE_ANTES, BIG_BLIND_ANTE]) {
    const t = new TestTable({ stacks: [1000, 1000, 1000], config });
    t.deal({ button: 0 });
    t.cmd(0, { type: 'moveSeat', playerId: t.ids[1]!, seat: 5 });

    t.fold(0);
    t.fold(1);
    t.finishHand();
    assert.equal(t.state.seats[5]!.playerId, t.ids[1]);

    // The big blind moves on from seat 2 to the next player, who is now the one in seat 5
    const before = t.stacks();
    t.deal();
    assert.deepEqual(t.state.hand!.players.map((p) => p.seat), [0, 2, 5]);
    assert.deepEqual(
      posts(t),
      config === EVERYONE_ANTES
        ? ['2 ante 5 1015 contribution', '5 ante 5 980 contribution', '0 ante 5 990 contribution', '2 small blind 10 1005', '5 big blind 20 960']
        : ['2 small blind 10 1000', '5 big blind 20 970', '5 big blind ante 20 950 dead'],
    );
    assert.equal(t.stacks().reduce((sum, stack) => sum + stack, 0) + t.view(0).hand!.pot, before.reduce((sum, stack) => sum + stack, 0));
    assertInvariants(t.state, t.now);
  }
});
