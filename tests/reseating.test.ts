import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember } from '../src/engine/index.ts';
import type { Seat } from '../src/engine/index.ts';
import { seededRng, TestTable } from './helpers.ts';
import { assertInvariants } from './invariants.ts';

const move = (t: TestTable, by: number, player: number, seat: number) => t.cmd(by, { type: 'moveSeat', playerId: t.ids[player]!, seat });

/** Plays the hand on the table to its end, by folding round to the big blind, and clears it away. */
function foldOut(t: TestTable): void {
  while (t.state.hand?.stage === 'betting') {
    const seat = t.toAct!;
    t.fold(t.ids.indexOf(t.state.seats[seat]!.playerId));
  }

  t.finishHand();
}

function seatOf(t: TestTable, player: number): number {
  return t.state.seats.findIndex((seat) => seat?.playerId === t.ids[player]);
}

/** A copy of a seat as it stands, to compare with after it has moved. */
const copy = (seat: Seat | null): Seat => structuredClone(seat!);

test('a player who is not in a hand moves at once, taking everything about their seat with them', () => {
  const t = new TestTable({ stacks: [1000, 700, 500], config: { allowStraddle: true } });
  t.cmd(1, { type: 'setStraddle', on: true });
  t.cmd(1, { type: 'sitOut' });
  const before = copy(t.state.seats[1]!);

  move(t, 0, 1, 6);

  assert.equal(t.state.seats[1], null);
  assert.deepEqual(t.state.seats[6], before);
  assert.equal(t.view(2).seats[6]!.name, 'P1');
  assert.equal(t.feedText().at(-1), 'The host moved P1 to seat 7');
  assertInvariants(t.state, t.now);
});

test('during a hand, a player not dealt into it moves at once and the hand plays on', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.cmd(2, { type: 'sitOut' });
  t.deal({ button: 0 });

  move(t, 0, 2, 8);
  assert.equal(seatOf(t, 2), 8);
  assert.equal(t.view(0).seats[8]!.inHand, false);

  foldOut(t);
  assert.equal(seatOf(t, 2), 8);
  assertInvariants(t.state, t.now);
});

test('a player dealt into the hand moves when it ends, and until then everyone can see the move coming', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { maxBuyIn: 5000 } });
  t.deal({ button: 0 });

  // Chips bought mid-hand wait for its end like the move does, and come with the player to the new seat
  t.cmd(1, { type: 'requestRebuy', amount: 300 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  move(t, 0, 1, 5);

  assert.equal(seatOf(t, 1), 1, 'the move happened in the middle of the hand');
  assert.equal(t.state.seats[1]!.moveTo, 5);
  assert.equal(t.view(2).seats[1]!.moveTo, 5);
  assert.equal(t.feedText().at(-1), 'The host moves P1 to seat 6 after this hand');

  foldOut(t);

  assert.equal(t.state.seats[1], null);
  assert.equal(t.state.seats[5]!.moveTo, null);
  assert.equal(t.state.seats[5]!.pendingAdd, 0);
  assert.deepEqual(t.stacks(), [1000, 1000 - 10 + 300, 1000 + 10]);
  assert.ok(t.feedText().includes('P1 moves to seat 6'));
  assertInvariants(t.state, t.now);
});

test('a move that waited is dropped, and the chat says so, when its seat was taken in the meantime', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.ids.push(addMember(t.state, 'Newcomer', t.ctx()).id);
  t.deal({ button: 0 });

  move(t, 0, 1, 5);
  t.cmd(3, { type: 'requestSeat', seat: 5, buyIn: 400 });
  t.cmd(0, { type: 'approve', playerId: t.ids[3]! });
  foldOut(t);

  assert.equal(seatOf(t, 1), 1);
  assert.equal(seatOf(t, 3), 5);
  assert.equal(t.state.seats[1]!.moveTo, null);
  assert.ok(t.feedText().includes('Seat 6 was taken, so P1 stays in seat 2'));
  assertInvariants(t.state, t.now);
});

test('two moves waiting for the same seat: the first one takes it and the second stays put', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  move(t, 0, 1, 5);
  move(t, 0, 2, 5);
  foldOut(t);

  assert.equal(seatOf(t, 1), 5);
  assert.equal(seatOf(t, 2), 2);
  assert.ok(t.feedText().includes('Seat 6 was taken, so P2 stays in seat 3'));
});

