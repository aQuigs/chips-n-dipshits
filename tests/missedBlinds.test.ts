/*
 * Missed blinds and the dead button as hands are really dealt and played: who posts what, how the
 * betting goes around a missed big blind, and what the table says about it. The rule itself, hand after
 * hand, is in handPlan.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { comingIn, owes, replayHand } from '../src/engine/index.ts';
import type { TableConfig } from '../src/engine/index.ts';
import { chipsIn, options, TestTable } from './helpers.ts';
import type { DealOptions } from './helpers.ts';
import { assertHandRecordsHold, assertInvariants } from './invariants.ts';

/** A table with a player in each of `seats`. */
const spread = (seats: number[], config: Partial<TableConfig> = {}) => new TestTable({ stacks: seats.map(() => 1000), seats, config });

/** Every forced bet of the hand on the table, as `seat what amount`, with how it counts when not as a live bet. */
function posts(t: TestTable): string[] {
  return t.state.hand!.events.flatMap((event) => (event[0] === 'post' ? [[event[1], event[2], event[3], ...(event[5] ? [event[5]] : [])].join(' ')] : []));
}

/** The seats that posted the small blind and the big blind in the hand on the table. */
function blindsOf(t: TestTable): [number | null, number] {
  const seatOf = (what: string) => t.state.hand!.events.flatMap((event) => (event[0] === 'post' && event[2] === what ? [event[1]] : []));

  return [seatOf('small blind')[0] ?? null, seatOf('big blind')[0]!];
}

test('gap: a newcomer who sits between the button and the small blind makes nobody post a blind twice', () => {
  const t = spread([0, 2, 4, 6]);
  t.deal({ button: 0 });
  assert.deepEqual(blindsOf(t), [2, 4]);
  t.foldOut();

  t.sitDown('New', 1);

  const dealt: [number | null, number][] = [];
  for (let hand = 0; hand < 4; hand++) {
    t.deal();
    dealt.push(blindsOf(t));
    t.foldOut();
  }

  // The blinds go on round the table as if nobody had come, and reach the newcomer in their turn
  assert.deepEqual(dealt, [[4, 6], [6, 0], [0, 1], [1, 2]]);
});

test('gap: a newcomer who sits between the small blind and the big blind makes nobody post a blind twice', () => {
  const t = spread([0, 2, 4, 6]);
  t.deal({ button: 0 });
  t.foldOut();

  t.sitDown('New', 3);

  const dealt: [number | null, number][] = [];
  for (let hand = 0; hand < 4; hand++) {
    t.deal();
    dealt.push(blindsOf(t));
    t.foldOut();
  }

  assert.deepEqual(dealt, [[4, 6], [6, 0], [0, 2], [2, 3]]);
});

test('gap: the player with the button, moved one seat clockwise, does not get it again, and nobody posts the same blind again', () => {
  const t = spread([0, 2, 4]);
  t.deal({ button: 0 });
  assert.deepEqual([t.state.hand!.button, ...blindsOf(t)], [0, 2, 4]);
  t.foldOut();

  t.cmd(0, { type: 'moveSeat', playerId: t.ids[0]!, seat: 1 });
  t.deal();

  assert.deepEqual([t.state.hand!.button, ...blindsOf(t)], [2, 4, 1]);
});

/**
 * Six players with 1000 each, of whom the one in seat 4 has sat out through both blinds and come back
 * to post them. Handed back as that hand is about to be dealt: the button will be on seat 5 and the
 * blinds on seats 0 and 1, so seat 4 comes in just ahead of the button.
 */
function backToPost(config: Partial<TableConfig> = {}): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000, 1000, 1000], config });

  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(4, { type: 'sitOut' });

  // The big blind passes seat 4 in the second of these, and the button in the third
  for (let hand = 0; hand < 3; hand++) {
    t.deal();
    t.foldOut();
  }

  assert.deepEqual([t.state.seats[4]!.owesBigBlind, t.state.seats[4]!.owesSmallBlind], [true, true]);
  t.cmd(4, { type: 'comeIn', post: true });
  assert.equal(comingIn(t.state).get(4), 'posting');

  return t;
}

function dealBack(config: Partial<TableConfig> = {}, deal: DealOptions = {}): TestTable {
  const t = backToPost(config);
  t.deal(deal);

  return t;
}

