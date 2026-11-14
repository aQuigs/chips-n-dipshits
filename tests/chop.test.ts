/*
 * Chopping the blinds: when a hand can be chopped, the offer and the answer, what a chop leaves behind,
 * and every way the big blind can be kept from answering. Hands are really dealt and played.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blindsOnly, mayOfferChop, replayHand, SEAT_COUNT, STRADDLES, TIMING } from '../src/engine/index.ts';
import type { HandEvent, Rng, TableConfig, TableState } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { handRecords, seededRng, TestTable } from './helpers.ts';
import { assertChipsConserved, assertHandRecordsHold, chopAnswers, assertInvariants } from './invariants.ts';
import { chance, pick } from './randomPlay.ts';

// Four players with the button on seat 0: the small blind on seat 1, the big blind on seat 2, seat 3 first to act
const SB = 1;
const BB = 2;
const CLOCK_MS = 30_000 + TIMING.actionGraceMs;
const CHOPS = { allowChop: true };

/** A hand at four players with the button on seat 0, folded round to the small blind. */
function foldedToTheBlinds(config: Partial<TableConfig> = {}, stacks = [1000, 1000, 1000, 1000]): TestTable {
  const t = new TestTable({ stacks, config: { actionSeconds: 30, ...CHOPS, ...config } });

  t.deal({ button: 0 });
  t.fold(3);
  t.fold(0);

  return t;
}

/** The small blind offers, and the big blind is on the clock to answer. */
function offered(config: Partial<TableConfig> = {}, stacks?: number[]): TestTable {
  const t = foldedToTheBlinds(config, stacks);

  t.cmd(SB, { type: 'offerChop' });
  assert.equal(t.state.hand!.stage, 'chop');

  return t;
}

const kinds = (t: TestTable) => t.state.hand!.events.map((event) => event[0]);
const lastLines = (t: TestTable, count: number) => t.feedText().slice(-count);

/** No seat may offer to chop now, whoever is on the clock. */
function nobodyMayOffer(t: TestTable): void {
  for (let seat = 0; seat < SEAT_COUNT; seat++) {
    assert.equal(mayOfferChop(t.state, seat), false, `seat ${seat} may offer to chop`);
  }
}

test('folded round to the small blind at four players, only the small blind may offer, and the pot is just the blinds', () => {
  const t = foldedToTheBlinds();

  assert.equal(t.toAct, SB);
  assert.ok(blindsOnly(t.state.hand!));
  assert.deepEqual([0, 1, 2, 3].map((seat) => t.view(seat).hand!.canOfferChop), [false, true, false, false]);
  assert.deepEqual([0, 1, 2, 3].map((seat) => mayOfferChop(t.state, seat)), [false, true, false, false]);
});

test('three-handed, the button folding leaves the blinds to chop; heads-up they never can', () => {
  const three = new TestTable({ stacks: [1000, 1000, 1000], config: CHOPS });
  three.deal({ button: 0 });
  three.fold(0);
  assert.equal(three.toAct, SB);
  assert.equal(three.view(SB).hand!.canOfferChop, true);

  // Heads-up the small blind has the button and acts first, with nobody to fold to them
  const two = new TestTable({ stacks: [1000, 1000], config: CHOPS });
  two.deal({ button: 0 });
  assert.equal(two.toAct, 0);
  assert.equal(two.state.hand!.sbSeat, 0);
  assert.equal(blindsOnly(two.state.hand!), false);
  assert.equal(two.view(0).hand!.canOfferChop, false);
});

test('an ante of either kind is more than the blinds, so neither stops at a chop', () => {
  for (const anteFrom of ['everyone', 'bigBlind'] as const) {
    const t = foldedToTheBlinds({ ante: 5, anteFrom });

    assert.equal(t.toAct, SB, anteFrom);
    assert.equal(blindsOnly(t.state.hand!), false, anteFrom);
    assert.equal(t.view(SB).hand!.canOfferChop, false, anteFrom);
    assert.throws(() => t.cmd(SB, { type: 'offerChop' }), { message: 'Only the small blind can offer to chop, when everyone else has folded and the pot is just the blinds' });
  }
});

