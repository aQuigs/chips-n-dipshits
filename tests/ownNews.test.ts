import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestNews, timedOutText, turnedDown } from '../src/client/ownNews.ts';
import { tableChange } from '../src/client/tableChange.ts';
import { addMember, TIMING } from '../src/engine/index.ts';
import type { RequestKind, TableView } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';

const HOST = 0;
const CLOCK = { actionSeconds: 10 };

/** The view as it reaches a page: a copy, where the engine's own shares the table's feed. */
const seenBy = (table: TestTable, player: number): TableView => structuredClone(table.view(player));

/** Someone who has joined and is only watching. Gives back what `cmd` and `view` name them by. */
const joins = (table: TestTable, name: string): number => table.ids.push(addMember(table.state, name, table.ctx()).id) - 1;

/** What `player`'s page makes of whatever `happens` at the table. */
function over(table: TestTable, player: number, happens: () => void): RequestKind | null {
  const before = seenBy(table, player);

  happens();

  return turnedDown(before, seenBy(table, player));
}

function twoSeated(): TestTable {
  return new TestTable({ stacks: [1000, 1000], names: ['Quigs', 'Danny'] });
}

test('a seat or chips the host turns down is known to the page of the player who asked', () => {
  const table = twoSeated();
  const zed = joins(table, 'Zed');

  table.cmd(zed, { type: 'requestSeat', seat: 5, buyIn: 500 });
  assert.equal(
    over(table, zed, () => table.cmd(HOST, { type: 'deny', playerId: table.ids[zed]! })),
    'seat',
  );

  table.cmd(1, { type: 'requestRebuy', amount: 300 });
  assert.equal(
    over(table, 1, () => table.cmd(HOST, { type: 'deny', playerId: table.ids[1]! })),
    'rebuy',
  );
});

test('nobody else is told: not the host who turned it down, and not another player who is waiting too', () => {
  const table = twoSeated();
  const zed = joins(table, 'Zed');
  const yan = joins(table, 'Yan');

  table.cmd(zed, { type: 'requestSeat', seat: 5, buyIn: 500 });
  table.cmd(yan, { type: 'requestSeat', seat: 6, buyIn: 500 });

  const deny = (): void => table.cmd(HOST, { type: 'deny', playerId: table.ids[zed]! });

  assert.equal(over(table, yan, deny), null);

  table.cmd(zed, { type: 'requestSeat', seat: 5, buyIn: 500 });
  assert.equal(over(table, HOST, deny), null);

  table.cmd(zed, { type: 'requestSeat', seat: 5, buyIn: 500 });
  assert.equal(over(table, 1, deny), null);
});

test('a request that went any other way was not turned down', () => {
  const table = twoSeated();
  const zed = joins(table, 'Zed');
  const yan = joins(table, 'Yan');
  const ask = (player: number, seat = 5): void => table.cmd(player, { type: 'requestSeat', seat, buyIn: 500 });

  ask(zed);
  assert.equal(
    over(table, zed, () => table.cmd(zed, { type: 'cancelRequest' })),
    null,
    'taken back',
  );

  ask(zed);
  assert.equal(
    over(table, zed, () => ask(zed, 6)),
    null,
    'asked again for another seat',
  );

  ask(yan, 6);
  assert.equal(
    over(table, zed, () => table.cmd(HOST, { type: 'approve', playerId: table.ids[yan]! })),
    null,
    'the seat went to someone else',
  );
  assert.ok(table.feedText().includes('Seat 7 is taken, so Zed needs to pick another'));

  ask(zed);
  assert.equal(
    over(table, zed, () => table.cmd(HOST, { type: 'approve', playerId: table.ids[zed]! })),
    null,
    'granted',
  );

  table.cmd(1, { type: 'requestRebuy', amount: 300 });
  assert.equal(
    over(table, 1, () => table.cmd(HOST, { type: 'approve', playerId: table.ids[1]! })),
    null,
    'chips granted',
  );

  table.cmd(1, { type: 'requestRebuy', amount: 300 });
  assert.equal(
    over(table, 1, () => table.cmd(HOST, { type: 'endNight' })),
    null,
    'dropped with the night',
  );
});

test('a request taken back while another player is turned down is told from theirs, by name', () => {
  const table = new TestTable({ stacks: [1000], names: ['Quigs'] });
  const al = joins(table, 'Al');
  const bigAl = joins(table, 'Big Al');

  table.cmd(al, { type: 'requestSeat', seat: 5, buyIn: 500 });
  table.cmd(bigAl, { type: 'requestSeat', seat: 6, buyIn: 500 });

  assert.equal(
    over(table, al, () => {
      table.cmd(al, { type: 'cancelRequest' });
      table.cmd(HOST, { type: 'deny', playerId: table.ids[bigAl]! });
    }),
    null,
  );
  assert.ok(table.feedText().includes("The host turned down Big Al's request for a seat"));
});

/** A page's memory of its viewer's requests, taking up the table as `player` sees it. */
class Page {
  readonly requests = new RequestNews();
  private readonly table: TestTable;
  private readonly player: number;
  private shown: TableView | null = null;

  constructor(table: TestTable, player: number) {
    this.table = table;
    this.player = player;
    this.arrive();
  }

