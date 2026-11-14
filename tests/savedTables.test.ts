import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { owes, replayHand, STATE_SCHEMA, TIMING, upgradeRecord } from '../src/engine/index.ts';
import type { HandRecord, TableState } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { checkAround, handRecords, seededRng, TestTable } from './helpers.ts';
import { assertHandRecordsHold, assertInvariants } from './invariants.ts';
import { randomStep } from './randomPlay.ts';

// Tables as older code saved them, written once by scripts/goldenTables.ts
const FOLDER = new URL('./fixtures/tables/', import.meta.url);
const FILES = readdirSync(FOLDER)
  .filter((file) => file.endsWith('.json'))
  .sort();

// Saved by the last code of schema 3, with everything added to a table while that schema lasted
const LAST_OF_SCHEMA_3 = 'schema3-with-straddle-and-missed-blinds.json';

// Saved while schema 3 lasted, before the night's numbers were kept
const SCHEMA_3 = FILES.filter((file) => /^schema[23]-/.test(file));

// The rest of those were saved as schema 3 began, before any of it was added
const OLDEST = SCHEMA_3.filter((file) => file !== LAST_OF_SCHEMA_3);

const HANDS_TO_PLAY = 4;
const STEP_LIMIT = 3000;

function load(file: string): TableState {
  return restoreState(readFileSync(new URL(file, FOLDER), 'utf8'));
}

function handsFinished(t: TestTable): number {
  return handRecords(t.effects).length;
}

test('there is a saved table for every state a new version has to pick a game up from', () => {
  assert.deepEqual(FILES, [
    'schema2-betting-straddle-side-pot.json',
    'schema3-betting-straddle-side-pot.json',
    'schema3-done-bounty-paid.json',
    'schema3-run-it-twice-vote.json',
    'schema3-runout-two-boards.json',
    'schema3-waiting-requests.json',
    'schema3-with-straddle-and-missed-blinds.json',
    ...FILES.slice(7),
  ]);
});

FILES.forEach((file, index) => {
  test(`a table saved as ${file} still loads, and the game goes on from where it stopped`, () => {
    const state = load(file);
    assert.equal(state.schema, STATE_SCHEMA);

    const t = TestTable.adopt(state);
    assertInvariants(t.state, t.now);

    // What was waiting on the host when the table was saved can still be granted
    for (const request of [...t.state.requests]) {
      t.cmd(0, { type: 'approve', playerId: request.playerId });
    }

    if (!t.state.running) {
      t.cmd(0, { type: 'start' });
    }

    const rng = seededRng(1000 + index);
    for (let step = 0; step < STEP_LIMIT && handsFinished(t) < HANDS_TO_PLAY; step++) {
      randomStep(t, rng);
      assertInvariants(t.state, t.now);
    }

    assert.equal(handsFinished(t), HANDS_TO_PLAY, 'the game stalled');
    assertHandRecordsHold(t.effects);
  });
});

test('the table from schema 2 comes out the same as the one saved a schema later', () => {
  assert.deepEqual(load('schema2-betting-straddle-side-pot.json'), load('schema3-betting-straddle-side-pot.json'));
});

test('a hand saved before hands kept events has none, and the next hand has them from its start', () => {
  const t = TestTable.adopt(load('schema3-betting-straddle-side-pot.json'));
  assert.deepEqual(t.state.hand!.events, []);

  t.fold(3);
  assert.deepEqual(t.state.hand!.events, [], 'a hand picked up halfway cannot be followed from its start, so it keeps no events');

  t.fold(4);
  while (handsFinished(t) === 0) {
    t.wait(t.state.hand!.deadline! - t.now);
  }

  const [finished] = handRecords(t.effects);
  assert.deepEqual(finished!.events, []);
  assert.equal(t.state.hand!.events[0]![0], 'start', 'the hand dealt next is recorded from its first event');
});