test('with a straddle of any kind in the pot there is no chop, whoever folds', () => {
  // Six players with the button on seat 0: the blinds on 1 and 2, under the gun 3, the cutoff 5. Each folds round to the small blind where it can
  const cases: { kind: string; want: Record<number, (typeof STRADDLES)[number]['what'][]>; folds: number[] }[] = [
    { kind: 'under the gun', want: { 3: ['straddle'] }, folds: [4, 5, 0] },
    { kind: 'double', want: { 3: ['straddle'], 4: ['double straddle'] }, folds: [5, 0] },
    { kind: 'button', want: { 0: ['button straddle'] }, folds: [] },
    { kind: 'Mississippi', want: { 5: ['Mississippi straddle'] }, folds: [0] },
  ];

  for (const { kind, want, folds } of cases) {
    const allowAll = Object.fromEntries(STRADDLES.map((entry) => [entry.setting, true]));
    const t = new TestTable({ stacks: [1000, 1000, 1000, 1000, 1000, 1000], config: { ...CHOPS, ...allowAll } });

    for (const [seat, chosen] of Object.entries(want)) {
      for (const what of chosen) {
        t.cmd(Number(seat), { type: 'setStraddle', kind: what, on: true });
      }
    }

    t.deal({ button: 0 });
    assert.ok(t.state.hand!.straddles.length > 0, `${kind}: no straddle was posted`);

    for (const seat of folds) {
      t.fold(seat);
    }

    assert.equal(t.toAct, SB, kind);
    assert.equal(blindsOnly(t.state.hand!), false, kind);
    assert.equal(t.view(SB).hand!.canOfferChop, false, kind);
  }
});

/** Six players: a first hand with the button on seat 0, then seat 5 owes what `owing` says and posts it in the next. */
function postingOwed(owing: { owesBigBlind: boolean; owesSmallBlind: boolean }): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000, 1000, 1000], config: CHOPS });

  t.deal({ button: 0 });
  t.foldOut();
  Object.assign(t.state.seats[5]!, owing, { postsOwed: true });

  // The button on seat 1, the blinds on 2 and 3, and seat 5 posting what it owes
  t.deal();
  assert.deepEqual([t.state.hand!.sbSeat, t.state.hand!.bbSeat], [2, 3]);

  return t;
}

test('a missed big blind posted live, or a small blind posted dead, stays in the pot when its player folds, so there is no chop', () => {
  for (const owing of [
    { owesBigBlind: true, owesSmallBlind: false, what: 'missed big blind' },
    { owesBigBlind: false, owesSmallBlind: true, what: 'dead small blind' },
  ]) {
    const t = postingOwed(owing);
    assert.ok(t.state.hand!.events.some((event) => event[0] === 'post' && event[2] === owing.what), `no ${owing.what} was posted`);

    t.fold(4);
    t.fold(5);
    t.fold(0);
    t.fold(1);

    assert.equal(t.toAct, 2, owing.what);
    assert.equal(blindsOnly(t.state.hand!), false, owing.what);
    assert.equal(t.view(2).hand!.canOfferChop, false, owing.what);
  }
});

test('a bomb pot has no blinds to chop', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: CHOPS });

  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0 });

  assert.ok(t.state.hand!.bombPot);
  assert.equal(blindsOnly(t.state.hand!), false);
  nobodyMayOffer(t);
});

test('a hand with no small blind has nobody to offer; a dead button with a small blind chops like any other', () => {
  // The big blind of the first hand leaves, so the next has no small blind: the button on seat 1, the big blind on seat 3
  const none = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: CHOPS });
  none.deal({ button: 0 });
  none.foldOut();
  none.cmd(2, { type: 'standUp' });
  none.deal();
  assert.ok(!none.state.hand!.players.some((player) => player.seat === none.state.hand!.sbSeat));
  nobodyMayOffer(none);
  none.fold(0);
  nobodyMayOffer(none);
  none.fold(1);
  assert.deepEqual(none.state.hand!.result!.winnings, [{ seat: 3, amount: 0 }]);

  // At five players the small blind of the first hand leaves, so the next has a dead button on seat 1 and the small blind on seat 2
  const dead = new TestTable({ stacks: [1000, 1000, 1000, 1000, 1000], config: CHOPS });
  dead.deal({ button: 0 });
  dead.foldOut();
  dead.cmd(1, { type: 'standUp' });
  dead.deal();
  assert.equal(dead.state.hand!.button, 1);
  assert.deepEqual([dead.state.hand!.sbSeat, dead.state.hand!.bbSeat], [2, 3]);
  dead.fold(4);
  dead.fold(0);
  assert.equal(dead.view(2).hand!.canOfferChop, true);
});

