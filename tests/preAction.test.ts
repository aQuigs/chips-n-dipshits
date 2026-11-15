/*
 * Moves chosen ahead of a turn (pre-actions): what each one does when the action arrives, what takes
 * one off before it does, and what the table makes of a choice that reaches it late. Hands are really
 * dealt and played, and every table here is also held to `preActionCheck.ts`: each move played for a
 * player makes the same hand as that move tapped.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, handFacts, replayHand, replaySteps, replayView, TIMING, TOO_LATE_TO_SET, viewFor } from '../src/engine/index.ts';
import type { PreActionKind, Street, TableConfig } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { ACES, BOARD, handRecords, KINGS, QUEENS, TestTable } from './helpers.ts';
import { assertInvariants } from './invariants.ts';
import { holdToWhatWasChosen } from './preActionCheck.ts';

// The button on Pam: Stu is the small blind, Kim the big blind, and Ann acts first before the flop. After it Stu does
const NAMES = ['Pam', 'Stu', 'Kim', 'Ann'];
const [PAM, STU, KIM, ANN] = [0, 1, 2, 3];
const HOLES = { [PAM]: QUEENS, [STU]: ACES, [KIM]: KINGS, [ANN]: '4c 4d' };
const CLOCK_MS = 30_000 + TIMING.actionGraceMs;
const TOO_LATE = { message: TOO_LATE_TO_SET };

function table(stacks = [1000, 1000, 1000, 1000], config: Partial<TableConfig> = {}): TestTable {
  const t = new TestTable({ stacks, config, names: NAMES });
  holdToWhatWasChosen(t);

  return t;
}

/** A hand with the button on Pam, before anyone has acted: Ann is on the clock. */
function dealt(stacks?: number[], config?: Partial<TableConfig>): TestTable {
  const t = table(stacks, config);
  t.deal({ button: PAM, holes: HOLES, board: BOARD });

  return t;
}

/** The same hand on the flop, everyone having called: Stu is on the clock, and nothing is bet. */
function onTheFlop(stacks?: number[], config?: Partial<TableConfig>): TestTable {
  const t = dealt(stacks, config);
  t.call(ANN);
  t.call(PAM);
  t.call(STU);
  t.check(KIM);

  return t;
}

/** The player chooses a move ahead, or none, for the spot they are looking at, unless told another. */
function choose(t: TestTable, player: number, what: PreActionKind | null, spot: { hand?: number; street?: Street; facing?: number } = {}): void {
  const hand = t.state.hand;

  t.cmd(player, { type: 'preAct', what, hand: hand?.number ?? t.state.handCount, street: hand?.street ?? 'preflop', facing: hand?.currentBet ?? 0, ...spot });
}

const chosen = (t: TestTable, player: number) => t.view(player).preAction;
const ahead = (t: TestTable, player: number) => t.view(player).hand!.ahead;
const inHand = (t: TestTable, player: number) => t.state.hand!.players.find((p) => p.seat === player)!;

/** The play-by-play since the hand's log was `mark` lines long. */
const since = (t: TestTable, mark: number) => t.state.hand!.log.slice(mark);
const lines = (t: TestTable) => t.state.hand!.log.length;

test('check/fold with nothing bet checks the moment the action arrives: no clock is started for the player, and the move is their own in the play-by-play and the events', () => {
  const t = onTheFlop(undefined, { actionSeconds: 30 });
  assert.deepEqual(ahead(t, KIM), { canCheck: true, callAmount: 0, callCost: 0 });

  choose(t, KIM, 'checkFold');
  assert.deepEqual(chosen(t, KIM), ['checkFold']);
  assert.deepEqual(inHand(t, KIM).pre, ['checkFold']);
  assertInvariants(t.state, t.now);

  const [mark, turn] = [lines(t), t.state.turn];
  t.wait(5000);
  t.check(STU);

  assert.deepEqual(since(t, mark), ['Stu checks', 'Kim checks']);
  assert.deepEqual(t.state.hand!.events.slice(-2), [['check', STU], ['check', KIM]]);
  assert.equal(inHand(t, KIM).lastAction, 'check');

  // Kim's decision has its number like any other, so the count tells nobody she chose ahead; the clock is Ann's from now
  assert.equal(t.toAct, ANN);
  assert.equal(t.state.turn, turn + 2);
  assert.equal(t.state.hand!.deadline, t.now + CLOCK_MS);
  assert.equal(t.state.seats[KIM]!.away, false);

  assert.equal(chosen(t, KIM), null);
  assert.ok(!('pre' in inHand(t, KIM)), 'nothing is kept once the move is made');
  assertInvariants(t.state, t.now);
});

