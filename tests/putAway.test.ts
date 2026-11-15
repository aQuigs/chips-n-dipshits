import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTable } from '../src/engine/index.ts';
import type { Effect } from '../src/engine/index.ts';
import { dueToBePutAway, dueToLookAt, lastWordsOf, LOOKED_AT_AT_ONCE, PUT_AWAY_AFTER_MS, PUT_AWAY_AT_ONCE, PUT_AWAY_MESSAGE } from '../src/server/putAway.ts';
import { DAY_MS, seededRng } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 14, 20);

test('a table is old once it has gone two weeks without being saved, to the millisecond, and the message says two weeks', () => {
  assert.equal(PUT_AWAY_AFTER_MS, 14 * DAY_MS);
  assert.match(PUT_AWAY_MESSAGE, /two weeks/);

  assert.equal(dueToBePutAway(NOW, NOW), false);
  assert.equal(dueToBePutAway(NOW - 14 * DAY_MS + 1, NOW), false);
  assert.equal(dueToBePutAway(NOW - 14 * DAY_MS, NOW), true);
  assert.equal(dueToBePutAway(0, NOW), true);
});

test('a table saved later than now, as by a clock that was set wrong, is not old', () => {
  assert.equal(dueToBePutAway(NOW + 1, NOW), false);
  assert.equal(dueToBePutAway(NOW + 400 * DAY_MS, NOW), false);
});

test('a sweep looks at the tables that are due, the longest unchanged first, by id among those saved at the same moment, and at no more than it may', () => {
  const tables = [
    { id: 'YOUNG2', changedAt: NOW - DAY_MS },
    { id: 'BBB222', changedAt: NOW - 20 * DAY_MS },
    { id: 'OLDEST', changedAt: NOW - 90 * DAY_MS },
    { id: 'AAA222', changedAt: NOW - 20 * DAY_MS },
    { id: 'EDGE22', changedAt: NOW - 14 * DAY_MS },
  ];
  const ids = (found: { id: string }[]) => found.map((table) => table.id);

  assert.deepEqual(ids(dueToLookAt(tables, NOW)), ['OLDEST', 'AAA222', 'BBB222', 'EDGE22']);
  assert.deepEqual(ids(dueToLookAt(tables, NOW - 20 * DAY_MS)), ['OLDEST']);
  assert.deepEqual(dueToLookAt([], NOW), []);

  assert.ok(PUT_AWAY_AT_ONCE >= 2, 'each new table adds one to put away later, so fewer than two a sweep would never catch up');
  assert.ok(LOOKED_AT_AT_ONCE > PUT_AWAY_AT_ONCE);
});

test('with more due than a sweep may look at, it looks at the longest unchanged it may put away, and then at others from a place that moves with the time, so that every table comes up', () => {
  // T00 is the longest unchanged, T39 the least
  const many = Array.from({ length: 40 }, (_table, index) => ({ id: `T${String(index).padStart(2, '0')}`, changedAt: NOW - (100 - index) * DAY_MS }));
  const cameUp = new Set<string>();

  for (let later = 0; later < 200; later++) {
    const found = dueToLookAt(many, NOW + later).map((table) => table.id);

    assert.equal(found.length, LOOKED_AT_AT_ONCE);
    assert.deepEqual(found.slice(0, PUT_AWAY_AT_ONCE), ['T00', 'T01', 'T02'], 'the oldest come first whatever the time');
    assert.deepEqual(found, [...new Set(found)].sort(), 'each once, and the others in order of age too');
    found.forEach((id) => cameUp.add(id));
  }

  assert.equal(cameUp.size, 40, 'some table is never looked at, so tables left in place ahead of it would keep it for good');

  // One more than a sweep looks at is the least there is to choose from
  const seven = many.slice(0, LOOKED_AT_AT_ONCE + 1);
  assert.deepEqual([0, 1].map((later) => dueToLookAt(seven, NOW - (NOW % 2) + later).at(-1)!.id).sort(), ['T05', 'T06']);
});

test('last words that throw come to nothing', () => {
  const { state } = createTable('ABC234', 'Host', {}, { now: NOW, rng: seededRng(1), effects: [] });
  const said: Effect[] = [{ type: 'nightEnded', night: { at: NOW, tableId: 'ABC234' } }];

  assert.deepEqual(lastWordsOf(state, NOW, () => said), said);
  assert.deepEqual(
    lastWordsOf(state, NOW, () => {
      throw new Error('a bug in whoever asked');
    }),
    [],
  );
});