test('a player back from missing both blinds posts a big blind that plays and a small blind that is dead, and the action still starts left of the big blind', () => {
  const t = dealBack();
  const hand = t.state.hand!;

  assert.deepEqual([hand.button, hand.sbSeat, hand.bbSeat], [5, 0, 1]);
  assert.deepEqual(posts(t), ['4 missed big blind 20', '4 dead small blind 10 dead', '0 small blind 10', '1 big blind 20']);
  assert.deepEqual(hand.log.slice(0, 5), ['Hand #5 · blinds 10/20 · P5 has the button', 'P4 posts missed big blind 20', 'P4 posts dead small blind 10', 'P0 posts small blind 10', 'P1 posts big blind 20']);

  // In front of them 20 that counts as their bet, and 10 in the pot that does not
  assert.deepEqual(chipsIn(t)[4], [20, 20, 10]);
  assert.equal(t.state.seats[4]!.stack, 970);
  assert.equal(t.view(0).hand!.pot, 60);
  assert.equal(t.view(0).seats[4]!.lastAction, 'missed big blind');
  assert.deepEqual([hand.currentBet, hand.minRaise, t.toAct], [20, 20, 2]);

  // Settled: they owe nothing more, and are an ordinary player from here
  assert.deepEqual([t.state.seats[4]!.owesBigBlind, t.state.seats[4]!.owesSmallBlind, t.state.seats[4]!.postsOwed], [false, false, false]);
  assertInvariants(t.state, t.now);
});

test('a posted missed big blind is that player\'s bet: a call costs the others one big blind, and its player may check or raise when the action reaches them', () => {
  const t = dealBack();

  assert.deepEqual([options(t, 2).callAmount, options(t, 2).minRaiseTo, options(t, 2).canCheck], [20, 40, false]);
  t.call(2);
  t.fold(3);

  // Nothing to call, and their turn all the same: they have not acted yet
  const theirs = options(t, 4);
  assert.deepEqual([theirs.canCheck, theirs.callAmount, theirs.canRaise, theirs.minRaiseTo], [true, 0, true, 40]);
  t.check(4);

  t.fold(5);
  assert.equal(options(t, 0).callAmount, 10);
  t.call(0);

  // The big blind still has the last word before the flop
  assert.equal(t.toAct, 1);
  assert.equal(options(t, 1).canCheck, true);
  t.check(1);

  assert.equal(t.state.hand!.street, 'flop');
  assert.equal(t.view(0).hand!.pot, 90, 'four big blinds and the dead small blind');
});

test('the player who posted a missed big blind raises over it, and a raise before them leaves them the difference to call', () => {
  const raised = dealBack();
  raised.fold(2);
  raised.fold(3);
  raised.raise(4, 60);
  assert.deepEqual(chipsIn(raised)[4], [60, 60, 10]);
  raised.fold(5);
  assert.deepEqual([options(raised, 0).callAmount, options(raised, 0).minRaiseTo], [50, 100]);
  raised.fold(0);
  assert.equal(options(raised, 1).callAmount, 40);

  const facing = dealBack();
  facing.raise(2, 80);
  facing.fold(3);
  assert.deepEqual([options(facing, 4).canCheck, options(facing, 4).callAmount, options(facing, 4).minRaiseTo], [false, 60, 140]);
  facing.call(4);
  assert.deepEqual(chipsIn(facing)[4], [80, 80, 10]);
});

test('a hand everyone folds to the big blind gives it the dead small blind and the missed big blind with the rest', () => {
  const t = dealBack();
  const before = t.stacks();

  t.foldOut();

  // Seat 1 gets back its own blind and wins the small blind, the missed big blind and the dead small blind
  assert.deepEqual(t.stacks().map((stack, seat) => stack - before[seat]!), [0, 60, 0, 0, 0, 0]);
  assert.equal(assertHandRecordsHold(t.effects), 5);
});

