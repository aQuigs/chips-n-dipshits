import assert from 'node:assert/strict';
import test from 'node:test';

import { ServerClock } from '../src/client/connection.ts';
import { TableNews, tableChange } from '../src/client/tableChange.ts';
import type { TableChange } from '../src/client/tableChange.ts';
import type { HandEvent, TableView } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';

/** The view as it reaches a page: a copy, where the engine's own shares the table's feed. */
const seenBy = (table: TestTable, seat: number): TableView => structuredClone(table.view(seat));

/** Seat 0's page, which shows each view the moment it is made, as nearly all of them arrive. */
/** A table screen taking up views, each `late` ms after the table made it. */
class Page {
  private readonly news = new TableNews();
  private shown: TableView | null = null;

  arrive(table: TestTable, wentBack = false, late = 0): TableChange {
    const change = this.news.change(this.shown, seenBy(table, 0), table.now + late, wentBack);

    this.shown = change.view;

    return change;
  }
}

const texts = (feed: { text: string }[]) => feed.map((entry) => entry.text);

const kinds = (events: HandEvent[]) => events.map((event) => event[0]);

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

/** Heads-up with the button on seat 0, who is first to act before the flop. */
function dealtTable(): TestTable {
  const table = new TestTable({ stacks: [1000, 1000] });

  table.deal({ button: 0 });

  return table;
}

test('the events a view adds to its hand are handed out once, however many it brings', () => {
  const table = dealtTable();
  const page = new Page();

  page.arrive(table);

  table.call(0);
  assert.deepEqual(kinds(page.arrive(table).events), ['call']);

  // The check that closes the round, and the flop it brings
  table.check(1);
  assert.deepEqual(kinds(page.arrive(table).events), ['check', 'street']);

  // The table changed and the hand did not
  table.cmd(1, { type: 'chat', text: 'nice flop' });
  assert.deepEqual(page.arrive(table).events, []);
});

test('a move made after a long quiet spell is happening now, so it is news like any other', () => {
  const table = new TestTable({ stacks: [1000, 1000], config: { actionSeconds: 0 } });
  const page = new Page();

  table.deal({ button: 0 });
  page.arrive(table);

  table.wait(25_000);
  table.call(0);

  const change = page.arrive(table);
  assert.deepEqual(kinds(change.events), ['call']);
  assert.equal(change.feed.length, 1);
});

test('the first view, and a table that went back, bring no events however far the hand has got', () => {
  const table = dealtTable();
  const page = new Page();
  const saved = structuredClone(table.state);

  table.call(0);
  assert.ok(table.view(0).hand!.events.length > 0);
  assert.deepEqual(page.arrive(table).events, []);

  table.state = saved;
  table.raise(0, 60);
  assert.deepEqual(page.arrive(table, true).events, []);

  table.call(1);
  assert.deepEqual(kinds(page.arrive(table).events), ['call', 'street']);
});

test('a view that brings a line the viewer missed is catching them up, and none of its events are news', () => {
  const table = new TestTable({ stacks: [1000, 1000], config: { actionSeconds: 0 } });
  const page = new Page();

  table.deal({ button: 0 });
  page.arrive(table);

  // The phone sleeps through the call, and wakes just as the check brings the flop
  table.call(0);
  table.wait(60_000);
  table.check(1);

  const woke = page.arrive(table);
  assert.deepEqual(woke.events, []);
  assert.ok(woke.feed.length > 0, 'the lines that are only moments old are still news');

  // From here the page is up to date again
  table.check(1);
  assert.deepEqual(kinds(page.arrive(table).events), ['check']);
});

test('a view that was slow to arrive brings no events, though no line in it says so', () => {
  const table = dealtTable();
  const before = seenBy(table, 0);

  table.call(0);
  const view = seenBy(table, 0);
  view.feed = before.feed;

  assert.deepEqual(kinds(tableChange(before, view, view.now).events), ['call']);
  assert.deepEqual(tableChange(before, view, view.now + 45_000).events, []);
});

test('a hand that began since the view before is news from its start', () => {
  const table = dealtTable();
  const page = new Page();

  page.arrive(table);
  table.fold(0);
  const lastHand = page.arrive(table).view.hand!;

  // The next view the page gets is already the next hand, whose list is shorter than the one it had
  table.finishHand();
  table.deal({ button: 1 });

  const { events, view } = page.arrive(table);
  assert.ok(view.hand!.events.length < lastHand.events.length);
  assert.equal(events[0]![0], 'start');
  assert.deepEqual(events, view.hand!.events);
});

test('a hand whose events were given up on brings none, where its shorter list would look like a new one', () => {
  const table = dealtTable();
  const before = seenBy(table, 0);

  table.call(0);
  const view = seenBy(table, 0);
  view.hand!.events = [];

  assert.deepEqual(tableChange(before, view, view.now).events, []);
});