test('a table saved before co-hosts loads with none, and its host can name one', () => {
  for (const file of OLDEST.filter((name) => !JSON.parse(readFileSync(new URL(name, FOLDER), 'utf8')).cohostIds)) {
    const t = TestTable.adopt(load(file));
    assert.deepEqual(t.state.cohostIds, [], file);

    t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });
    assert.equal(t.view(1).you.role, 'cohost', file);
  }
});

test('a table saved before tables could play dollars and cents is a whole-chip table, and goes on saying so', () => {
  for (const file of OLDEST) {
    assert.equal(load(file).config.unit, 'chips', file);
  }

  const t = TestTable.adopt(load('schema3-waiting-requests.json'));
  for (const request of [...t.state.requests]) {
    t.cmd(0, { type: 'approve', playerId: request.playerId });
  }
  t.cmd(0, { type: 'start' });
  t.wait(TIMING.startDelayMs);

  assert.ok(t.feedText().includes('P1 adds 500') && t.feedText().includes('P2 sits down with 600'), t.feedText().join(' / '));
  assert.match(t.state.hand!.log[0]!, / · blinds 10\/20 · /);
});

test('a table saved before antes has none, its hand in play holds no dead money, and an ante set on it is posted from the next hand', () => {
  for (const file of OLDEST) {
    const state = load(file);

    assert.deepEqual([state.config.ante, state.config.anteFrom], [0, 'everyone'], file);
    assert.ok((state.hand?.players ?? []).every((player) => player.dead === 0), file);
  }

  const t = TestTable.adopt(load('schema3-betting-straddle-side-pot.json'));
  t.cmd(0, { type: 'updateConfig', config: { ante: 20, anteFrom: 'bigBlind' } });
  assertInvariants(t.state, t.now);

  t.fold(3);
  t.fold(4);
  while (handsFinished(t) === 0) {
    t.wait(t.state.hand!.deadline! - t.now);
  }

  const hand = t.state.hand!;
  assert.match(hand.log[0]!, / · blinds 10\/20 · BB ante 20 · /);
  assert.equal(hand.players.find((player) => player.seat === hand.bbSeat)!.dead, 20);
  assertInvariants(t.state, t.now);
});

test('a table saved before bomb pots has none called or counted, a hand in play that is an ordinary one, and the amount a new table of its kind starts with', () => {
  for (const file of OLDEST) {
    const state = load(file);

    assert.deepEqual([state.bombPotCalled, state.handsSinceBombPot, state.config.bombPotAmount, state.config.bombPotEvery, state.config.bombPotBoards], [false, 0, 100, 0, 'one'], file);
    assert.equal(state.hand === null ? null : state.hand.bombPot, null, file);
  }

  // A table of dollars and cents starts a setting added since where a new one of its kind does
  const cents = new TestTable({ stacks: [5000, 5000], config: { unit: 'cents', bombPotAmount: 900 } });
  const { bombPotAmount: _amount, bombPotEvery: _every, ...asOnceSaved } = cents.state.config;
  const restored = restoreState(JSON.stringify({ ...cents.state, config: asOnceSaved }));
  assert.deepEqual([restored.config.bombPotAmount, restored.config.bombPotEvery, restored.config.smallBlind], [250, 0, 25]);
});