test('a player short of the missed big blind posts what they have and is all in for it, and the price to call is still the big blind', () => {
  const t = backToPost();
  t.cmd(0, { type: 'setStack', playerId: t.ids[4]!, stack: 15 });
  t.deal({ holes: { 4: 'As Ah', 1: 'Ks Kh', 2: '7c 2d' }, board: '3s 4d 9h Jc Qd' });
  const hand = t.state.hand!;

  // Nothing is left for the small blind they owed, which is let go
  assert.deepEqual(posts(t), ['4 missed big blind 15', '0 small blind 10', '1 big blind 20']);
  assert.equal(hand.log[1], 'P4 posts missed big blind 15 and is all in');
  assert.deepEqual([chipsIn(t)[4], hand.players[4]!.allIn], [[15, 15, 0], true]);
  assert.deepEqual([hand.currentBet, hand.minRaise, t.toAct], [20, 20, 2]);
  assert.deepEqual([t.state.seats[4]!.owesBigBlind, t.state.seats[4]!.owesSmallBlind], [false, false]);

  t.call(2);
  t.fold(3);
  assert.equal(t.toAct, 5, 'a player who is all in from their post is asked nothing');
  t.fold(5);
  t.fold(0);
  t.check(1);
  for (let street = 0; street < 3; street++) {
    t.check(1);
    t.check(2);
  }
  t.finishHand();

  // Aces win the pot they could reach: 15 from each of the two who stayed and from themselves, and the folded small blind's 10
  assert.equal(t.stacks()[4], 55);
  assert.equal(assertHandRecordsHold(t.effects), 5);
  assertInvariants(t.state, t.now);
});

test('a stack that covers the missed big blind and part of the small blind posts both and is all in', () => {
  for (const [stack, expected, line] of [
    [20, ['4 missed big blind 20', '0 small blind 10', '1 big blind 20'], 'P4 posts missed big blind 20 and is all in'],
    [25, ['4 missed big blind 20', '4 dead small blind 5 dead', '0 small blind 10', '1 big blind 20'], 'P4 posts dead small blind 5 and is all in'],
  ] as const) {
    const t = backToPost();
    t.cmd(0, { type: 'setStack', playerId: t.ids[4]!, stack });
    t.deal();

    assert.deepEqual(posts(t), expected);
    assert.ok(t.state.hand!.log.includes(line), t.state.hand!.log.join(' / '));
    assert.deepEqual([t.state.hand!.players[4]!.allIn, t.state.seats[4]!.stack, t.toAct], [true, 0, 2]);

    t.foldOut();
    assertHandRecordsHold(t.effects);
    assertInvariants(t.state, t.now);
  }
});

test('with an ante the returning player antes like everyone, and a big-blind ante is still the big blind\'s alone', () => {
  const everyone = dealBack({ ante: 5 });
  assert.deepEqual(posts(everyone).slice(0, 6), [0, 1, 2, 3, 4, 5].map((seat) => `${seat} ante 5 contribution`));
  assert.deepEqual(posts(everyone).slice(6), ['4 missed big blind 20', '4 dead small blind 10 dead', '0 small blind 10', '1 big blind 20']);
  assert.deepEqual(chipsIn(everyone)[4], [20, 25, 10]);
  assert.deepEqual([everyone.state.hand!.currentBet, everyone.toAct], [20, 2]);

  const bigBlind = dealBack({ ante: 20, anteFrom: 'bigBlind' });
  assert.deepEqual(posts(bigBlind), ['4 missed big blind 20', '4 dead small blind 10 dead', '0 small blind 10', '1 big blind 20', '1 big blind ante 20 dead']);
  assert.deepEqual([bigBlind.state.hand!.currentBet, bigBlind.toAct], [20, 2]);
});

test('with a straddle on, the returning player has the difference to call, and the action starts left of the straddle', () => {
  const t = backToPost();
  t.cmd(2, { type: 'setStraddle', kind: 'straddle', on: true });
  t.deal();
  const hand = t.state.hand!;

  assert.deepEqual(posts(t), ['4 missed big blind 20', '4 dead small blind 10 dead', '0 small blind 10', '1 big blind 20', '2 straddle 40']);
  assert.deepEqual([hand.straddles.map((straddle) => straddle.seat), hand.currentBet, hand.minRaise, t.toAct], [[2], 40, 40, 3]);

  t.fold(3);
  assert.deepEqual([options(t, 4).canCheck, options(t, 4).callAmount, options(t, 4).minRaiseTo], [false, 20, 80]);
  t.call(4);
  assert.deepEqual(chipsIn(t)[4], [40, 40, 10]);
});