test('check/fold stays through a bet and a raise, and then folds', () => {
  const t = onTheFlop();
  choose(t, ANN, 'checkFold');

  const mark = lines(t);
  t.raise(STU, 40);
  assert.deepEqual(chosen(t, ANN), ['checkFold']);
  assert.deepEqual(ahead(t, ANN), { canCheck: false, callAmount: 40, callCost: 40 });
  assertInvariants(t.state, t.now);

  t.raise(KIM, 120);
  assert.deepEqual(since(t, mark), ['Stu bets 40', 'Kim raises to 120', 'Ann folds']);
  assert.equal(t.toAct, PAM);
  assert.equal(t.stacks()[ANN], 980);
});

test('check checks and never puts in a chip: a bet takes it off, and the player is asked as if they had chosen nothing', () => {
  const free = onTheFlop();
  choose(free, KIM, 'check');
  choose(free, ANN, 'check');

  const mark = lines(free);
  free.check(STU);
  assert.deepEqual(since(free, mark), ['Stu checks', 'Kim checks', 'Ann checks']);
  assert.equal(free.toAct, PAM);
  assert.deepEqual(free.stacks(), [980, 980, 980, 980]);

  const bet = onTheFlop();
  choose(bet, ANN, 'check');
  bet.raise(STU, 40);
  assert.equal(chosen(bet, ANN), null);
  assert.ok(!('pre' in inHand(bet, ANN)));
  assertInvariants(bet.state, bet.now);

  const before = lines(bet);
  bet.call(KIM);
  assert.deepEqual(since(bet, before), ['Kim calls 40']);
  assert.equal(bet.toAct, ANN);
  assert.equal(bet.view(ANN).hand!.options!.callAmount, 40);
  assert.equal(bet.stacks()[ANN], 980);
});

test('a call is for the bet it was chosen against: it calls exactly that, and a raise takes it off', () => {
  const t = onTheFlop();
  t.raise(STU, 40);
  assert.deepEqual(ahead(t, ANN), { canCheck: false, callAmount: 40, callCost: 40 });

  choose(t, ANN, 'call');
  choose(t, PAM, 'call');
  assert.deepEqual([chosen(t, ANN), chosen(t, PAM)], [['call', 40], ['call', 40]]);
  assertInvariants(t.state, t.now);

  const mark = lines(t);
  t.call(KIM);
  assert.deepEqual(since(t, mark), ['Kim calls 40', 'Ann calls 40', 'Pam calls 40', 'Turn: 2♣ 7♦ 9♥ J♣']);
  assert.deepEqual(t.stacks(), [940, 940, 940, 940]);

  const raised = onTheFlop();
  raised.raise(STU, 40);
  choose(raised, ANN, 'call');
  choose(raised, PAM, 'call');

  const before = lines(raised);
  raised.raise(KIM, 120);
  assert.deepEqual(since(raised, before), ['Kim raises to 120']);
  assert.deepEqual([chosen(raised, ANN), chosen(raised, PAM)], [null, null]);
  assert.equal(raised.toAct, ANN);
  assert.equal(raised.view(ANN).hand!.options!.callAmount, 120);
  assert.deepEqual(raised.stacks(), [980, 940, 860, 980]);
  assertInvariants(raised.state, raised.now);
});

