import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, endNight, MAX_LAST_HANDS, nightIsOver, TIMING } from '../src/engine/index.ts';
import type { Command, NightEnd } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { ACES, BOARD, handRecords, KINGS, options, TestTable } from './helpers.ts';
import { assertInvariants } from './invariants.ts';

const HOST = 0;
const COHOST = 1;
const PLAYER = 2;

/** Three players seated, the second of them a co-host, and the game on. */
function running(stacks = [1000, 1000, 1000]): TestTable {
  const t = new TestTable({ stacks });
  t.cmd(HOST, { type: 'setCohost', playerId: t.ids[COHOST]!, on: true });
  t.cmd(HOST, { type: 'start' });

  return t;
}

/** The hand a running table deals by itself: the one it went straight on to from the last, or the one it deals after the short wait at the start. */
function nextHand(t: TestTable): void {
  if (!t.state.hand) {
    assert.notEqual(t.state.nextHandAt, null, 'no hand is coming');
    t.wait(t.state.nextHandAt! - t.now);
  }

  assert.notEqual(t.state.hand, null, 'the table did not deal');
}

/** Folds the hand on the table around to one player and lets time pass until it is cleared away. */
function foldAround(t: TestTable): void {
  const number = t.state.hand!.number;

  while (betting(t)) {
    t.fold(t.toAct!);
  }

  while (t.state.hand?.number === number) {
    t.wait(t.state.hand.deadline! - t.now);
  }
}

const betting = (t: TestTable) => t.state.hand?.stage === 'betting';

const nightsEnded = (t: TestTable): NightEnd[] => t.effects.flatMap((effect) => (effect.type === 'nightEnded' ? [effect.night] : []));

const lastLine = (t: TestTable) => t.feedText().at(-1);

test('the host calls the last hands, changes the number and calls them off, and the chat says each', () => {
  const t = running();

  t.cmd(HOST, { type: 'setLastHands', hands: 3 });
  assert.equal(lastLine(t), 'The host calls it a night after 3 more hands');
  assert.equal(t.view(PLAYER).handsLeft, 3);

  t.cmd(COHOST, { type: 'setLastHands', hands: 1 });
  assert.equal(lastLine(t), 'Co-host P1 now calls it a night after 1 more hand');
  assert.equal(t.view(PLAYER).handsLeft, 1);

  // The same number again changes nothing and says nothing
  const said = t.feedText().length;
  t.cmd(HOST, { type: 'setLastHands', hands: 1 });
  assert.equal(t.feedText().length, said);

  t.cmd(HOST, { type: 'setLastHands', hands: null });
  assert.equal(lastLine(t), 'The host called off the last hands, so play goes on');
  assert.equal(t.view(PLAYER).handsLeft, null);

  t.cmd(HOST, { type: 'setLastHands', hands: null });
  assert.equal(t.feedText().length, said + 1, 'calling off what is not called says something');
});

test('the number of hands is a whole number from 1 to the most, or from 0 while a hand is on the table', () => {
  const t = running();

  for (const hands of [0, MAX_LAST_HANDS + 1, -1, 2.5, '3', undefined, true]) {
    assert.throws(() => t.cmd(HOST, { type: 'setLastHands', hands } as unknown as Command), { name: 'GameError', message: `The number of hands must be a whole number from 1 to ${MAX_LAST_HANDS}` }, String(hands));
  }

  t.cmd(HOST, { type: 'setLastHands', hands: MAX_LAST_HANDS });
  assert.equal(t.view(PLAYER).handsLeft, MAX_LAST_HANDS);

  nextHand(t);
  assert.throws(() => t.cmd(HOST, { type: 'setLastHands', hands: -1 }), { message: `The number of hands must be a whole number from 0 to ${MAX_LAST_HANDS}` });
});