test('a device whose clock is a minute off still takes a view that arrives at once as current, and one that is slow as late', () => {
  const table = chattyTable();
  const clock = new ServerClock();
  const realNow = Date.now;
  let device = table.now - 60_000;

  // The page notes each view's time as it takes it up, then reckons the server's time from that
  const arrive = (before: TableView | null) => {
    const view = seenBy(table, 0);
    clock.note(view.now);

    return tableChange(before, view, clock.now());
  };

  Date.now = () => device;
  try {
    const first = arrive(null);

    table.now += 2000;
    device += 2000;
    table.cmd(1, { type: 'chat', text: 'on time' });
    const onTime = arrive(first.view);
    assert.equal(onTime.current, true, 'a view that arrived at once');

    // Made at once, but taking half a minute to arrive
    table.now += 2000;
    table.cmd(1, { type: 'chat', text: 'slow' });
    device += 32_000;
    assert.equal(arrive(onTime.view).current, false, 'a view half a minute on its way');
  } finally {
    Date.now = realNow;
  }
});

test('the end of the night is told once, by the first view on time that shows it', () => {
  const table = new TestTable({ stacks: [1000, 1000] });
  const page = new Page();
  page.arrive(table);

  table.cmd(0, { type: 'endNight' });
  assert.equal(page.arrive(table).nightEnded, true);

  table.cmd(1, { type: 'chat', text: 'gg' });
  assert.equal(page.arrive(table).nightEnded, false, 'the night ended again');

  // Started and ended again between two views
  table.cmd(0, { type: 'playOn' });
  table.now += 1000;
  table.cmd(0, { type: 'endNight' });
  assert.equal(page.arrive(table).nightEnded, true);
});

test('an end of the night brought by a late view is told by the next view on time, and one gone by then never is', () => {
  const table = new TestTable({ stacks: [1000, 1000] });
  const page = new Page();
  page.arrive(table);

  // Half a minute on its way, the view is not news, but the end it brought waits
  table.cmd(0, { type: 'endNight' });
  const late = page.arrive(table, false, 30_000);
  assert.equal(late.current, false);
  assert.equal(late.nightEnded, false);
  assert.equal(page.arrive(table).nightEnded, true);
  assert.equal(page.arrive(table).nightEnded, false, 'told again');

  // Ended again and played on, all before a view on time came
  table.cmd(0, { type: 'playOn' });
  table.now += 1000;
  table.cmd(0, { type: 'endNight' });
  assert.equal(page.arrive(table, false, 30_000).nightEnded, false);
  table.cmd(0, { type: 'playOn' });
  assert.equal(page.arrive(table).nightEnded, false, 'an end no longer shown');
});

test('a page opened on a table whose night ended long ago, or shown it again after the table went back, is told nothing', () => {
  const table = new TestTable({ stacks: [1000, 1000] });
  table.cmd(0, { type: 'endNight' });
  table.now += 60 * 60_000;

  const opened = new Page();
  assert.equal(opened.arrive(table).nightEnded, false);
  table.cmd(1, { type: 'chat', text: 'still here' });
  assert.equal(opened.arrive(table).nightEnded, false, 'the next view on time');

  const page = new Page();
  page.arrive(table);
  table.cmd(0, { type: 'playOn' });
  page.arrive(table);
  table.now += 1000;
  table.cmd(0, { type: 'endNight' });
  assert.equal(page.arrive(table, true).nightEnded, false);
  assert.equal(page.arrive(table).nightEnded, false);
});

/**
 * Seat 0 takes every chip of seat 1, heads-up, and earns badges for it once the hand is cleared. The
 * page sees each step on time but the last, which arrives `late` ms late; gives back what that brought.
 */
function felt(table: TestTable, page: Page, late = 0): TableChange {
  table.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Ks Kh' }, board: '2c 7d 9h Jc 3s' });
  table.raise(0, 1000);
  table.call(1);
  page.arrive(table);

  while (table.state.hand!.stage !== 'done') {
    table.wait(table.state.hand!.deadline! - table.now);
    page.arrive(table);
  }

  table.wait(table.state.hand!.deadline! - table.now);

  return page.arrive(table, false, late);
}

function rebuy(table: TestTable): void {
  table.cmd(1, { type: 'requestRebuy', amount: 1000 });
  table.cmd(0, { type: 'approve', playerId: table.ids[1]! });
}

const earned = (change: TableChange) => change.earned.map((badge) => [badge.id, badge.times]);

test('a badge is told once, to whoever earned it, by the first view on time that shows it, and one earned again is told again', () => {
  const table = new TestTable({ stacks: [1000, 1000] });
  const page = new Page();
  page.arrive(table);

  assert.deepEqual(earned(felt(table, page)), [['bigPot', 1], ['felted', 1]]);

  table.cmd(1, { type: 'chat', text: 'gg' });
  assert.deepEqual(earned(page.arrive(table)), [], 'told again');

  // Late on its way, the view tells nothing, and the next on time tells what it brought
  rebuy(table);
  assert.deepEqual(earned(felt(table, page, 30_000)), []);
  assert.deepEqual(earned(page.arrive(table)), [['bigPot', 2], ['felted', 2]]);
});

test('badges earned before the page opened, or shown again after the table went back, are never told', () => {
  const table = new TestTable({ stacks: [1000, 1000] });
  const before = new Page();
  before.arrive(table);
  felt(table, before);

  const opened = new Page();
  assert.deepEqual(earned(opened.arrive(table)), []);
  table.cmd(1, { type: 'chat', text: 'still here' });
  assert.deepEqual(earned(opened.arrive(table)), [], 'the next view on time');

  rebuy(table);
  felt(table, before);
  assert.deepEqual(earned(opened.arrive(table, true)), []);
  assert.deepEqual(earned(opened.arrive(table)), []);
});