  /** The kind of request the view that arrives now tells the effects was turned down. */
  arrive(wentBack = false): RequestKind | undefined {
    const view = seenBy(this.table, this.player);
    const change = this.requests.see(tableChange(this.shown, view, this.table.now, wentBack));

    this.shown = view;

    return change.turnedDown;
  }
}

/** Zed, watching a table of two, has asked for a seat and been turned down, as his page has seen. */
function zedTurnedDown(): { table: TestTable; zed: number; page: Page } {
  const table = twoSeated();
  const zed = joins(table, 'Zed');

  table.cmd(zed, { type: 'requestSeat', seat: 5, buyIn: 500 });

  const page = new Page(table, zed);

  table.cmd(HOST, { type: 'deny', playerId: table.ids[zed]! });
  assert.equal(page.arrive(), 'seat');

  return { table, zed, page };
}

test('the page tells a request turned down once, and the bar goes on saying it', () => {
  const { table, page } = zedTurnedDown();

  assert.equal(page.requests.turnedDown, 'seat');

  table.cmd(1, { type: 'chat', text: 'unlucky' });
  assert.equal(page.arrive(), undefined, 'told once');
  assert.equal(page.requests.turnedDown, 'seat');
});

test('the bar stops saying it when they ask again, and when they get a seat', () => {
  const { table, zed, page } = zedTurnedDown();

  table.cmd(zed, { type: 'requestSeat', seat: 6, buyIn: 500 });
  page.arrive();
  assert.equal(page.requests.turnedDown, null);

  table.cmd(HOST, { type: 'deny', playerId: table.ids[zed]! });
  assert.equal(page.arrive(), 'seat', 'turned down again is news again');

  table.cmd(zed, { type: 'requestSeat', seat: 6, buyIn: 500 });
  table.cmd(HOST, { type: 'approve', playerId: table.ids[zed]! });
  page.arrive();
  assert.equal(page.requests.turnedDown, null);
});

test('the bar says it through the hand on the table and the next, and no longer', () => {
  const { table, page } = zedTurnedDown();

  table.deal({ button: 0 });
  page.arrive();
  assert.equal(page.requests.turnedDown, 'seat');

  table.foldOut();
  table.deal();
  page.arrive();
  assert.equal(page.requests.turnedDown, null);
});

test('chips turned down are beside the point to a player who has left their seat, and so is anything once the night is over', () => {
  const table = twoSeated();
  const page = new Page(table, 1);
  const turnDown = (): void => {
    table.cmd(1, { type: 'requestRebuy', amount: 300 });
    page.arrive();
    table.cmd(HOST, { type: 'deny', playerId: table.ids[1]! });
    assert.equal(page.arrive(), 'rebuy');
  };

  turnDown();
  table.cmd(HOST, { type: 'endNight' });
  page.arrive();
  assert.equal(page.requests.turnedDown, null);

  table.cmd(HOST, { type: 'playOn' });
  page.arrive();
  turnDown();
  table.cmd(1, { type: 'standUp' });
  page.arrive();
  assert.equal(page.requests.turnedDown, null);
});

test('a table that went back tells nothing of a request it no longer has', () => {
  const table = twoSeated();
  const zed = joins(table, 'Zed');

  table.cmd(zed, { type: 'requestSeat', seat: 5, buyIn: 500 });

  const page = new Page(table, zed);

  table.cmd(HOST, { type: 'deny', playerId: table.ids[zed]! });
  assert.equal(page.arrive(true), undefined);
  assert.equal(page.requests.turnedDown, null);
});

/** Three players with a clock, P0 first to act before the flop. */
function onTheClock(): TestTable {
  const table = new TestTable({ stacks: [1000, 1000, 1000], config: CLOCK });

  table.deal({ button: 0 });

  return table;
}

const runOut = (table: TestTable): void => table.wait(CLOCK.actionSeconds * 1000 + TIMING.actionGraceMs);

const toldTo = (table: TestTable, player: number): string => {
  const view = table.view(player);

  return timedOutText(view, view.seats[view.you.seat!]!);
};

test('a player the clock ran out on is told what it did to their hand: folded when there was a bet to call', () => {
  const table = onTheClock();

  runOut(table);

  assert.equal(table.view(0).seats[0]!.away, true);
  assert.equal(toldTo(table, 0), 'You ran out of time. Your hand was folded and you are sitting out.');
});

test('checked for them when checking was free, the hand goes on being played for them until they are back', () => {
  const table = onTheClock();

  table.call(0);
  table.call(1);
  runOut(table);

  assert.equal(table.state.hand!.street, 'flop');
  assert.equal(toldTo(table, 2), 'You ran out of time. Your hand is checked or folded until you are back.');

  table.check(1);
  table.raise(0, 40);
  table.call(1);
  assert.equal(toldTo(table, 2), 'You ran out of time. Your hand was folded and you are sitting out.');
});

test('once that hand is over they are told they are sitting out, for as long as they are away', () => {
  const table = onTheClock();

  table.call(0);
  table.call(1);
  runOut(table);
  table.fold(1);
  table.fold(0);
  assert.equal(table.state.hand!.stage, 'done');
  assert.equal(toldTo(table, 2), 'You ran out of time. You are sitting out.', 'a hand that was theirs in the end');

  table.finishHand();
  table.deal();
  assert.equal(table.view(2).seats[2]!.inHand, false);
  assert.equal(toldTo(table, 2), 'You ran out of time. You are sitting out.');
});
