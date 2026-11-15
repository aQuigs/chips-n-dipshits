/*
 * Hands as every schema recorded them, read the way the history reads the Hands tab and played back.
 * scripts/goldenRecords.ts says how the files came to be.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { noReplayLine } from '../src/client/replayPlayer.ts';
import { handFacts, replaySteps, replayView, STATE_SCHEMA, upgradeRecord } from '../src/engine/index.ts';
import type { HandRecord } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';
import { assertEventsRetellTheHand, assertRecordBalances } from './invariants.ts';

const FOLDER = new URL('./fixtures/records/', import.meta.url);
const FILES = readdirSync(FOLDER).filter((file) => file.endsWith('.json')).sort();

/** A record as the history hands it to the page: read from its cell and brought up to date. */
const recordIn = (file: string): HandRecord => upgradeRecord(JSON.parse(readFileSync(new URL(file, FOLDER), 'utf8')));
const schemaOf = (file: string) => Number(/^schema(\d+)-/.exec(file)![1]);

// A table as it is now, which is what a replay is shown at whenever the hand was played
const NOW = new TestTable({ stacks: [1000, 1000, 1000] }).view(0);

test('there is a record from every schema a hand was ever recorded under', () => {
  const schemas = new Set(FILES.map(schemaOf));

  for (let schema = 2; schema <= STATE_SCHEMA; schema++) {
    assert.ok(schemas.has(schema), `no hand recorded under schema ${schema}: run scripts/goldenRecords.ts before changing what a record holds`);
  }
});

test('every recorded hand, from every schema, replays to its recorded result or is told as text with the reason', () => {
  const told: string[] = [];

  for (const file of FILES) {
    const record = recordIn(file);
    const steps = replaySteps(record, NOW.config);

    assertRecordBalances(record);
    assertEventsRetellTheHand(record);

    if (!steps) {
      told.push(file);
      assert.ok(record.summary.length > 0, `${file} has no text to be told as`);
      assert.equal(noReplayLine(record, NOW.config), 'This hand was recorded before hands could be replayed, so here it is as text.', file);
      continue;
    }

    assert.equal(noReplayLine(record, NOW.config), null, file);

    const total = record.players.reduce((sum, player) => sum + player.startStack, 0);
    for (const step of steps) {
      const view = replayView(record, step, NOW);
      const stacks = view.seats.reduce((sum, seat) => sum + (seat?.stack ?? 0), 0);

      assert.equal(stacks + view.hand!.pot, total, `${file}: the chips do not add up after ${step.events} events`);
    }

    const end = replayView(record, steps.at(-1)!, NOW);
    assert.equal(end.hand!.stage, 'done', file);
    assert.deepEqual(end.hand!.result, record.result, `${file} ends on another result`);
    assert.deepEqual(end.hand!.boards, record.boards, `${file} ends on other boards`);
    assert.deepEqual(end.seats.flatMap((seat) => (seat ? [[seat.seat, seat.name, seat.stack, seat.cards]] : [])), record.players.map((player) => [player.seat, player.name, player.endStack, player.cards]), `${file} ends on other stacks or cards`);
    assert.equal(handFacts(record).players.length, end.seats.filter((seat) => seat !== null).length);
  }

  // Schema 2 recorded no events. Every hand recorded since replays, and one that stops is a hand players can no longer watch
  assert.deepEqual(told, FILES.filter((file) => schemaOf(file) === 2));
});

test('a bounty recorded before bounties named their hand is told as the seven-deuce bounty it was', () => {
  for (const file of FILES.filter((name) => name.endsWith('-shown-and-hunted.json'))) {
    const lines = replaySteps(recordIn(file), NOW.config)!.flatMap((step) => step.lines);

    assert.ok(lines.includes('P0 collects 100 for the 72 bounty'), `${file} tells its bounty as ${lines.filter((line) => line.includes('bounty')).join(', ')}`);
  }
});

test('a hand that lost its events since replays came is told as text too, and is not said to be from before them', () => {
  const recent = recordIn(`schema${STATE_SCHEMA}-showdown.json`);

  assert.equal(noReplayLine({ ...recent, events: [] }, NOW.config), 'This hand cannot be replayed, so here it is as text.');
  assert.equal(noReplayLine({ ...recent, events: recent.events.slice(0, -1) }, NOW.config), 'This hand cannot be replayed, so here it is as text.');
});

test('the hands of the newest schema tell their whole story: every part, and each thing only a newer hand has', () => {
  const parts = (name: string) => [...new Set(replaySteps(recordIn(`schema${STATE_SCHEMA}-${name}.json`), NOW.config)!.map((step) => step.part))];

  assert.deepEqual(parts('showdown'), ['Preflop', 'Flop', 'Turn', 'River', 'Showdown']);
  assert.deepEqual(parts('ante-folded'), ['Preflop', 'End']);
  assert.deepEqual(parts('all-in-run-three-times'), ['Preflop', 'Flop', 'Turn', 'River', 'Second board', 'Third board', 'Showdown']);
  assert.deepEqual(parts('bomb-pot-two-boards'), ['Preflop', 'Flop', 'Turn', 'River', 'Showdown']);
  assert.deepEqual(parts('chopped'), ['Preflop', 'End']);
  assert.deepEqual(parts('shown-and-hunted'), ['Preflop', 'End']);
});