test('a call chosen against a bet is off when a short stack in front goes all in for a little more, and stands when one calls all in for less', () => {
  // Kim has 50 behind on the flop, which is less than a full raise over 40
  const more = onTheFlop([1000, 1000, 70, 1000]);
  more.raise(STU, 40);
  choose(more, ANN, 'call');

  const mark = lines(more);
  more.raise(KIM, 50);
  assert.deepEqual(since(more, mark), ['Kim raises to 50 and is all in']);
  assert.equal(chosen(more, ANN), null);
  assert.equal(more.toAct, ANN);
  assert.equal(more.view(ANN).hand!.options!.callAmount, 50);
  assert.equal(more.stacks()[ANN], 980);

  // And here 25, which changes nothing of what the bet is to Ann
  const less = onTheFlop([1000, 1000, 45, 1000]);
  less.raise(STU, 40);
  choose(less, ANN, 'call');

  const before = lines(less);
  less.call(KIM);
  assert.deepEqual(since(less, before), ['Kim calls 25 and is all in', 'Ann calls 40']);
  assert.equal(less.toAct, PAM);
});

test('a player with less than the bet chooses the call they can make, which puts them all in', () => {
  const t = onTheFlop([1000, 1000, 1000, 45]);
  t.raise(STU, 40);
  assert.deepEqual(ahead(t, ANN), { canCheck: false, callAmount: 25, callCost: 25 });

  choose(t, ANN, 'call');
  assert.deepEqual(chosen(t, ANN), ['call', 25]);

  const mark = lines(t);
  t.call(KIM);
  assert.deepEqual(since(t, mark), ['Kim calls 40', 'Ann calls 25 and is all in']);
  assert.equal(t.stacks()[ANN], 0);
  assertInvariants(t.state, t.now);
});

test('call any checks when nothing is bet, calls a bet, and stays through a raise to call that', () => {
  const free = onTheFlop();
  choose(free, KIM, 'callAny');
  assert.deepEqual(chosen(free, KIM), ['callAny']);

  const mark = lines(free);
  free.check(STU);
  assert.deepEqual(since(free, mark), ['Stu checks', 'Kim checks']);

  const raised = onTheFlop();
  choose(raised, ANN, 'callAny');
  raised.raise(STU, 40);
  assert.deepEqual(chosen(raised, ANN), ['callAny']);

  const before = lines(raised);
  raised.raise(KIM, 120);
  assert.deepEqual(since(raised, before), ['Kim raises to 120', 'Ann calls 120']);
  assert.equal(raised.stacks()[ANN], 860);
  assert.equal(raised.toAct, PAM);
});

test('call any into an all-in calls with everything the player has when that is less', () => {
  const t = onTheFlop([1000, 1000, 1000, 300]);
  choose(t, ANN, 'callAny');
  choose(t, KIM, 'fold');

  const mark = lines(t);
  t.raise(STU, 980);
  assert.deepEqual(since(t, mark), ['Stu bets 980 and is all in', 'Kim folds', 'Ann calls 280 and is all in']);
  assert.equal(t.toAct, PAM);
  assert.equal(t.stacks()[ANN], 0);
  assertInvariants(t.state, t.now);
});

test('fold folds even when a check would be free, which check/fold never does', () => {
  const t = onTheFlop();
  choose(t, KIM, 'fold');
  choose(t, ANN, 'checkFold');

  const mark = lines(t);
  t.check(STU);
  assert.deepEqual(since(t, mark), ['Stu checks', 'Kim folds', 'Ann checks']);
  assert.equal(inHand(t, KIM).folded, true);

  const raised = onTheFlop();
  choose(raised, ANN, 'fold');
  raised.raise(STU, 40);
  assert.deepEqual(chosen(raised, ANN), ['fold']);

  const before = lines(raised);
  raised.raise(KIM, 120);
  assert.deepEqual(since(raised, before), ['Kim raises to 120', 'Ann folds']);
});

test('three in a row take the hand to the next street in the one move that reached them, and nothing chosen on a street is there on the next', () => {
  const t = onTheFlop(undefined, { actionSeconds: 30 });
  choose(t, KIM, 'check');
  choose(t, ANN, 'callAny');
  choose(t, PAM, 'checkFold');

  const [mark, turn] = [lines(t), t.state.turn];
  t.check(STU);

  assert.deepEqual(since(t, mark), ['Stu checks', 'Kim checks', 'Ann checks', 'Pam checks', 'Turn: 2♣ 7♦ 9♥ J♣']);
  assert.equal(t.state.hand!.street, 'turn');
  assert.equal(t.toAct, STU);
  assert.equal(t.state.turn, turn + 4);
  assert.deepEqual([KIM, ANN, PAM].map((player) => chosen(t, player)), [null, null, null]);
  assert.ok(t.state.hand!.players.every((player) => !('pre' in player)));

  // On the turn each of them is asked again
  t.check(STU);
  assert.equal(t.toAct, KIM);
  assertInvariants(t.state, t.now);
});

