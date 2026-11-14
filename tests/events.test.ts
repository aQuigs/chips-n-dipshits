import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, EVENT_LIMIT, LIMITS, replayHand } from '../src/engine/index.ts';
import type { HandEvent, HandRecord } from '../src/engine/index.ts';
import { handRecords, TestTable } from './helpers.ts';
import { assertEventsRetellTheHand, assertHandRecordsHold, assertInvariants, assertRecordBalances, assertViewsKeepSecrets } from './invariants.ts';

/** Plays the hand out to its record, however many steps of the clock that takes. */
function recordOf(t: TestTable): HandRecord {
  const before = handRecords(t.effects).length;

  while (handRecords(t.effects).length === before) {
    assert.notEqual(t.state.hand!.deadline, null, 'the hand is waiting on a player');
    t.wait(t.state.hand!.deadline! - t.now);
  }

  return handRecords(t.effects)[before]!;
}

test('a hand is told in events from the blinds to the pot, with what every bet left its player', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.cmd(3, { type: 'setStraddle', kind: 'straddle', on: true });
  t.deal({ button: 0, holes: { 3: '8s 8h' }, board: 'Kd 7c 2s 9h 4d' });

  t.call(0);
  t.fold(1);
  t.raise(2, 120);
  t.call(3);
  t.fold(0);

  t.raise(2, 100);
  t.call(3);

  t.check(2);
  t.check(3);

  t.raise(2, 300);
  t.fold(3);
  t.cmd(3, { type: 'showCards' });

  const expected: HandEvent[] = [
    ['start', 1, 0, 10, 20, [[0, 'P0', 1000], [1, 'P1', 1000], [2, 'P2', 1000], [3, 'P3', 1000]]],
    ['post', 1, 'small blind', 10, 990],
    ['post', 2, 'big blind', 20, 980],
    ['post', 3, 'straddle', 40, 960],
    ['deal'],
    ['call', 0, 40, 960],
    ['fold', 1],
    ['raise', 2, 120, 880],
    ['call', 3, 80, 880],
    ['fold', 0],
    ['street', 0, ['Kd', '7c', '2s']],
    ['bet', 2, 100, 780],
    ['call', 3, 100, 780],
    ['street', 0, ['9h']],
    ['check', 2],
    ['check', 3],
    ['street', 0, ['4d']],
    ['bet', 2, 300, 480],
    ['fold', 3],
    ['return', 2, 300],
    ['win', 2, 490, 0, 0],
    ['show', 3, ['8s', '8h']],
  ];

  assert.deepEqual(t.state.hand!.events, expected);
  assert.deepEqual(t.view(1).hand!.events, expected, 'every viewer is sent the same events');

  const record = recordOf(t);
  assert.deepEqual(record.events, expected);
  assertEventsRetellTheHand(record);
});

test('a hand can be followed one event at a time from its events alone', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.deal({ button: 0, board: 'Kd 7c 2s 9h 4d' });

  t.call(3);
  t.raise(0, 100);
  t.fold(1);
  t.call(2);
  t.call(3);
  t.check(2);

  const events = t.state.hand!.events;
  const seats = (count: number) => replayHand(events, count)!.seats.map((seat) => [seat.stack, seat.bet, seat.folded]);

  assert.equal(replayHand(events, 0), null, 'before its first event there is no hand');
  assert.deepEqual(replayHand(events, 1), {
    number: 1,
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    bombPot: null,
    seats: [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, stack: 1000, bet: 0, folded: false, cards: null })),
    pot: 0,
    boards: [[]],
    awards: [],
  });

  // The blinds are in, then the raise and the fold
  assert.deepEqual(seats(3), [[1000, 0, false], [990, 10, false], [980, 20, false], [1000, 0, false]]);
  assert.deepEqual(seats(7), [[900, 100, false], [990, 10, true], [980, 20, false], [980, 20, false]]);

  const flop = replayHand(events, 10)!;
  assert.deepEqual(flop.boards, [['Kd', '7c', '2s']]);
  assert.equal(flop.pot, 310, 'the bets are in the middle once the flop is dealt');
  assert.ok(flop.seats.every((seat) => seat.bet === 0));

  assert.deepEqual(replayHand(events), replayHand(events, events.length));
});