test('a blind all in for less has not posted in full, so there is no chop; a big blind whose stack was the big blind exactly has', () => {
  const short = foldedToTheBlinds({}, [1000, 1000, 15, 1000]);
  assert.equal(short.state.hand!.players[BB]!.allIn, true);
  assert.equal(blindsOnly(short.state.hand!), false);
  assert.equal(short.view(SB).hand!.canOfferChop, false);

  const exact = offered({}, [1000, 1000, 20, 1000]);
  exact.cmd(BB, { type: 'answerChop', agree: true });
  assert.deepEqual(exact.stacks(), [1000, 1000, 20, 1000]);
  assert.equal(exact.state.hand!.players[BB]!.allIn, false);

  // A small blind all in for less is never on the clock, so has nothing to offer with
  const smallShort = new TestTable({ stacks: [1000, 5, 1000, 1000], config: CHOPS });
  smallShort.deal({ button: 0 });
  smallShort.fold(3);
  smallShort.fold(0);
  assert.equal(smallShort.state.hand!.stage, 'runout');
});

test('a limper who folds leaves their chips in the pot, which is then more than the blinds, so it does not chop', () => {
  // Before the small blind acts a limper is never asked again, so this is the hand as it would be had they folded
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: CHOPS });
  t.deal({ button: 0 });
  t.call(3);
  t.fold(0);
  t.state.hand!.players[3]!.folded = true;

  assert.equal(t.toAct, SB);
  assert.equal(blindsOnly(t.state.hand!), false);
  assert.equal(mayOfferChop(t.state, SB), false);
});

test('once the flop is out there is no chop', () => {
  const t = foldedToTheBlinds();

  t.call(SB);
  t.check(BB);

  assert.equal(t.state.hand!.street, 'flop');
  assert.equal(t.toAct, SB);
  assert.equal(blindsOnly(t.state.hand!), false);
  assert.equal(t.view(SB).hand!.canOfferChop, false);
});

test('offered and agreed: each takes back their blind, nobody wins, and nothing is shown', () => {
  const t = offered();
  const before = t.state.turn;

  assert.equal(t.toAct, BB);
  assert.equal(t.state.hand!.deadline, t.now + CLOCK_MS);
  assert.deepEqual([0, 1, 2, 3].map((seat) => t.view(seat).hand!.canAnswerChop), [false, false, true, false]);
  assert.equal(t.view(BB).hand!.options, null);
  assert.equal(t.view(SB).hand!.canOfferChop, false);

  t.cmd(BB, { type: 'answerChop', agree: true, turn: before });

  const hand = t.state.hand!;
  assert.equal(hand.stage, 'done');
  assert.deepEqual(hand.result, { uncontested: true, chopped: true, pots: [], winnings: [], hands: [], bounty: null });
  assert.deepEqual(t.stacks(), [1000, 1000, 1000, 1000]);
  assert.ok(hand.players.every((player) => player.bet === 0 && player.committed === 0 && !player.shown));
  assert.deepEqual(hand.boards, [[]]);
  assert.deepEqual(kinds(t).slice(-3), ['chopOffer', 'chopAnswer', 'chop']);
  assert.deepEqual(hand.events.at(-1), ['chop', [[SB, 10], [BB, 20]]]);
  assert.deepEqual(lastLines(t, 3), ['P1 offers to chop the blinds', 'P2 agrees to chop', 'P1 and P2 chop the blinds: each takes back their own']);
  assert.equal(hand.deadline, t.now + TIMING.uncontestedPauseMs);

  t.finishHand();
  const [record] = handRecords(t.effects);
  assert.equal(record!.result.chopped, true);
  assert.ok(record!.players.every((player) => player.endStack === player.startStack && player.cards === null));
  assertHandRecordsHold(t.effects);
});

test('offered and turned down: the small blind is back on a fresh clock with the usual choices, and cannot offer again', () => {
  const t = offered();
  const asked = t.state.turn;

  t.wait(10_000);
  t.cmd(BB, { type: 'answerChop', agree: false });

  const hand = t.state.hand!;
  assert.equal(hand.stage, 'betting');
  assert.equal(t.toAct, SB);
  assert.equal(t.state.turn, asked + 1);
  assert.equal(hand.deadline, t.now + CLOCK_MS);
  assert.deepEqual(t.view(SB).hand!.options, { canCheck: false, callAmount: 10, callCost: 10, canRaise: true, minRaiseTo: 40, maxRaiseTo: 1000 });
  assert.equal(t.view(SB).hand!.canOfferChop, false);
  assert.deepEqual(lastLines(t, 2), ['P1 offers to chop the blinds', 'P2 says no to the chop']);
  assert.throws(() => t.cmd(SB, { type: 'offerChop' }), { message: 'You already offered to chop in this hand' });

  // The hand goes on as any other, and the big blind still has their option
  t.call(SB);
  assert.equal(t.toAct, BB);
  assert.equal(t.view(BB).hand!.options!.canCheck, true);
  t.check(BB);
  assert.equal(t.state.hand!.street, 'flop');
});