test('three in a row end the hand: the last player wins without their own choice ever being needed, and it is dropped', () => {
  const t = dealt();
  choose(t, PAM, 'fold');
  choose(t, STU, 'fold');
  choose(t, KIM, 'check');

  const mark = lines(t);
  t.fold(ANN);

  assert.deepEqual(since(t, mark), ['Ann folds', 'Pam folds', 'Stu folds', 'Uncalled bet of 10 returned to Kim', 'Kim wins 20']);
  assert.equal(t.state.hand!.stage, 'done');
  assert.equal(chosen(t, KIM), null);
  assert.ok(t.state.hand!.players.every((player) => !('pre' in player)));

  // The record is the one the same hand makes with every fold tapped
  const tapped = dealt();
  [ANN, PAM, STU].forEach((player) => tapped.fold(player));
  t.finishHand();
  tapped.finishHand();
  assert.equal(handRecords(t.effects).length, 1);
  assert.deepEqual(handRecords(t.effects), handRecords(tapped.effects));
  assertInvariants(t.state, t.now);
});

test('a hand with moves chosen ahead on every street is the hand those moves make tapped: the same record, the same replay at every step, the same facts for the night', () => {
  const made = dealt();
  choose(made, PAM, 'call');
  choose(made, STU, 'callAny');
  choose(made, KIM, 'check');
  made.call(ANN);

  // A bet takes nothing off these three: Kim folds to it, Ann folds whatever comes, Pam calls it
  choose(made, KIM, 'checkFold');
  choose(made, ANN, 'fold');
  choose(made, PAM, 'callAny');
  made.raise(STU, 40);

  choose(made, PAM, 'check');
  made.check(STU);
  choose(made, PAM, 'checkFold');
  made.check(STU);

  const tapped = dealt();
  [ANN, PAM, STU].forEach((player) => tapped.call(player));
  tapped.check(KIM);
  tapped.raise(STU, 40);
  [KIM, ANN].forEach((player) => tapped.fold(player));
  tapped.call(PAM);
  [STU, PAM, STU, PAM].forEach((player) => tapped.check(player));

  assert.equal(made.state.hand!.stage, 'done');
  made.finishHand();
  tapped.finishHand();

  const [record, same] = [handRecords(made.effects).at(-1)!, handRecords(tapped.effects).at(-1)!];
  assert.equal(record.events.filter(([kind]) => ['fold', 'check', 'call'].includes(kind)).length, 11);
  assert.deepEqual(record, same);
  assert.deepEqual(handFacts(record), handFacts(same));

  for (let count = 0; count <= record.events.length; count++) {
    assert.deepEqual(replayHand(record.events, count), replayHand(same.events, count), `the replay after ${count} events`);
  }

  assertInvariants(made.state, made.now);
});

test('a hand played back shows nothing of the move its viewer has chosen ahead in the hand on the table', () => {
  const t = dealt();
  [ANN, PAM, STU].forEach((player) => t.fold(player));
  t.finishHand();

  const record = handRecords(t.effects).at(-1)!;
  t.deal({ button: PAM, holes: HOLES, board: BOARD });
  choose(t, KIM, 'check');

  const live = t.view(KIM);
  assert.deepEqual([live.preAction, live.hand!.ahead], [['check'], { canCheck: true, callAmount: 0, callCost: 0 }]);

  for (const step of replaySteps(record, t.state.config)!) {
    const back = replayView(record, step, live);

    assert.deepEqual([back.preAction, back.hand!.ahead], [null, null]);
  }
});