test('side pots, both boards of a hand run twice and every vote are in the events', () => {
  const t = new TestTable({ stacks: [300, 1000, 1000], config: { allowRunItTwice: true } });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: 'Qc Qs' }, board: 'Ks 7s 2h 3c 4d', secondBoard: 'Ac Qd 8h 5c 6s' });

  t.raise(0, 300);
  t.raise(1, 1000);
  t.call(2);
  for (const voter of [0, 1, 2]) {
    t.cmd(voter, { type: 'ritVote', agree: true });
  }

  const record = recordOf(t);

  assert.deepEqual(record.events.slice(4), [
    ['raise', 0, 300, 0],
    ['raise', 1, 1000, 0],
    ['call', 2, 980, 0],
    ['show', 0, ['As', 'Ah']],
    ['show', 1, ['Kd', 'Kh']],
    ['show', 2, ['Qc', 'Qs']],
    ['vote', 0, true],
    ['vote', 1, true],
    ['vote', 2, true],
    ['runs', 2],
    ['street', 0, ['Ks', '7s', '2h']],
    ['street', 0, ['3c']],
    ['street', 0, ['4d']],
    ['street', 1, ['Ac', 'Qd', '8h']],
    ['street', 1, ['5c']],
    ['street', 1, ['6s']],
    ['win', 1, 450, 0, 0],
    ['win', 0, 450, 0, 1],
    ['win', 1, 700, 1, 0],
    ['win', 2, 700, 1, 1],
  ]);
  assertEventsRetellTheHand(record);
  assert.deepEqual(replayHand(record.events)!.seats.map((seat) => seat.stack), [450, 1150, 700]);
});

test('a vote against, a timeout, a muck and a bounty each leave their event', () => {
  const declined = new TestTable({ stacks: [500, 500], config: { allowRunItTwice: true } });
  declined.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh' }, board: 'Ks 7s 2h 3c 4d' });
  declined.raise(0, 500);
  declined.call(1);
  declined.cmd(1, { type: 'ritVote', agree: false });
  assert.deepEqual(declined.state.hand!.events.slice(-2), [['vote', 1, false], ['runs', 1]]);
  assertEventsRetellTheHand(recordOf(declined));

  const slow = new TestTable({ stacks: [500, 500, 500], config: { actionSeconds: 10 } });
  slow.deal({ button: 0 });
  slow.wait(slow.state.hand!.deadline! - slow.now);
  assert.deepEqual(slow.state.hand!.events.slice(-2), [['timeout', 0], ['fold', 0]]);

  const checkedDown = (holes: Record<number, string>) => {
    const t = new TestTable({ stacks: [500, 500] });
    t.deal({ button: 0, holes, board: 'Ks 7s 2h 3c 4d' });
    t.call(0);
    t.check(1);
    for (let street = 0; street < 3; street++) {
      t.check(1);
      t.check(0);
    }

    return t;
  };

  const showdown = checkedDown({ 0: 'As Ah', 1: '9c 8d' });
  assert.deepEqual(showdown.state.hand!.events.slice(-3), [['show', 1, ['9c', '8d']], ['show', 0, ['As', 'Ah']], ['win', 0, 40, 0, 0]]);

  const beaten = checkedDown({ 0: '9c 8d', 1: 'As Ah' });
  assert.deepEqual(beaten.state.hand!.events.slice(-3), [['show', 1, ['As', 'Ah']], ['muck', 0], ['win', 1, 40, 0, 0]]);
  assertEventsRetellTheHand(recordOf(beaten));

  const bounty = new TestTable({ stacks: [500, 500, 500], config: { sevenDeuceBounty: 25 } });
  bounty.deal({ button: 0, holes: { 0: '7h 2c' } });
  bounty.raise(0, 60);
  bounty.fold(1);
  bounty.fold(2);
  assert.deepEqual(bounty.state.hand!.events.slice(-4), [['return', 0, 40], ['win', 0, 50, 0, 0], ['show', 0, ['7h', '2c']], ['bounty', 0, [[1, 25], [2, 25]]]]);
  assertEventsRetellTheHand(recordOf(bounty));
});

