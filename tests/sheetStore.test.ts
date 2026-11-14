import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, BADGES, createTable, DEFAULT_CONFIG, LIMITS, presetSettings, REACTIONS, REACTIONS_LIVE } from '../src/engine/index.ts';
import type { Effect, HandRecord, TableConfig, TableState } from '../src/engine/index.ts';
import { SheetPresetStore } from '../src/gas/sheetPresetStore.ts';
import { SheetStore } from '../src/gas/sheetStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import type { PresetStore, SavedPreset } from '../src/server/presetStore.ts';
import { StoreBusyError } from '../src/server/store.ts';
import { FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import { seededRng, TestTable } from './helpers.ts';
import { fullestChat } from './invariants.ts';

function setup() {
  const lock = new FakeLock();
  const spreadsheet = new FakeSpreadsheet(lock);
  const cache = new FakeCache();
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
      counts.flushes += 1;

      if (counts.flushes === failingFlush) {
        throw new Error('Service Spreadsheets failed');
      }
    },
  });

  /** Makes the nth flush from now report failure. What was written before it stays written, as with a reply that got lost. */
  const failFlush = (nth: number) => (failingFlush = counts.flushes + nth);

  /** A second store over the same sheet and cache, as a separate script run would have. */
  const anotherRun = () => new SheetStore({ spreadsheet: () => spreadsheet, cache, lock, flush: () => {} });

  return { store, spreadsheet, cache, lock, counts, anotherRun, failFlush, failNextFlush: () => failFlush(1) };
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

function save(store: SheetStore, state: TableState, effects: Effect[] = []): void {
  store.transact(state.id, () => ({ save: state, effects, result: null }));
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

    return { save: state, effects: [], result: state!.version };
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
  const longest = presetSettings({ ...DEFAULT_CONFIG, name: 'W'.repeat(LIMITS.tableNameLength), smallBlind: LIMITS.chips, bigBlind: LIMITS.chips, minBuyIn: LIMITS.chips, maxBuyIn: LIMITS.chips });

  store.save(preset('W'.repeat(LIMITS.presetNameLength), longest), false);
  assert.ok(String(tab().cells[1]![1]).length < 1000);

  assert.throws(() => store.save(preset('Huge', { name: 'x'.repeat(50_000) }), false), /maximum of 50000 characters/);
  assert.deepEqual(names(store), ['W'.repeat(LIMITS.presetNameLength)], 'nothing of the refused one was left behind');
  assert.equal(tab().getLastRow(), 2);
});

test('after the longest night the fullest table still fits its row and the cache: ten seated and fifty who came and went, which is every member a table takes, with the longest names, every number at its largest and a full chat', () => {
  const { store, cache, anotherRun } = setup();

  // Sixteen characters of three bytes each, no two names alike
  const name = (index: number) => '好'.repeat(LIMITS.nameLength - 1) + String.fromCodePoint(0x4e00 + index);
  const t = new TestTable({ stacks: Array.from({ length: 10 }, () => LIMITS.chips), names: Array.from({ length: 10 }, (_name, seat) => name(seat)), config: { maxBuyIn: LIMITS.chips } });

  for (let gone = 10; gone < LIMITS.members; gone++) {
    const member = addMember(t.state, name(gone), t.ctx());

    member.buyIn = LIMITS.chips;
    member.cashOut = LIMITS.chips - 1;
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
  const longest = [...REACTIONS].filter((kind) => kind.thrown).sort((a, b) => b.id.length - a.id.length)[0]!;
  t.state.reactions = Array.from({ length: REACTIONS_LIVE }, (_reaction, index) => ({ from: t.ids[index]!, kind: longest.id, at: 9_999_999_999_999, to: t.ids[index + 1]! }));
  const reactions = JSON.stringify(t.state.reactions).length;
  assert.ok(reactions <= 300, `the reactions take ${reactions} characters`);

  const numbers = JSON.stringify(t.state.tonight).length;
  assert.ok(numbers <= LIMITS.members * 400, `the night's numbers for ${LIMITS.members} players take ${numbers} characters`);

  save(store, t.state);

  // Kept by the cache too, which is what spares every poll a read of the Sheet under the lock
  assert.ok(cache.entries.has(`state:${t.state.id}`), 'the table was too big for the cache');

  cache.entries.clear();
  assert.deepEqual(anotherRun().read(t.state.id), t.state, 'and it reads back from its row the same');
});