test('only the host or a co-host calls the last hands or ends the night: a seated player and a watcher are refused', () => {
  const t = running();
  t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id);

  for (const sender of [PLAYER, 3]) {
    for (const command of [{ type: 'setLastHands', hands: 2 }, { type: 'setLastHands', hands: null }, { type: 'endNight' }] as Command[]) {
      assert.throws(() => t.cmd(sender, command), { name: 'GameError', message: 'Only the host or a co-host can do that' });
    }
  }

  t.cmd(COHOST, { type: 'endNight' });
  assert.equal(lastLine(t), 'Co-host P1 ended the night');
  assert.ok(nightIsOver(t.state));
});

test('the count goes down as each hand dealt is finished, whatever the hand was, and the last one ends the night', () => {
  // Paused, so that each hand is the one dealt here
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { allowRunItTwice: true } });
  t.cmd(HOST, { type: 'setLastHands', hands: 4 });

  t.deal({ button: 0 });
  assert.equal(t.view(PLAYER).handsLeft, 3, 'the hand on the table is counted among the hands left');
  foldAround(t);
  assert.equal(t.view(PLAYER).handsLeft, 3);

  t.deal({ button: 1 });
  t.call(t.toAct!);
  t.call(t.toAct!);
  while (betting(t)) {
    t.check(t.toAct!);
  }
  t.finishHand();
  assert.equal(t.view(PLAYER).handsLeft, 2, 'a hand played to a showdown');

  t.cmd(HOST, { type: 'setBombPot', on: true });
  t.deal({ button: 2 });
  assert.notEqual(t.state.hand!.bombPot, null);
  foldAround(t);
  assert.equal(t.view(PLAYER).handsLeft, 1, 'a bomb pot');

  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD, secondBoard: 'Kd 4c 5h 8s Td' });
  assert.equal(t.view(PLAYER).handsLeft, 0);
  t.raise(t.toAct!, options(t, t.toAct!).maxRaiseTo);
  while (betting(t)) {
    t.call(t.toAct!);
  }
  for (const player of t.state.hand!.players.filter((p) => !p.folded)) {
    t.cmd(t.ids.indexOf(player.playerId), { type: 'ritVote', agree: true });
  }
  t.runToResult();
  assert.equal(t.state.hand!.runs, 2);
  assert.ok(!nightIsOver(t.state), 'the night ended with the last hand still showing its result');

  t.finishHand();
  assert.ok(nightIsOver(t.state), 'a hand run twice');
  assert.equal(lastLine(t), 'That was the last hand. The night is over');
  assert.equal(handRecords(t.effects).length, 4);
  assert.equal(nightsEnded(t).length, 1);
  assertInvariants(t.state, t.now);
});

test('called during a hand, the count leaves that hand out, and none makes it the last', () => {
  const t = running();
  nextHand(t);

  t.cmd(HOST, { type: 'setLastHands', hands: 1 });
  assert.equal(lastLine(t), 'The host calls it a night after this hand and 1 more');
  assert.equal(t.view(PLAYER).handsLeft, 1);
  foldAround(t);
  assert.ok(!nightIsOver(t.state));

  nextHand(t);
  assert.equal(t.view(PLAYER).handsLeft, 0);
  t.cmd(HOST, { type: 'setLastHands', hands: 2 });
  t.cmd(HOST, { type: 'setLastHands', hands: 0 });
  assert.equal(lastLine(t), 'The host now calls it a night after this hand');
  foldAround(t);
  assert.ok(nightIsOver(t.state));
  assert.equal(handRecords(t.effects).length, 2);

  // Nothing is dealt however long the table waits
  t.wait(TIMING.startDelayMs * 100);
  assert.deepEqual([t.state.hand, t.state.nextHandAt, t.state.handCount], [null, null, 2]);
});

test('called while the game is paused, the count waits for hands to be dealt', () => {
  const t = running();
  t.cmd(HOST, { type: 'pause' });
  t.cmd(HOST, { type: 'setLastHands', hands: 1 });
  t.wait(TIMING.startDelayMs * 10);
  assert.equal(t.view(PLAYER).handsLeft, 1);
  assert.ok(!nightIsOver(t.state));

  t.cmd(HOST, { type: 'start' });
  nextHand(t);
  foldAround(t);
  assert.ok(nightIsOver(t.state));
});