test('the big blind running out of time is a no: they sit out, and the small blind is back on the clock', () => {
  const t = offered();

  t.wait(CLOCK_MS);

  assert.equal(t.state.hand!.stage, 'betting');
  assert.equal(t.toAct, SB);
  assert.equal(t.state.hand!.deadline, t.now + CLOCK_MS);
  assert.ok(t.state.seats[BB]!.away && t.state.seats[BB]!.sittingOut);
  assert.deepEqual(kinds(t).slice(-3), ['chopOffer', 'timeout', 'chopAnswer']);
  assert.deepEqual(t.state.hand!.events.at(-1), ['chopAnswer', BB, false]);
  assert.deepEqual(lastLines(t, 2), ['P2 ran out of time', 'P2 did not answer, so there is no chop']);

  // Away, the big blind's option is a check made for them
  t.call(SB);
  assert.equal(t.state.hand!.street, 'flop');
});

test('a big blind who switches Always chop on while asked takes the chop when the clock runs out, as when they leave', () => {
  const t = offered();
  t.cmd(BB, { type: 'setAlwaysChop', on: true });

  t.wait(CLOCK_MS);

  assert.equal(t.state.hand!.result!.chopped, true);
  assert.deepEqual(lastLines(t, 3), ['P2 ran out of time', 'P2 agrees to chop', 'P1 and P2 chop the blinds: each takes back their own']);
});

test('a clock switched on or changed while the big blind answers is theirs, counted from the change', () => {
  const t = offered({ actionSeconds: 0 });
  assert.equal(t.state.hand!.deadline, null);

  t.wait(5_000);
  t.cmd(0, { type: 'updateConfig', config: { actionSeconds: 20 } });

  assert.equal(t.state.hand!.deadline, t.now + 20_000 + TIMING.actionGraceMs);
});

test('nobody but the small blind on the clock offers, and nobody but the big blind asked answers', () => {
  const t = foldedToTheBlinds();

  assert.throws(() => t.cmd(BB, { type: 'offerChop' }), { message: "It's not your turn" });
  assert.throws(() => t.cmd(3, { type: 'offerChop' }), { message: "It's not your turn" });
  assert.throws(() => t.cmd(BB, { type: 'answerChop', agree: true }), { message: 'There is no chop for you to answer' });

  t.cmd(SB, { type: 'offerChop' });

  for (const seat of [0, SB, 3]) {
    assert.throws(() => t.cmd(seat, { type: 'answerChop', agree: true }), { message: 'There is no chop for you to answer' }, `seat ${seat}`);
  }

  // While the big blind answers nobody moves, the two blinds included, and the offer is not made again
  for (const seat of [SB, BB]) {
    assert.throws(() => t.fold(seat), { message: "It's not your turn" });
    assert.throws(() => t.cmd(seat, { type: 'offerChop' }), { message: "It's not your turn" });
  }

  assert.throws(() => t.cmd(BB, { type: 'answerChop', agree: 'yes' as unknown as boolean }), { name: 'GameError' });
  assert.equal(t.state.hand!.stage, 'chop');
});

test('an offer or an answer meant for an earlier decision is not played', () => {
  const t = foldedToTheBlinds();
  const turn = t.state.turn;

  assert.throws(() => t.cmd(SB, { type: 'offerChop', turn: turn - 1 }), { message: 'The hand moved on before that arrived, so it was not played' });
  t.cmd(SB, { type: 'offerChop', turn });

  // The offer sent twice, as a page that heard nothing back might: the second is for a decision that has passed
  assert.throws(() => t.cmd(SB, { type: 'offerChop', turn }), { message: "It's not your turn" });
  assert.throws(() => t.cmd(BB, { type: 'answerChop', agree: true, turn }), { message: 'The hand moved on before that arrived, so it was not played' });

  t.cmd(BB, { type: 'answerChop', agree: false, turn: turn + 1 });
  assert.throws(() => t.cmd(BB, { type: 'answerChop', agree: true, turn: turn + 1 }), { message: 'There is no chop for you to answer' });
});

