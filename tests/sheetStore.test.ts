import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, AUTO_SHOWS, BADGES, createTable, DEFAULT_CONFIG, LIMITS, prettyCards, presetSettings, REACTIONS, REACTIONS_LIVE } from '../src/engine/index.ts';
import type { Bounty, Effect, HandRecord, KnownPlayer, Rng, TableConfig, TableState } from '../src/engine/index.ts';
import { ERRORS_TAB, REPORTS_PER_RUN, SheetErrorLog } from '../src/gas/sheetErrorLog.ts';
import { SheetPlayerStore } from '../src/gas/sheetPlayerStore.ts';
import { SheetPresetStore } from '../src/gas/sheetPresetStore.ts';
import { TEXT, TIMESTAMP, WHOLE_NUMBER } from '../src/gas/sheets.ts';
import type { SpreadsheetLike } from '../src/gas/sheets.ts';
import { SheetStore } from '../src/gas/sheetStore.ts';
import { ERROR_LIMITS, NOWHERE } from '../src/server/errorLog.ts';
import type { ErrorLog } from '../src/server/errorLog.ts';
import { MemoryErrorLog } from '../src/server/memoryErrorLog.ts';
import { MemoryPlayerStore } from '../src/server/memoryPlayerStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { SEEN_EVERY_MS } from '../src/server/playerStore.ts';
import type { PlayerStore } from '../src/server/playerStore.ts';
import type { PresetStore, SavedPreset } from '../src/server/presetStore.ts';
import type { LastWords } from '../src/server/putAway.ts';
import { PokerService } from '../src/server/service.ts';
import { StoreBusyError } from '../src/server/store.ts';
import type { TableStore } from '../src/server/store.ts';
import { Calls, FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import type { FakeSheet } from './fakes.ts';
import { cards, DAY_MS, seededRng, TestTable } from './helpers.ts';
import { fullestChat } from './invariants.ts';

function setup() {
  const lock = new FakeLock();
  const calls = new Calls();
  const spreadsheet = new FakeSpreadsheet(lock, {}, calls);
  const cache = new FakeCache(calls);
  const counts = { opens: 0, flushes: 0 };
  let failingFlush = 0;

  const store = new SheetStore({
    spreadsheet: () => {
      counts.opens += 1;
      return spreadsheet;
    },
    cache,
    lock,
    flush: () => {
      calls.note('flush');
      counts.flushes += 1;

      if (counts.flushes === failingFlush) {
        throw new Error('Service Spreadsheets failed');
      }
    },
  });

  /** Makes the nth flush from now report failure. What was written before it stays written, as with a reply that got lost. */
  const failFlush = (nth: number) => (failingFlush = counts.flushes + nth);

  /** A second store over the same sheet and cache, as a separate script run would have. */
  const anotherRun = () => new SheetStore({ spreadsheet: () => spreadsheet, cache, lock, flush: () => calls.note('flush') });

  return { store, spreadsheet, cache, lock, calls, counts, anotherRun, failFlush, failNextFlush: () => failFlush(1) };
}

function buyIn(amount: number, tableId = 'ABC234'): Effect {
  return { type: 'ledger', entry: { at: 1_700_000_000_000, tableId, playerId: 'P1', name: 'Ann', kind: 'buy-in', amount } };
}

/** What a test needs to see of one table's records: those still held in its row, and those that reached the Ledger tab. */
function records(spreadsheet: FakeSpreadsheet) {
  const tables = spreadsheet.getSheetByName('Tables')!;
  const ledger = spreadsheet.getSheetByName('Ledger')!;

  return {
    tables,
    ledger,
    held: () => tables.cells[1]!.slice(9, 12).join(''),
    // A transfer's chips are in their own column
    ledgerAmounts: () => ledger.cells.slice(1).map((row) => row[4] || row[7]),
  };
}

function table(id: string, version = 1, config: Partial<TableConfig> = {}): TableState {
  const { state } = createTable(id, 'Host', config, { now: 1000, rng: seededRng(3), effects: [] });
  state.version = version;

  return state;
}

// When the tables of these tests are saved, unless a test says otherwise
const NOW = Date.UTC(2026, 10, 14, 20);

function save(store: TableStore, state: TableState, effects: Effect[] = [], at = NOW): void {
  store.transact(state.id, () => ({ save: state, at, effects, result: null }));
}

function handRecord(tableId: string, number: number): HandRecord {
  return {
    at: 1_700_000_000_000 + number,
    tableId,
    number,
    summary: `Hand #${number}`,
    boards: [[]],
    bigBlind: 20,
    bombPot: null,
    players: [],
    result: { uncontested: true, pots: [], winnings: [], hands: [], bounty: null },
    events: [],
  };
}

test('a saved table reads back the same, from the cache and from the sheet', () => {
  const { store, cache, anotherRun } = setup();
  const state = table('ABC234');

  save(store, state);
  assert.deepEqual(store.read('ABC234'), state);

  cache.entries.clear();
  assert.deepEqual(anotherRun().read('ABC234'), state);
  assert.deepEqual(store.peek('ABC234'), { version: 1, wakeAt: null });
});

test('once a table is cached, reading and peeking never touch the spreadsheet', () => {
  const { store, cache, lock, anotherRun } = setup();
  save(store, table('ABC234'));

  let opened = false;
  const reader = new SheetStore({
    spreadsheet: () => {
      opened = true;
      throw new Error('the spreadsheet should not be opened');
    },
    cache,
    lock,
    flush: () => {},
  });

  assert.equal(reader.read('ABC234')!.id, 'ABC234');
  assert.equal(reader.peek('ABC234')!.version, 1);
  assert.equal(opened, false);
  assert.equal(anotherRun().read('ABC234')!.id, 'ABC234');
});

test('a transaction sees the latest saved state and updates the same row', () => {
  const { store, spreadsheet } = setup();
  save(store, table('ABC234'));
  save(store, table('XYZ789'));

  const seen = store.transact('ABC234', (state) => {
    state!.version = 2;
    state!.running = true;

    return { save: state!, at: NOW, effects: [], result: state!.version };
  });

  assert.equal(seen, 2);
  assert.equal(store.read('ABC234')!.running, true);
  assert.equal(store.read('XYZ789')!.version, 1);

  const sheet = spreadsheet.getSheetByName('Tables')!;
  assert.equal(sheet.getLastRow(), 3, 'a header and one row per table');
  assert.deepEqual(sheet.cells.slice(1).map((row) => [row[0], row[2]]), [['ABC234', '2'], ['XYZ789', '1']]);
});

test('a transaction on a table that does not exist gets null and saves nothing unless asked', () => {
  const { store, spreadsheet } = setup();

  const result = store.transact('NOPE22', (state) => ({ save: null, effects: [], result: state }));

  assert.equal(result, null);
  assert.equal(spreadsheet.getSheetByName('Tables')!.getLastRow(), 1);
});

test('nothing is saved when the transaction throws, and the lock is released', () => {
  const { store, lock } = setup();
  save(store, table('ABC234'));

  assert.throws(
    () =>
      store.transact('ABC234', (state) => {
        state!.version = 99;
        throw new Error('rule broken');
      }),
    /rule broken/,
  );

  assert.equal(lock.held, false);
  assert.equal(store.read('ABC234')!.version, 1);
});

test('ids and text that a spreadsheet would reinterpret survive untouched', () => {
  const { store, cache, anotherRun } = setup();

  for (const id of ['234567', '2E5678']) {
    const state = table(id);
    state.config.name = '=HYPERLINK("x")';
    save(store, state);
  }

  cache.entries.clear();

  assert.equal(anotherRun().read('234567')!.id, '234567');
  assert.equal(anotherRun().read('2E5678')!.config.name, '=HYPERLINK("x")');
});

test('a table too long for one cell is spread over several, whatever each piece starts with', () => {
  const { store, cache, spreadsheet, anotherRun } = setup();
  const state = table('ABC234');
  state.feed.push({ seq: 1, at: 1, kind: 'chat', from: 'Host', text: '='.repeat(90_000) });

  save(store, state);

  const row = spreadsheet.getSheetByName('Tables')!.cells[1]!;
  assert.deepEqual(row.slice(3, 9).map((cell) => String(cell).length > 0), [true, true, true, false, false, false]);

  cache.entries.clear();
  assert.deepEqual(anotherRun().read('ABC234'), state);
});

test('an emoji that falls where one cell ends and the next begins is kept whole', () => {
  // The two texts differ by one character, so one of them puts the cut in the middle of an emoji
  for (const lead of ['a', 'ab']) {
    const { store, cache, anotherRun } = setup();
    const state = table('ABC234');
    state.feed.push({ seq: 1, at: 1, kind: 'chat', from: 'Host', text: lead + '🃏'.repeat(30_000) });

    save(store, state);

    cache.entries.clear();
    assert.deepEqual(anotherRun().read('ABC234'), state);
  }
});

test('a table shrinking again leaves no stale pieces behind', () => {
  const { store, cache, anotherRun } = setup();
  const state = table('ABC234');
  state.feed.push({ seq: 1, at: 1, kind: 'chat', from: 'Host', text: 'x'.repeat(90_000) });
  save(store, state);

  state.feed = [];
  save(store, state);

  cache.entries.clear();
  assert.deepEqual(anotherRun().read('ABC234'), state);
});

test('a table too big for the cache is still stored and served, just from the sheet', () => {
  const { store, cache } = setup();
  const state = table('ABC234');
  state.feed.push({ seq: 1, at: 1, kind: 'chat', from: 'Host', text: '♠'.repeat(40_000) });

  save(store, state);

  assert.equal(cache.get('state:ABC234'), null);
  assert.deepEqual(store.peek('ABC234'), { version: 1, wakeAt: null });
  assert.deepEqual(store.read('ABC234'), state);
});

test('a table that outgrows its row is refused, and the cache stops serving the old copy', () => {
  const { store, cache } = setup();
  const state = table('ABC234');
  save(store, state);

  const huge = structuredClone(state);
  huge.version = 2;
  huge.feed.push({ seq: 1, at: 1, kind: 'chat', from: 'Host', text: 'x'.repeat(300_000) });

  assert.throws(() => save(store, huge), /more than its row can hold/);
  assert.equal(cache.get('state:ABC234'), null);
  assert.equal(store.read('ABC234')!.version, 1, 'the sheet still has the last good save');
});

test('if the write to the sheet fails, the cache is dropped rather than left stale', () => {
  const { store, cache, lock, failNextFlush } = setup();
  save(store, table('ABC234', 1));

  failNextFlush();
  assert.throws(() => save(store, table('ABC234', 2)), /Spreadsheets failed/);

  assert.equal(lock.held, false);
  assert.equal(cache.get('state:ABC234'), null);
  assert.equal(cache.get('peek:ABC234'), null);
});

test('if the cache cannot be written after a save, the save still counts and the cache is dropped', () => {
  const { store, cache } = setup();
  save(store, table('ABC234', 1));

  cache.failNextWrite = true;
  save(store, table('ABC234', 2));

  assert.equal(cache.get('state:ABC234'), null);
  assert.equal(store.read('ABC234')!.version, 2, 'the sheet has the new save and the next read finds it');
});

test('a cache that lost only one of a table\'s entries gets both back from the sheet', () => {
  const { store, cache, spreadsheet } = setup();
  save(store, table('ABC234', 3));
  const tables = spreadsheet.getSheetByName('Tables')!;

  cache.entries.delete('peek:ABC234');
  const readsBefore = tables.reads;
  assert.deepEqual(store.peek('ABC234'), { version: 3, wakeAt: null });
  assert.ok(tables.reads > readsBefore, 'the sheet was read');
  assert.notEqual(cache.get('peek:ABC234'), null, 'so the next peek is answered by the cache');

  const readsAfter = tables.reads;
  store.peek('ABC234');
  assert.equal(tables.reads, readsAfter);
});

test('a missing table is remembered briefly, and creating it clears that', () => {
  const { store, cache, counts } = setup();

  assert.equal(store.peek('ABC234'), null);
  assert.equal(store.read('ABC234'), null);
  assert.equal(cache.get('peek:ABC234'), 'none');

  const opensAfterFirstMiss = counts.opens;
  assert.equal(store.peek('ABC234'), null);
  assert.equal(counts.opens, opensAfterFirstMiss, 'the second look is answered by the cache');

  save(store, table('ABC234'));
  assert.equal(store.peek('ABC234')!.version, 1);
  assert.equal(store.read('ABC234')!.id, 'ABC234');
});

test('rows that moved in the sheet are found again', () => {
  const { store, spreadsheet, lock, anotherRun } = setup();
  save(store, table('AAA222'));
  save(store, table('BBB333'));
  save(store, table('CCC444', 5));

  lock.waitLock();
  spreadsheet.getSheetByName('Tables')!.deleteRow(2);
  lock.releaseLock();

  const found = anotherRun().transact('CCC444', (state) => ({ save: null, effects: [], result: state }));
  assert.equal(found!.version, 5);

  const gone = anotherRun().transact('AAA222', (state) => ({ save: null, effects: [], result: state }));
  assert.equal(gone, null);
});

test('ledger entries and finished hands are appended to their own tabs', () => {
  const { store, spreadsheet } = setup();
  const effects: Effect[] = [
    { type: 'ledger', entry: { at: 1_700_000_000_000, tableId: 'ABC234', playerId: 'P1', name: '12', kind: 'buy-in', amount: 500 } },
    { type: 'hand', record: handRecord('ABC234', 1) },
    { type: 'ledger', entry: { at: 1_700_000_050_000, tableId: 'ABC234', playerId: 'P1', name: '12', kind: 'cash-out', amount: -650 } },
  ];

  save(store, table('ABC234'), effects);

  const ledger = spreadsheet.getSheetByName('Ledger')!.cells;
  assert.deepEqual(ledger[0], ['Time', 'Table', 'Player', 'Type', 'Amount', 'Player ID', 'Record ID', 'Transferred', 'Other player', 'Other player ID']);
  assert.deepEqual(ledger.slice(1).map((row) => row.slice(1)), [
    ['ABC234', '12', 'buy-in', 500, 'P1', 'ABC234:1:0', '', '', ''],
    ['ABC234', '12', 'cash-out', -650, 'P1', 'ABC234:1:2', '', '', ''],
  ]);
  assert.ok(ledger[1]![0] instanceof Date);

  const hands = spreadsheet.getSheetByName('Hands')!.cells;
  assert.deepEqual(hands[1]!.slice(1, 4), ['ABC234', 1, 'Hand #1']);
});

test('the end of a night has no tab yet, so the Sheet keeps nothing of it, and what comes with it is still copied out', () => {
  const { store, spreadsheet } = setup();

  save(store, table('ABC234'), [{ type: 'nightEnded', night: { at: 1_700_000_000_000, tableId: 'ABC234' } }, buyIn(500)]);
  const sheet = records(spreadsheet);

  assert.equal(sheet.held(), '');
  assert.deepEqual(sheet.ledgerAmounts(), [500]);
  assert.equal(sheet.ledger.cells[1]![6], 'ABC234:1:1', 'a record is known by its place among everything the save made');
  assert.deepEqual([...spreadsheet.sheets.keys()].sort(), ['Ledger', 'Tables']);
});

test('the Ledger tab reads in dollars for a table that plays dollars and cents, and in chips for one that plays chips', () => {
  const { store, spreadsheet } = setup();

  save(store, table('ABC234'), [buyIn(150), buyIn(-650)]);
  save(store, table('CNT234', 1, { unit: 'cents' }), [buyIn(150, 'CNT234'), buyIn(-650, 'CNT234'), buyIn(100_000_005, 'CNT234')]);
  save(store, table('ABC234', 2), [buyIn(2000)]);

  const ledger = spreadsheet.getSheetByName('Ledger')!;
  const read = [2, 3, 4, 5, 6, 7].map((row) => [ledger.shown(row, 2), ledger.shown(row, 5)]);

  assert.deepEqual(read, [
    ['ABC234', '150'],
    ['ABC234', '-650'],
    ['CNT234', '1.50'],
    ['CNT234', '-6.50'],
    ['CNT234', '1000000.05'],
    ['ABC234', '2000'],
  ]);

  // Numbers, not text, so someone can add the column up
  const amounts = ledger.cells.slice(1).map((row) => row[4]);
  assert.deepEqual(amounts, [150, -650, 1.5, -6.5, 1_000_000.05, 2000]);
});

/** The two lines a transfer is booked as, from Dana to Sam. */
function transfer(amount: number, tableId = 'ABC234'): Effect[] {
  const line = { at: 1_700_000_000_000, tableId, kind: 'transfer' as const };

  return [
    { type: 'ledger', entry: { ...line, playerId: 'D1', name: 'Dana', amount: -amount, otherId: 'S1', otherName: 'Sam' } },
    { type: 'ledger', entry: { ...line, playerId: 'S1', name: 'Sam', amount, otherId: 'D1', otherName: 'Dana' } },
  ];
}

test('a transfer reaches the Ledger tab as a line for each player, each naming the other, beside the Amount column so a player\'s amounts still add up to what they owe', () => {
  const { store, spreadsheet } = setup();

  save(store, table('ABC234'), [buyIn(1000), ...transfer(500)]);
  save(store, table('CNT234', 1, { unit: 'cents' }), transfer(1234, 'CNT234'));

  const ledger = spreadsheet.getSheetByName('Ledger')!;
  const read = [3, 4, 5, 6].map((row) => [2, 3, 4, 5, 6, 8, 9, 10].map((column) => ledger.shown(row, column)));

  assert.deepEqual(read, [
    ['ABC234', 'Dana', 'transfer', '', 'D1', '-500', 'Sam', 'S1'],
    ['ABC234', 'Sam', 'transfer', '', 'S1', '500', 'Dana', 'D1'],
    ['CNT234', 'Dana', 'transfer', '', 'D1', '-12.34', 'Sam', 'S1'],
    ['CNT234', 'Sam', 'transfer', '', 'S1', '12.34', 'Dana', 'D1'],
  ]);
  assert.deepEqual(ledger.cells.slice(1).map((row) => row[7]), ['', -500, 500, -12.34, 12.34], 'numbers, so the column can be added up');
  assert.deepEqual(ledger.cells.slice(1).map((row) => row[4]), [1000, '', '', '', '']);
});

test('a transfer whose copy reported failure after the table was saved is copied once, both lines together', () => {
  const { store, spreadsheet, failFlush } = setup();
  save(store, table('ABC234', 1), [buyIn(1000)]);
  const { ledger, held, ledgerAmounts } = records(spreadsheet);

  failFlush(2);
  save(store, table('ABC234', 2), transfer(300));
  assert.match(held(), /"kind":"transfer"/);

  save(store, table('ABC234', 3));
  assert.deepEqual(ledgerAmounts(), [1000, -300, 300]);
  assert.equal(held(), '');

  // And when the tab refuses the write altogether, both lines wait in the row and go out with the next save
  ledger.refuseWritesAfter(0);
  save(store, table('ABC234', 4), transfer(200));
  assert.deepEqual(ledgerAmounts(), [1000, -300, 300]);

  ledger.acceptWrites();
  save(store, table('ABC234', 5));
  assert.deepEqual(ledgerAmounts(), [1000, -300, 300, -200, 200]);
  assert.equal(held(), '');
});

test('a Ledger tab made before transfers gets the transfer columns\' headers with the first transfer, and its old lines are left as they were', () => {
  const { store, spreadsheet, lock, anotherRun } = setup();

  // The tab as the code before transfers made it, under the lock as the store holds it
  const baseHeaders = ['Time', 'Table', 'Player', 'Type', 'Amount', 'Player ID', 'Record ID'];
  lock.waitLock();
  const old = spreadsheet.insertSheet('Ledger');
  old.getRange(1, 1, 1, 7).setValues([baseHeaders]);
  old.getRange(2, 1, 1, 7).setValues([[new Date(0), 'ABC234', 'Ann', 'buy-in', 100, 'P1', 'ABC234:1:0']]);
  lock.releaseLock();

  save(store, table('ABC234', 2), [buyIn(200)]);
  assert.deepEqual(old.cells[0], baseHeaders, 'a copy with no transfer in it left the headers alone');

  // A buy-in whose copy reported failure although it landed, held from before the change
  const { tables, ledgerAmounts } = records(spreadsheet);
  tables.cells[1]![9] = `~${JSON.stringify([{ id: 'ABC234:1:0', record: buyIn(100) }])}`;

  save(anotherRun(), table('ABC234', 3), transfer(50));

  assert.deepEqual(old.cells[0], [...baseHeaders, 'Transferred', 'Other player', 'Other player ID']);
  assert.deepEqual(old.cells[1], [new Date(0), 'ABC234', 'Ann', 'buy-in', 100, 'P1', 'ABC234:1:0']);
  assert.deepEqual(ledgerAmounts(), [100, 200, -50, 50], 'the line written before the new columns was found by its id and not written again');
});

/** The lines a high-hand bonus of 5 is booked as, paid to Dana by Sam and by Kim, who had only 3. */
function bonusPaid(tableId = 'ABC234'): Effect[] {
  const line = { at: 1_700_000_000_000, tableId, kind: 'high hand' as const };
  const pair = (playerId: string, name: string, amount: number): Effect[] => [
    { type: 'ledger', entry: { ...line, playerId, name, amount: -amount, otherId: 'D1', otherName: 'Dana' } },
    { type: 'ledger', entry: { ...line, playerId: 'D1', name: 'Dana', amount, otherId: playerId, otherName: name } },
  ];

  return [...pair('S1', 'Sam', 5), ...pair('K1', 'Kim', 3)];
}

test('a high-hand bonus reaches a Ledger tab made before chips moved between players as a pair of lines a payment, headed with the first, beside the Amount column', () => {
  const { store, spreadsheet, lock } = setup();

  // The tab as the code on main made it, before transfers
  const baseHeaders = ['Time', 'Table', 'Player', 'Type', 'Amount', 'Player ID', 'Record ID'];
  lock.waitLock();
  const old = spreadsheet.insertSheet('Ledger');
  old.getRange(1, 1, 1, 7).setValues([baseHeaders]);
  lock.releaseLock();

  save(store, table('ABC234'), [buyIn(1000), ...bonusPaid()]);

  assert.deepEqual(old.cells[0], [...baseHeaders, 'Transferred', 'Other player', 'Other player ID']);
  assert.deepEqual(
    [3, 4, 5, 6].map((row) => [3, 4, 5, 6, 8, 9, 10].map((column) => old.shown(row, column))),
    [
      ['Sam', 'high hand', '', 'S1', '-5', 'Dana', 'D1'],
      ['Dana', 'high hand', '', 'D1', '5', 'Sam', 'S1'],
      ['Kim', 'high hand', '', 'K1', '-3', 'Dana', 'D1'],
      ['Dana', 'high hand', '', 'D1', '3', 'Kim', 'K1'],
    ],
  );
  assert.deepEqual(old.cells.slice(1).map((row) => row[4]), [1000, '', '', '', ''], 'a player\'s amounts still add up to what they paid');
});

test('a header someone renamed is kept when the transfer columns are headed', () => {
  const { store, spreadsheet, lock } = setup();

  lock.waitLock();
  spreadsheet.insertSheet('Ledger').getRange(1, 1, 1, 7).setValues([['When', 'Table', 'Player', 'Type', 'Amount', 'Player ID', 'Record ID']]);
  lock.releaseLock();

  save(store, table('ABC234'), transfer(50));

  assert.deepEqual(spreadsheet.getSheetByName('Ledger')!.cells[0], ['When', 'Table', 'Player', 'Type', 'Amount', 'Player ID', 'Record ID', 'Transferred', 'Other player', 'Other player ID']);
});

test('a ledger entry in dollars and cents that had to wait in its row is written in dollars whichever way it goes out', () => {
  const { store, spreadsheet, cache, lock, anotherRun } = setup();
  const cents = (version: number) => table('CNT234', version, { unit: 'cents' });

  save(store, cents(1));
  lock.waitLock();
  const ledger = spreadsheet.getSheetByName('Ledger') ?? spreadsheet.insertSheet('Ledger');
  lock.releaseLock();

  // With the next save
  ledger.refuseWritesAfter(0);
  save(store, cents(2), [buyIn(150, 'CNT234')]);
  ledger.acceptWrites();
  save(store, cents(3), [buyIn(275, 'CNT234')]);

  // When the row is next read from the sheet
  ledger.refuseWritesAfter(0);
  save(store, cents(4), [buyIn(1205, 'CNT234')]);
  ledger.acceptWrites();
  cache.entries.clear();
  anotherRun().read('CNT234');
  assert.equal(ledger.shown(4, 5), '12.05', 'reading the row did not copy out what it held');

  // When the table is next looked up without being saved
  ledger.refuseWritesAfter(0);
  save(store, cents(5), [buyIn(5, 'CNT234')]);
  ledger.acceptWrites();
  anotherRun().transact('CNT234', () => ({ save: null, effects: [], result: null }));

  assert.deepEqual([2, 3, 4, 5].map((row) => ledger.shown(row, 5)), ['1.50', '2.75', '12.05', '0.05']);
});

test('a record that cannot be copied to its tab waits in the table\'s row and goes out with the next save', () => {
  const { store, spreadsheet, cache, anotherRun } = setup();
  save(store, table('ABC234', 1), [buyIn(100)]);

  const { ledger, held, ledgerAmounts } = records(spreadsheet);
  assert.equal(held(), '', 'nothing is left in the row once it is copied');

  ledger.refuseWritesAfter(0);
  save(store, table('ABC234', 2), [buyIn(200), { type: 'hand', record: handRecord('ABC234', 1) }]);

  assert.equal(store.read('ABC234')!.version, 2, 'the game goes on: the table itself was saved');
  assert.deepEqual(ledgerAmounts(), [100]);
  assert.match(held(), /"amount":200/, 'the buy-in is still in the row');
  assert.doesNotMatch(held(), /"type":"hand"/, 'the hand was copied, so it is not');
  assert.deepEqual(store.recentHands('ABC234', 5).map((hand) => hand.number), [1]);

  // Still failing on the next save: both buy-ins wait together
  cache.entries.clear();
  save(anotherRun(), table('ABC234', 3), [buyIn(300)]);
  assert.deepEqual(ledgerAmounts(), [100]);

  ledger.acceptWrites();
  save(anotherRun(), table('ABC234', 4));

  assert.deepEqual(ledgerAmounts(), [100, 200, 300]);
  assert.equal(held(), '');
  assert.deepEqual(store.recentHands('ABC234', 5).map((hand) => hand.number), [1], 'and nothing was copied twice');
});

test('a copy that landed although it reported failure is not made a second time', () => {
  const { store, spreadsheet, failFlush } = setup();
  save(store, table('ABC234', 1), [buyIn(100)]);
  const { tables, held, ledgerAmounts } = records(spreadsheet);

  // The table row is flushed first, then the Ledger rows: the reply to the second is the one that gets lost
  failFlush(2);
  save(store, table('ABC234', 2), [buyIn(500)]);
  assert.deepEqual(ledgerAmounts(), [100, 500]);
  assert.match(held(), /"amount":500/, 'for all the store knows, it still has to be copied');

  save(store, table('ABC234', 3));
  assert.deepEqual(ledgerAmounts(), [100, 500]);
  assert.equal(held(), '');

  // The other way to get there: the copy is fine, but the row can't be cleared of it afterwards
  tables.refuseWritesAfter(1);
  save(store, table('ABC234', 4), [buyIn(700)]);
  assert.deepEqual(ledgerAmounts(), [100, 500, 700]);
  assert.match(held(), /"amount":700/);

  tables.acceptWrites();
  save(store, table('ABC234', 5), [buyIn(900)]);
  assert.deepEqual(ledgerAmounts(), [100, 500, 700, 900]);
  assert.equal(held(), '');
});

test('records left waiting by a table\'s last save are copied without anyone having to act again', () => {
  const { store, spreadsheet, cache, anotherRun } = setup();
  save(store, table('ABC234', 1), [buyIn(100)]);
  const { ledger, held, ledgerAmounts } = records(spreadsheet);
  const settledFor = cache.seconds.get('state:ABC234')!;

  ledger.refuseWritesAfter(0);
  save(store, table('ABC234', 2), [buyIn(-100)]);
  assert.ok(cache.seconds.get('state:ABC234')! <= 60, 'the cache is told to let go soon, so that a reader comes back to the sheet');
  assert.ok(cache.seconds.get('peek:ABC234')! <= 60);

  // A reader that finds the cache empty retries, here while the tab is still failing
  cache.entries.clear();
  assert.equal(anotherRun().peek('ABC234')!.version, 2);
  assert.deepEqual(ledgerAmounts(), [100]);
  assert.ok(cache.seconds.get('peek:ABC234')! <= 60);

  ledger.acceptWrites();
  cache.entries.clear();
  assert.equal(anotherRun().read('ABC234')!.version, 2);
  assert.deepEqual(ledgerAmounts(), [100, -100]);
  assert.equal(held(), '');
  assert.equal(cache.seconds.get('state:ABC234'), settledFor, 'and the cache keeps the table as long as usual again');

  // A request that changes nothing does the same when it comes first
  ledger.refuseWritesAfter(0);
  save(store, table('ABC234', 3), [buyIn(250)]);
  ledger.acceptWrites();
  anotherRun().transact('ABC234', () => ({ save: null, effects: [], result: null }));
  assert.deepEqual(ledgerAmounts(), [100, -100, 250]);
  assert.equal(held(), '');
});

test('a table is still read and saved if the cells holding its waiting records were tampered with', () => {
  const { store, spreadsheet, cache, anotherRun } = setup();
  save(store, table('ABC234', 1), [buyIn(100)]);
  const { tables, held, ledgerAmounts } = records(spreadsheet);

  const spoiled = [
    '~[{"id":"ABC234:9:0","record":',
    '~[1]',
    '~{"id":"ABC234:9:0"}',
    `~${JSON.stringify([buyIn(999)])}`,
    '~[{"id":"ABC234:9:0","record":{"type":"hand","record":{}}}]',
  ];

  spoiled.forEach((text, index) => {
    tables.cells[1]![9] = text;
    cache.entries.clear();

    assert.equal(anotherRun().read('ABC234')!.version, index + 1, text);
    save(anotherRun(), table('ABC234', index + 2), [buyIn(200 + index)]);
    assert.equal(held(), '', text);
  });

  assert.deepEqual(ledgerAmounts(), [100, 200, 201, 202, 203, 204]);

  // A record that is intact goes out even when its neighbor is not
  const intact = { id: 'ABC234:50:0', record: buyIn(555) };
  tables.cells[1]![9] = `~${JSON.stringify([7, intact])}`;
  cache.entries.clear();
  anotherRun().read('ABC234');
  assert.equal(ledgerAmounts().at(-1), 555);
});

test('when more records are waiting than a row can hold, hands give way before money', () => {
  const { store, spreadsheet } = setup();
  const longHand = (number: number): Effect => ({ type: 'hand', record: { ...handRecord('ABC234', number), summary: 'x'.repeat(29_000) } });

  save(store, table('ABC234', 1), [buyIn(100), longHand(1)]);
  const { ledger, held } = records(spreadsheet);

  ledger.refuseWritesAfter(0);
  spreadsheet.getSheetByName('Hands')!.refuseWritesAfter(0);
  save(store, table('ABC234', 2), [buyIn(200), longHand(2), longHand(3), longHand(4), longHand(5), longHand(6)]);

  assert.match(held(), /"amount":200/);
  assert.doesNotMatch(held(), /"number":2,/, 'the oldest hand was let go');
  assert.match(held(), /"number":6,/);
});

test('a hand with more to say than a cell holds is saved all the same, keeping the end', () => {
  const { store } = setup();
  const record = { ...handRecord('ABC234', 7), summary: `${'x'.repeat(80_000)}\nP1 wins 40` };

  save(store, table('ABC234'), [{ type: 'hand', record }]);

  const [saved] = store.recentHands('ABC234', 1);
  assert.equal(saved!.number, 7);
  assert.ok(saved!.summary.startsWith('…'));
  assert.ok(saved!.summary.endsWith('P1 wins 40'));
});

test('a hand saved before records kept events, or said whether it was a bomb pot, is served with no events as an ordinary hand', () => {
  const { store, spreadsheet } = setup();
  save(store, table('ABC234'), [{ type: 'hand', record: handRecord('ABC234', 1) }]);

  const row = spreadsheet.getSheetByName('Hands')!.cells[1]!;
  const { events: _events, bombPot: _bombPot, ...asOnceSaved } = handRecord('ABC234', 1);
  row[4] = JSON.stringify(asOnceSaved);

  assert.deepEqual(store.recentHands('ABC234', 1), [handRecord('ABC234', 1)]);
});

test('a record whose events would not fit its cell is saved without them', () => {
  const { store } = setup();
  const events: HandRecord['events'] = Array.from({ length: 6000 }, () => ['fold', 3]);
  const record = { ...handRecord('ABC234', 7), events };
  assert.ok(JSON.stringify(record).length > 50_000);

  save(store, table('ABC234'), [{ type: 'hand', record }]);

  assert.deepEqual(store.recentHands('ABC234', 1), [handRecord('ABC234', 7)]);
});

test('history reaches back past other tables\' hands', () => {
  const { store } = setup();
  const mine: Effect[] = [1, 2].map((number) => ({ type: 'hand', record: handRecord('ABC234', number) }));
  const theirs: Effect[] = Array.from({ length: 700 }, (_hand, index) => ({ type: 'hand', record: handRecord('XYZ789', index + 1) }));

  save(store, table('ABC234'), mine);
  save(store, table('XYZ789'), theirs.slice(0, 350));
  save(store, table('ABC234', 2), [{ type: 'hand', record: handRecord('ABC234', 3) }]);
  save(store, table('XYZ789', 2), theirs.slice(350));

  assert.deepEqual(store.recentHands('ABC234', 30).map((hand) => hand.number), [1, 2, 3]);
  assert.deepEqual(store.recentHands('ABC234', 2).map((hand) => hand.number), [2, 3]);
});

test('recent hands come back oldest first, for one table only, up to the limit', () => {
  const { store } = setup();
  const effects: Effect[] = [];
  for (let number = 1; number <= 5; number++) {
    effects.push({ type: 'hand', record: handRecord('ABC234', number) });
    effects.push({ type: 'hand', record: handRecord('XYZ789', number) });
  }
  save(store, table('ABC234'), effects);

  assert.deepEqual(store.recentHands('ABC234', 3).map((hand) => [hand.tableId, hand.number]), [['ABC234', 3], ['ABC234', 4], ['ABC234', 5]]);
  assert.deepEqual(store.recentHands('NOPE22', 3), []);
});

test('a lock that cannot be had in time becomes a retryable error', () => {
  const { store, lock } = setup();
  lock.busy = true;

  assert.throws(() => save(store, table('ABC234')), StoreBusyError);
});

// ---- Presets ----

const PRESET_ROWS = 1 + LIMITS.presets;

function presetSetup() {
  const lock = new FakeLock();
  const spreadsheet = new FakeSpreadsheet(lock, { Presets: PRESET_ROWS });
  const store = new SheetPresetStore({ spreadsheet: () => spreadsheet, lock, flush: () => {} });

  /** A second store over the same Sheet, as another script run, answering another player at the same moment, would have. */
  const anotherRun = () => new SheetPresetStore({ spreadsheet: () => spreadsheet, lock, flush: () => {} });
  const tab = () => spreadsheet.getSheetByName('Presets')!;

  return { store, spreadsheet, lock, anotherRun, tab };
}

function preset(name: string, settings: Record<string, unknown> = { smallBlind: 25, bigBlind: 50 }): SavedPreset {
  return { name, settings, savedAt: 1_700_000_000_000, savedBy: 'Quigs' };
}

const names = (store: PresetStore) => store.list().map((kept) => kept.name);

for (const [kind, make] of [
  ['in the Sheet', () => presetSetup().store],
  ['in memory', () => new MemoryPresetStore()],
] as [string, () => PresetStore][]) {
  test(`presets ${kind}: saved, listed in order, replaced in place only when asked, deleted whatever the case`, () => {
    const store = make();

    store.save(preset('Friday 25/50'), false);
    store.save(preset('Tuesday cents', { unit: 'cents' }), false);
    assert.deepEqual(store.list(), [
      { name: 'Friday 25/50', settings: { smallBlind: 25, bigBlind: 50 } },
      { name: 'Tuesday cents', settings: { unit: 'cents' } },
    ]);

    assert.throws(() => store.save(preset('friday 25/50'), false), { name: 'GameError', message: 'There is already a preset called Friday 25/50' });

    assert.deepEqual(store.save(preset('FRIDAY 25/50', { smallBlind: 50 }), true), store.list(), 'a save answers with the presets as they are after it');
    assert.deepEqual(store.list()[0], { name: 'FRIDAY 25/50', settings: { smallBlind: 50 } });
    assert.equal(store.list().length, 2);

    assert.deepEqual(store.delete('tuesday CENTS'), store.list());
    assert.deepEqual(store.delete('Nothing by this name'), store.list());
    assert.deepEqual(names(store), ['FRIDAY 25/50']);
  });

  test(`presets ${kind}: past the limit a new name is refused, while one of the same name is still replaced`, () => {
    const store = make();

    for (let index = 0; index < LIMITS.presets; index++) {
      store.save(preset(`Night ${index}`), false);
    }

    assert.throws(() => store.save(preset('One more'), false), { name: 'GameError', message: `There are ${LIMITS.presets} presets already. Delete one to save another` });
    assert.throws(() => store.save(preset('One more'), true), { name: 'GameError' });

    store.save(preset('night 3', { bigBlind: 100 }), true);
    store.delete('Night 0');
    store.save(preset('One more'), false);
    assert.equal(store.list().length, LIMITS.presets);
    assert.equal(names(store).at(-1), 'One more');
  });
}

test('presets in a Sheet that has never had one: listing finds none and makes no tab, and the first save makes it with its headers', () => {
  const { store, spreadsheet, tab } = presetSetup();

  assert.deepEqual(store.list(), []);
  store.delete('Anything');
  assert.equal(spreadsheet.getSheetByName('Presets'), null, 'reading or deleting made the tab');

  store.save(preset('Friday 25/50'), false);
  assert.deepEqual(tab().cells[0], ['Name', 'Settings (the game reads these, so edit with care)', 'Saved', 'Saved by']);
  assert.deepEqual(tab().cells[1], ['Friday 25/50', '{"smallBlind":25,"bigBlind":50}', new Date(1_700_000_000_000), 'Quigs']);
});

test('a preset name that reads like a formula is kept as text', () => {
  const { store } = presetSetup();

  store.save(preset('=1+1'), false);
  store.save(preset('2024'), false);
  assert.deepEqual(names(store), ['=1+1', '2024']);
});

test('presets are written only under the script lock, and a lock that can\'t be had is a busy store, not a failure', () => {
  const { store, lock, tab } = presetSetup();

  store.save(preset('Friday 25/50'), false);
  assert.equal(lock.held, false, 'the lock was kept');

  lock.busy = true;
  assert.throws(() => store.save(preset('Tuesday'), false), StoreBusyError);
  assert.throws(() => store.delete('Friday 25/50'), StoreBusyError);
  assert.deepEqual(store.list().map((kept) => kept.name), ['Friday 25/50'], 'listing needs no lock');

  // The fake refuses what the store would do outside the lock
  lock.busy = false;
  assert.throws(() => tab().deleteRow(2), /without holding the script lock/);
});

test('two saves of one name at the same moment make one preset: the second sees the first under the lock', () => {
  const { store, anotherRun, tab } = presetSetup();

  // Both pages listed the presets before either saved, and neither found the name
  const second = anotherRun();
  assert.deepEqual(store.list(), []);
  assert.deepEqual(second.list(), []);

  store.save(preset('Friday 25/50'), false);
  assert.throws(() => second.save(preset('friday 25/50', { bigBlind: 100 }), false), { message: 'There is already a preset called Friday 25/50' });
  assert.equal(tab().getLastRow(), 2);

  second.save(preset('friday 25/50', { bigBlind: 100 }), true);
  assert.deepEqual(store.list(), [{ name: 'friday 25/50', settings: { bigBlind: 100 } }]);
});

test('two saves of new names when one place is left: the second is refused, and the tab never grows past the limit', () => {
  const { store, anotherRun, tab } = presetSetup();

  for (let index = 0; index < LIMITS.presets - 1; index++) {
    store.save(preset(`Night ${index}`), false);
  }

  store.save(preset('Last place'), false);
  assert.throws(() => anotherRun().save(preset('Too late'), false), { message: /Delete one to save another/ });
  assert.equal(tab().getLastRow(), PRESET_ROWS);
});

test('a row someone made unreadable by hand is skipped, keeps its place, and stops nothing else', () => {
  const { store, tab } = presetSetup();
  store.save(preset('Friday 25/50'), false);
  store.save(preset('Broken'), false);
  store.save(preset('Tuesday'), false);
  store.save(preset('Not settings'), false);

  tab().cells[2]![1] = '{"smallBlind": 25,';
  tab().cells[4]![1] = '[1, 2]';
  tab().cells.push(['', 'a note to self', '', '']);
  tab().cells.push(['x'.repeat(31), '{}', '', '']);

  assert.deepEqual(names(store), ['Friday 25/50', 'Tuesday']);

  // A row that can't be read is no preset by any name, so a new one called that goes after the others
  store.save(preset('Broken'), false);
  assert.deepEqual(names(store), ['Friday 25/50', 'Tuesday', 'Broken']);
  assert.equal(tab().cells[2]![1], '{"smallBlind": 25,', 'the row someone was editing is left for them');

  store.delete('Tuesday');
  assert.deepEqual(names(store), ['Friday 25/50', 'Broken']);
});

test('a row cleared by hand is free again, and a note typed further down the tab takes no place', () => {
  const { store, tab } = presetSetup();
  store.save(preset('Friday 25/50'), false);
  store.save(preset('Cleared'), false);
  store.save(preset('Tuesday'), false);

  // Cleared rather than deleted, and a note to the side far down, as someone working in the Sheet leaves them
  tab().cells[2] = ['', '', '', ''];
  tab().cells[29] = ['', '', '', '', '', 'ask Stu about Fridays'];
  assert.deepEqual(names(store), ['Friday 25/50', 'Tuesday']);

  assert.deepEqual(store.save(preset('Saturday'), false), store.list());
  assert.equal(tab().cells[2]![0], 'Saturday', 'the new preset went past the cleared row');
  assert.deepEqual(names(store), ['Friday 25/50', 'Saturday', 'Tuesday']);

  for (let index = 0; index < LIMITS.presets - 3; index++) {
    store.save(preset(`Night ${index}`), false);
  }

  assert.equal(store.list().length, LIMITS.presets, 'the note took the place of a preset');
});

test('the largest preset the game can make fits its cell with room to spare, and one too long for a cell is refused whole', () => {
  const { store, tab } = presetSetup();
  const bounties = ['AKs', 'AKo', 'AQs', 'AQo', 'AJs', 'AJo', 'ATs', 'ATo'].slice(0, LIMITS.bounties).map((hand): Bounty => [hand, LIMITS.chips]);
  const longest = presetSettings({ ...DEFAULT_CONFIG, name: 'W'.repeat(LIMITS.tableNameLength), smallBlind: LIMITS.chips, bigBlind: LIMITS.chips, minBuyIn: LIMITS.chips, maxBuyIn: LIMITS.chips, bounties });
  assert.equal(longest.bounties!.length, LIMITS.bounties);

  store.save(preset('W'.repeat(LIMITS.presetNameLength), longest), false);
  assert.ok(String(tab().cells[1]![1]).length < 1000, `the largest preset takes ${String(tab().cells[1]![1]).length} characters`);

  assert.throws(() => store.save(preset('Huge', { name: 'x'.repeat(50_000) }), false), /maximum of 50000 characters/);
  assert.deepEqual(names(store), ['W'.repeat(LIMITS.presetNameLength)], 'nothing of the refused one was left behind');
  assert.equal(tab().getLastRow(), 2);
});

test('after the longest night the fullest table still fits its row and the cache: ten seated and fifty who came and went, which is every member a table takes, with the longest names, every number at its largest and a full chat', () => {
  const { store, cache, anotherRun } = setup();

  // Sixteen characters of three bytes each, no two names alike
  const name = (index: number) => '好'.repeat(LIMITS.nameLength - 1) + String.fromCodePoint(0x4e00 + index);
  // As many bounties as a table can have, each of the longest kind and amount, which the hand in play keeps too
  const bounties = ['AKs', 'AKo', 'AQs', 'AQo', 'AJs', 'AJo', 'ATs', 'ATo'].slice(0, LIMITS.bounties).map((hand): Bounty => [hand, LIMITS.chips]);
  assert.equal(bounties.length, LIMITS.bounties);
  const t = new TestTable({ stacks: Array.from({ length: 10 }, () => LIMITS.chips), names: Array.from({ length: 10 }, (_name, seat) => name(seat)), config: { maxBuyIn: LIMITS.chips, bounties } });

  for (let gone = 10; gone < LIMITS.members; gone++) {
    const member = addMember(t.state, name(gone), t.ctx());

    member.buyIn = LIMITS.chips;
    member.cashOut = LIMITS.chips - 1;
  }

  // Every one of them a player the game knows
  t.state.members.forEach((member, index) => (member.identity = `KNOWN${10 + index}`));

  // Every seat showing what it can without being asked
  for (const seat of t.state.seats) {
    seat?.autoShow.push(...AUTO_SHOWS);
  }

  // A hand that all ten are in, with some betting behind it
  t.deal({ button: 0 });
  for (let calls = 0; calls < 9; calls++) {
    t.call(t.playerIn(t.toAct!));
  }

  // More hands than any night has, a pot of every chip ten players can hold, a best hand and every badge for everyone
  const everyBadge = Object.fromEntries(BADGES.map((badge) => [badge.id, 9_999]));
  for (const member of t.state.members) {
    t.state.tonight.players[member.id] = { hands: 99_999, won: 99_999, biggest: 10 * LIMITS.chips, best: ['As', 'Ks', 'Qs', 'Js', 'Ts'], rebuys: 9_999, busts: 9_999, streak: 9_999, badges: { ...everyBadge } };
  }
  t.state.tonight.hands = 99_999;

  // A high hand all ten seated shared, a hand shown since by every member, and every member paid the bonus
  const seated = t.state.seats.flatMap((seat) => (seat ? [seat.playerId] : []));
  t.state.tonight.highHand = {
    best: { playerIds: seated, cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'], hand: 99_999 },
    sincePaid: Object.fromEntries(t.state.members.map((member) => [member.id, { cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'], hand: 99_999 }])),
    paid: Object.fromEntries(t.state.members.map((member) => [member.id, 10 * LIMITS.chips])),
  };
  t.state.feed = fullestChat();

  // As many reactions as the table keeps, each as long as one can be: a throw, the longest kind, between two members
  const longest = REACTIONS.filter((kind) => kind.thrown).sort((a, b) => b.id.length - a.id.length)[0]!;
  t.state.reactions = Array.from({ length: REACTIONS_LIVE }, (_reaction, index) => ({ from: t.ids[index]!, kind: longest.id, at: 9_999_999_999_999, to: t.ids[index + 1]! }));
  const reactions = JSON.stringify(t.state.reactions).length;
  assert.ok(reactions <= 300, `the reactions take ${reactions} characters`);

  // And the most a rabbit hunt adds to the hand: every card of three boards, in the hand, its events and its log
  const withoutHunt = JSON.stringify(t.state).length;
  const hunted = [cards('As Ks Qs Js Ts'), cards('Ah Kh Qh Jh Th'), cards('Ad Kd Qd Jd Td')];
  t.state.hand!.hunted = hunted;
  t.state.hand!.events.push(['hunt', hunted]);
  t.state.hand!.log.push(`${name(0)} hunts the rabbit, cards that did not count: ${hunted.map((board, index) => `${['first', 'second', 'third'][index]} board ${prettyCards(board)}`).join(', ')}`);
  assert.ok(JSON.stringify(t.state).length - withoutHunt <= 400, `a hunt adds ${JSON.stringify(t.state).length - withoutHunt} characters`);

  const listed = JSON.stringify(t.state.config.bounties).length + JSON.stringify(t.state.hand!.bounties).length;
  assert.ok(listed <= 320, `the bounties, in the settings and on the hand, take ${listed} characters`);

  const numbers = JSON.stringify(t.state.tonight).length;
  assert.ok(numbers <= LIMITS.members * 400, `the night's numbers for ${LIMITS.members} players take ${numbers} characters`);

  save(store, t.state);

  // Kept by the cache too, which is what spares every poll a read of the Sheet under the lock
  assert.ok(cache.entries.has(`state:${t.state.id}`), 'the table was too big for the cache');

  cache.entries.clear();
  assert.deepEqual(anotherRun().read(t.state.id), t.state, 'and it reads back from its row the same');
});

// ---- Putting old tables away ----

const TABLE_CELLS = 12;
const nothingToSay: LastWords = () => [];

/** The ids in a tab's first column, row by row from the second, '' for a row that is empty there. */
function idsIn(sheet: { cells: unknown[][] } | null): string[] {
  return (sheet?.cells ?? []).slice(1).map((row) => String(row?.[0] ?? ''));
}

/** A Sheet with some tables in it, each last saved the given number of days before `NOW`. */
function aged(ages: Record<string, number>) {
  const context = setup();

  // Looking for a table is what makes the Tables tab, so it is there for a test that starts with none
  context.store.transact('NONE22', () => ({ save: null, effects: [], result: null }));

  for (const [id, days] of Object.entries(ages)) {
    save(context.store, table(id), [], NOW - days * DAY_MS);
  }

  const tables = context.spreadsheet.getSheetByName('Tables')!;
  const archive = () => context.spreadsheet.getSheetByName('Archive');

  return { ...context, tables, archive, sweep: (lastWords: LastWords = nothingToSay, now = NOW) => context.anotherRun().putAwayOld(now, lastWords) };
}

/** The two kinds of store, each with a look at the ledger entries it has kept. */
const STORES: [string, () => { store: TableStore; ledgerAmounts(): unknown[] }][] = [
  [
    'in the Sheet',
    () => {
      const { store, spreadsheet } = setup();

      return { store, ledgerAmounts: () => (spreadsheet.getSheetByName('Ledger')?.cells ?? []).slice(1).map((row) => row[4]) };
    },
  ],
  [
    'in memory',
    () => {
      const store = new MemoryStore();

      return { store, ledgerAmounts: () => store.ledger.map((entry) => entry.amount) };
    },
  ],
];

for (const [kind, make] of STORES) {
  test(`tables ${kind}: one nobody has saved for two weeks is put away, and from then on there is no such table, only the knowledge that it was put away`, () => {
    const { store } = make();
    save(store, table('OLD222', 7), [], NOW - 14 * DAY_MS);
    save(store, table('NEW333'), [], NOW - 14 * DAY_MS + 1);

    store.putAwayOld(NOW, nothingToSay);

    assert.equal(store.read('OLD222'), null);
    assert.equal(store.peek('OLD222'), null);
    assert.equal(store.transact('OLD222', (state) => ({ save: null, effects: [], result: state })), null);
    assert.equal(store.wasPutAway('OLD222'), true);

    assert.equal(store.read('NEW333')!.id, 'NEW333', 'a millisecond short of two weeks is not two weeks');
    assert.equal(store.wasPutAway('NEVER2'), false, 'a table that never was is not one that was put away');
  });

  test(`tables ${kind}: looking at a table does not keep it, and saving it does`, () => {
    const { store } = make();
    save(store, table('SEEN22'), [], NOW - 20 * DAY_MS);
    save(store, table('PLAYED'), [], NOW - 20 * DAY_MS);

    // A page left open polls for ever, and now and then something looks the table up without changing it
    store.read('SEEN22');
    store.peek('SEEN22');
    store.transact('SEEN22', () => ({ save: null, effects: [], result: null }));
    save(store, table('PLAYED', 2), [], NOW - DAY_MS);

    store.putAwayOld(NOW, nothingToSay);

    assert.equal(store.read('SEEN22'), null);
    assert.equal(store.read('PLAYED')!.version, 2);
  });

  test(`tables ${kind}: a sweep puts away three at most, the longest unchanged first, and the next sweeps take the rest`, () => {
    const { store } = make();
    const ages: Record<string, number> = { DAYS15: 15, DAYS40: 40, DAYS20: 20, DAYS30: 30, DAYS16: 16, YOUNG2: 2 };

    for (const [id, days] of Object.entries(ages)) {
      save(store, table(id), [], NOW - days * DAY_MS);
    }

    const left = () => Object.keys(ages).filter((id) => store.read(id) !== null);

    store.putAwayOld(NOW, nothingToSay);
    assert.deepEqual(left(), ['DAYS15', 'DAYS16', 'YOUNG2']);

    store.putAwayOld(NOW, nothingToSay);
    assert.deepEqual(left(), ['YOUNG2']);

    store.putAwayOld(NOW, nothingToSay);
    assert.deepEqual(left(), ['YOUNG2']);
  });

  test(`tables ${kind}: a table is asked its last words once, with its last state, and what it says is kept like the effects of a save`, () => {
    const { store, ledgerAmounts } = make();
    const last = table('OLD222', 4);
    last.config.name = 'Friday night';
    save(store, table('OLD222', 3), [], NOW - 30 * DAY_MS);
    save(store, last, [buyIn(100, 'OLD222')], NOW - 20 * DAY_MS);
    save(store, table('NEW333'), [], NOW);

    const asked: [TableState, number][] = [];
    store.putAwayOld(NOW, (state, at) => {
      asked.push([state, at]);

      return [buyIn(-100, 'OLD222'), { type: 'nightEnded', night: { at, tableId: state.id } }];
    });

    assert.deepEqual(asked, [[last, NOW]], 'only the table that was put away, as it was last saved');
    assert.deepEqual(ledgerAmounts(), [100, -100]);

    store.putAwayOld(NOW + DAY_MS, () => {
      throw new Error('a table that is gone was asked again');
    });
  });

  test(`tables ${kind}: last words that cannot be had stop nothing: the table is put away all the same`, () => {
    const { store, ledgerAmounts } = make();
    save(store, table('OLD222'), [buyIn(100, 'OLD222')], NOW - 20 * DAY_MS);
    save(store, table('OLD333'), [], NOW - 19 * DAY_MS);

    store.putAwayOld(NOW, (state) => {
      if (state.id === 'OLD222') {
        throw new Error('whoever wanted to know has a bug');
      }

      return [buyIn(7, state.id)];
    });

    assert.deepEqual([store.wasPutAway('OLD222'), store.wasPutAway('OLD333')], [true, true]);
    assert.deepEqual(ledgerAmounts(), [100, 7]);
  });
}

test('a sweep with nothing to put away reads two small cells a row in one call, writes nothing and makes no tab', () => {
  const { tables, archive, calls, sweep } = aged({ AAA222: 13, BBB333: 1, CCC444: 0 });
  calls.made = [];

  sweep();

  assert.deepEqual(calls.made, ['spreadsheet.getSheetByName', 'Tables.getLastRow', 'Tables.getValues'], 'no write, no flush, no call to the cache');
  assert.equal(archive(), null);
  assert.deepEqual(idsIn(tables), ['AAA222', 'BBB333', 'CCC444']);
});

test('an old table moves to the Archive whole, with what tells it from the others beside it, and leaves an empty row and no cache entry behind', () => {
  const { store, tables, archive, cache, anotherRun, sweep } = aged({});
  const old = table('OLD222', 3);
  old.config.name = '=Friday night';
  old.members[0]!.buyIn = 500;
  addMember(old, 'Ann', { now: 2000, rng: seededRng(4), effects: [] }).buyIn = 200;
  addMember(old, 'Watcher', { now: 2000, rng: seededRng(5), effects: [] });

  save(store, table('NEW333'), [], NOW - DAY_MS);
  save(store, old, [], NOW - 15 * DAY_MS);
  save(store, table('NEW444'), [], NOW - DAY_MS);

  const row = [...tables.cells[2]!];
  const others = [1, 3].map((index) => [...tables.cells[index]!]);
  const cached = (id: string) => ['state', 'peek', 'row'].map((key) => cache.entries.has(`${key}:${id}`));
  assert.deepEqual([cached('OLD222'), cached('NEW444')], [[true, true, true], [true, true, true]]);

  sweep();

  assert.deepEqual(archive()!.cells[0], [
    'Table',
    'Updated',
    'Version',
    'State (the game reads and writes these cells, so leave them alone)',
    ...['', '', '', '', ''],
    'Records on their way to the Ledger and Hands tabs (normally empty)',
    ...['', ''],
    'Name',
    'Created',
    'Players',
    'Put away',
  ]);
  assert.deepEqual(archive()!.cells[1], [...row, '=Friday night', new Date(1000), 'Host, Ann', new Date(NOW)]);
  assert.equal(row.length, TABLE_CELLS);
  assert.equal(row[1], new Date(NOW - 15 * DAY_MS).toISOString(), 'when it last changed is the row\'s own Updated cell');

  assert.deepEqual(tables.cells[2], Array.from({ length: TABLE_CELLS }, () => ''), 'its row is emptied');
  assert.deepEqual([tables.cells[1], tables.cells[3]], others, 'and no other row has moved or changed');

  assert.deepEqual(cached('OLD222'), [false, false, false]);
  assert.deepEqual(cached('NEW444'), [true, true, true], 'a table still there keeps its entries');
  assert.equal(cache.get('row:NEW444'), '4', 'and the row remembered for it is still its row');

  assert.equal(anotherRun().read('OLD222'), null);
  assert.equal(anotherRun().read('NEW444')!.id, 'NEW444');
});

test('the row a table left empty is taken by the next new table, so the tab stops growing', () => {
  const { store, tables, anotherRun, sweep } = aged({ OLD222: 20, NEW333: 1, OLD444: 20, NEW555: 1 });
  sweep();
  assert.deepEqual(idsIn(tables), ['', 'NEW333', '', 'NEW555']);

  save(anotherRun(), table('2E5678'));
  save(anotherRun(), table('NEXT33'));
  save(anotherRun(), table('NEXT44'));

  assert.deepEqual(idsIn(tables), ['2E5678', 'NEW333', 'NEXT33', 'NEW555', 'NEXT44']);
  assert.equal(tables.cells[1]![0], '2E5678', 'kept as text in a row that was used before');

  for (const id of ['2E5678', 'NEW333', 'NEXT33', 'NEW555', 'NEXT44']) {
    assert.equal(store.read(id)!.id, id);
    assert.equal(anotherRun().transact(id, (state) => ({ save: null, effects: [], result: state!.id })), id);
  }
});

test('a row that only lost its id is not an empty row: a new table goes past it, and it is left as it is', () => {
  const { tables, anotherRun } = aged({ AAA222: 1, BBB333: 1 });
  tables.cells[1]![0] = '';
  const orphan = [...tables.cells[1]!];

  save(anotherRun(), table('NEW444'));

  assert.deepEqual(tables.cells[1], orphan);
  assert.deepEqual(idsIn(tables), ['', 'BBB333', 'NEW444']);
});

test('a table whose Updated cell is empty or says nothing readable counts as new and is left exactly where it is', () => {
  const { tables, archive, sweep } = aged({ BLANK2: 30, WORDS2: 30, SERIAL: 30, WRONG2: 30, FUTURE: 30, DATED2: 30, YOUNG2: 1 });
  const cell = (index: number, value: unknown) => (tables.cells[index]![1] = value);

  // What a tab from before the column was written would have, and what a hand can leave there
  cell(1, '');
  cell(2, 'last month');
  cell(3, 45_000);
  cell(4, '2026-02-31');
  cell(5, new Date(NOW + 400 * DAY_MS).toISOString());
  cell(6, new Date(NOW - 30 * DAY_MS));
  const before = tables.cells.map((row) => [...row]);

  sweep();

  assert.deepEqual(idsIn(tables), ['BLANK2', 'WORDS2', 'SERIAL', 'WRONG2', 'FUTURE', '', 'YOUNG2'], 'only the one whose cell holds a date two weeks old has gone');
  assert.deepEqual(tables.cells.slice(0, 6), before.slice(0, 6));
  assert.deepEqual(idsIn(archive()), ['DATED2']);
});

test('rows that do not read as the tables they name are left exactly where they are, and however many there are the tables behind them are still put away', () => {
  const ages: Record<string, number> = { BROKEN: 90, OTHER2: 89, NOJSON: 88, NOTE22: 87, HELD22: 86, HELD33: 85, HELD44: 84 };
  const good = ['GOOD22', 'GOOD33', 'GOOD44', 'GOOD55', 'GOOD66'];
  good.forEach((id, index) => (ages[id] = 60 - index));

  const { store, tables, archive, sweep } = aged(ages);

  tables.cells[1]![3] = '~{"id":"BROKEN","schema":';
  tables.cells[2]![3] = `~${JSON.stringify(table('ELSE22'))}`;
  tables.cells[3]![3] = '~[1, 2]';
  tables.cells[4] = ['a note to self', new Date(NOW - 87 * DAY_MS).toISOString()];

  // What is in the cells for waiting records and is not such records: cut short by hand, not a list, a list of something else
  tables.cells[5]![9] = '~[{"id":"HELD22:1:0","record":{"type":"ledger","entry":{"amount":500}}';
  tables.cells[6]![9] = '~{"id":"HELD33:1:0"}';
  tables.cells[7]![10] = '~[7]';
  const before = tables.cells.slice(1, 8).map((row) => [...row]);

  // Seven rows that stay, the oldest of all: more than a sweep looks at. Each sweep is at a time of its own, as each new table is
  for (let later = 0; later < 12; later++) {
    sweep(nothingToSay, NOW + later);
    assert.deepEqual(tables.cells.slice(1, 8), before, `sweep ${later}`);
  }

  assert.deepEqual(idsIn(archive()).sort(), good);
  assert.deepEqual(idsIn(tables).slice(7), ['', '', '', '', '']);
  assert.equal(store.wasPutAway('GOOD66'), true);
  assert.equal(store.wasPutAway('HELD22'), false);
});

test('a table saved by code too old to load is put away as it is, with nothing asked of it', () => {
  const { tables, archive, anotherRun, sweep } = aged({ FIRST2: 20 });
  const ancient = { ...table('FIRST2'), schema: 1 };
  tables.cells[1]![3] = `~${JSON.stringify(ancient)}`;
  const row = [...tables.cells[1]!];
  assert.throws(() => anotherRun().transact('FIRST2', () => ({ save: null, effects: [], result: null })), /schema 1/);

  sweep(() => {
    throw new Error('asked of a table that cannot be loaded');
  });

  assert.deepEqual(archive()!.cells[1]!.slice(0, TABLE_CELLS), row);
  assert.deepEqual(archive()!.cells[1]!.slice(TABLE_CELLS, TABLE_CELLS + 3), ["Chips n' Dipshits", new Date(1000), '']);
  assert.equal(anotherRun().wasPutAway('FIRST2'), true);
});

test('the Archive tab is made by the first table that moves, and one that is already there is added to, whatever its headers', () => {
  const { spreadsheet, archive, lock, sweep, anotherRun } = aged({ OLD222: 20, OLD333: 19 });

  assert.equal(anotherRun().wasPutAway('OLD222'), false);
  assert.equal(archive(), null, 'asking after a table made no tab');

  // A tab of that name the owner made, or renamed the headers of
  lock.waitLock();
  spreadsheet.insertSheet('Archive').getRange(1, 1, 2, 2).setValues([
    ['Old tables', 'When'],
    ['a note', ''],
  ]);
  lock.releaseLock();

  sweep();

  assert.deepEqual(archive()!.cells[0], ['Old tables', 'When']);
  assert.deepEqual(idsIn(archive()), ['a note', 'OLD222', 'OLD333']);
  assert.equal(anotherRun().wasPutAway('OLD333'), true);
});

test('an Archive tab left without its headers, as when making it failed halfway, gets them with the next table', () => {
  const { spreadsheet, archive, lock, sweep } = aged({ OLD222: 20 });

  lock.waitLock();
  spreadsheet.insertSheet('Archive');
  lock.releaseLock();

  sweep();

  assert.deepEqual(archive()!.cells[0]!.slice(TABLE_CELLS), ['Name', 'Created', 'Players', 'Put away']);
  assert.deepEqual(idsIn(archive()), ['OLD222']);
});

test('a table is asked its last words while its row is still in the Tables tab, and a record of them that cannot be copied keeps it there until it can', () => {
  const { store, spreadsheet, tables, archive, anotherRun, sweep } = aged({ OLD222: 20 });
  save(store, table('NEW333'), [buyIn(100, 'NEW333')]);
  const ledger = spreadsheet.getSheetByName('Ledger')!;
  const seen: string[][] = [];
  const lastWords: LastWords = (state) => {
    seen.push([idsIn(tables).join(), idsIn(archive()).join()]);

    return [buyIn(-50, state.id)];
  };

  ledger.refuseWritesAfter(0);
  sweep(lastWords);

  assert.deepEqual(seen, [['OLD222,NEW333', '']], 'asked before anything of it has moved');
  assert.deepEqual(idsIn(tables), ['OLD222', 'NEW333'], 'it stays where its record is still waiting');
  assert.equal(archive(), null);
  assert.match(String(tables.cells[1]![9]), /"id":"OLD222:1:away:0"/);
  assert.equal(anotherRun().read('OLD222')!.id, 'OLD222');

  ledger.acceptWrites();
  sweep(lastWords);

  assert.deepEqual(idsIn(tables), ['', 'NEW333']);
  assert.deepEqual(ledger.cells.slice(1).map((row) => [row[4], row[6]]), [[100, 'NEW333:1:0'], [-50, 'OLD222:1:away:0']], 'its record was written once, though it was asked twice');
  assert.deepEqual(archive()!.cells[1]!.slice(9, TABLE_CELLS), ['', '', ''], 'and it went to the Archive with nothing left waiting');
});

test('a table with records still on their way to the Ledger is put away once they have arrived', () => {
  const { store, spreadsheet, tables, archive, sweep } = aged({});
  save(store, table('NEW333'), [buyIn(1, 'NEW333')]);
  const ledger = spreadsheet.getSheetByName('Ledger')!;

  ledger.refuseWritesAfter(0);
  save(store, table('OLD222'), [buyIn(500, 'OLD222')], NOW - 20 * DAY_MS);
  assert.match(String(tables.cells[2]![9]), /"amount":500/);

  sweep();
  assert.deepEqual(idsIn(tables), ['NEW333', 'OLD222'], 'the Ledger is still refusing, so the table and its buy-in stay');

  ledger.acceptWrites();
  sweep();

  assert.deepEqual(idsIn(tables), ['NEW333', '']);
  assert.deepEqual(idsIn(archive()), ['OLD222']);
  assert.deepEqual(ledger.cells.slice(1).map((row) => row[4]), [1, 500]);
});

/** Ledger lines of another table, more than a retry at the table would look back through. */
function manyLinesSince(store: TableStore): void {
  for (let version = 1; version <= 3; version++) {
    save(store, table('BUSY22', version), Array.from({ length: 200 }, (_line, index) => buyIn(index + 1, 'BUSY22')));
  }
}

test('a record that reached its tab long ago, though its row still says it is waiting, is not written again when its table is put away', () => {
  const { store, spreadsheet, tables, archive, failFlush, sweep } = aged({});

  // The line landed, the push after it failed, and everyone had left: nothing read the row again to find out
  failFlush(2);
  save(store, table('OLD222'), [buyIn(100, 'OLD222')], NOW - 20 * DAY_MS);
  assert.match(String(tables.cells[1]![9]), /"id":"OLD222:1:0"/);

  manyLinesSince(store);
  const ledger = spreadsheet.getSheetByName('Ledger')!;
  assert.equal(ledger.getLastRow(), 602);

  sweep();

  assert.deepEqual(idsIn(archive()), ['OLD222']);
  assert.equal(ledger.cells.filter((row) => row[6] === 'OLD222:1:0').length, 1);
  assert.equal(ledger.getLastRow(), 602);
});

test('last words that reached their tab in a sweep that then failed are not written again by the sweep that finishes it, however much later', () => {
  const { store, spreadsheet, lock, tables, archive, sweep } = aged({ OLD222: 20 });
  const lastWords: LastWords = (state) => [buyIn(-50, state.id)];

  lock.waitLock();
  const made = spreadsheet.insertSheet('Archive');
  lock.releaseLock();
  made.refuseWritesAfter(0);

  sweep(lastWords);
  assert.deepEqual(idsIn(tables), ['OLD222'], 'the Archive could not take it');

  const ledger = spreadsheet.getSheetByName('Ledger')!;
  assert.deepEqual(ledger.cells.slice(1).map((row) => row[6]), ['OLD222:1:away:0']);

  manyLinesSince(store);
  made.acceptWrites();
  sweep(lastWords, NOW + DAY_MS);

  assert.deepEqual(idsIn(archive()), ['OLD222']);
  assert.equal(ledger.cells.filter((row) => row[6] === 'OLD222:1:away:0').length, 1);
  assert.equal(ledger.getLastRow(), 602);
});

test('rows sorted by hand while a sweep runs: a row that no longer names the table that was leaving is not emptied', () => {
  const { spreadsheet, cache, lock, tables, archive, anotherRun, sweep } = aged({ OLD222: 20, LIVE33: 1 });
  let flushes = 0;

  // The owner sorts the tab between the sweep reading the old table's row and emptying it
  const sweeper = new SheetStore({
    spreadsheet: () => spreadsheet,
    cache,
    lock,
    flush: () => {
      flushes += 1;

      if (flushes === 1) {
        [tables.cells[1], tables.cells[2]] = [tables.cells[2]!, tables.cells[1]!];
      }
    },
  });

  sweeper.putAwayOld(NOW, nothingToSay);

  assert.deepEqual(idsIn(tables), ['LIVE33', 'OLD222'], 'the live table is in the row the old one had, and is still there');
  assert.deepEqual(anotherRun().read('LIVE33'), table('LIVE33'));
  assert.equal(anotherRun().transact('LIVE33', (state) => ({ save: null, effects: [], result: state!.id })), 'LIVE33');

  // The old table is in both tabs, as after any sweep that could not finish, and the next one finishes it where it now is
  sweep();
  assert.deepEqual(idsIn(tables), ['LIVE33', '']);
  assert.deepEqual(idsIn(archive()), ['OLD222']);
});

test('a table whose saved state says something of it that cannot be written to a cell is put away without that', () => {
  const { tables, archive, sweep } = aged({ ODD222: 20, OLD333: 19 });
  const odd = { ...table('ODD222'), createdAt: 1e20, members: [null, { name: 7, buyIn: 'lots' }], config: null };
  tables.cells[1]![3] = `~${JSON.stringify(odd)}`;

  sweep();

  assert.deepEqual(idsIn(archive()), ['ODD222', 'OLD333'], 'and it keeps back nothing it is written with');
  assert.deepEqual(archive()!.cells[1]!.slice(TABLE_CELLS, TABLE_CELLS + 3), ['', '', '']);
});

/** Whether every table saved is still somewhere, whole, and the store answers for each as the Tables tab has it. */
function assertNothingLost(context: ReturnType<typeof aged>, saved: Record<string, number>): void {
  const { tables, archive, cache, anotherRun } = context;
  const stateIn = (row: unknown[] | undefined) => (row ? row.slice(3, 9).map((cell) => String(cell).slice(1)).join('') : '');

  for (const [id, version] of Object.entries(saved)) {
    const expected = JSON.stringify(table(id, version));
    const here = tables.cells.slice(1).filter((row) => row?.[0] === id);
    const away = (archive()?.cells ?? []).slice(1).filter((row) => row?.[0] === id);

    assert.ok(here.length + away.length >= 1, `${id} is in neither tab`);
    assert.ok(here.length <= 1, `${id} is in the Tables tab twice`);
    for (const row of [...here, ...away]) {
      assert.equal(stateIn(row), expected, `${id} is not whole`);
    }

    // The cache never answers for a table the Tables tab no longer has, and a row remembered for a table is its row
    if (here.length === 0) {
      assert.deepEqual(['state', 'peek', 'row'].map((key) => cache.entries.has(`${key}:${id}`) && cache.entries.get(`${key}:${id}`) !== 'away'), [false, false, false], `${id} is still cached`);
    }

    const read = anotherRun().read(id);
    assert.deepEqual(read, here.length === 1 ? table(id, version) : null, `the store answers wrongly for ${id}`);
    assert.equal(anotherRun().transact(id, (state) => ({ save: null, effects: [], result: state?.id ?? null })), here.length === 1 ? id : null);

    // Asked only of a table the store has said it does not have
    if (here.length === 0) {
      assert.equal(anotherRun().wasPutAway(id), true);
    }
  }
}

test('a sweep that fails at any one of its calls loses no table, never answers for the wrong one, and the next sweep finishes what it left', () => {
  const ages = { OLD222: 30, NEW333: 1, OLD444: 25, OLD555: 20, NEW666: 2 };
  const versions = { OLD222: 1, NEW333: 1, OLD444: 1, OLD555: 1, NEW666: 1 };
  const lastWords: LastWords = (state) => (state.id === 'OLD444' ? [buyIn(-50, state.id)] : []);

  // Once over with nothing failing, to learn every call a sweep makes
  const clean = aged(ages);
  clean.calls.made = [];
  clean.sweep(lastWords);
  const steps = [...clean.calls.made];
  assertNothingLost(clean, versions);
  assert.deepEqual(idsIn(clean.tables), ['', 'NEW333', '', '', 'NEW666']);

  for (const kind of ['spreadsheet.insertSheet', 'Archive.setValues', 'Tables.setValues', 'Ledger.setValues', 'cache.remove', 'flush']) {
    assert.ok(steps.includes(kind), `the sweep being failed makes no call to ${kind}`);
  }

  // The Archive has the tables, and has been made to say so, before anything of them is taken away
  const pushed = steps.indexOf('flush', steps.lastIndexOf('Archive.setValues'));
  const after = steps.slice(pushed + 1);
  assert.ok(pushed > 0 && !steps.slice(0, pushed).includes('cache.remove'));
  assert.deepEqual(
    after,
    ['Tables.getValues', ...Array.from({ length: 3 }, () => ['cache.remove', 'cache.remove', 'cache.remove', 'Tables.setValues']).flat(), 'flush'],
    'then their rows are looked at once more, and a table at a time its cache entries go before its row is emptied',
  );

  for (let failing = 1; failing <= steps.length; failing++) {
    const context = aged(ages);
    const step = `call ${failing}, ${steps[failing - 1]}`;

    context.calls.failNth(failing);
    assert.doesNotThrow(() => context.sweep(lastWords), step);
    assert.equal(context.lock.held, false, step);
    assertNothingLost(context, versions);

    context.sweep(lastWords);
    context.sweep(lastWords);
    assertNothingLost(context, versions);
    assert.deepEqual(idsIn(context.tables), ['', 'NEW333', '', '', 'NEW666'], `${step}: the old tables have gone`);
    assert.deepEqual(idsIn(context.archive()).sort(), ['OLD222', 'OLD444', 'OLD555'], `${step}: each once in the Archive`);
    assert.deepEqual((context.spreadsheet.getSheetByName('Ledger')?.cells ?? []).slice(1).map((row) => row[4]), [-50], `${step}: a table's last words are written once`);
  }
});

test('a sweep whose writes landed although the reply was lost adds nothing to the Archive twice', () => {
  const ages = { OLD222: 30, OLD444: 25, NEW666: 2 };

  for (const lost of [1, 2]) {
    const context = aged(ages);

    context.failFlush(lost);
    context.store.putAwayOld(NOW, nothingToSay);
    assertNothingLost(context, { OLD222: 1, OLD444: 1, NEW666: 1 });

    context.sweep();
    assert.deepEqual(idsIn(context.archive()), ['OLD222', 'OLD444'], `flush ${lost}`);
    assert.deepEqual(idsIn(context.tables), ['', '', 'NEW666']);
  }
});

test('the most a sweep does is bounded: six rows read, three tables moved in one write, two flushes', () => {
  // However many tables there are, and whichever of them the sweep goes on to after the ones it must leave
  const ages: Record<string, number> = { NEW222: 1 };
  for (let index = 0; index < 12; index++) {
    ages[`OLD${index + 100}`] = 90 - index;
  }

  const { tables, archive, calls, sweep } = aged(ages);

  // The three unchanged longest cannot be read, so the sweep goes on to the next three
  for (const index of [2, 3, 4]) {
    tables.cells[index]![3] = '~not a table';
  }

  sweep();
  calls.made = [];
  sweep();

  assert.deepEqual(idsIn(archive()).length, 6);
  assert.deepEqual(
    { reads: calls.count('.getValues'), writes: calls.count('.setValues'), formats: calls.count('.setNumberFormats'), flushes: calls.count('flush'), cache: calls.count('cache.remove'), cacheOther: calls.count('cache.get') + calls.count('cache.put') },
    { reads: 9, writes: 4, formats: 1, flushes: 2, cache: 9, cacheOther: 0 },
    'reads: the two columns of every row, the Archive\'s three, six rows, and the ids of the rows about to be emptied; writes: three tables to the Archive at once, and their three rows emptied',
  );
  assert.deepEqual(calls.made.filter((call) => call.startsWith('Ledger') || call.startsWith('Hands')), []);
});

test('last words kept in both tabs cost each table a fixed number of calls more, so the most a sweep does is still bounded', () => {
  const ages: Record<string, number> = { NEW222: 1 };
  for (let index = 0; index < 8; index++) {
    ages[`OLD${index + 100}`] = 90 - index;
  }

  const { archive, calls, spreadsheet, sweep } = aged(ages);
  const lastWords: LastWords = (state) => [buyIn(-1, state.id), { type: 'hand', record: handRecord(state.id, 1) }];

  sweep(lastWords);
  calls.made = [];
  sweep(lastWords);

  assert.equal(idsIn(archive()).length, 6);
  assert.equal(spreadsheet.getSheetByName('Ledger')!.getLastRow() - 1, 6);
  assert.deepEqual(
    { reads: calls.count('.getValues'), writes: calls.count('.setValues'), flushes: calls.count('flush') },
    { reads: 3 + 3 * 3, writes: 4 + 3 * 4, flushes: 2 + 3 * 4 },
    'for each table: its row and the end of two tabs read; its records held, written to each tab and taken off its row, each pushed through',
  );
});

test('a table that was put away is known from the Archive, which is read once and then remembered, like a table that never was', () => {
  const { archive, cache, anotherRun, sweep } = aged({ OLD222: 20, NEW333: 1 });
  sweep();

  const reads = () => archive()!.reads;
  const before = reads();

  assert.equal(anotherRun().peek('OLD222'), null);
  assert.equal(reads(), before + 1, 'the first look reads the Archive\'s ids');
  assert.equal(cache.get('peek:OLD222'), 'away');
  assert.equal(cache.seconds.get('peek:OLD222'), 30);

  // Every poll of a page left open on it, and every question after it, for as long as the cache remembers
  for (let poll = 0; poll < 5; poll++) {
    assert.equal(anotherRun().peek('OLD222'), null);
    assert.equal(anotherRun().read('OLD222'), null);
    assert.equal(anotherRun().wasPutAway('OLD222'), true);
  }

  assert.equal(anotherRun().peek('NEVER2'), null);
  assert.equal(reads(), before + 2);
  assert.equal(cache.get('peek:NEVER2'), 'none');
  assert.equal(anotherRun().wasPutAway('NEVER2'), false);
  assert.equal(reads(), before + 2, 'a table that never was costs the Archive one look too');

  // After a table was looked up under its lock, which leaves no note, the answer is found without one
  cache.entries.clear();
  assert.equal(anotherRun().transact('OLD222', (state) => ({ save: null, effects: [], result: state })), null);
  assert.equal(anotherRun().wasPutAway('OLD222'), true);
  assert.equal(reads(), before + 3);

  // And asked of a table that is there, whatever the cache has lost, it says no and notes nothing against it
  cache.entries.clear();
  assert.equal(anotherRun().wasPutAway('NEW333'), false);
  assert.equal(cache.get('peek:NEW333'), null);
  assert.equal(anotherRun().peek('NEW333')!.version, 1);
});

test('a sweep does not queue for the lock as a move does: when it is taken, the old tables wait for the next sweep', () => {
  const { store, tables, lock, sweep } = aged({ OLD222: 20 });

  lock.waits = [];
  save(store, table('NEW333'));
  sweep();
  assert.deepEqual(lock.waits, [20_000, 1000]);
  assert.deepEqual(idsIn(tables), ['', 'NEW333']);

  const busy = aged({ OLD222: 20 });
  busy.lock.busy = true;
  assert.doesNotThrow(() => busy.sweep());
  assert.deepEqual(idsIn(busy.tables), ['OLD222']);
});

test('a table put back by hand is a table again, and is not put away once more until two weeks after it is next saved', () => {
  const { tables, archive, cache, anotherRun, sweep } = aged({ OLD222: 20, NEW333: 1 });
  sweep();
  assert.equal(anotherRun().read('OLD222'), null);

  // As the README says: the first twelve cells of its Archive row into an empty row of Tables, and its Updated cell emptied
  tables.cells[1] = archive()!.cells[1]!.slice(0, TABLE_CELLS);
  tables.formats[1] = Array.from({ length: TABLE_CELLS }, () => '@');
  tables.cells[1]![1] = '';
  cache.entries.clear();

  assert.deepEqual(anotherRun().read('OLD222'), table('OLD222'));
  sweep();
  assert.deepEqual(idsIn(tables), ['OLD222', 'NEW333'], 'with no time in its Updated cell it counts as new');

  save(anotherRun(), table('OLD222', 2), [], NOW);
  save(anotherRun(), table('NEW333', 2), [], NOW);
  sweep(nothingToSay, NOW + 14 * DAY_MS - 1);
  assert.deepEqual(idsIn(tables), ['OLD222', 'NEW333']);

  sweep(nothingToSay, NOW + 14 * DAY_MS);
  assert.deepEqual(idsIn(tables), ['', '']);
  assert.deepEqual(archive()!.cells.slice(1).map((row) => [row[0], row[2]]), [['OLD222', '1'], ['NEW333', '2'], ['OLD222', '2']], 'the Archive keeps both times it was put away');

  // Put back from the older of its rows and played on, it comes to a version the Archive has under another save
  const replayed = table('OLD222', 2);
  replayed.config.name = 'Played again';
  tables.cells[1] = archive()!.cells[1]!.slice(0, TABLE_CELLS);
  tables.cells[1]![1] = '';
  cache.entries.clear();
  save(anotherRun(), replayed, [], NOW + 15 * DAY_MS);

  sweep(nothingToSay, NOW + 30 * DAY_MS);
  assert.deepEqual(idsIn(tables), ['', '']);
  assert.deepEqual(archive()!.cells.slice(1).map((row) => [row[0], row[2], row[12]]).slice(2), [['OLD222', '2', "Chips n' Dipshits"], ['OLD222', '2', 'Played again']], 'which is kept as well, not taken for the one already there');
});

test('a table put away whose cache entries outlived it, and a new table in its row: nothing asked of either reads or writes the other', () => {
  const { cache, tables, anotherRun, sweep } = aged({ OLD222: 20, LIVE33: 0 });
  const entries = ['state:OLD222', 'peek:OLD222', 'row:OLD222'];
  const outlived = entries.map((key) => cache.get(key)!);
  assert.equal(cache.get('row:OLD222'), '2');

  sweep();
  save(anotherRun(), table('NEW444'));
  assert.equal(cache.get('row:NEW444'), '2', 'the new table has taken the row the old one left');

  // Everything the cache had of the old table is back, as if none of it had been removed: its row number
  // and the new table's now name the same row
  const stale = (): void => entries.forEach((key, index) => cache.put(key, outlived[index]!, 600));
  const theirRow = (): unknown[] => [...tables.cells[1]!];
  const before = theirRow();
  stale();

  // A move from a tab left open on the old table: it is handed no table, least of all the new one, and writes nothing
  const handed: unknown[] = [];
  const moved = anotherRun().transact('OLD222', (state) => {
    handed.push(state);

    return state ? { save: { ...state, version: 99 }, at: NOW, effects: [buyIn(999, 'OLD222')], result: 'saved' } : { save: null, effects: [], result: 'no table' };
  });

  assert.deepEqual([moved, handed], ['no table', [null]]);
  assert.deepEqual(theirRow(), before, 'the row is the new table\'s, untouched');

  // What its polls are answered from is its own last state out of the cache, never the row
  assert.deepEqual(anotherRun().read('OLD222'), table('OLD222'));
  assert.deepEqual(anotherRun().peek('OLD222'), { version: 1, wakeAt: null });

  // Asked what became of it, as the service asks after such a move, the store finds out and lets go of all three
  assert.equal(anotherRun().wasPutAway('OLD222'), true);
  assert.deepEqual(entries.map((key) => cache.get(key)), [null, 'away', null]);
  assert.deepEqual([anotherRun().read('OLD222'), anotherRun().peek('OLD222')], [null, null]);

  // The other way round: the new table is read and saved in its row with the old one's number pointing there too
  stale();
  assert.deepEqual(anotherRun().read('NEW444'), table('NEW444'));
  save(anotherRun(), table('NEW444', 2));
  assert.deepEqual([tables.cells[1]![0], tables.cells[1]![2]], ['NEW444', '2']);
  assert.equal(anotherRun().transact('OLD222', (state) => ({ save: null, effects: [], result: state })), null);

  // And a wrong number for a table that is there sends the store to look for it, never to another table's row
  cache.put('row:LIVE33', '2', 600);
  save(anotherRun(), table('LIVE33', 2));
  assert.deepEqual(tables.cells.slice(1).map((row) => [row[0], row[2]]), [['NEW444', '2'], ['LIVE33', '2']]);
  assert.equal(cache.get('row:LIVE33'), '3');
});

// ---- The two stores, held to each other ----

const TABLES_AT_ONCE = 8;
const STEPS = 250;
const SEEDS = 30;
const JUMPS = [1000, 60_000, 3_600_000, DAY_MS, 3 * DAY_MS, 6 * DAY_MS, 15 * DAY_MS];

test('the Sheet store and the memory store agree after every step of random creates, saves, loads, polls and sweeps, with cache entries lost at any moment', () => {
  // What the random runs came to between them, so that the test cannot pass by never doing the thing it is about
  const seen = { putAway: 0, askedAfter: 0, rowsTakenAgain: 0, sweepsWithOthersLeft: 0 };

  // Something to tell for every other table, which the stores must then both have kept
  const lastWords: LastWords = (state) => (state.version % 2 === 0 ? [buyIn(-state.version, state.id)] : []);

  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = seededRng(seed);
    const memory = new MemoryStore();

    // A script run of its own for every request, as the deployed game has: nothing is carried over but the Sheet and the cache
    const { spreadsheet, cache, anotherRun: sheet } = setup();
    const both = <T>(what: string, ask: (store: TableStore) => T): T => {
      const answers = [ask(sheet()), ask(memory)] as const;
      assert.deepEqual(answers[0], answers[1], what);

      return answers[1];
    };

    const ids: string[] = [];
    let now = NOW;

    for (let step = 0; step < STEPS; step++) {
      const at = `seed ${seed}, step ${step}`;
      const id = ids.length > 0 ? ids[rng.int(ids.length)]! : null;
      const roll = rng.int(100);

      // The cache may drop anything at any time: everything it holds, or one entry while its neighbors stay
      if (rng.int(10) === 0) {
        cache.entries.clear();
      } else if (rng.int(4) === 0 && cache.entries.size > 0) {
        cache.entries.delete([...cache.entries.keys()][rng.int(cache.entries.size)]!);
      }

      if (roll < 12 && ids.filter((known) => memory.read(known)).length < TABLES_AT_ONCE) {
        const created = `M${String(seed).padStart(2, '0')}${String(ids.length).padStart(3, '0')}`;

        seen.rowsTakenAgain += idsIn(spreadsheet.getSheetByName('Tables')).includes('') ? 1 : 0;
        ids.push(created);
        both(`${at}: creating ${created}`, (store) => store.transact(created, (existing) => (existing ? { save: null, effects: [], result: false } : { save: table(created), at: now, effects: [], result: true })));
      } else if (roll < 40 && id) {
        const effects = rng.int(3) === 0 ? [buyIn(100 + step, id)] : [];

        seen.askedAfter += memory.wasPutAway(id) ? 1 : 0;
        both(`${at}: saving ${id}`, (store) =>
          store.transact(id, (state) => {
            if (!state) {
              return { save: null, effects: [], result: null };
            }

            state.version += 1;

            return { save: state, at: now, effects, result: state.version };
          }),
        );
      } else if (roll < 55 && id) {
        both(`${at}: loading ${id}`, (store) => store.read(id));
      } else if (roll < 70 && id) {
        both(`${at}: polling ${id}`, (store) => store.peek(id));
      } else if (roll < 78 && id) {
        both(`${at}: looking up ${id} under its lock`, (store) => store.transact(id, (state) => ({ save: null, effects: [], result: state })));
      } else if (roll < 90) {
        const before = ids.filter((known) => memory.wasPutAway(known)).length;

        sheet().putAwayOld(now, lastWords);
        memory.putAwayOld(now, lastWords);

        const moved = ids.filter((known) => memory.wasPutAway(known)).length - before;
        seen.putAway += moved;
        seen.sweepsWithOthersLeft += moved > 0 && ids.some((known) => memory.read(known)) ? 1 : 0;
      } else {
        now += JUMPS[rng.int(JUMPS.length)]!;
      }

      // After every step, every table ever made: there or not, the same table, and put away or not
      for (const known of ids) {
        const state = both(`${at}: ${known} as loaded`, (store) => store.read(known));
        both(`${at}: ${known} as polled`, (store) => store.peek(known));

        if (!state) {
          assert.deepEqual([sheet().wasPutAway(known), memory.wasPutAway(known)], [true, true], `${at}: ${known} is gone without having been put away`);
        }

        // The Sheet itself: a table is in the Tables tab exactly when it is there to load, once, and in the Archive when it was put away
        assert.equal(idsIn(spreadsheet.getSheetByName('Tables')).filter((row) => row === known).length, state ? 1 : 0, `${at}: ${known} in the Tables tab`);
        assert.equal(idsIn(spreadsheet.getSheetByName('Archive')).includes(known), !state, `${at}: ${known} in the Archive`);
      }

      const ledger = (spreadsheet.getSheetByName('Ledger')?.cells ?? []).slice(1).map((row) => row[4]);
      assert.deepEqual(ledger, memory.ledger.map((entry) => entry.amount), `${at}: the ledger entries kept`);
    }
  }

  assert.ok(seen.putAway > 100, `only ${seen.putAway} tables were put away`);
  assert.ok(seen.sweepsWithOthersLeft > 30, `only ${seen.sweepsWithOthersLeft} sweeps moved tables from among others that stayed`);
  assert.ok(seen.askedAfter > 100, `a table that had been put away was saved to only ${seen.askedAfter} times`);
  assert.ok(seen.rowsTakenAgain > 30, `a new table found an empty row only ${seen.rowsTakenAgain} times`);
});

// ---- The Errors tab ----

const ERRORS_ROW_LIMIT = 1 + ERROR_LIMITS.rowsKept + ERROR_LIMITS.rowsPerReport;

/** An Errors tab in a Sheet whose other tabs need the lock, with the calls made to it and the cache counted apart, and a clock the test moves. */
function errorsSetup() {
  const lock = new FakeLock();
  const calls = new Calls();
  const spreadsheet = new FakeSpreadsheet(lock, { [ERRORS_TAB]: ERRORS_ROW_LIMIT }, calls, [ERRORS_TAB]);
  const cache = new FakeCache(calls);
  const clock = { time: NOW, now: () => clock.time };

  /** A log as one script run has it: each request is a run of its own. */
  const run = () => new SheetErrorLog({ spreadsheet: () => spreadsheet, cache, clock, build: 'thisbuild123' });
  const tab = () => spreadsheet.getSheetByName(ERRORS_TAB);

  return { lock, calls, spreadsheet, cache, clock, run, tab };
}

test('the first failure makes the Errors tab, with its headers and every row formatted, without the lock and whoever holds it', () => {
  const { lock, spreadsheet, run, tab } = errorsSetup();

  assert.equal(tab(), null, 'nothing is made before there is something to write');
  lock.busy = true;
  run().report({ where: 'server act', error: new Error('Sheet broke'), tableId: 'ABC234' });

  const sheet = tab()!;
  assert.deepEqual(sheet.cells[0], ['When', 'Where', 'Times', 'Message', 'Table', 'Build', 'Browser', 'Trace']);
  assert.deepEqual(sheet.cells[1]!.slice(1, 7), ['server act', 1, 'Sheet broke', 'ABC234', 'thisbuild123', '']);
  assert.ok(sheet.cells[1]![0] instanceof Date);
  assert.equal(sheet.formats.length, 1000);
  assert.deepEqual(sheet.formats[999], [TIMESTAMP, TEXT, WHOLE_NUMBER, TEXT, TEXT, TEXT, TEXT, TEXT]);
  assert.deepEqual(lock.waits, [], 'the lock was asked for');
  assert.equal(spreadsheet.getSheetByName('Tables'), null);
});

test('a tab someone made with other headers is added to below its last row, its headers left as they are', () => {
  const { lock, spreadsheet, run, tab } = errorsSetup();

  lock.waitLock(0);
  const made = spreadsheet.insertSheet(ERRORS_TAB);
  made.getRange(1, 1, 3, 2).setValues([
    ['Date', 'What went wrong'],
    ['yesterday', 'a note'],
    ['', ''],
  ]);
  lock.releaseLock();

  run().report({ where: 'page', error: 'Boom' });

  assert.deepEqual(tab()!.cells.slice(0, 2), [
    ['Date', 'What went wrong'],
    ['yesterday', 'a note'],
  ]);
  assert.equal(tab()!.shown(3, 4), 'Boom');
});

test('text that a Sheet would take for a formula is written as text, in the tab the game made and in one made by hand without formats', () => {
  const texts = ['=SUM(A1:A9)', '+1+2', '-5 chips', '@someone'];

  for (const byHand of [false, true]) {
    const { lock, spreadsheet, clock, run, tab } = errorsSetup();

    if (byHand) {
      lock.waitLock(0);
      spreadsheet.insertSheet(ERRORS_TAB).getRange(1, 1, 1, 1).setValues([['Errors']]);
      lock.releaseLock();
    }

    for (const text of texts) {
      clock.time += 60_000;
      run().report({ where: text, error: text });
    }

    const sheet = tab()!;
    const rows = Array.from({ length: texts.length }, (_row, index) => index + 2);

    for (const [index, row] of rows.entries()) {
      for (const column of [2, 4]) {
        const shown = sheet.shown(row, column);

        assert.ok(shown === texts[index] || shown === `'${texts[index]}`, `${byHand ? 'by hand' : 'made by the game'}: ${shown}`);
        assert.equal(typeof sheet.cells[row - 1]![column - 1], 'string');
      }
    }
  }
});

test('past its cap the oldest rows go in one call, so the newest are always there and the tab never grows past it', () => {
  const { calls, clock, run, tab } = errorsSetup();
  let deletes = 0;

  for (let n = 0; n < 2 * ERROR_LIMITS.rowsKept; n++) {
    clock.time += 60_000;
    run().report({ where: 'server act', error: `failure ${n.toString(36)}x` });

    const kept = tab()!.getLastRow() - 1;
    assert.ok(kept <= ERROR_LIMITS.rowsKept, `${kept} rows after failure ${n}`);
    deletes = calls.count('.deleteRows');
  }

  assert.ok(deletes >= 2 && deletes <= 2 * ERROR_LIMITS.rowsKept / 50, `${deletes} trims`);
  assert.equal(tab()!.cells[0]![0], 'When', 'the headers stay');
  assert.equal(tab()!.shown(tab()!.getLastRow(), 4), `failure ${(2 * ERROR_LIMITS.rowsKept - 1).toString(36)}x`);
});

test('a report costs a known number of calls, a repeat only the cache, and a run reports three failures at most', () => {
  const { calls, run } = errorsSetup();

  run().report({ where: 'server act', error: 'first' });
  calls.made = [];

  const log = run();
  log.report({ where: 'server act', error: 'second' });
  assert.deepEqual(calls.made, ['cache.get', 'cache.put', 'spreadsheet.getSheetByName', 'Errors.appendRow', 'Errors.getLastRow']);

  calls.made = [];
  log.report({ where: 'server act', error: 'second' });
  assert.deepEqual(calls.made, ['cache.get', 'cache.put']);

  const busy = errorsSetup();
  const many = busy.run();
  for (let n = 0; n < 10; n++) {
    many.report({ where: 'server act', error: `kind ${'abcdefghij'[n]}` });
  }

  assert.equal(busy.tab()!.getLastRow(), 1 + REPORTS_PER_RUN);
  assert.ok(busy.calls.made.length <= 2 + 5 + REPORTS_PER_RUN * 4, busy.calls.made.join(' '));
});

test('every call of a report failed in turn: nothing is thrown, the lock is never asked for, and the next run writes as usual', () => {
  const clean = errorsSetup();
  clean.run().report({ where: 'server act', error: 'first' });
  const steps = [...clean.calls.made];

  for (const kind of ['cache.get', 'cache.put', 'spreadsheet.insertSheet', 'Errors.setNumberFormats', 'Errors.setValues', 'Errors.appendRow', 'Errors.getLastRow']) {
    assert.ok(steps.includes(kind), `no call to ${kind}`);
  }

  for (let failing = 1; failing <= steps.length; failing++) {
    const context = errorsSetup();
    const step = `call ${failing}, ${steps[failing - 1]}`;

    context.calls.failNth(failing);
    assert.doesNotThrow(() => context.run().report({ where: 'server act', error: 'first' }), step);
    assert.deepEqual(context.lock.waits, [], step);

    // The counts are in the cache, but the row does not hang on them
    if (steps[failing - 1]!.startsWith('cache.')) {
      assert.equal(context.tab()?.shown(2, 4), 'first', `${step}: the row was not written`);
    }

    context.clock.time += ERROR_LIMITS.repeatWindowMs;
    context.run().report({ where: 'server act', error: 'second' });
    assert.equal(context.tab()?.shown(context.tab()!.getLastRow(), 4), 'second', step);
  }
});

test('the counts kept in the cache stay well inside its limits at their fullest', () => {
  const { cache, clock, run } = errorsSetup();
  const words = (n: number) => `${n.toString(36)} ${'long words '.repeat(30)}`;

  for (let minute = 0; minute < 5; minute++) {
    clock.time += 60_000;

    for (let n = 0; n < 40; n++) {
      run().report({ where: `server ${'x'.repeat(30)}`, error: words(minute * 40 + n), tableId: 'ABC234', page: { memberId: `M${String(n).padStart(7, '0')}`, build: 'b'.repeat(40), browser: null } });
    }
  }

  const kept = cache.entries.get('errors:tally')!;
  assert.ok(Buffer.byteLength(kept, 'utf8') < 20_000, `${kept.length} characters`);
  assert.deepEqual(
    [...cache.seconds.entries()].filter(([key]) => key.startsWith('errors')),
    [['errors:tally', ERROR_LIMITS.tallySeconds]],
  );
});

/** A game on the Sheet with its log (or none), the Errors tab and its cache counted apart from the store's calls, so either can be failed alone. */
function sheetGame(logged: boolean) {
  const store = setup();
  const logCalls = new Calls();
  const book = new FakeSpreadsheet(store.lock, { [ERRORS_TAB]: ERRORS_ROW_LIMIT }, logCalls, [ERRORS_TAB]);
  const clock = { now: () => NOW };
  const errors = logged ? new SheetErrorLog({ spreadsheet: () => book, cache: new FakeCache(logCalls), clock, build: 'thisbuild123' }) : NOWHERE;
  const sheetStore = new SheetStore({ spreadsheet: () => store.spreadsheet, cache: store.cache, lock: store.lock, flush: () => store.calls.note('flush'), errors });
  const game = new PokerService({ store: sheetStore, presets: new MemoryPresetStore(), players: new MemoryPlayerStore(seededRng(10)), clock, rng: seededRng(9), errors });
  const host = game.handle({ op: 'create', name: 'Host', config: { minBuyIn: 100 } });
  assert.ok(host.ok && host.kind === 'joined');

  const sitDown = () => {
    try {
      return game.handle({ op: 'act', tableId: host.view.id, auth: host.auth, command: { type: 'requestSeat', seat: 0, buyIn: 1000 } });
    } catch (error) {
      return { threw: String(error) };
    }
  };

  return { ...store, logCalls, book, sitDown };
}

test("failing each of a request's own Sheet, cache and flush calls in turn gets the same answer with the log as without, and failing the log's own calls changes nothing", () => {
  const learned = sheetGame(true);
  learned.calls.made = [];
  learned.sitDown();
  const steps = learned.calls.made.length;
  let reported = 0;

  for (let failing = 1; failing <= steps; failing++) {
    const plain = sheetGame(false);
    plain.calls.failNth(failing);
    const answer = plain.sitDown();

    const logged = sheetGame(true);
    logged.calls.failNth(failing);
    logged.logCalls.made = [];
    assert.deepEqual(logged.sitDown(), answer, `store call ${failing}`);

    const logSteps = logged.logCalls.made.length;
    reported += logSteps > 0 ? 1 : 0;

    for (let logFailing = 1; logFailing <= logSteps; logFailing++) {
      const both = sheetGame(true);
      both.calls.failNth(failing);
      both.logCalls.failNth(logFailing);
      assert.deepEqual(both.sitDown(), answer, `store call ${failing}, log call ${logFailing}`);
    }
  }

  assert.ok(reported >= 5, `only ${reported} of the failed calls were reported`);
});

test('what the store notes while holding the lock is reported once the lock is let go, to an Errors tab in the same Sheet', () => {
  const lock = new FakeLock();
  const spreadsheet = new FakeSpreadsheet(lock, {}, null, [ERRORS_TAB]);
  const cache = new FakeCache();
  const log = new SheetErrorLog({ spreadsheet: () => spreadsheet, cache, clock: { now: () => NOW }, build: 'thisbuild123' });
  const reported: { where: string; lockHeld: boolean }[] = [];
  const errors = {
    report: (failure: Parameters<SheetErrorLog['report']>[0]) => {
      reported.push({ where: failure.where, lockHeld: lock.held });
      log.report(failure);
    },
  };
  const store = new SheetStore({ spreadsheet: () => spreadsheet, cache, lock, flush: () => undefined, errors });

  save(store, table('ABC234'));
  lock.waitLock(0);
  spreadsheet.insertSheet('Ledger').refuseWritesAfter(0);
  lock.releaseLock();
  save(store, table('ABC234', 2), [buyIn(500)]);

  assert.deepEqual(reported, [{ where: 'store copy to Ledger', lockHeld: false }]);
  assert.deepEqual([2, 5].map((column) => spreadsheet.getSheetByName(ERRORS_TAB)!.shown(2, column)), ['store copy to Ledger', 'ABC234']);
});

test('a sweep that fails is reported before the call that made it returns, which is the last of a new table', () => {
  const errors = new MemoryErrorLog({ now: () => NOW });
  const store = new SheetStore({
    spreadsheet: () => {
      throw new Error('Sheet down');
    },
    cache: new FakeCache(),
    lock: new FakeLock(),
    flush: () => undefined,
    errors,
  });

  store.putAwayOld(NOW, () => []);

  assert.deepEqual(
    errors.rows.map((row) => [row.where, row.message]),
    [['store put away', 'Sheet down']],
  );
});

test('two runs that fail first at the same moment make one Errors tab with one header row, and lose a row at worst, never failing', () => {
  /** The Sheet as a run sees it that looked for the tab before the other run made it. */
  const lookedEarly = (spreadsheet: FakeSpreadsheet, made: (sheet: FakeSheet) => void = () => undefined): SpreadsheetLike => {
    let looked = false;

    return {
      getSheetByName: (name) => (looked ? spreadsheet.getSheetByName(name) : ((looked = true), null)),
      insertSheet: (name) => {
        const sheet = spreadsheet.insertSheet(name);
        made(sheet);

        return sheet;
      },
    };
  };
  const logOn = (spreadsheet: SpreadsheetLike) => new SheetErrorLog({ spreadsheet: () => spreadsheet, cache: new FakeCache(), clock: { now: () => NOW }, build: 'thisbuild123' });
  const written = (spreadsheet: FakeSpreadsheet) => spreadsheet.getSheetByName(ERRORS_TAB)!.cells.map((row) => row[1]);

  // The second run's insert comes after the first run has written its row
  const after = new FakeSpreadsheet(null, {}, null, [ERRORS_TAB]);
  logOn(after).report({ where: 'server act', error: 'first' });
  assert.doesNotThrow(() => logOn(lookedEarly(after)).report({ where: 'server poll', error: 'second' }));
  assert.deepEqual(written(after), ['Where', 'server act', 'server poll']);

  // The second run's whole report comes between the first run's insert and its headers
  const between = new FakeSpreadsheet(null, {}, null, [ERRORS_TAB]);
  const second = logOn(lookedEarly(between));
  const first = logOn(lookedEarly(between, () => second.report({ where: 'server poll', error: 'second' })));
  assert.doesNotThrow(() => first.report({ where: 'server act', error: 'first' }));
  assert.deepEqual(written(between), ['Where', 'server act']);
});

// ---- The players the game knows ----

const PLAYER_ROWS = 1 + LIMITS.knownPlayers;
const PLAYER_HEADERS = ['ID (the game knows a player by this, so leave it as it is)', 'Name', 'First seen', 'Last seen'];
const PLAYER_ID = /^[A-HJ-NP-Z2-9]{7}$/;

function playerSetup(rng: Rng = seededRng(77)) {
  const lock = new FakeLock();
  const calls = new Calls();
  const spreadsheet = new FakeSpreadsheet(lock, { Players: PLAYER_ROWS }, calls, [], { Players: LIMITS.nameLength });
  const cache = new FakeCache(calls);

  /** What the error log was told, and whether the lock was still held when it was. */
  const reports: { where: string; held: boolean }[] = [];
  const errors: ErrorLog = { report: (failure) => void reports.push({ where: failure.where, held: lock.held }) };

  /** A script run of its own, as every request of the deployed game is: nothing is carried over but the Sheet and the cache. */
  const run = () => new SheetPlayerStore({ spreadsheet: () => spreadsheet, cache, lock, flush: () => calls.note('flush'), rng, errors });

  // Looked at without a call of its own, which the counts and the failures below would take for the store's
  const tab = () => spreadsheet.sheets.get('Players')!;

  /** What the store says with the cache as it is, held to what the tab alone gives: the cache must never be behind it. */
  const assertCacheNotBehind = (when: string): KnownPlayer[] => {
    const said = run().list();

    cache.entries.clear();
    assert.deepEqual(said, run().list(), `${when}: the cache was behind the tab`);

    return said;
  };

  return { run, spreadsheet, cache, lock, calls, reports, tab, assertCacheNotBehind };
}

/** The calls made to the Sheet itself, by kind, which are the slow ones. */
function sheetCalls(calls: Calls) {
  return {
    opens: calls.count('.getSheetByName'),
    made: calls.count('.insertSheet'),
    lastRows: calls.count('.getLastRow'),
    reads: calls.count('.getValues'),
    formats: calls.count('.setNumberFormats'),
    writes: calls.count('.setValues'),
    flushes: calls.count('flush'),
  };
}

const NO_SHEET_CALLS = { opens: 0, made: 0, lastRows: 0, reads: 0, formats: 0, writes: 0, flushes: 0 };

const playerNames = (store: PlayerStore) => store.list().map((player) => player.name);

for (const [kind, make] of [
  ['in the Sheet', () => playerSetup().run()],
  ['in memory', () => new MemoryPlayerStore(seededRng(77))],
] as [string, () => PlayerStore][]) {
  test(`players ${kind}: someone new gets an id for good, and the list has the most recently seen first`, () => {
    const store = make();
    const ann = store.add('Ann', NOW);
    const bob = store.add('  Big   Bob ', NOW + 1000);

    assert.match(ann.id, PLAYER_ID);
    assert.notEqual(ann.id, bob.id);
    assert.deepEqual(bob, { id: bob.id, name: 'Big Bob' }, 'a name is kept as a table would keep it');
    assert.deepEqual(store.list(), [bob, ann]);

    // Seen again the same night changes nothing; the next night it moves them to the front
    assert.deepEqual(store.seen(ann.id, NOW + SEEN_EVERY_MS - 1), ann);
    assert.deepEqual(store.list(), [bob, ann]);
    assert.deepEqual(store.seen(ann.id, NOW + SEEN_EVERY_MS), ann);
    assert.deepEqual(store.list(), [ann, bob]);

    assert.equal(store.seen('NOBODY2', NOW), null);
    assert.equal(store.seen('', NOW), null);
    assert.deepEqual(store.list(), [ann, bob]);
  });

  test(`players ${kind}: a name that reads like one on the list is refused, naming whose it is`, () => {
    const store = make();
    store.add('Big Al', NOW);
    store.add('Bob', NOW);

    for (const [name, holder] of [['big al', 'Big Al'], ['BIG  AL', 'Big Al'], ['BigAl', 'Big Al'], ['Big AI', 'Big Al'], ['BIG AI', 'Big Al'], ['B\u0131gAl', 'Big Al'], [' bob ', 'Bob'], ['B0b', 'Bob'], ['B0B', 'Bob'], ['B o b', 'Bob']]) {
      assert.throws(() => store.add(name!, NOW), { name: 'NameOnList', message: `${holder} is already on the list of players. If that is you, pick ${holder} from the list. If not, add something to your name` }, name);
    }

    assert.deepEqual(playerNames(store).sort(), ['Big Al', 'Bob']);
    assert.equal(store.add('Bob K', NOW).name, 'Bob K');

    // An i is not an l, though a capital I passes for either
    store.add('Kai', NOW);
    assert.equal(store.add('Kal', NOW).name, 'Kal');
  });

  test(`players ${kind}: only what a table takes for a name gets on the list, up to the longest`, () => {
    const store = make();

    for (const name of ['=1+1', '+1', '-1', '@home', '=SUM(A1)', '', '   ', 'x'.repeat(LIMITS.nameLength + 1), 'Alеx']) {
      assert.throws(() => store.add(name, NOW), { name: 'GameError' }, name);
    }

    assert.deepEqual(store.list(), []);

    const longest = 'W'.repeat(LIMITS.nameLength);
    assert.deepEqual(playerNames(store.add(longest, NOW) && store), [longest]);
  });

  test(`players ${kind}: the list takes ${LIMITS.knownPlayers} players and then nobody new, and those on it are still found`, () => {
    const store = make();
    const first = store.add('Player 0', NOW);

    for (let index = 1; index < LIMITS.knownPlayers; index++) {
      store.add(`Player ${index}`, NOW);
    }

    assert.throws(() => store.add('One more', NOW), { name: 'ListFull', message: `The list of players is full at ${LIMITS.knownPlayers}. Whoever runs the game can make room in its Sheet` });
    assert.throws(() => store.add('player 7', NOW), { name: 'NameOnList' }, 'a name on the list is still told so, full or not');
    assert.equal(store.list().length, LIMITS.knownPlayers);
    assert.deepEqual(store.seen(first.id, NOW + DAY_MS), first);
    assert.deepEqual(store.list()[0], first);
  });
}

test('players in a Sheet that has never had one: asking finds nobody and makes no tab, and the first to join makes it, with its headers and their row', () => {
  const { run, spreadsheet, tab } = playerSetup();

  assert.deepEqual(run().list(), []);
  assert.equal(run().seen('ABCDEFG', NOW), null);
  assert.equal(spreadsheet.sheets.has('Players'), false, 'reading made the tab');

  const quigs = run().add('Quigs', NOW);

  assert.deepEqual(tab().cells, [PLAYER_HEADERS, [quigs.id, 'Quigs', new Date(NOW), new Date(NOW)]]);
  assert.deepEqual(tab().formats[1], ['@', '@', 'yyyy-mm-dd hh:mm:ss', 'yyyy-mm-dd hh:mm:ss']);
  assert.deepEqual(run().list(), [quigs]);
});

test('a Players tab with nothing in it, as when making it failed halfway, reads as nobody known and gets its headers with the first player', () => {
  const { run, spreadsheet, tab, lock } = playerSetup();

  lock.held = true;
  spreadsheet.insertSheet('Players');
  lock.held = false;

  assert.deepEqual(run().list(), []);

  const quigs = run().add('Quigs', NOW);
  assert.deepEqual(tab().cells, [PLAYER_HEADERS, [quigs.id, 'Quigs', new Date(NOW), new Date(NOW)]]);
});

test('a Players tab under other headers is read by where things are, and its headers are left as someone wrote them', () => {
  const { run, tab } = playerSetup();
  const quigs = run().add('Quigs', NOW);

  tab().cells[0] = ['Who', 'Called', 'Since', 'Lately', 'Notes'];
  tab().cells[1]![4] = 'owes me a beer';

  const ann = run().add('Ann', NOW + 1000);

  assert.deepEqual(tab().cells[0], ['Who', 'Called', 'Since', 'Lately', 'Notes']);
  assert.deepEqual(tab().cells[1]![4], 'owes me a beer');
  assert.deepEqual(run().list(), [ann, quigs]);
});

test('a Players tab whose header row was deleted by hand still has the player who moved up into its place, and goes on being written to', () => {
  const { run, tab, cache } = playerSetup();
  const quigs = run().add('Quigs', NOW);
  const ann = run().add('Ann', NOW + 1000);

  tab().cells.shift();
  cache.entries.clear();

  assert.deepEqual(run().list(), [ann, quigs]);

  const bob = run().add('Bob', NOW + 2000);
  assert.deepEqual(tab().cells.map((cells) => cells[1]), ['Quigs', 'Ann', 'Bob'], 'no headers were written over the first player');
  assert.deepEqual(run().list(), [bob, ann, quigs]);

  assert.deepEqual(run().seen(quigs.id, NOW + SEEN_EVERY_MS), quigs);
  assert.deepEqual(tab().cells[0]![3], new Date(NOW + SEEN_EVERY_MS));
  assert.deepEqual(run().list(), [quigs, bob, ann]);
});

test('ids and names that a spreadsheet would take for a number or a date are kept as the text they are', () => {
  // An id spelled 2E56789, which a cell not formatted as text keeps as 2 followed by 56789 zeros
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const spelled = [...'2E56789', ...['A', 'B', 'C', 'D'].map((letter) => letter.repeat(7)).join('')].map((letter) => letters.indexOf(letter));
  const { run, cache, tab } = playerSetup({ int: () => spelled.shift()! });
  const names = ['1E5', '007', '3.14', '1-2', '12'];

  const added = names.map((name, index) => run().add(name, NOW + index));
  assert.equal(added[0]!.id, '2E56789');

  cache.entries.clear();
  assert.deepEqual(run().list(), [...added].reverse(), 'read back from the tab itself');
  assert.deepEqual(tab().cells.slice(1).map((row) => row[1]), names);
  assert.equal(tab().cells[1]![0], '2E56789');
});

test('rows of the Players tab changed by hand: a renamed player keeps their id, a removed one is nobody, and what can no longer be read is skipped and keeps its place', () => {
  const { run, cache, tab } = playerSetup();
  const [ann, bob, cat, dee, eve, flo] = ['Ann', 'Bob', 'Cat', 'Dee', 'Eve', 'Flo'].map((name, index) => run().add(name, NOW + index));

  const cells = tab().cells;
  cells[1]![1] = 'Annie';
  cells[2] = ['', '', '', ''];
  cells[3]![0] = 'not an id';
  cells[4]![1] = 'A name far too long to be one';
  cells[5]![0] = ann!.id;
  cells[6]![1] = 'ANNIE';
  cells.push(['', 'Typed in by hand', '', '']);
  cells[40] = ['', '', '', '', '', 'ask Stu who this was'];

  // Until the cache entry runs out, which is five minutes at most, the game goes on with the list as it was
  assert.deepEqual(run().seen(bob!.id, NOW), bob);
  assert.equal(cache.seconds.get('players'), 300);
  cache.entries.clear();

  assert.deepEqual(run().list(), [{ id: ann!.id, name: 'Annie' }]);
  assert.deepEqual(run().seen(ann!.id, NOW), { id: ann!.id, name: 'Annie' });
  for (const gone of [bob, cat, dee, eve, flo]) {
    assert.equal(run().seen(gone!.id, NOW), null, gone!.name);
  }

  // Someone new takes the row that was cleared, and nothing else is touched
  const before = JSON.stringify(cells.filter((_row, index) => index !== 2));
  const gus = run().add('Gus', NOW + 100);
  assert.equal(cells[2]![0], gus.id);
  assert.equal(JSON.stringify(cells.filter((_row, index) => index !== 2)), before);

  // A row that can't be read is nobody by any name, and still counts toward how many the list holds
  assert.equal(run().add('Cat', NOW + 200).name, 'Cat');
  for (let index = 0; run().list().length + 5 < LIMITS.knownPlayers; index++) {
    run().add(`Player ${index}`, NOW);
  }

  assert.throws(() => run().add('One more', NOW), { name: 'ListFull' });
  assert.ok(tab().getLastRow() <= PLAYER_ROWS);
});

test('a player\'s last-seen cell that is empty or says something else counts as never seen, and is written the next time they are', () => {
  const { run, cache, tab } = playerSetup();
  const ann = run().add('Ann', NOW);
  const bob = run().add('Bob', NOW + 1);

  tab().cells[2]![3] = 'last Friday';
  cache.entries.clear();
  assert.deepEqual(run().list(), [ann, bob]);

  assert.deepEqual(run().seen(bob.id, NOW + 2), bob);
  assert.deepEqual(tab().cells[2]![3], new Date(NOW + 2));
  assert.deepEqual(run().list(), [bob, ann]);
});

test('what a join costs the Sheet: nothing while the list is cached, one read when it is not, and a fixed handful of calls for someone new or a note that a player was seen, however many are known', () => {
  for (const known of [0, 50, LIMITS.knownPlayers - 1]) {
    const { run, cache, calls } = playerSetup();
    const players = Array.from({ length: known }, (_player, index) => run().add(`Player ${index}`, NOW));
    const counted = (work: () => void) => {
      calls.made = [];
      work();

      return { ...sheetCalls(calls), cacheGets: calls.count('cache.get'), cachePuts: calls.count('cache.put') };
    };
    const at = `with ${known} known`;

    cache.entries.clear();
    assert.deepEqual(counted(() => run().list()), { ...NO_SHEET_CALLS, opens: 1, lastRows: known > 0 ? 1 : 0, reads: known > 0 ? 1 : 0, cacheGets: 2, cachePuts: 1 }, `${at}: the list, not cached`);
    assert.deepEqual(counted(() => run().list()), { ...NO_SHEET_CALLS, cacheGets: 1, cachePuts: 0 }, `${at}: the list, cached`);

    if (known > 0) {
      const player = players[known - 1]!;

      assert.deepEqual(counted(() => run().seen(player.id, NOW + 1000)), { ...NO_SHEET_CALLS, cacheGets: 1, cachePuts: 0 }, `${at}: a known player joins on a night they were already seen`);
      assert.deepEqual(counted(() => run().seen('NOBODY2', NOW)), { ...NO_SHEET_CALLS, cacheGets: 1, cachePuts: 0 }, `${at}: an id the list does not have`);
      assert.deepEqual(
        counted(() => run().seen(player.id, NOW + SEEN_EVERY_MS)),
        { opens: 1, made: 0, lastRows: 1, reads: 1, formats: 1, writes: 1, flushes: 1, cacheGets: 1, cachePuts: 1 },
        `${at}: a known player joins on a new night`,
      );
    }

    assert.deepEqual(
      counted(() => run().add('Someone new', NOW)),
      { opens: 1, made: known > 0 ? 0 : 1, lastRows: 1, reads: 1, formats: 1, writes: known > 0 ? 1 : 2, flushes: 1, cacheGets: 0, cachePuts: 1 },
      `${at}: someone new`,
    );
  }
});

test('the list of players is refilled once when everyone opening the game finds the cache empty at the same moment', () => {
  const { run, cache, calls, lock } = playerSetup();
  const ann = run().add('Ann', NOW);
  cache.entries.clear();

  // The second request found the cache empty, waited for the lock, and by then the first had refilled it
  const second = run();
  const emptyOnce = cache.get.bind(cache);
  let asked = 0;
  cache.get = (key) => (asked++ === 0 ? null : emptyOnce(key));

  assert.deepEqual(run().list(), [ann]);
  calls.made = [];
  asked = 0;
  assert.deepEqual(second.list(), [ann]);
  assert.deepEqual(sheetCalls(calls), NO_SHEET_CALLS);
  assert.equal(lock.held, false);
});

test('the Players tab is written only under the script lock, which this store waits for three seconds: without it someone new is not added, a player already known is still found, and nothing fails for a note that could not be made', () => {
  const { run, cache, lock, tab } = playerSetup();
  const ann = run().add('Ann', NOW);
  assert.equal(lock.held, false, 'the lock was kept');
  assert.deepEqual(lock.waits, [3000]);

  lock.busy = true;
  assert.throws(() => run().add('Bob', NOW), StoreBusyError);
  assert.deepEqual(run().list(), [ann], 'the cached list needs no lock');
  assert.deepEqual(run().seen(ann.id, NOW + DAY_MS), ann, 'nor does finding a player, whose note is left for the next time');
  assert.deepEqual(tab().cells[1]![3], new Date(NOW));

  cache.entries.clear();
  assert.throws(() => run().list(), StoreBusyError, 'a list that has to be read from the tab does');

  lock.busy = false;
  assert.deepEqual(run().seen(ann.id, NOW + DAY_MS), ann);
  assert.deepEqual(tab().cells[1]![3], new Date(NOW + DAY_MS));
  assert.throws(() => tab().getRange(2, 1, 1, 1).setValues([['x']]), /without holding the script lock/);
});

test('what the list of players carries on through is told to the error log by the step that failed, once the lock is let go, and the answer is what it would have been', () => {
  const { run, cache, lock, calls, reports, tab } = playerSetup();
  const ann = run().add('Ann', NOW);

  const told = () => {
    assert.ok(reports.every((report) => !report.held), 'the error log was told while the lock was held');

    return reports.splice(0).map((report) => report.where);
  };
  assert.deepEqual(told(), []);

  // A cache that can't be asked: the list is the tab's
  calls.failNth(1);
  assert.deepEqual(run().list(), [ann]);
  assert.deepEqual(told(), ['store read cached players']);

  // A list read from the tab that can't be put in the cache
  cache.entries.clear();
  calls.made = [];
  cache.failNextWrite = true;
  assert.deepEqual(run().list(), [ann]);
  assert.deepEqual(told(), ['store cache players']);

  // Nor can whatever the cache has be taken out of it
  const untilRemoved = calls.made.indexOf('cache.remove') + 1;
  cache.failNextWrite = true;
  calls.failNth(untilRemoved);
  assert.deepEqual(run().list(), [ann]);
  assert.deepEqual(told(), ['store cache players', 'store forget cached players']);

  // A note that a player was seen that can't be written, for want of the lock or by the Sheet failing
  assert.deepEqual(run().list(), [ann]);
  lock.busy = true;
  assert.deepEqual(run().seen(ann.id, NOW + DAY_MS), ann);
  assert.deepEqual(told(), ['store player last seen']);

  lock.busy = false;
  tab().refuseWritesAfter(0);
  assert.deepEqual(run().seen(ann.id, NOW + DAY_MS), ann);
  assert.deepEqual(told(), ['store player last seen']);
  assert.deepEqual(tab().cells[1]![3], new Date(NOW));

  // What the store answers is told to nobody: a player it does not have, a name it has
  tab().acceptWrites();
  assert.equal(run().seen('ABCDEFG', NOW), null);
  assert.throws(() => run().add('ann', NOW), { name: 'NameOnList' });
  assert.deepEqual(told(), []);
});

test('two people who are the first ever to join, at the same moment, end with one Players tab under one header row', () => {
  const { run, spreadsheet, tab } = playerSetup();
  const [first, second] = [run(), run()];

  // Both asked for the list while there was no tab, and neither made one
  assert.deepEqual([first.list(), second.list()], [[], []]);
  assert.deepEqual([...spreadsheet.sheets.keys()], []);

  // The tab is looked for and made under the lock, so the second finds the one the first made
  first.add('Ann', NOW);
  second.add('Bob', NOW);
  assert.deepEqual([...spreadsheet.sheets.keys()], ['Players']);
  assert.deepEqual(tab().cells.map((row) => row[1]), ['Name', 'Ann', 'Bob']);
});

test('two people new under one name at the same moment: the second sees the first under the lock, and is told the name is taken', () => {
  const { run, tab } = playerSetup();
  const [first, second] = [run(), run()];

  // Both pages had the list before either joined, and neither found the name on it
  assert.deepEqual([first.list(), second.list()], [[], []]);

  first.add('Bob', NOW);
  assert.throws(() => second.add('bob', NOW), { name: 'NameOnList' });
  assert.equal(tab().getLastRow(), 2);
});

test('whichever call fails while someone new is added, a player is noted as seen or the list is read, the cache is never left behind the tab, the lock is let go, and the next try works', () => {
  const tried: Record<string, (context: ReturnType<typeof playerSetup>, ann: KnownPlayer | null) => unknown> = {
    'the first player ever': ({ run }) => run().add('Quigs', NOW),
    'someone new': ({ run }) => run().add('Quigs', NOW),
    'a player seen on a new night': ({ run }, ann) => run().seen(ann!.id, NOW + DAY_MS),
    'the list, not cached': ({ run, cache }) => {
      cache.entries.clear();
      return run().list();
    },
  };

  for (const [what, attempt] of Object.entries(tried)) {
    const fresh = () => {
      const context = playerSetup();
      const ann = what === 'the first player ever' ? null : context.run().add('Ann', NOW);
      context.calls.made = [];

      return { context, ann };
    };

    // Once with nothing failing, to learn every call it makes
    const clean = fresh();
    attempt(clean.context, clean.ann);
    const steps = [...clean.context.calls.made];
    assert.ok(steps.length >= 3, `${what} makes only ${steps.length} calls`);

    for (let failing = 1; failing <= steps.length; failing++) {
      const { context, ann } = fresh();
      const step = `${what}, call ${failing}, ${steps[failing - 1]}`;
      let threw = false;

      context.calls.failNth(failing);
      try {
        attempt(context, ann);
      } catch {
        threw = true;
      }

      assert.equal(context.lock.held, false, step);
      assert.ok(threw || context.reports.length > 0, `${step}: a failure the store carried on through was told to nobody`);
      assert.ok(context.reports.every((report) => !report.held), `${step}: the error log was told while the lock was held`);
      if (what === 'a player seen on a new night') {
        assert.equal(threw && steps[failing - 1] !== 'cache.get', false, `${step}: a note that a player was seen failed the request it rode on`);
      }

      const listed = context.assertCacheNotBehind(step);
      assert.equal(new Set(listed.map((player) => player.id)).size, listed.length, step);

      // What the failed try did or did not leave behind, the next ones go through and leave the tab whole
      if (!listed.some((player) => player.name === 'Quigs')) {
        context.run().add('Quigs', NOW);
      }

      const zoe = context.run().add('Zoe', NOW + 2 * DAY_MS);
      assert.deepEqual(context.run().seen(zoe.id, NOW + 2 * DAY_MS), zoe, step);
      assert.deepEqual(context.assertCacheNotBehind(step).map((player) => player.name).sort(), [...(ann ? ['Ann'] : []), 'Quigs', 'Zoe'], step);
      assert.deepEqual(context.tab().cells[0], PLAYER_HEADERS, `${step}: the tab was left without its headers`);
    }
  }
});

test('the Sheet\'s list of players and the one in memory agree after every step of random joins by known players and new ones, with the cache emptied at any moment', () => {
  const seenIt = { added: 0, refused: 0, movedUp: 0, refills: 0 };

  for (let seed = 1; seed <= 20; seed++) {
    const rng = seededRng(seed);
    const memory = new MemoryPlayerStore(seededRng(1000 + seed));
    const { run, cache, assertCacheNotBehind } = playerSetup(seededRng(1000 + seed));
    const ids: string[] = [];
    let now = NOW;

    const both = <T>(what: string, ask: (store: PlayerStore) => T): T => {
      const answers = [run(), memory].map((store) => {
        try {
          return { answer: ask(store) };
        } catch (error) {
          return { refused: (error as Error).name };
        }
      });
      assert.deepEqual(answers[0], answers[1], what);

      return (answers[1] as { answer: T }).answer;
    };

    for (let step = 0; step < 200; step++) {
      const at = `seed ${seed}, step ${step}`;
      const roll = rng.int(100);

      if (rng.int(6) === 0) {
        seenIt.refills += cache.entries.size;
        cache.entries.clear();
      }

      if (roll < 25) {
        // Now and then a name the list has already, in other letters
        const name = rng.int(4) === 0 ? `player ${rng.int(ids.length + 1)}` : `Player ${ids.length}`;
        const added = both(`${at}: adding ${name}`, (store) => store.add(name, now));

        seenIt.added += added ? 1 : 0;
        seenIt.refused += added ? 0 : 1;
        if (added) {
          ids.push(added.id);
        }
      } else if (roll < 70 && ids.length > 0) {
        const id = ids[rng.int(ids.length)]!;
        const first = memory.list()[0]?.id;

        both(`${at}: ${id} is seen`, (store) => store.seen(id, now));
        seenIt.movedUp += memory.list()[0]?.id === id && first !== id ? 1 : 0;
      } else if (roll < 80) {
        both(`${at}: someone nobody knows is looked for`, (store) => store.seen(`NOBODY${1000 + step}`, now));
      } else {
        now += [1000, 3_600_000, SEEN_EVERY_MS, DAY_MS][rng.int(4)]!;
      }

      both(`${at}: the list`, (store) => store.list());
    }

    assert.deepEqual(assertCacheNotBehind(`seed ${seed}`), memory.list());
  }

  assert.ok(seenIt.added > 500 && seenIt.refused > 100 && seenIt.movedUp > 300 && seenIt.refills > 100, JSON.stringify(seenIt));
});