test('a player who leaves before their move happens takes it with them, and cannot be moved on their way out', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  move(t, 0, 1, 5);
  t.cmd(1, { type: 'standUp' });
  assert.equal(t.state.seats[1]!.moveTo, null);
  assert.throws(() => move(t, 0, 1, 6), { name: 'GameError', message: 'P1 is giving up their seat when this hand ends' });

  foldOut(t);

  assert.equal(t.state.seats[1], null);
  assert.equal(t.state.seats[5], null);
  assertInvariants(t.state, t.now);
});

test('a player in a run-it-twice vote still votes, and moves once the boards are out', () => {
  const t = new TestTable({ stacks: [500, 500, 500], config: { allowRunItTwice: true } });
  t.cmd(2, { type: 'sitOut' });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Ks Kh' }, board: '2c 7d 9h 3s 4s', secondBoard: '5c 6c 8d Jd Qc' });
  t.raise(t.toAct === 0 ? 0 : 1, 500);
  t.call(t.toAct === 0 ? 0 : 1);
  assert.equal(t.state.hand!.stage, 'ritVote');

  move(t, 0, 0, 4);
  move(t, 0, 2, 7);
  assert.equal(seatOf(t, 0), 0, 'a voter was moved out from under the vote');
  assert.equal(seatOf(t, 2), 7, 'a player watching the vote waited for nothing');

  t.cmd(0, { type: 'ritVote', agree: true });
  t.cmd(1, { type: 'ritVote', agree: true });
  t.runToResult();
  assert.equal(t.state.hand!.runs, 2);
  t.finishHand();

  assert.equal(seatOf(t, 0), 4);
  assert.equal(t.stacks().reduce((sum, stack) => sum + stack, 0), 1500);
  assertInvariants(t.state, t.now);
});

test('a shuffle keeps every seated player seated once, with the same chips and the same everything else, in the seats already taken', () => {
  const t = new TestTable({ stacks: [1000, 250, 3000, 40, 777, 1200], config: { allowStraddle: true } });
  t.cmd(1, { type: 'sitOut' });
  t.cmd(2, { type: 'setStraddle', on: true });
  move(t, 0, 3, 8);

  const taken = (seats: (Seat | null)[]) => seats.flatMap((seat, index) => (seat ? [index] : []));
  const byPlayer = (seats: (Seat | null)[]) => Object.fromEntries(seats.flatMap((seat) => (seat ? [[seat.playerId, seat]] : [])));
  const before = structuredClone(t.state.seats);

  let moved = 0;
  for (let round = 0; round < 6; round++) {
    const last = t.state.seats.map((seat) => seat?.playerId);
    t.cmd(0, { type: 'shuffleSeats' });

    assert.deepEqual(taken(t.state.seats), taken(before), 'a shuffle changed which seats are open');
    assert.deepEqual(byPlayer(t.state.seats), byPlayer(before), 'a shuffle changed something about a player besides their seat');
    assert.equal(t.state.buttonSeat, null);
    moved += t.state.seats.some((seat, index) => seat?.playerId !== last[index]) ? 1 : 0;
  }

  assert.ok(moved >= 5, 'shuffling hardly ever changed the seats');
  assert.equal(t.feedText().at(-1), 'The host shuffled the seats');
  assertInvariants(t.state, t.now);
});

test('a shuffle during a hand waits for it to end, and no single move can be made or left waiting until then', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.deal({ button: 0 });
  move(t, 0, 1, 7);

  t.cmd(0, { type: 'shuffleSeats' });
  assert.equal(t.state.shuffleAfterHand, true);
  assert.equal(t.state.seats[1]!.moveTo, null, 'a move was left to be undone by the shuffle');
  assert.equal(t.view(2).shuffleAfterHand, true);
  assert.equal(t.feedText().at(-1), 'The host shuffles the seats after this hand');
  assert.throws(() => move(t, 0, 2, 7), { name: 'GameError', message: 'The seats are being shuffled when this hand ends' });

  // Asking again changes nothing and says nothing
  const lines = t.feedText().length;
  t.cmd(0, { type: 'shuffleSeats' });
  assert.equal(t.feedText().length, lines);

  const seated = new Set(t.state.seats.map((seat) => seat?.playerId));
  foldOut(t);

  assert.equal(t.state.shuffleAfterHand, false);
  assert.deepEqual(new Set(t.state.seats.map((seat) => seat?.playerId)), seated);
  assert.ok(t.feedText().includes('The seats are shuffled'));
  assertInvariants(t.state, t.now);
});