test('the big blind before the flop: a check chosen ahead is made when everyone only calls, and a raise takes it off', () => {
  const t = dealt();
  assert.deepEqual(ahead(t, KIM), { canCheck: true, callAmount: 0, callCost: 0 });
  assert.deepEqual(ahead(t, STU), { canCheck: false, callAmount: 10, callCost: 10 });
  assert.throws(() => choose(t, KIM, 'call'), /nothing to call/);

  choose(t, KIM, 'check');
  choose(t, STU, 'call');
  assert.deepEqual(chosen(t, STU), ['call', 10]);

  t.call(ANN);
  const mark = lines(t);
  t.call(PAM);
  assert.deepEqual(since(t, mark), ['Pam calls 20', 'Stu calls 10', 'Kim checks', 'Flop: 2♣ 7♦ 9♥']);

  const raised = dealt();
  choose(raised, KIM, 'check');
  raised.raise(ANN, 60);
  assert.equal(chosen(raised, KIM), null);
  raised.fold(PAM);
  raised.fold(STU);
  assert.equal(raised.toAct, KIM);
  assert.equal(raised.view(KIM).hand!.options!.callAmount, 40);
});

test('the big blind before the flop with check/fold: it checks behind callers, and folds to a raise', () => {
  const t = dealt();
  choose(t, KIM, 'checkFold');
  t.raise(ANN, 60);
  t.fold(PAM);

  const mark = lines(t);
  t.fold(STU);
  assert.deepEqual(since(t, mark), ['Stu folds', 'Kim folds', 'Uncalled bet of 40 returned to Ann', 'Ann wins 50']);
  assert.equal(t.stacks()[KIM], 980);
});

test('with a straddle on, the blinds call what the straddle makes it and the straddler checks their option, all chosen ahead', () => {
  const t = table(undefined, { allowStraddle: true });
  t.cmd(ANN, { type: 'setStraddle', kind: 'straddle', on: true });
  t.deal({ button: PAM, holes: HOLES, board: BOARD });
  assert.equal(t.toAct, PAM);
  assert.deepEqual(ahead(t, ANN), { canCheck: true, callAmount: 0, callCost: 0 });

  choose(t, STU, 'call');
  choose(t, KIM, 'call');
  choose(t, ANN, 'check');
  assert.deepEqual([chosen(t, STU), chosen(t, KIM)], [['call', 30], ['call', 20]]);

  const mark = lines(t);
  t.call(PAM);
  assert.deepEqual(since(t, mark), ['Pam calls 40', 'Stu calls 30', 'Kim calls 20', 'Ann checks', 'Flop: 2♣ 7♦ 9♥']);
  assert.deepEqual(t.stacks(), [960, 960, 960, 960]);
  assertInvariants(t.state, t.now);
});

test('with antes in the pot a call chosen ahead is still for the bet alone', () => {
  const t = dealt(undefined, { ante: 5 });
  choose(t, STU, 'call');
  choose(t, KIM, 'check');
  assert.deepEqual(chosen(t, STU), ['call', 10]);

  t.call(ANN);
  const mark = lines(t);
  t.call(PAM);
  assert.deepEqual(since(t, mark).slice(0, 3), ['Pam calls 20', 'Stu calls 10', 'Kim checks']);
  assert.deepEqual(t.stacks(), [975, 975, 975, 975]);
  assertInvariants(t.state, t.now);
});

test('in a bomb pot the choices are made on the flop, where its betting starts', () => {
  const t = table();
  t.cmd(PAM, { type: 'setBombPot', on: true });
  t.deal({ button: PAM, holes: HOLES, board: BOARD });
  assert.equal(t.state.hand!.street, 'flop');
  assert.equal(t.toAct, STU);

  choose(t, KIM, 'checkFold');
  choose(t, ANN, 'callAny');

  const mark = lines(t);
  t.raise(STU, 100);
  assert.deepEqual(since(t, mark), ['Stu bets 100', 'Kim folds', 'Ann calls 100']);
  assert.equal(t.toAct, PAM);
  assertInvariants(t.state, t.now);
});

