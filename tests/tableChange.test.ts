import assert from 'node:assert/strict';
import test from 'node:test';

import { tableChange } from '../src/client/tableChange.ts';
import type { TableChange } from '../src/client/tableChange.ts';
import type { TableView } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';

/** The view as it reaches a page: a copy, where the engine's own shares the table's feed. */
const seenBy = (table: TestTable, seat: number): TableView => structuredClone(table.view(seat));

/** Seat 0's page, which shows each view the moment it is made, as nearly all of them arrive. */
class Page {
  private shown: TableView | null = null;

  arrive(table: TestTable, wentBack = false): TableChange {
    const change = tableChange(this.shown, seenBy(table, 0), table.now, wentBack);

    this.shown = change.view;

    return change;
  }
}

const texts = (feed: { text: string }[]) => feed.map((entry) => entry.text);

function chattyTable(): TestTable {
  const table = new TestTable({ stacks: [1000, 1000] });

  table.cmd(1, { type: 'chat', text: 'said before anyone was looking' });

  return table;
}

test('the first view is where things stand: nothing in it is news, however much was said before', () => {
  const table = chattyTable();
  const change = new Page().arrive(table);

  assert.equal(change.before, null);
  assert.ok(change.view.feed.length > 0);
  assert.deepEqual(change.feed, []);
});

test('each line is handed out once, with the view that brought it, and every one when a view brings several', () => {
  const table = chattyTable();
  const page = new Page();
  const first = page.arrive(table).view;

  table.cmd(1, { type: 'chat', text: 'one' });
  const afterOne = page.arrive(table);

  assert.equal(afterOne.before, first);
  assert.deepEqual(texts(afterOne.feed), ['one']);

  table.cmd(1, { type: 'chat', text: 'two' });
  table.cmd(0, { type: 'chat', text: 'three' });
  assert.deepEqual(texts(page.arrive(table).feed), ['two', 'three']);

  // Nothing new was said, though the table changed
  table.cmd(0, { type: 'sitOut' });
  assert.deepEqual(page.arrive(table).feed, []);
});

test('a table that went back to an earlier state brings no news, and what is said after that is news again', () => {
  const table = chattyTable();
  const page = new Page();
  const saved = structuredClone(table.state);

  page.arrive(table);
  table.cmd(1, { type: 'chat', text: 'lost with the restore' });
  table.cmd(1, { type: 'chat', text: 'also lost' });
  const beforeRestore = page.arrive(table).view;

  table.state = saved;
  table.cmd(1, { type: 'chat', text: 'said just before the restore was noticed' });
  const restored = page.arrive(table, true);

  assert.equal(restored.before, beforeRestore, 'what was on screen is still what it is compared with');
  assert.deepEqual(restored.feed, []);

  // Numbered like a line handed out before the restore, and news all the same
  table.cmd(1, { type: 'chat', text: 'after the restore' });
  assert.deepEqual(texts(page.arrive(table).feed), ['after the restore']);
});

test('after a restore the page could not notice, lines numbered like ones it has shown are still news', () => {
  const table = chattyTable();
  const page = new Page();
  const saved = structuredClone(table.state);

  page.arrive(table);
  table.cmd(1, { type: 'chat', text: 'lost with the restore' });
  page.arrive(table);

  // The table is put back and played on past where this page was before the page next hears from it
  table.wait(3000);
  table.state = saved;
  table.cmd(1, { type: 'chat', text: 'takes the lost line\'s number' });
  table.cmd(0, { type: 'sitOut' });

  assert.deepEqual(texts(page.arrive(table).feed), ["takes the lost line's number"]);
});

test('lines that are old by the time they arrive, as after a phone slept through them, are not news', () => {
  const table = chattyTable();
  const page = new Page();

  page.arrive(table);

  table.cmd(1, { type: 'chat', text: 'said while the phone slept' });
  table.wait(60_000);
  table.cmd(1, { type: 'chat', text: 'said as it woke' });
  table.wait(2000);

  assert.deepEqual(texts(page.arrive(table).feed), ['said as it woke']);

  // The one that was skipped stays skipped
  table.cmd(1, { type: 'chat', text: 'next' });
  assert.deepEqual(texts(page.arrive(table).feed), ['next']);
});

test('a view that was slow to arrive is judged by when it arrives, not by when the server made it', () => {
  const table = chattyTable();
  const before = seenBy(table, 0);

  // Made a moment after the line was said, and held up on the way for most of a minute
  table.cmd(1, { type: 'chat', text: 'said just before the answer was held up' });
  const view = seenBy(table, 0);

  assert.deepEqual(tableChange(before, view, view.now + 45_000).feed, []);
});