test('no card that is still face down is ever in the events', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: 'Qc Qs' }, board: 'Js 7s 2h 3c 4d' });

  t.call(0);
  t.call(1);
  t.check(2);
  assertViewsKeepSecrets(t.state, t.now);

  for (let street = 0; street < 3; street++) {
    t.check(1);
    t.check(2);
    t.check(0);
    assertViewsKeepSecrets(t.state, t.now);
  }

  // Seat 2 mucked at the showdown: beaten by what was already shown
  assert.equal(t.state.hand!.stage, 'done');
  assert.ok(!JSON.stringify(t.state.hand!.events).includes('"Qc"'));
});

/**
 * Ten players with the longest names and the deepest stacks raise the least they can for as long as a
 * hand is recorded, then go all in for nine pots on two boards. Each holds a different pair, so no pot
 * is split and the number of events is the same every run.
 */
function longestRecordedHand(): TestTable {
  const pairs = ['As Ah', 'Ks Kh', 'Qs Qh', 'Js Jh', 'Ts Th', '9c 9d', '8c 8d', '7c 7d', '6c 6d', '5c 5d'];
  const names = pairs.map((_pair, seat) => `${'W'.repeat(LIMITS.nameLength - 1)}${seat}`);
  const stacks = pairs.map((_pair, seat) => LIMITS.chips - 10 * seat);
  const t = new TestTable({ stacks, names, config: { maxBuyIn: LIMITS.chips, allowRunItTwice: true, smallBlind: 1, bigBlind: 2 } });

  while (t.state.members.length < LIMITS.members) {
    addMember(t.state, `${'好'.repeat(LIMITS.nameLength - 2)}${t.state.members.length}`, t.ctx());
  }

  t.deal({ button: 0, holes: Object.fromEntries(pairs.entries()), board: '2c 3d 4h 9s Jc', secondBoard: 'Kd Qd 8s 3c 2h' });

  // What the hand still has to tell once the raising stops: everyone's last bet, cards and vote, both boards and every pot
  const ending = 70;
  const act = (raiseTo: 'minRaiseTo' | 'maxRaiseTo') => {
    const options = t.view(t.toAct!).hand!.options!;

    if (options.canRaise) {
      t.raise(t.toAct!, options[raiseTo]);
    } else {
      t.call(t.toAct!);
    }
  };

  while (t.state.hand!.events.length < EVENT_LIMIT - ending) {
    act('minRaiseTo');
  }

  while (t.state.hand!.stage === 'betting') {
    act('maxRaiseTo');
  }

  for (let voter = 0; voter < 10; voter++) {
    t.cmd(voter, { type: 'ritVote', agree: true });
  }

  return t;
}

test('the longest hand that is recorded fits its cell in the Hands tab with room to spare, and its table fits the cache', () => {
  const t = longestRecordedHand();
  assertInvariants(t.state, t.now);

  const record = recordOf(t);
  const cell = JSON.stringify(record).length;
  const events = JSON.stringify(record.events).length;

  assert.ok(record.events.length > EVENT_LIMIT - 20, `the hand has ${record.events.length} events, well short of the ${EVENT_LIMIT} a hand may have`);
  assert.ok(record.result.pots.length === 9 && record.boards.length === 2);
  assertRecordBalances(record);
  assertEventsRetellTheHand(record);

  // A cell takes 50,000 characters; a fifth of that is kept free for what records come to hold later
  assert.ok(cell <= 40_000, `the record is ${cell} characters`);
  assert.ok(events <= 12_000, `the events alone are ${events} characters`);
});

test('a hand that goes on past what is recorded keeps no events at all, and is played and paid as ever', () => {
  const t = new TestTable({ stacks: [LIMITS.chips, LIMITS.chips], config: { maxBuyIn: LIMITS.chips, smallBlind: 1, bigBlind: 2 } });
  t.deal({ button: 0 });

  for (let raises = 0; raises < EVENT_LIMIT + 50; raises++) {
    t.raise(t.toAct!, t.view(t.toAct!).hand!.options!.minRaiseTo);

    assert.ok(t.state.hand!.events.length <= EVENT_LIMIT);
    assert.ok(t.state.hand!.events.length === 0 || t.state.hand!.events[0]![0] === 'start');
  }

  assert.deepEqual(t.state.hand!.events, [], 'half a hand is no use to anything that follows it from the start');
  assert.deepEqual(t.view(0).hand!.events, []);

  t.fold(t.toAct!);
  const record = recordOf(t);

  assert.deepEqual(record.events, []);
  assertRecordBalances(record);
  assertEventsRetellTheHand(record);
  assertInvariants(t.state, t.now);
});