test('an offer to chop takes off what the big blind chose, nothing can be chosen while it stands, and after a no the big blind may choose again', () => {
  const t = dealt(undefined, { allowChop: true });
  choose(t, KIM, 'check');
  t.fold(ANN);
  t.fold(PAM);
  assert.deepEqual(chosen(t, KIM), ['check']);

  t.cmd(STU, { type: 'offerChop' });
  assert.equal(t.state.hand!.stage, 'chop');
  assert.equal(chosen(t, KIM), null);
  assert.equal(ahead(t, KIM), null);
  assert.throws(() => choose(t, KIM, 'check'), TOO_LATE);
  assertInvariants(t.state, t.now);

  t.cmd(KIM, { type: 'answerChop', agree: false });
  assert.equal(t.toAct, STU);
  choose(t, KIM, 'check');

  const mark = lines(t);
  t.call(STU);
  assert.deepEqual(since(t, mark), ['Stu calls 10', 'Kim checks', 'Flop: 2♣ 7♦ 9♥']);
});

test('a big blind nobody is left to bet against is never asked: what they chose is dropped as the hand goes to its run-it vote, where nothing can be chosen', () => {
  // Three players, so Pam on the button acts first, and has less than the big blind
  const t = new TestTable({ stacks: [15, 1000, 1000], names: NAMES, config: { maxRuns: 2 } });
  holdToWhatWasChosen(t);
  t.deal({ button: PAM, holes: { [PAM]: QUEENS, [KIM]: KINGS }, board: BOARD });
  choose(t, KIM, 'check');

  t.call(PAM);
  assert.deepEqual(chosen(t, KIM), ['check']);

  const mark = lines(t);
  t.fold(STU);
  assert.equal(t.state.hand!.stage, 'ritVote');
  assert.ok(!since(t, mark).includes('Kim checks'));
  assert.equal(chosen(t, KIM), null);
  assert.equal(ahead(t, KIM), null);
  assert.throws(() => choose(t, KIM, 'check'), TOO_LATE);
  assertInvariants(t.state, t.now);
});

test('a player sitting out after this hand still plays it, and may choose ahead in it', () => {
  const t = onTheFlop();
  t.cmd(KIM, { type: 'sitOut' });
  choose(t, KIM, 'checkFold');

  const mark = lines(t);
  t.check(STU);
  assert.deepEqual(since(t, mark), ['Stu checks', 'Kim checks']);
});

test('the table plays the turns of a player who ran out of time, so they are offered no choice ahead and one that arrives is refused', () => {
  const t = onTheFlop(undefined, { actionSeconds: 30 });
  t.wait(CLOCK_MS);
  assert.equal(t.state.seats[STU]!.away, true);
  assert.equal(t.toAct, KIM);

  t.raise(KIM, 40);
  assert.equal(ahead(t, STU), null);
  assert.throws(() => choose(t, STU, 'callAny'), TOO_LATE);

  // And a player who chose ahead is never the one the clock runs out on
  choose(t, PAM, 'fold');
  const mark = lines(t);
  t.call(ANN);
  assert.deepEqual(since(t, mark), ['Ann calls 40', 'Pam folds', 'Stu folds', 'Turn: 2♣ 7♦ 9♥ J♣']);
  assert.equal(t.state.seats[PAM]!.away, false);
  assertInvariants(t.state, t.now);
});

test('a player the host moves keeps what they chose, since they play the hand out where they sit', () => {
  const t = onTheFlop();
  choose(t, KIM, 'callAny');
  t.cmd(PAM, { type: 'moveSeat', playerId: t.ids[KIM]!, seat: 7 });
  assert.deepEqual(chosen(t, KIM), ['callAny']);

  const mark = lines(t);
  t.raise(STU, 40);
  assert.deepEqual(since(t, mark), ['Stu bets 40', 'Kim calls 40']);
});

test('a player who is removed, or gets up, loses what they chose: from then on the table checks or folds for them', () => {
  for (const leave of ['kick', 'standUp'] as const) {
    const t = onTheFlop();
    choose(t, KIM, 'callAny');
    t.cmd(leave === 'kick' ? PAM : KIM, leave === 'kick' ? { type: 'kick', playerId: t.ids[KIM]! } : { type: 'standUp' });

    assert.ok(!('pre' in inHand(t, KIM)), leave);
    assert.throws(() => choose(t, KIM, 'callAny'), TOO_LATE, leave);
    assertInvariants(t.state, t.now);

    const mark = lines(t);
    t.raise(STU, 40);
    assert.deepEqual(since(t, mark).slice(0, 2), ['Stu bets 40', 'Kim folds'], leave);
  }
});