test('a big blind who sits out while answering is still asked; one who leaves or is removed has said no', () => {
  const sitting = offered();
  sitting.cmd(BB, { type: 'sitOut' });
  assert.equal(sitting.state.hand!.stage, 'chop');
  sitting.cmd(BB, { type: 'answerChop', agree: true });
  assert.equal(sitting.state.hand!.result!.chopped, true);

  const leaving = offered();
  leaving.cmd(BB, { type: 'standUp' });
  assert.equal(leaving.state.hand!.stage, 'betting');
  assert.equal(leaving.toAct, SB);
  assert.deepEqual(leaving.state.hand!.events.at(-1), ['chopAnswer', BB, false]);
  assert.deepEqual(lastLines(leaving, 1), ['P2 did not answer, so there is no chop']);

  // Removed by the host, the same as leaving: the small blind takes the pot by folding, or plays a big blind who checks to the end
  const removed = offered();
  removed.cmd(0, { type: 'kick', playerId: removed.ids[BB]! });
  assert.equal(removed.toAct, SB);
  removed.fold(SB);
  removed.finishHand();
  assert.equal(removed.state.seats[BB], null);
  assertChipsConserved(removed.state);
});

test('a big blind who always chops and leaves or is removed takes the chop', () => {
  const t = foldedToTheBlinds();
  t.cmd(BB, { type: 'setAlwaysChop', on: true });
  t.cmd(SB, { type: 'setAlwaysChop', on: false });
  t.cmd(SB, { type: 'offerChop' });

  // Saying yes to every offer, they were never asked
  assert.equal(t.state.hand!.result!.chopped, true);

  const leaving = offered();
  leaving.cmd(BB, { type: 'setAlwaysChop', on: true });
  leaving.cmd(BB, { type: 'standUp' });
  assert.equal(leaving.state.hand!.result!.chopped, true);
});

test('a small blind who leaves while the offer stands folds once it is turned down', () => {
  const t = offered();

  t.cmd(SB, { type: 'standUp' });
  assert.equal(t.state.hand!.stage, 'chop');

  t.cmd(BB, { type: 'answerChop', agree: false });
  assert.equal(t.state.hand!.stage, 'done');
  assert.deepEqual(t.state.hand!.result!.winnings, [{ seat: BB, amount: 20 }]);
});

test('the host pausing while the offer stands changes nothing in the hand, and the next waits for the game to resume', () => {
  const t = offered();
  t.cmd(0, { type: 'start' });

  t.cmd(0, { type: 'pause' });
  assert.equal(t.state.hand!.stage, 'chop');
  assert.equal(t.toAct, BB);

  t.cmd(BB, { type: 'answerChop', agree: true });
  t.finishHand();
  assert.equal(t.state.hand, null);
  assert.equal(t.state.nextHandAt, null);
});

test('switching chops off refuses an offer, and leaves one already made to be answered', () => {
  const off = foldedToTheBlinds({ allowChop: false });
  assert.equal(off.view(SB).hand!.canOfferChop, false);
  assert.throws(() => off.cmd(SB, { type: 'offerChop' }), { message: "This table doesn't chop the blinds" });

  const t = offered();
  t.cmd(0, { type: 'updateConfig', config: { allowChop: false } });
  assert.deepEqual(lastLines(t, 1), ['The blinds no longer chop']);
  t.cmd(BB, { type: 'answerChop', agree: true });
  assert.equal(t.state.hand!.result!.chopped, true);
});

test('chips go back to the seat that posted them to the cent, and nobody is up or down', () => {
  const stacks = [10_037, 4_999, 12_345, 7_001];
  const t = offered({ unit: 'cents', smallBlind: 25, bigBlind: 50 }, stacks);

  assert.deepEqual(t.stacks(), [10_037, 4_974, 12_295, 7_001]);
  assert.equal(t.view(0).hand!.pot, 75);

  t.cmd(BB, { type: 'answerChop', agree: true });

  assert.deepEqual(t.stacks(), stacks);
  assert.deepEqual(t.state.hand!.events.at(-1), ['chop', [[SB, 25], [BB, 50]]]);
  assert.deepEqual(lastLines(t, 4), ['P0 folds', 'P1 offers to chop the blinds', 'P2 agrees to chop', 'P1 and P2 chop the blinds: each takes back their own']);
  assert.ok(t.view(0).ledger.every((row) => row.net === 0));
  assertChipsConserved(t.state);
});

test('the hand after a chop moves the button and the blinds on as after any hand, and nobody owes', () => {
  const t = offered();
  t.cmd(BB, { type: 'answerChop', agree: true });
  t.finishHand();

  t.deal();
  const hand = t.state.hand!;
  assert.deepEqual([hand.button, hand.sbSeat, hand.bbSeat], [1, 2, 3]);
  assert.ok(t.state.seats.every((seat) => !seat || (!seat.owesBigBlind && !seat.owesSmallBlind)));
  assert.deepEqual(hand.players.map((player) => player.seat), [0, 1, 2, 3]);
});