test('the night can be ended outright between hands, and not while a hand is being played', () => {
  const t = running();
  nextHand(t);

  const before = JSON.stringify(t.state);
  assert.throws(() => t.cmd(HOST, { type: 'endNight' }), { name: 'GameError', message: 'The night can end once this hand is over: make it the last hand' });
  assert.equal(JSON.stringify(t.state), before);

  // A running table goes straight on to the next hand, so between hands is a paused table, or one short of players
  t.cmd(HOST, { type: 'pause' });
  foldAround(t);
  assert.equal(t.state.hand, null);
  t.cmd(HOST, { type: 'endNight' });
  assert.equal(lastLine(t), 'The host ended the night');
  assert.ok(nightIsOver(t.state));
  assert.equal(t.view(PLAYER).nightEndedAt, t.now);
  assert.deepEqual([t.state.running, t.state.nextHandAt], [false, null]);

  t.wait(TIMING.startDelayMs * 10);
  assert.equal(t.state.hand, null);
});

test('ending a night that is over is refused plainly from the menu and does nothing from the engine', () => {
  const t = running();
  t.cmd(HOST, { type: 'endNight' });
  const before = JSON.stringify(t.state);

  assert.throws(() => t.cmd(COHOST, { type: 'endNight' }), { name: 'GameError', message: 'The night is already over' });
  endNight(t.state, t.ctx(), 'Again');

  assert.equal(JSON.stringify(t.state), before);
  assert.equal(nightsEnded(t).length, 1);
});

test('the end of each night leaves the engine once, however many nights a table has', () => {
  const t = running();
  t.now += 1000;
  t.cmd(HOST, { type: 'endNight' });
  assert.deepEqual(nightsEnded(t), [{ at: t.now, tableId: t.state.id }]);

  t.cmd(COHOST, { type: 'start' });
  assert.equal(lastLine(t), 'Co-host P1 started play again');
  assert.ok(!nightIsOver(t.state));
  assert.equal(t.state.running, true);
  assert.equal(t.view(PLAYER).nightEndedAt, null);
  nextHand(t);
  t.cmd(HOST, { type: 'setLastHands', hands: 0 });
  foldAround(t);

  assert.ok(nightIsOver(t.state));
  assert.equal(nightsEnded(t).length, 2);
  assert.equal(nightsEnded(t)[1]!.at, t.now);

  t.cmd(HOST, { type: 'start' });
  t.cmd(HOST, { type: 'endNight' });
  assert.equal(nightsEnded(t).length, 3);
});

test('starting play again after the night deals again, with no last hands called', () => {
  const t = running();
  t.cmd(HOST, { type: 'setLastHands', hands: 1 });
  nextHand(t);
  foldAround(t);
  assert.equal(t.view(PLAYER).handsLeft, null);

  t.cmd(HOST, { type: 'start' });
  for (let hand = 0; hand < 3; hand++) {
    nextHand(t);
    foldAround(t);
  }

  assert.ok(!nightIsOver(t.state));
  assert.equal(handRecords(t.effects).length, 4);
});

test('when the night ends, requests waiting are dropped and a called bomb pot is called off, while the count to the next bomb pot is kept', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 500], config: { bombPotEvery: 3 } });
  t.ids.push(addMember(t.state, 'Asker', t.ctx()).id);
  t.cmd(HOST, { type: 'start' });
  nextHand(t);
  t.cmd(HOST, { type: 'pause' });
  foldAround(t);

  t.cmd(4, { type: 'requestSeat', seat: 7, buyIn: 500 });
  t.cmd(3, { type: 'requestRebuy', amount: 500 });
  t.cmd(HOST, { type: 'setBombPot', on: true });
  t.cmd(HOST, { type: 'endNight' });

  assert.deepEqual(t.feedText().slice(-4), [
    'The host ended the night',
    'The bomb pot that was called is off',
    "The night is over, so Asker's request for a seat is dropped",
    "The night is over, so P3's request for chips is dropped",
  ]);
  assert.deepEqual(t.state.requests, []);
  assert.equal(t.state.bombPotCalled, false);
  assert.equal(t.state.handsSinceBombPot, 1);
  assertInvariants(t.state, t.now);
});