test('a choice is offered only to a player the action is still to reach on this street', () => {
  const t = onTheFlop([1000, 1000, 1000, 60]);
  const offered = () => [PAM, STU, KIM, ANN].map((player) => ahead(t, player) !== null);

  // Stu is on the clock, which is a turn and no longer a turn to come
  assert.deepEqual(offered(), [true, false, true, true]);
  assert.equal(t.view(STU).hand!.options !== null, true);

  t.raise(STU, 40);
  t.call(KIM);
  // Kim has matched the bet, and owes nothing unless someone raises
  assert.deepEqual(offered(), [true, false, false, false]);
  assert.throws(() => choose(t, KIM, 'fold'), TOO_LATE);

  t.call(ANN);
  assert.equal(inHand(t, ANN).allIn, true);
  t.fold(PAM);
  assert.equal(t.state.hand!.street, 'turn');
  // Ann is all in and Pam has folded: neither has a turn to come in this hand
  assert.deepEqual(offered(), [false, false, true, false]);
  assert.throws(() => choose(t, ANN, 'fold'), TOO_LATE);
  assert.throws(() => choose(t, PAM, 'fold'), TOO_LATE);

  // Someone only watching is offered nothing, and has nothing of anyone's
  const watcher = addMember(t.state, 'Wes', t.ctx());
  choose(t, KIM, 'check');
  const watching = viewFor(t.state, watcher.id, t.now);
  assert.equal(watching.hand!.ahead, null);
  assert.equal(watching.preAction, null);
  assert.throws(() => t.cmd(t.ids.push(watcher.id) - 1, { type: 'preAct', what: 'fold', hand: 1, street: 'turn', facing: 0 }));
});

test('what a player chose is theirs alone to see: every other view is the view of a table where they chose nothing', () => {
  const t = onTheFlop();
  choose(t, KIM, 'checkFold');
  choose(t, ANN, 'fold');

  assert.deepEqual([PAM, STU, KIM, ANN].map((player) => chosen(t, player)), [null, null, ['checkFold'], ['fold']]);
  assert.ok(!JSON.stringify(t.view(STU)).includes('checkFold'));
  assert.ok(!JSON.stringify(t.view(KIM)).includes('"fold"'), "Kim's view holds Ann's choice");
  // Held in full by the leak check, which compares each view with the one of a table where nobody else chose
  assertInvariants(t.state, t.now);
});