test('a player posting a missed big blind under the gun does not straddle on top of it', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(3, { type: 'sitOut' });
  t.cmd(3, { type: 'setStraddle', kind: 'straddle', on: true });

  // Round until the big blind is back on seat 2, with seat 3 next to act after it
  for (let hand = 0; hand < 4; hand++) {
    t.deal();
    t.foldOut();
  }

  t.cmd(3, { type: 'comeIn', post: true });
  t.deal();
  assert.deepEqual([t.state.hand!.button, t.state.hand!.bbSeat, t.state.hand!.straddles], [0, 2, []]);
  assert.deepEqual(t.state.hand!.passedOver, [{ seat: 3, why: 'blind' }]);
  assert.deepEqual(posts(t), ['3 missed big blind 20', '3 dead small blind 10 dead', '1 small blind 10', '2 big blind 20']);
  assert.equal(t.toAct, 3);
  assert.equal(options(t, 3).canCheck, true);
});

test('the events of a hand with missed blinds posted retell it: what is in front of whom, and what is in the pot', () => {
  const t = dealBack({ ante: 5 });
  const events = t.state.hand!.events;

  const posted = replayHand(events, events.findIndex((event) => event[0] === 'deal'))!;
  assert.deepEqual(posted.seats.map((seat) => [seat.stack, seat.bet]), t.state.hand!.players.map((player) => [t.state.seats[player.seat]!.stack, player.bet]));
  assert.deepEqual(posted.seats.map((seat) => seat.bet), [10, 20, 0, 0, 20, 0]);
  assert.equal(posted.pot, 40, 'six antes and the dead small blind');

  t.raise(2, 60);
  t.fold(3);
  t.call(4);
  const now = replayHand(t.state.hand!.events)!;
  assert.deepEqual([now.seats[4]!.stack, now.seats[4]!.bet], [t.state.seats[4]!.stack, 60]);

  t.foldOut();
  assert.equal(assertHandRecordsHold(t.effects), 5);
});

test('seven-deuce folded to as a lone big blind still collects its bounty, though the hand had nothing else to win', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: { sevenDeuceBounty: 50 } });
  t.deal({ button: 0 });
  t.foldOut();

  t.cmd(2, { type: 'sitOut' });
  t.deal({ holes: { 3: '7s 2h' } });
  t.fold(0);
  t.fold(1);

  // Winning without a showdown is what pays it, and a big blind with nobody to match it wins that way
  assert.deepEqual(t.state.hand!.result!.winnings, [{ seat: 3, amount: 0 }]);
  assert.deepEqual(t.state.hand!.result!.bounty, { seat: 3, payments: [{ seat: 0, amount: 50 }, { seat: 1, amount: 50 }] });
  assert.deepEqual(t.stacks(), [950, 940, 1010, 1100]);
});

test('a dead button and a hand with no small blind are said in the play-by-play, and the hand plays on round the players in it', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.foldOut();

  // The big blind steps out: their seat is the small blind's next, and the button's after that
  t.cmd(2, { type: 'sitOut' });
  t.deal({ holes: { 0: 'As Ah', 1: 'Ks Kh', 3: 'Qs Qh' }, board: '2c 7d 9h Jc 3s' });
  assert.deepEqual(t.state.hand!.log.slice(0, 3), ['Hand #2 · blinds 10/20 · P1 has the button', 'No small blind this hand', 'P3 posts big blind 20']);
  assert.deepEqual(posts(t), ['3 big blind 20']);
  assert.equal(t.toAct, 0);

  // Folded to, the big blind goes back to its player, and with no other chip in the hand nothing is won
  t.fold(0);
  t.fold(1);
  assert.deepEqual(t.state.hand!.log.slice(-2), ['Uncalled bet of 20 returned to P3', 'Everyone folded to P3']);
  assert.deepEqual([t.state.hand!.result!.pots, t.state.hand!.result!.winnings], [[], [{ seat: 3, amount: 0 }]]);
  t.finishHand();

  t.deal({ holes: { 0: 'As Ah', 1: 'Ks Kh', 3: 'Qs Qh' }, board: '2c 7d 9h Jc 3s' });
  const hand = t.state.hand!;
  assert.deepEqual([hand.button, hand.sbSeat, hand.bbSeat], [2, 3, 0]);
  assert.deepEqual(hand.log.slice(0, 3), ['Hand #3 · blinds 10/20 · dead button on seat 3', 'P3 posts small blind 10', 'P0 posts big blind 20']);
  assert.equal(replayHand(hand.events)!.button, 2);

  // Before the flop the action starts left of the big blind; after it, left of the button's seat, which is the small blind
  assert.equal(t.toAct, 1);
  t.call(1);
  t.call(3);
  t.check(0);
  assert.deepEqual([hand.street, t.toAct], ['flop', 3]);
  t.check(3);
  t.check(0);
  t.check(1);
  assert.equal(hand.street, 'turn');

  for (let street = 0; street < 2; street++) {
    t.check(3);
    t.check(0);
    t.check(1);
  }
  t.finishHand();

  assert.deepEqual(t.stacks(), [1040, 970, 1010, 980]);
  assert.equal(assertHandRecordsHold(t.effects), 3);
});

