import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { STATE_SCHEMA, TIMING } from '../src/engine/index.ts';
import type { TableState } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { handRecords, seededRng, TestTable } from './helpers.ts';
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