test('a choice is set only in the spot it was made in: one made for another hand, another street or another bet, or arriving on the player\'s own turn, is refused', () => {
  const t = onTheFlop();

  assert.throws(() => choose(t, KIM, 'checkFold', { hand: 2 }), TOO_LATE);
  assert.throws(() => choose(t, KIM, 'checkFold', { street: 'preflop' }), TOO_LATE);
  assert.throws(() => choose(t, KIM, 'checkFold', { facing: 20 }), TOO_LATE);
  assert.throws(() => choose(t, STU, 'checkFold'), TOO_LATE);
  assert.deepEqual([chosen(t, KIM), chosen(t, STU)], [null, null]);

  // The bet changed while it was on its way: Kim was looking at a free check, whatever she chose
  t.raise(STU, 40);
  for (const what of ['fold', 'callAny', 'checkFold', 'check', 'call'] as const) {
    assert.throws(() => choose(t, ANN, what, { facing: 0 }), TOO_LATE, what);
  }
  assert.equal(chosen(t, ANN), null);

  // Chosen for what is there, it is set
  assert.throws(() => choose(t, ANN, 'check'), /You can't check, there is a bet of 40 to you/);
  choose(t, ANN, 'call');
  assert.deepEqual(chosen(t, ANN), ['call', 40]);
});

test('a request that is no choice at all is refused', () => {
  const t = onTheFlop();
  const bad = (command: object) => assert.throws(() => t.cmd(KIM, { type: 'preAct', what: 'fold', hand: 1, street: 'flop', facing: 0, ...command } as never), { name: 'GameError' });

  bad({ what: 'raise' });
  bad({ what: undefined });
  bad({ street: 'showdown' });
  bad({ hand: '1' });
  bad({ facing: -1 });
  bad({ facing: 0.5 });
  assert.equal(chosen(t, KIM), null);
});

test('choosing again replaces the choice, choosing the same twice changes nothing, and one that arrives again after it was played does not play twice', () => {
  const t = onTheFlop();
  choose(t, KIM, 'fold');
  choose(t, KIM, 'callAny');
  assert.deepEqual(chosen(t, KIM), ['callAny']);

  const once = JSON.stringify(t.state);
  choose(t, KIM, 'callAny');
  assert.equal(JSON.stringify(t.state), once);

  t.raise(STU, 40);
  assert.equal(t.toAct, ANN);
  assert.equal(t.stacks()[KIM], 940);

  // The same request once more, late: Kim has made her move, and has no turn to come
  assert.throws(() => choose(t, KIM, 'callAny', { facing: 0 }), TOO_LATE);
  assert.throws(() => choose(t, KIM, 'callAny'), TOO_LATE);
  assert.equal(t.stacks()[KIM], 940);
});

test('taking a choice back leaves the player to be asked, and one that arrives after the move was made is answered with the table as it is', () => {
  const t = onTheFlop();
  choose(t, KIM, 'fold');
  choose(t, KIM, null);
  assert.equal(chosen(t, KIM), null);
  assert.ok(!('pre' in inHand(t, KIM)));

  // With nothing chosen it is no refusal either
  choose(t, KIM, null);

  t.check(STU);
  assert.equal(t.toAct, KIM);

  const late = onTheFlop();
  choose(late, KIM, 'fold');
  late.check(STU);
  assert.equal(inHand(late, KIM).folded, true);

  const after = JSON.stringify(late.state);
  choose(late, KIM, null, { facing: 0 });
  assert.equal(JSON.stringify(late.state), after);
});

test('a new choice that arrives after the bet changed takes the old one off and sets nothing: the player is asked, never left with the choice they were replacing', () => {
  const t = onTheFlop();
  choose(t, ANN, 'fold');
  t.raise(STU, 40);
  assert.deepEqual(chosen(t, ANN), ['fold']);

  // Ann tapped Call any while she was looking at a free check, and it arrives after Stu's bet
  choose(t, ANN, 'callAny', { facing: 0 });
  assert.equal(chosen(t, ANN), null);

  const mark = lines(t);
  t.call(KIM);
  assert.deepEqual(since(t, mark), ['Kim calls 40']);
  assert.equal(t.toAct, ANN);

  // So does taking one back that arrives after the bet changed
  const taken = onTheFlop();
  choose(taken, ANN, 'callAny');
  taken.raise(STU, 40);
  choose(taken, ANN, null, { facing: 0 });
  assert.equal(chosen(taken, ANN), null);
});

test('a request for a street that is over touches nothing chosen on this one', () => {
  const t = onTheFlop();
  choose(t, KIM, 'checkFold');

  choose(t, KIM, null, { street: 'preflop' });
  assert.throws(() => choose(t, KIM, 'fold', { street: 'preflop', facing: 20 }), TOO_LATE);
  choose(t, KIM, null, { hand: 2 });
  assert.deepEqual(chosen(t, KIM), ['checkFold']);
});

test('a table saved with moves chosen ahead loads with them, and plays them', () => {
  const t = onTheFlop();
  t.raise(STU, 40);
  choose(t, ANN, 'call');
  choose(t, PAM, 'callAny');

  const loaded = TestTable.adopt(restoreState(JSON.stringify(t.state)));
  const as = (player: number) => loaded.ids.indexOf(t.ids[player]!);
  loaded.now = t.now;
  assert.deepEqual(loaded.state, t.state);
  assert.deepEqual([ANN, PAM].map((player) => loaded.view(as(player)).preAction), [['call', 40], ['callAny']]);

  const mark = loaded.state.hand!.log.length;
  loaded.call(as(KIM));
  assert.deepEqual(loaded.state.hand!.log.slice(mark), ['Kim calls 40', 'Ann calls 40', 'Pam calls 40', 'Turn: 2♣ 7♦ 9♥ J♣']);
  assertInvariants(loaded.state, loaded.now);
});