test('each ante is an event that puts its chips straight in the pot, and the first event says what the ante was', () => {
  const everyone = new TestTable({ stacks: [1000, 3, 1000, 1000], config: { ante: 5 } });
  everyone.deal({ button: 0 });

  const events = everyone.state.hand!.events;
  assert.deepEqual(events, [
    ['start', 1, 0, 10, 20, [[0, 'P0', 1000], [1, 'P1', 3], [2, 'P2', 1000], [3, 'P3', 1000]], 5, 'everyone'],
    ['post', 1, 'ante', 3, 0, 'contribution'],
    ['post', 2, 'ante', 5, 995, 'contribution'],
    ['post', 3, 'ante', 5, 995, 'contribution'],
    ['post', 0, 'ante', 5, 995, 'contribution'],
    ['post', 2, 'big blind', 20, 975],
    ['deal'],
  ]);

  const antesIn = replayHand(events, 5)!;
  assert.equal(antesIn.pot, 18);
  assert.deepEqual(antesIn.seats.map((seat) => [seat.stack, seat.bet]), [[995, 0], [0, 0], [995, 0], [995, 0]], 'an ante is never in front of its player');
  assert.deepEqual(replayHand(events)!.seats.map((seat) => [seat.stack, seat.bet]), [[995, 0], [0, 0], [975, 20], [995, 0]]);

  everyone.fold(3);
  everyone.fold(0);
  assertEventsRetellTheHand(recordOf(everyone));

  const bigBlind = new TestTable({ stacks: [1000, 1000, 25], config: { ante: 20, anteFrom: 'bigBlind' } });
  bigBlind.deal({ button: 0 });

  assert.deepEqual(bigBlind.state.hand!.events, [
    ['start', 1, 0, 10, 20, [[0, 'P0', 1000], [1, 'P1', 1000], [2, 'P2', 25]], 20, 'bigBlind'],
    ['post', 1, 'small blind', 10, 990],
    ['post', 2, 'big blind', 20, 5],
    ['post', 2, 'big blind ante', 5, 0, 'dead'],
    ['deal'],
  ]);
  assert.equal(replayHand(bigBlind.state.hand!.events)!.pot, 5);

  bigBlind.call(0);
  bigBlind.fold(1);
  assertEventsRetellTheHand(recordOf(bigBlind));
});

test('a hand with antes replays to its final stacks, through side pots, two boards and an ante that came back unmatched', () => {
  const twice = new TestTable({ stacks: [100, 500, 500], config: { ante: 25, anteFrom: 'bigBlind', allowRunItTwice: true } });
  twice.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh' }, board: '2c 7d 9h Jc 3s', secondBoard: 'Qd 4c 5h 8s Td' });
  twice.raise(0, 100);
  twice.raise(1, 500);
  twice.call(2);
  for (const voter of [0, 1, 2]) {
    twice.cmd(voter, { type: 'ritVote', agree: true });
  }

  const record = recordOf(twice);
  assertRecordBalances(record);
  assertEventsRetellTheHand(record);

  // The player all in for 3 of the ante of 5 can win 3 from the other, whose other 2 and whole blind go back
  const unmatched = new TestTable({ stacks: [3, 1000], config: { ante: 5 } });
  unmatched.deal({ button: 0 });

  const events = unmatched.state.hand!.events;
  assert.deepEqual(events.slice(1, 5), [['post', 1, 'ante', 5, 995, 'contribution'], ['post', 0, 'ante', 3, 0, 'contribution'], ['post', 1, 'big blind', 20, 975], ['deal']]);
  assert.deepEqual(events[5], ['return', 1, 22]);

  for (let count = 1; count <= events.length; count++) {
    const position = replayHand(events, count)!;

    assert.ok(position.pot >= 0 && position.seats.every((seat) => seat.bet >= 0 && seat.stack >= 0), `after ${count} events the table holds less than nothing somewhere`);
  }

  const returned = replayHand(events, 6)!;
  assert.equal(returned.pot, 6);
  assert.deepEqual(returned.seats.map((seat) => [seat.stack, seat.bet]), [[0, 0], [997, 0]]);

  const settled = recordOf(unmatched);
  assertRecordBalances(settled);
  assertEventsRetellTheHand(settled);
});