test('a table saved in the middle of a hand before missed blinds finishes that hand, moves the button on once as it used to, and follows the dead button from there', () => {
  for (const file of OLDEST) {
    const state = load(file);

    assert.deepEqual([state.blinds, state.config.missedBlinds], [null, 'owed'], file);
    assert.ok(state.seats.every((seat) => !seat || (!owes(seat) && !seat.postsOwed)), file);
  }

  // Five players, the button on seat 0, and the hand before the flop
  const t = TestTable.adopt(load('schema3-betting-straddle-side-pot.json'));
  t.cmd(0, { type: 'pause' });
  assert.deepEqual([t.state.hand!.button, t.state.hand!.sbSeat, t.state.hand!.bbSeat], [0, 1, 2]);

  t.fold(3);
  t.fold(4);
  while (handsFinished(t) === 0) {
    t.wait(t.state.hand!.deadline! - t.now);
  }
  t.finishHand();
  assert.equal(t.state.blinds, null, 'the hand it was saved in left blinds behind that it never recorded');

  // Nothing says where that hand's blinds were, so the next starts from the button alone, as every hand used to
  t.deal();
  assert.deepEqual([t.state.hand!.button, t.state.hand!.sbSeat, t.state.hand!.bbSeat], [1, 2, 3]);
  assert.deepEqual(t.state.blinds, { small: 2, big: 3 });
  assertInvariants(t.state, t.now);

  // From here a player who steps out is owed for: the big blind passes seat 4, and the button is dead on seat 2
  const seated = (seat: number) => t.ids.indexOf(t.state.seats[seat]!.playerId);
  for (const seat of [4, 0, 1, 2]) {
    t.fold(seated(seat));
  }
  t.finishHand();
  t.cmd(seated(4), { type: 'sitOut' });
  t.cmd(seated(2), { type: 'sitOut' });
  t.deal();

  assert.deepEqual([t.state.hand!.button, t.state.hand!.sbSeat, t.state.hand!.bbSeat], [2, 3, 0]);
  assert.match(t.state.hand!.log[0]!, / · dead button on seat 3$/);
  assert.deepEqual([t.state.seats[4]!.owesBigBlind, t.state.seats[4]!.owesSmallBlind, t.state.seats[2]!.owesBigBlind], [true, true, false]);
  assertInvariants(t.state, t.now);
});

test('a bomb pot saved in the middle by the code before there were two boards goes on as it was, on one', () => {
  // A bomb pot on one board says nothing of boards, so one saved by the code before is this one without the setting
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { maxRuns: 2 } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh' }, board: '2c 7d 9h Jc 3s' });
  t.check(1);
  assert.deepEqual(t.state.hand!.bombPot, { amount: 100 });

  const { bombPotBoards: _boards, ...asOnceSaved } = t.state.config;
  const restored = TestTable.adopt(restoreState(JSON.stringify({ ...t.state, config: asOnceSaved })));
  assert.equal(restored.state.config.bombPotBoards, 'one');
  assert.deepEqual([restored.state.hand!.boards, restored.state.hand!.runs], [[['2c', '7d', '9h']], 1]);
  assertInvariants(restored.state, restored.now);

  restored.check(2);
  restored.check(0);
  assert.deepEqual(restored.state.hand!.boards, [['2c', '7d', '9h', 'Jc']], 'the turn comes on its one board');
  assert.deepEqual(replayHand(restored.state.hand!.events)!.boards, restored.state.hand!.boards);

  // Its settings can be changed from there, and the bomb pot after this one is on two
  restored.cmd(0, { type: 'updateConfig', config: { bombPotBoards: 'two', bombPotEvery: 1 } });
  checkAround(restored, [1, 2, 0], 2);
  restored.finishHand();
  assertHandRecordsHold(restored.effects);

  restored.deal();
  assert.deepEqual([restored.state.hand!.bombPot, restored.state.hand!.boards.length], [{ amount: 100, boards: 2 }, 2]);
});