test('a chopped hand is a hand played: it counts down the last hands and toward the next bomb pot', () => {
  const last = foldedToTheBlinds();
  last.cmd(0, { type: 'setLastHands', hands: 0 });
  last.cmd(SB, { type: 'offerChop' });
  last.cmd(BB, { type: 'answerChop', agree: true });
  last.finishHand();
  assert.notEqual(last.state.nightEndedAt, null);
  assert.ok(last.feedText().includes('That was the last hand. The night is over'));

  const bombs = foldedToTheBlinds({ bombPotEvery: 2 });
  bombs.cmd(SB, { type: 'offerChop' });
  bombs.cmd(BB, { type: 'answerChop', agree: true });
  bombs.finishHand();
  bombs.deal();
  assert.ok(bombs.state.hand!.bombPot, 'the hand after a chopped one was not the bomb pot due every second hand');
});

test('no seven-deuce bounty is paid on a chop: nobody won', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: { ...CHOPS, sevenDeuceBounty: 50 } });
  t.deal({ button: 0, holes: { [SB]: '7h 2c' } });
  t.fold(3);
  t.fold(0);
  t.cmd(SB, { type: 'offerChop' });
  t.cmd(BB, { type: 'answerChop', agree: true });

  assert.equal(t.state.hand!.result!.bounty, null);
  assert.deepEqual(t.stacks(), [1000, 1000, 1000, 1000]);
  assert.ok(!t.state.hand!.players[SB]!.shown);
});

test('two blinds who always chop chop the moment it folds to them, without anyone being asked', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: CHOPS });
  t.cmd(SB, { type: 'setAlwaysChop', on: true });
  t.cmd(BB, { type: 'setAlwaysChop', on: true });
  t.deal({ button: 0 });
  t.fold(3);
  t.fold(0);

  assert.equal(t.state.hand!.result!.chopped, true);
  assert.deepEqual(kinds(t).slice(-3), ['fold', 'fold', 'chop']);
  assert.deepEqual(lastLines(t, 1), ['P1 and P2 chop the blinds: each takes back their own']);
  assert.deepEqual(t.stacks(), [1000, 1000, 1000, 1000]);
});

test('a small blind who always chops, facing a big blind who does not, is asked to act as usual', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: CHOPS });
  t.cmd(SB, { type: 'setAlwaysChop', on: true });
  t.deal({ button: 0 });
  t.fold(3);
  t.fold(0);

  assert.equal(t.state.hand!.stage, 'betting');
  assert.equal(t.view(SB).hand!.canOfferChop, true);
});

test('a player who is away chops by their standing choice, and folds without it', () => {
  // Timed out on the hand before, the small blind is away; with both switches on the hand is chopped all the same
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: CHOPS });
  t.cmd(SB, { type: 'setAlwaysChop', on: true });
  t.cmd(BB, { type: 'setAlwaysChop', on: true });
  t.deal({ button: 0 });
  t.state.seats[SB]!.away = true;
  t.fold(3);
  t.fold(0);
  assert.equal(t.state.hand!.result!.chopped, true);

  const without = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: CHOPS });
  without.deal({ button: 0 });
  without.state.seats[SB]!.away = true;
  without.fold(3);
  without.fold(0);
  assert.deepEqual(without.state.hand!.result!.winnings, [{ seat: BB, amount: 20 }]);
});

test('always chopping is for a table that chops: refused where it does not, and switched off for everyone when the host turns chops off', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: CHOPS });
  t.cmd(1, { type: 'setAlwaysChop', on: true });
  t.cmd(2, { type: 'setAlwaysChop', on: true });
  assert.deepEqual(t.view(0).seats.slice(0, 3).map((seat) => seat!.alwaysChop), [false, true, true]);

  t.cmd(0, { type: 'updateConfig', config: { allowChop: false } });
  assert.ok(t.state.seats.every((seat) => !seat?.alwaysChop));
  assert.throws(() => t.cmd(1, { type: 'setAlwaysChop', on: true }), { message: "This table doesn't chop the blinds" });
  t.cmd(1, { type: 'setAlwaysChop', on: false });

  t.cmd(0, { type: 'updateConfig', config: { allowChop: true } });
  assert.deepEqual(lastLines(t, 1), ['The blinds may chop when it folds to them']);
  assert.ok(t.state.seats.every((seat) => !seat?.alwaysChop));
});