test('a single move leaves the button on its seat, so the next hand passes it on from there', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.deal({ button: 1 });
  foldOut(t);
  assert.equal(t.state.buttonSeat, 1);

  // The player with the button leaves it behind, for the seat after it to take next
  move(t, 0, 1, 7);
  assert.equal(t.state.buttonSeat, 1);

  t.cmd(0, { type: 'start' });
  t.wait(5000);
  assert.equal(t.state.hand!.button, 2);
});

test('after a shuffle the next hand draws the button afresh, as for a table\'s first hand', () => {
  const buttons = new Set<number>();

  for (let seed = 1; seed <= 12; seed++) {
    const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], seed });
    t.deal({ button: 0 });
    foldOut(t);
    t.cmd(0, { type: 'shuffleSeats' });
    assert.equal(t.state.buttonSeat, null);

    t.rng = seededRng(seed * 31);
    t.cmd(0, { type: 'start' });
    t.wait(5000);
    buttons.add(t.state.hand!.button);
  }

  assert.ok(buttons.size >= 3, `the button after a shuffle always landed on the same few seats: ${[...buttons].join(', ')}`);
});

test('a request for a seat someone has just been moved into is turned away like one for a seat given out', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.ids.push(addMember(t.state, 'Asker', t.ctx()).id);
  t.cmd(2, { type: 'requestSeat', seat: 6, buyIn: 400 });

  move(t, 0, 1, 6);

  assert.deepEqual(t.state.requests, []);
  assert.deepEqual(t.feedText().slice(-2), ['The host moved P1 to seat 7', 'Seat 7 is taken, so Asker needs to pick another']);
  assert.throws(() => t.cmd(2, { type: 'requestSeat', seat: 6, buyIn: 400 }), { message: 'That seat is taken' });
});

test('a request for chips follows its player to the new seat', () => {
  const t = new TestTable({ stacks: [1000, 1000], config: { maxBuyIn: 5000 } });
  t.ids.push(addMember(t.state, 'Asker', t.ctx()).id);
  t.cmd(2, { type: 'requestSeat', seat: 2, buyIn: 400 });
  t.cmd(0, { type: 'approve', playerId: t.ids[2]! });
  t.cmd(2, { type: 'requestRebuy', amount: 300 });

  move(t, 0, 2, 9);
  assert.equal(t.state.requests[0]!.seat, 9);

  t.cmd(0, { type: 'approve', playerId: t.ids[2]! });
  assert.equal(t.state.seats[9]!.stack, 700);
});

test('a move is refused when it can\'t be made, and moving a player to their own seat takes back a move that is waiting', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id);

  assert.throws(() => move(t, 0, 1, 2), { message: 'Seat 3 is taken' });
  assert.throws(() => move(t, 0, 3, 5), { message: "Watcher doesn't have a seat" });
  assert.throws(() => move(t, 0, 1, 10), { message: 'The seat must be a whole number from 0 to 9' });
  assert.throws(() => t.cmd(0, { type: 'moveSeat', playerId: 'NOBODY12', seat: 5 }), { message: 'That player is no longer at the table' });

  t.deal({ button: 0 });
  move(t, 0, 1, 5);
  move(t, 0, 1, 1);
  assert.equal(t.state.seats[1]!.moveTo, null);
  assert.equal(t.feedText().at(-1), 'P1 stays in seat 2');

  foldOut(t);
  assert.equal(seatOf(t, 1), 1);
});

test('a co-host moves and shuffles too, named as one in the chat, and a plain member is refused both', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });

  move(t, 1, 0, 5);
  assert.equal(t.feedText().at(-1), 'Co-host P1 moved P0 to seat 6');
  t.cmd(1, { type: 'shuffleSeats' });
  assert.equal(t.feedText().at(-1), 'Co-host P1 shuffled the seats');

  const before = JSON.stringify(t.state);
  assert.throws(() => move(t, 2, 2, 8), { name: 'GameError', message: 'Only the host or a co-host can do that' });
  assert.throws(() => t.cmd(2, { type: 'shuffleSeats' }), { message: 'Only the host or a co-host can do that' });
  assert.equal(JSON.stringify(t.state), before);
});

test('there is nothing to shuffle with fewer than two seated', () => {
  const t = new TestTable({ stacks: [1000] });

  assert.throws(() => t.cmd(0, { type: 'shuffleSeats' }), { message: 'Shuffling takes at least two seated players' });
});