test('a table saved when a hand had one straddle, kept as its seat, has it as a line of one, and every player who asked to straddle still posts under the gun', () => {
  for (const file of SCHEMA_3) {
    const state = load(file);
    const before = JSON.parse(readFileSync(new URL(file, FOLDER), 'utf8')) as { seats: ({ straddle: boolean } | null)[]; hand: { straddleSeat: number | null } | null };

    // Nothing but the kind there was is allowed, so the table plays as it did until its host says otherwise
    assert.deepEqual([state.config.allowStraddle, state.config.allowDoubleStraddle, state.config.allowButtonStraddle, state.config.allowMississippiStraddle], [true, false, false, false], file);
    assert.deepEqual(state.seats.map((seat) => seat && seat.straddles), before.seats.map((seat) => seat && (seat.straddle ? ['straddle'] : [])), file);
    assert.ok(state.seats.every((seat) => !seat || !('straddle' in seat)), file);

    if (state.hand) {
      const straddler = before.hand!.straddleSeat;

      assert.deepEqual(state.hand.straddles, straddler === null ? [] : [{ seat: straddler, what: 'straddle', amount: 40 }], file);
      assert.deepEqual([state.hand.passedOver, 'straddleSeat' in state.hand], [[], false], file);
    }
  }

  // Seat 2 straddled under the gun and has a raise to 160 to answer, with seats 1 and 5 waiting to straddle in their turn
  const t = TestTable.adopt(load(LAST_OF_SCHEMA_3));
  const hand = t.state.hand!;

  assert.deepEqual([hand.straddles, hand.currentBet, t.toAct], [[{ seat: 2, what: 'straddle', amount: 40 }], 160, 1]);
  assert.deepEqual(t.state.seats.slice(0, 6).map((seat) => seat!.straddles.join()), ['', 'straddle', 'straddle', '', '', 'straddle']);
  assert.deepEqual(t.view(t.playerIn(2)).hand!.straddles, hand.straddles);
  assertInvariants(t.state, t.now);

  // The hand it was saved in plays out: the big blind folds, the straddler calls what is left of the raise, and seat 3 folds
  t.cmd(0, { type: 'pause' });
  t.fold(t.playerIn(1));
  assert.deepEqual([t.toAct, t.view(t.playerIn(2)).hand!.options!.callAmount], [2, 120]);
  t.call(t.playerIn(2));
  t.fold(t.playerIn(3));
  assert.equal(hand.street, 'flop');

  t.check(t.playerIn(2));
  t.raise(t.playerIn(4), 100);
  t.fold(t.playerIn(2));
  t.finishHand();
  assertHandRecordsHold(t.effects);
  assert.deepEqual(replayHand(handRecords(t.effects)[0]!.events)!.seats.map((seat) => seat.stack), [0, 1, 2, 3, 4, 5].map((seat) => t.state.seats[seat]!.stack));

  // The button moves on to seat 0. Seats 3 and 4 are under the gun in turn without having asked, and then seat 5, who had
  for (const straddles of [[], [], [{ seat: 5, what: 'straddle', amount: 40 }]]) {
    t.deal();
    assert.deepEqual(t.state.hand!.straddles, straddles, `hand ${t.state.hand!.number}`);
    assertInvariants(t.state, t.now);
    t.foldOut();
  }

  // The kinds added since are the host's to allow, and a player's to ask for, on the table as it was saved
  t.cmd(0, { type: 'updateConfig', config: { allowButtonStraddle: true } });
  t.cmd(t.playerIn(3), { type: 'setStraddle', kind: 'button straddle', on: true });
  t.deal();
  assert.deepEqual([t.state.hand!.button, t.state.hand!.straddles], [3, [{ seat: 3, what: 'button straddle', amount: 40 }]]);
  assertInvariants(t.state, t.now);
});

test('a table saved before the night’s numbers were kept loads with nothing counted and says how many hands it missed, and a hand it was saved in the middle of is the first one counted', () => {
  for (const file of SCHEMA_3) {
    const state = load(file);
    const { tonight, ledger } = TestTable.adopt(state).view(0);

    assert.deepEqual(state.tonight, { hands: 0, players: {} }, file);
    assert.deepEqual([tonight.hands, tonight.missed], [0, state.handCount - (state.hand ? 1 : 0)], file);
    assert.deepEqual(tonight.players.map((row) => [row.playerId, row.net, row.hands]).sort(), ledger.map((row) => [row.playerId, row.net, 0]).sort(), file);
  }

  const t = TestTable.adopt(load(LAST_OF_SCHEMA_3));
  const dealtIn = t.state.hand!.players.map((player) => player.playerId).sort();
  const missed = t.state.handCount - 1;
  assert.ok(missed > 0 && dealtIn.length > 0);

  t.cmd(0, { type: 'pause' });
  t.foldOut();

  assert.deepEqual([t.view(0).tonight.hands, t.view(0).tonight.missed], [1, missed]);
  assert.deepEqual(Object.keys(t.state.tonight.players).sort(), dealtIn);
  assert.ok(Object.values(t.state.tonight.players).every((numbers) => numbers.hands === 1));
  assert.equal(Object.values(t.state.tonight.players).filter((numbers) => numbers.won === 1).length, 1, 'the hand it was saved in had one winner');
  assertInvariants(t.state, t.now);
});