test('a bomb pot deals in a player who is waiting for the big blind, and leaves what they owe as it was', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(3, { type: 'sitOut' });
  t.deal();
  t.foldOut();
  t.cmd(3, { type: 'sitIn' });
  assert.equal(comingIn(t.state).get(3), 'big blind');

  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal();
  assert.deepEqual(t.state.hand!.players.map((player) => player.seat), [0, 1, 2, 3]);
  assert.deepEqual(posts(t), [0, 1, 2, 3].map((seat) => `${(seat + 3) % 4} bomb pot 100 contribution`));
  assert.deepEqual([t.state.seats[3]!.owesBigBlind, t.state.seats[3]!.owesSmallBlind], [true, true]);
  assertInvariants(t.state, t.now);
  t.foldOut();

  t.deal();
  assert.deepEqual(t.state.hand!.players.map((player) => player.seat), [0, 1, 2], 'the bomb pot settled what they owed');
});

test('sitting back in waits for the big blind unless the player says they will post, and the choice can be changed until they are dealt in', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(3, { type: 'sitOut' });
  t.deal();
  t.foldOut();

  const seat = t.state.seats[3]!;
  t.cmd(3, { type: 'sitIn' });
  assert.deepEqual([seat.sittingOut, seat.postsOwed], [false, false]);
  assert.equal(comingIn(t.state).get(3), 'big blind');

  t.cmd(3, { type: 'comeIn', post: true });
  assert.equal(seat.postsOwed, true);
  assert.equal(comingIn(t.state).get(3), 'button');

  t.cmd(3, { type: 'comeIn', post: false });
  assert.deepEqual([seat.sittingOut, seat.postsOwed], [false, false]);

  assert.throws(() => t.cmd(3, { type: 'comeIn', post: 'yes' as unknown as boolean }), /must be on or off/);

  // Someone who owes nothing has nothing to post, whatever they say
  t.cmd(1, { type: 'sitOut' });
  t.cmd(1, { type: 'comeIn', post: true });
  assert.deepEqual([t.state.seats[1]!.sittingOut, t.state.seats[1]!.postsOwed], [false, false]);
});

test('the host or a co-host forgives a player what they owe, the table is told, and forgiving nothing says nothing', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });
  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(3, { type: 'sitOut' });
  t.deal();
  t.foldOut();
  t.cmd(3, { type: 'comeIn', post: true });

  assert.throws(() => t.cmd(2, { type: 'forgiveBlinds', playerId: t.ids[3]! }), { name: 'GameError' });

  t.cmd(1, { type: 'forgiveBlinds', playerId: t.ids[3]! });
  assert.deepEqual([t.state.seats[3]!.owesBigBlind, t.state.seats[3]!.owesSmallBlind, t.state.seats[3]!.postsOwed], [false, false, false]);
  assert.equal(t.feedText().at(-1), 'Co-host P1 forgave P3 the blinds they missed');

  const said = t.feedText().length;
  t.cmd(0, { type: 'forgiveBlinds', playerId: t.ids[3]! });
  assert.equal(t.feedText().length, said);

  t.deal();
  assert.deepEqual(t.state.hand!.players.map((player) => player.seat), [0, 1, 2, 3]);
  assert.deepEqual(posts(t).filter((post) => post.startsWith('3 ')), []);
});