test('once the night is over, what only makes sense in play is refused, and money, seats and chat still work', () => {
  const t = running([1000, 1000, 1000, 500]);
  t.ids.push(addMember(t.state, 'Late', t.ctx()).id);
  nextHand(t);
  t.cmd(HOST, { type: 'setLastHands', hands: 0 });
  foldAround(t);
  assert.ok(nightIsOver(t.state));

  const refusal = { name: 'GameError', message: 'The night is over, so that waits until play starts again' };
  const refused: [number, Command][] = [
    [4, { type: 'requestSeat', seat: 7, buyIn: 500 }],
    [3, { type: 'requestRebuy', amount: 500 }],
    [HOST, { type: 'requestRebuy', amount: 500 }],
    [HOST, { type: 'setBombPot', on: true }],
    [COHOST, { type: 'setLastHands', hands: 2 }],
    [HOST, { type: 'setLastHands', hands: null }],
  ];
  const before = JSON.stringify(t.state);
  for (const [sender, command] of refused) {
    assert.throws(() => t.cmd(sender, command), refusal, command.type);
  }
  assert.equal(JSON.stringify(t.state), before);

  // Who may not is still told so first
  assert.throws(() => t.cmd(PLAYER, { type: 'setLastHands', hands: 2 }), { message: 'Only the host or a co-host can do that' });

  const p3 = t.state.seats[3]!.stack;
  t.cmd(PLAYER, { type: 'chat', text: 'gg' });
  t.cmd(HOST, { type: 'setStack', playerId: t.ids[PLAYER]!, stack: 900 });
  t.cmd(COHOST, { type: 'transferChips', from: t.ids[PLAYER]!, to: t.ids[3]!, amount: 100 });
  t.cmd(3, { type: 'sitOut' });
  t.cmd(3, { type: 'sitIn' });
  t.cmd(PLAYER, { type: 'standUp' });
  t.cmd(HOST, { type: 'kick', playerId: t.ids[3]! });

  assert.deepEqual(t.feedText().slice(-5), [
    "The host set P2's stack to 900",
    'Co-host P1 moved 100 from P2 to P3',
    'P2 leaves the table with 800',
    'The host removed P3 from their seat',
    `P3 leaves the table with ${p3 + 100}`,
  ]);
  const ledger = t.view(HOST).ledger;
  assert.deepEqual(
    ledger.filter((row) => row.stack === 0).map((row) => row.name),
    ['P2', 'P3'],
  );
  assert.equal(ledger.find((row) => row.name === 'P3')!.cashOut, p3 + 100);
  assert.ok(nightIsOver(t.state));
  assertInvariants(t.state, t.now);
});

test('a table saved mid-countdown, or with the night over, comes back as it was', () => {
  const counting = running();
  nextHand(counting);
  counting.cmd(HOST, { type: 'setLastHands', hands: 2 });

  const restored = restoreState(JSON.stringify(counting.state));
  assert.deepEqual(restored, counting.state);
  assert.equal(TestTable.adopt(restored).view(PLAYER).handsLeft, 2);

  const over = running();
  over.cmd(HOST, { type: 'endNight' });

  const reloaded = TestTable.adopt(restoreState(JSON.stringify(over.state)));
  assert.ok(nightIsOver(reloaded.state));
  assert.throws(() => reloaded.cmd(HOST, { type: 'endNight' }), { message: 'The night is already over' });
  reloaded.cmd(HOST, { type: 'start' });
  assert.ok(!nightIsOver(reloaded.state));
});