test('a table saved before the last hands could be called has none called, and its night goes on', () => {
  for (const file of OLDEST) {
    const state = load(file);

    assert.deepEqual([state.lastHand, state.nightEndedAt], [null, null], file);
  }
});

test('a table saved when running it more than once was a yes or no to twice: on is up to twice, off is once only, and each yes is a pick of twice', () => {
  for (const file of FILES) {
    const raw = JSON.parse(readFileSync(new URL(file, FOLDER), 'utf8')) as { config: { allowRunItTwice?: boolean }; hand: { players: { ritVote: boolean | null }[] } | null };
    const state = load(file);

    assert.equal(state.config.maxRuns, raw.config.allowRunItTwice === false ? 1 : 2, file);
    assert.ok(!('allowRunItTwice' in state.config), file);
    assert.deepEqual(state.hand?.players.map((player) => player.ritVote), raw.hand?.players.map((player) => (player.ritVote === null ? null : player.ritVote ? 2 : 1)), file);
    assert.ok((state.hand?.events ?? []).every((event) => event[0] !== 'vote' || typeof event[2] === 'number'), file);
  }

  // Saved in the middle of the vote, one player having said yes: they picked twice, and twice is the most the other can pick
  const voting = TestTable.adopt(load('schema4-run-it-twice-vote.json'));
  assert.deepEqual(voting.state.hand!.events.filter((event) => event[0] === 'vote'), [['vote', 0, 2]]);
  assert.deepEqual([voting.view(2).hand!.canVote, voting.view(2).seats[0]!.ritVote], [true, 2]);
  assert.throws(() => voting.cmd(2, { type: 'ritVote', runs: 3 }), { message: 'This table runs it twice at most' });
  voting.cmd(2, { type: 'ritVote', runs: 2 });
  assert.ok(voting.feedText().includes('Everyone agreed: running it twice'));
  voting.runToResult();
  assert.equal(voting.state.hand!.boards.length, 2);
  voting.finishHand();
  assertHandRecordsHold(voting.effects);

  // Saved between the two runs: the second board is dealt on, and the hand is paid on both
  const between = TestTable.adopt(load('schema4-runout-two-boards.json'));
  assert.deepEqual(between.state.hand!.boards.map((board) => board.length), [5, 4]);
  between.runToResult();
  assert.ok(between.state.hand!.result!.pots[0]!.awards.some((award) => award.run === 1));
  between.finishHand();
  assertHandRecordsHold(between.effects);
  assertInvariants(between.state, between.now);

  // Saved with run it twice off, while the hand was run out once: it is run out once, as it would have been
  const off = TestTable.adopt(load('schema4-runout-run-it-twice-off.json'));
  assert.deepEqual([off.state.config.maxRuns, off.state.hand!.stage, off.state.hand!.runs], [1, 'runout', 1]);
  off.finishHand();
  assertHandRecordsHold(off.effects);
  assert.equal(handRecords(off.effects)[0]!.boards.length, 1);
});

test('a hand record saved when a pick was a yes or no to twice reads each as the number of runs it was', () => {
  const t = new TestTable({ stacks: [500, 500], config: { maxRuns: 2 } });
  t.deal({ button: 0 });
  t.raise(0, 500);
  t.call(1);
  t.cmd(0, { type: 'ritVote', runs: 2 });
  t.cmd(1, { type: 'ritVote', runs: 1 });
  t.finishHand();

  const [record] = handRecords(t.effects);
  const asOnceSaved = JSON.parse(JSON.stringify(record).replace('["vote",0,2]', '["vote",0,true]').replace('["vote",1,1]', '["vote",1,false]')) as HandRecord;
  assert.deepEqual(asOnceSaved.events.filter((event) => event[0] === 'vote'), [['vote', 0, true], ['vote', 1, false]]);

  assert.deepEqual(upgradeRecord(asOnceSaved), record);
});