test('switching missed blinds to forgiven clears what is owed at once and says so, and switching back counts from the next hand', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(3, { type: 'sitOut' });
  t.deal();
  assert.equal(t.state.seats[3]!.owesBigBlind, true);

  t.cmd(0, { type: 'updateConfig', config: { missedBlinds: 'forgiven' } });
  assert.equal(t.feedText().at(-1), 'Missed blinds are forgiven: nobody owes any');
  assert.deepEqual([t.state.seats[3]!.owesBigBlind, t.state.seats[3]!.owesSmallBlind], [false, false]);

  t.cmd(0, { type: 'updateConfig', config: { missedBlinds: 'owed' } });
  assert.equal(t.feedText().at(-1), 'Missed blinds are owed from the next hand');
  t.foldOut();

  t.cmd(0, { type: 'updateConfig', config: { missedBlinds: 'forgiven' } });
  t.cmd(0, { type: 'updateConfig', config: { missedBlinds: 'owed' } });
  assert.equal(t.feedText().at(-1), 'Missed blinds are owed');
});

test('a player who sits down at a table with a game going owes a big blind, and one who sits down before the first hand owes nothing', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  const early = t.sitDown('Early', 5);
  assert.equal(t.state.seats[5]!.owesBigBlind, false);

  t.deal({ button: 0 });
  assert.deepEqual(t.state.hand!.players.map((player) => player.seat), [0, 1, 2, 5]);

  const late = t.sitDown('Late', 7);
  assert.deepEqual([t.state.seats[7]!.owesBigBlind, t.state.seats[7]!.owesSmallBlind, t.state.seats[7]!.postsOwed], [true, false, false]);
  t.foldOut();

  // Posting from where they sit costs a big blind, live, and no small blind
  t.cmd(late, { type: 'comeIn', post: true });
  t.deal();
  assert.deepEqual(posts(t), ['7 missed big blind 20', '2 small blind 10', '5 big blind 20']);
  assert.equal(t.state.seats[5]!.playerId, t.ids[early]);
  t.foldOut();

  // At a table that forgives missed blinds a newcomer owes nothing
  t.cmd(0, { type: 'updateConfig', config: { missedBlinds: 'forgiven' } });
  t.sitDown('Free', 8);
  assert.equal(t.state.seats[8]!.owesBigBlind, false);
});

test('after a shuffle nobody owes, and the next hand is dealt to everyone there to play', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(3, { type: 'sitOut' });
  t.deal();
  t.foldOut();
  t.cmd(3, { type: 'sitIn' });
  assert.equal(t.state.seats.filter((seat) => seat?.owesBigBlind).length, 1);

  t.cmd(0, { type: 'shuffleSeats' });
  assert.deepEqual([t.state.blinds, t.state.buttonSeat], [null, null]);
  assert.equal(t.state.seats.filter((seat) => seat && owes(seat)).length, 0);

  t.deal();
  assert.equal(t.state.hand!.players.length, 4);
  assertInvariants(t.state, t.now);
});

test('everyone sees who owes, who is waiting for the big blind or to post, and what a returning player posted', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000, 1000, 1000] });
  const seenBy = (viewer: number) => {
    const { owesBigBlind, owesSmallBlind, comesIn, lastAction } = t.view(viewer).seats[3]!;

    return [owesBigBlind, owesSmallBlind, comesIn, lastAction];
  };
  const seen = (expected: unknown[]) => {
    assert.deepEqual([seenBy(0), seenBy(3)], [expected, expected]);
    assertInvariants(t.state, t.now);
  };

  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(3, { type: 'sitOut' });
  seen([false, false, null, null]);

  // Out of the game, they owe and have not said how they will settle it
  t.deal();
  seen([true, true, null, null]);
  t.foldOut();

  t.cmd(3, { type: 'sitIn' });
  seen([true, true, 'big blind', null]);

  t.cmd(3, { type: 'comeIn', post: true });
  seen([true, true, 'button', null]);

  t.deal();
  t.foldOut();
  seen([true, true, 'posting', null]);

  t.deal();
  seen([false, false, null, 'missed big blind']);
});