test('everyone sees the offer stand, and what was answered', () => {
  const t = offered();

  for (const seat of [0, SB, BB, 3]) {
    const hand = t.view(seat).hand!;

    assert.equal(hand.stage, 'chop');
    assert.equal(hand.toAct, BB);
    assert.deepEqual(hand.events.at(-1), ['chopOffer', SB]);
  }

  t.cmd(BB, { type: 'answerChop', agree: false });
  assert.ok([0, 3].every((seat) => t.view(seat).feed.at(-1)!.text === 'P2 says no to the chop'));
});

test('a chopped hand replays from its events to every stack as it was dealt', () => {
  const t = offered();
  t.cmd(BB, { type: 'answerChop', agree: true });

  const events = t.state.hand!.events;
  const end = replayHand(events)!;
  assert.deepEqual(end.seats.map((seat) => [seat.stack, seat.bet]), [[1000, 0], [1000, 0], [1000, 0], [1000, 0]]);
  assert.equal(end.pot, 0);
  assert.deepEqual(end.awards, []);

  // Just before the chop the blinds are still in front of their seats
  const offeredAt = replayHand(events, events.length - 1)!;
  assert.deepEqual(offeredAt.seats.map((seat) => seat.bet), [0, 10, 20, 0]);
});

test('a table saved while the big blind answers loads still answering, and a hand saved before chops plays on and can be chopped', () => {
  const t = offered();
  const reloaded = TestTable.adopt(restoreState(JSON.stringify(t.state)));
  reloaded.now = t.now;
  assert.equal(reloaded.state.hand!.stage, 'chop');
  reloaded.cmd(reloaded.ids.indexOf(t.ids[BB]!), { type: 'answerChop', agree: true });
  assert.equal(reloaded.state.hand!.result!.chopped, true);

  // As the code before this saved it: no setting, no standing choice, no word of an offer. The host allows chops once it is loaded
  const old = foldedToTheBlinds();
  const saved = JSON.parse(JSON.stringify(old.state)) as Record<'config' | 'hand', Record<string, unknown>> & { seats: (Record<string, unknown> | null)[] };
  delete saved.config.allowChop;
  delete saved.hand.chopOffered;
  for (const seat of saved.seats) {
    delete seat?.alwaysChop;
  }

  const back = TestTable.adopt(restoreState(JSON.stringify(saved)));
  back.now = old.now;
  assert.equal(back.state.config.allowChop, false, 'a table saved before chops chops only once its host says so');
  back.cmd(0, { type: 'updateConfig', config: { allowChop: true } });
  assert.equal(back.state.hand!.chopOffered, false);
  assert.ok(back.state.seats.every((seat) => !seat || seat.alwaysChop === false));
  back.cmd(back.ids.indexOf(old.ids[SB]!), { type: 'offerChop' });
  back.cmd(back.ids.indexOf(old.ids[BB]!), { type: 'answerChop', agree: true });
  assert.equal(back.state.hand!.result!.chopped, true);
});

/**
 * Whether the small blind could offer to chop now, read from the hand's events rather than its chips: the
 * test's own wording of the rule, against which the engine's is checked. Null when the hand keeps no events.
 */
function chopByTheEvents(state: TableState): boolean | null {
  const hand = state.hand!;
  const { events } = hand;

  if (events.length === 0) {
    return null;
  }

  const posts = events.flatMap((event) => (event[0] === 'post' ? [event] : []));
  const blindsAlone = posts.length === 2 && posts[0]![2] === 'small blind' && posts[0]![3] === hand.smallBlind && posts[1]![2] === 'big blind' && posts[1]![3] === hand.bigBlind;
  const othersFolded = hand.players.every((player) => player.folded === (player.seat !== hand.sbSeat && player.seat !== hand.bbSeat));
  const actedSince = events.slice(events.findIndex((event) => event[0] === 'deal') + 1).filter((event: HandEvent) => event[0] !== 'fold' && event[0] !== 'timeout' && event[0] !== 'check');

  return (
    state.config.allowChop &&
    hand.stage === 'betting' &&
    hand.street === 'preflop' &&
    hand.bombPot === null &&
    hand.straddles.length === 0 &&
    hand.players.length >= 3 &&
    hand.toAct === hand.sbSeat &&
    blindsAlone &&
    othersFolded &&
    actedSince.length === 0 &&
    !events.some((event) => event[0] === 'chopOffer')
  );
}

