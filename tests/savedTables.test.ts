import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { replayHand, STATE_SCHEMA, TIMING } from '../src/engine/index.ts';
import type { TableState } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { checkAround, handRecords, seededRng, TestTable } from './helpers.ts';
import { assertHandRecordsHold, assertInvariants } from './invariants.ts';
import { randomStep } from './randomPlay.ts';

// Tables as older code saved them, written once by scripts/goldenTables.ts
const FOLDER = new URL('./fixtures/tables/', import.meta.url);
const FILES = readdirSync(FOLDER)
  .filter((file) => file.endsWith('.json'))
  .sort();

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
    ...FILES.slice(6),
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
  for (const file of FILES.filter((name) => !JSON.parse(readFileSync(new URL(name, FOLDER), 'utf8')).cohostIds)) {
    const t = TestTable.adopt(load(file));
    assert.deepEqual(t.state.cohostIds, [], file);

    t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });
    assert.equal(t.view(1).you.role, 'cohost', file);
  }
});

test('a table saved before tables could play dollars and cents is a whole-chip table, and goes on saying so', () => {
  for (const file of FILES) {
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
  for (const file of FILES) {
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
  for (const file of FILES) {
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

test('a bomb pot saved in the middle by the code before there were two boards goes on as it was, on one', () => {
  // A bomb pot on one board says nothing of boards, so one saved by the code before is this one without the setting
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { allowRunItTwice: true } });
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

test('a table saved before the last hands could be called has none called, and its night goes on', () => {
  for (const file of FILES) {
    const state = load(file);

    assert.deepEqual([state.lastHand, state.nightEndedAt], [null, null], file);
  }
});