test('a hand without an ante starts with the same event as before there were antes', () => {
  const t = new TestTable({ stacks: [1000, 1000], config: { ante: 0, anteFrom: 'bigBlind' } });
  t.deal({ button: 0 });

  assert.deepEqual(t.state.hand!.events.slice(0, 3), [['start', 1, 0, 10, 20, [[0, 'P0', 1000], [1, 'P1', 1000]]], ['post', 0, 'small blind', 10, 990], ['post', 1, 'big blind', 20, 980]]);
});

test('a bomb pot says so in its first event, and is told as what everyone posted into the pot and then the flop', () => {
  const t = new TestTable({ stacks: [1000, 30, 1000, 1000], config: { ante: 5 } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, holes: { 1: 'As Ah', 3: 'Ks Kh', 0: 'Qs Qh' }, board: '2c 7d 9h Jc 3s' });

  const events = t.state.hand!.events;
  assert.deepEqual(events, [
    ['start', 1, 0, 10, 20, [[0, 'P0', 1000], [1, 'P1', 30], [2, 'P2', 1000], [3, 'P3', 1000]], 0, 'everyone', { amount: 100 }],
    ['post', 1, 'bomb pot', 30, 0, 'contribution'],
    ['post', 2, 'bomb pot', 100, 900, 'contribution'],
    ['post', 3, 'bomb pot', 100, 900, 'contribution'],
    ['post', 0, 'bomb pot', 100, 900, 'contribution'],
    ['deal'],
    ['street', 0, ['2c', '7d', '9h']],
  ]);
  assert.deepEqual(t.view(2).hand!.events, events);

  assert.deepEqual(replayHand(events, 1)!.bombPot, { amount: 100 }, 'a replay knows what kind of hand it is from the start');

  const posted = replayHand(events, 5)!;
  assert.equal(posted.pot, 330);
  assert.deepEqual(posted.seats.map((seat) => [seat.stack, seat.bet]), [[900, 0], [0, 0], [900, 0], [900, 0]], 'what is posted is never in front of its player');

  const flop = replayHand(events)!;
  assert.deepEqual([flop.boards, flop.pot], [[['2c', '7d', '9h']], 330]);

  t.check(2);
  t.raise(3, 100);
  t.call(0);
  t.fold(2);
  for (const seat of [3, 0, 3, 0]) {
    t.check(seat);
  }

  const record = recordOf(t);
  assert.deepEqual(record.bombPot, { amount: 100 });
  assertHandRecordsHold(t.effects);

  // The hand after it is an ordinary one again, and its first event has nothing about bomb pots
  t.deal();
  assert.deepEqual(t.state.hand!.events[0]!.slice(6), [5, 'everyone']);
  assert.equal(replayHand(t.state.hand!.events)!.bombPot, null);
});

test('a bomb pot that is all in when dealt replays through what came back, a second board and every pot', () => {
  const t = new TestTable({ stacks: [1000, 60, 50], config: { allowRunItTwice: true } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, holes: { 0: 'Qs Qh', 1: 'Ks Kh', 2: 'As Ah' }, board: '2c 7d 9h Jc 3s', secondBoard: 'Kd 4c' });

  const events = t.state.hand!.events;
  assert.deepEqual(events.slice(1), [
    ['post', 1, 'bomb pot', 60, 0, 'contribution'],
    ['post', 2, 'bomb pot', 50, 0, 'contribution'],
    ['post', 0, 'bomb pot', 100, 900, 'contribution'],
    ['deal'],
    ['return', 0, 40],
    ['street', 0, ['2c', '7d', '9h']],
    ['show', 0, ['Qs', 'Qh']],
    ['show', 1, ['Ks', 'Kh']],
    ['show', 2, ['As', 'Ah']],
  ]);

  const returned = replayHand(events, 6)!;
  assert.equal(returned.pot, 170, 'what comes back comes out of the pot, where it was posted');
  assert.deepEqual(returned.seats.map((seat) => [seat.stack, seat.bet]), [[940, 0], [0, 0], [0, 0]]);

  for (const voter of [0, 1, 2]) {
    t.cmd(voter, { type: 'ritVote', agree: true });
  }

  const record = recordOf(t);
  assert.deepEqual(record.boards, [['2c', '7d', '9h', 'Jc', '3s'], ['2c', '7d', '9h', 'Kd', '4c']]);
  assertHandRecordsHold(t.effects);
});