/** A table of three to seven players with chops on, and now and then an ante, straddles or players owing blinds. */
function randomTable(rng: Rng, seed: number): TestTable {
  const players = 3 + rng.int(5);
  const allowAll = Object.fromEntries(STRADDLES.map((entry) => [entry.setting, chance(rng, 30)]));
  const t = new TestTable({
    stacks: Array.from({ length: players }, () => (chance(rng, 10) ? 5 + rng.int(30) : 500 + rng.int(1500))),
    seed,
    config: { ...CHOPS, actionSeconds: 30, ante: chance(rng, 20) ? 5 : 0, anteFrom: chance(rng, 50) ? 'everyone' : 'bigBlind', ...allowAll },
  });

  for (let seat = 0; seat < players; seat++) {
    t.cmd(seat, { type: 'setAlwaysChop', on: chance(rng, 25) });

    for (const kind of STRADDLES.filter((entry) => t.state.config[entry.setting])) {
      t.cmd(seat, { type: 'setStraddle', kind: kind.what, on: chance(rng, 30) });
    }
  }

  t.cmd(0, { type: 'start' });

  return t;
}

/** A move for whoever is on the clock: mostly a fold before anyone has come in, so that hands often fold round to the blinds. */
function randomMove(t: TestTable, rng: Rng): void {
  const hand = t.state.hand!;
  const seat = hand.toAct!;
  const options = t.view(t.playerIn(seat)).hand!.options!;

  if (hand.street === 'preflop' && seat !== hand.sbSeat && seat !== hand.bbSeat && chance(rng, 70)) {
    t.fold(t.playerIn(seat));
  } else if (options.canCheck) {
    t.check(t.playerIn(seat));
  } else if (chance(rng, 50)) {
    t.call(t.playerIn(seat));
  } else {
    t.fold(t.playerIn(seat));
  }
}

test('over random tables an offer is legal exactly when the rule says, and every chop puts each stack back as it was dealt', () => {
  const TABLES = Number(process.env.SIM_TABLES ?? 40);
  const seen = { offered: 0, refused: 0, agreed: 0, saidNo: 0, timedOut: 0, unasked: 0 };

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 104_729);
    const t = randomTable(rng, seed);

    for (let step = 0; step < 400; step++) {
      const hand = t.state.hand;

      // Between hands the next comes when its time does, unless the table is short of players
      if (!hand) {
        if (t.state.nextHandAt === null) {
          break;
        }

        t.wait(t.state.nextHandAt - t.now);
        continue;
      }

      const onClock = hand.toAct;

      // Building every view is the slow part, so the whole table is checked on a sample of steps
      if (step % 10 === 0) {
        assertInvariants(t.state, t.now);
      }

      if (hand.stage === 'betting' && onClock !== null) {
        const legal = chopByTheEvents(t.state);
        const offering = pick(rng, [onClock, ...hand.players.map((player) => player.seat)])!;

        if (legal !== null) {
          assert.equal(mayOfferChop(t.state, onClock), legal, `seed ${seed}: the engine and the rule disagree on an offer`);
        }

        // Anyone may try; only the small blind with the hand as the rule says gets through
        try {
          t.cmd(t.playerIn(offering), { type: 'offerChop' });
          assert.ok(offering === onClock && legal !== false, `seed ${seed}: an offer the rule does not allow was taken`);
          seen.offered += 1;
        } catch (error) {
          assert.equal((error as Error).name, 'GameError');
          assert.ok(offering !== onClock || legal !== true, `seed ${seed}: an offer the rule allows was refused: ${(error as Error).message}`);
          seen.refused += 1;
          randomMove(t, rng);
        }
      } else if (hand.stage === 'chop') {
        if (chance(rng, 15)) {
          t.wait(hand.deadline! - t.now);
        } else {
          t.cmd(t.playerIn(hand.toAct!), { type: 'answerChop', agree: chance(rng, 50) });
        }
      } else {
        t.wait(Math.max(0, hand.deadline! - t.now));
      }
    }

    for (const record of handRecords(t.effects)) {
      const answers = chopAnswers(record);

      if (record.result.chopped) {
        assert.ok(record.players.every((player) => player.endStack === player.startStack), `seed ${seed}: a chop changed a stack`);
        seen[answers.length === 0 ? 'unasked' : 'agreed'] += 1;
      }

      seen.saidNo += answers.filter((answer) => !answer.agree && !answer.timedOut).length;
      seen.timedOut += answers.filter((answer) => answer.timedOut).length;
    }

    assertHandRecordsHold(t.effects);
    assertChipsConserved(t.state);
  }

  const reached = JSON.stringify(seen);
  assert.ok(seen.agreed >= TABLES && seen.unasked >= TABLES / 4 && seen.saidNo >= TABLES / 2 && seen.timedOut >= TABLES / 10, reached);
});
