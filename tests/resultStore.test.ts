/*
 * The players' records over time: the Results tab as the Sheet store keeps it, the same kept in
 * memory, how rows add up into a record, and that whatever fails or is done to the tab by hand, no
 * night is counted twice.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BADGES, LIMITS } from '../src/engine/index.ts';
import type { PlayerResult, TableResults, Unit } from '../src/engine/index.ts';
import { RESULTS_TAB, SheetResultStore } from '../src/gas/sheetResultStore.ts';
import { TEXT, TIMESTAMP, WHOLE_NUMBER } from '../src/gas/sheets.ts';
import { MemoryErrorLog } from '../src/server/memoryErrorLog.ts';
import { MemoryResultStore } from '../src/server/memoryResultStore.ts';
import { countedOnce, nightsIn, nightsOf, NIGHTS_SHOWN, recordsOf } from '../src/server/resultStore.ts';
import type { NightResult, PlayerRecord } from '../src/server/resultStore.ts';
import { Calls, FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import { cards, DAY_MS, seededRng } from './helpers.ts';
import { ANN, BOB, CY, RESULTS_TEXT_LIMIT } from './resultHelpers.ts';

const NOW = Date.UTC(2026, 10, 14, 20);

const NOTHING = { hands: 0, won: 0, biggest: 0, best: null, badges: {}, highHand: false };

const line = (playerId: string, net: number, more: Partial<PlayerResult> = {}): PlayerResult => ({ ...NOTHING, playerId, name: playerId.slice(0, 3), net, ...more });

function results(tableId: string, version: number, players: PlayerResult[], more: Partial<TableResults> = {}): TableResults {
  return { tableId, tableName: `Table ${tableId}`, unit: 'chips', createdAt: NOW - DAY_MS, version, players, ...more };
}

/** The Results tab over the stand-ins, with every call counted, and a run of the script for each store asked for. */
function setup() {
  const lock = new FakeLock();
  const calls = new Calls();
  const spreadsheet = new FakeSpreadsheet(lock, {}, calls, [], { [RESULTS_TAB]: RESULTS_TEXT_LIMIT });
  const cache = new FakeCache(calls);
  const clock = { time: NOW, now: () => clock.time };
  const errors = new MemoryErrorLog(clock);
  const run = () => new SheetResultStore({ spreadsheet: () => spreadsheet, cache, lock, flush: () => calls.note('flush'), clock, errors });

  /** Writes as the store of tables does: holding the lock. */
  const write = (written: TableResults, store = run()) => {
    lock.waitLock();

    try {
      store.write([written]);
    } finally {
      lock.releaseLock();
    }
  };

  const tab = () => spreadsheet.sheets.get(RESULTS_TAB);

  /** The rows of the tab below its headers, as they lie: table, player, save and money. */
  const kept = () => (tab()?.cells ?? []).slice(1).map((row) => [row[13], row[12], row[14], row[4]]);

  /** The standings as a fresh run reads them from the tab, whatever the cache holds. */
  const fresh = () => {
    cache.entries.clear();

    return run().standings().records;
  };

  return { lock, calls, spreadsheet, cache, clock, errors, run, write, tab, kept, fresh };
}

const netOf = (records: PlayerRecord[]) => Object.fromEntries(records.map((record) => [record.id, record.net]));

test('with no Results tab there are no standings and nobody has a night, and asking makes no tab', () => {
  const { run, spreadsheet, clock } = setup();

  assert.deepEqual(run().standings(), { asOf: clock.time, records: { chips: [], cents: [] } });
  assert.deepEqual(run().nights(ANN, 'chips'), []);
  assert.deepEqual([...spreadsheet.sheets.keys()], []);
});

test('the first results written make the tab with its headers, and a row is what a person reads: amounts as their table writes them, numbers as numbers, the money named in a column of its own', () => {
  const { write, tab } = setup();

  write(results('ABC234', 7, [line(ANN, 1250, { name: 'Ann', hands: 40, won: 9, biggest: 800, best: cards('Ks Kh Kd Kc As'), badges: { quads: 1, felted: 2 }, highHand: true }), line(BOB, -1250, { name: 'Bob', hands: 38 })], { tableName: 'Friday' }));
  write(results('DEF567', 3, [line(ANN, -1505, { name: 'Ann', biggest: 2075 }), line(CY, 1505, { name: 'Cy' })], { unit: 'cents', tableName: 'Small stakes' }));

  const sheet = tab()!;
  assert.deepEqual(sheet.cells[0], ['Night', 'Table', 'Player', 'Played in', 'Up or down', 'Hands', 'Pots won', 'Biggest pot', 'Best hand', 'Best hand cards', 'Badges', 'High hand', 'Player ID', 'Table ID', 'Table save (the game goes by this and the two before it, so leave them as they are)']);
  assert.deepEqual(sheet.cells[1], [new Date(NOW - DAY_MS), 'Friday', 'Ann', 'chips', 1250, 40, 9, 800, 'Four kings', 'Ks Kh Kd Kc As', 'quads:1 felted:2', 1, ANN, 'ABC234', 7]);
  assert.deepEqual(sheet.cells[2], [new Date(NOW - DAY_MS), 'Friday', 'Bob', 'chips', -1250, 38, 0, 0, '', '', '', 0, BOB, 'ABC234', 7]);
  assert.deepEqual(sheet.cells[3]!.slice(1, 8), ['Small stakes', 'Ann', 'dollars', -15.05, 0, 0, 20.75]);

  assert.deepEqual(sheet.formats[1], [TIMESTAMP, TEXT, TEXT, TEXT, WHOLE_NUMBER, WHOLE_NUMBER, WHOLE_NUMBER, WHOLE_NUMBER, TEXT, TEXT, TEXT, WHOLE_NUMBER, TEXT, TEXT, WHOLE_NUMBER]);
  assert.deepEqual([sheet.shown(4, 5), sheet.shown(4, 8), sheet.shown(2, 5)], ['-15.05', '20.75', '1250'], 'a cents table reads to the cent, a chips table in whole chips');
});

test('text goes in as text: a table named like a formula, a player named like a number, and ids that read as numbers stay what they were', () => {
  const { write, tab, fresh, run } = setup();
  const exponent = '2E56789';

  write(results('23E456', 1, [line(exponent, 50, { name: '+1' }), line(BOB, -50, { name: '=Bob' })], { tableName: '=SUM(A1:A9)' }));

  assert.deepEqual(tab()!.cells[1]!.slice(1, 3), ['=SUM(A1:A9)', '+1']);
  assert.deepEqual(tab()!.cells[1]!.slice(12, 14), [exponent, '23E456']);
  assert.deepEqual(netOf(fresh().chips), { [exponent]: 50, [BOB]: -50 });
  assert.deepEqual(run().nights(exponent, 'chips').map((night) => night.table), ['=SUM(A1:A9)']);
});

test('a table’s rows are replaced, never added twice: its players may come and go between saves, and every other table’s rows stay as they are', () => {
  const { write, kept, fresh } = setup();

  write(results('ABC234', 1, [line(ANN, 100), line(BOB, -100)]));
  write(results('DEF567', 1, [line(ANN, 5), line(CY, -5)]));
  write(results('ABC234', 2, [line(ANN, 300), line(BOB, -100), line(CY, -200)]));

  assert.deepEqual(kept(), [
    ['DEF567', ANN, 1, 5],
    ['DEF567', CY, 1, -5],
    ['ABC234', ANN, 2, 300],
    ['ABC234', BOB, 2, -100],
    ['ABC234', CY, 2, -200],
  ]);

  write(results('ABC234', 3, [line(BOB, 40), line(CY, -40)]));
  assert.deepEqual(kept().filter(([tableId]) => tableId === 'ABC234'), [['ABC234', BOB, 3, 40], ['ABC234', CY, 3, -40]]);
  assert.deepEqual(netOf(fresh().chips), { [ANN]: 5, [BOB]: 40, [CY]: -45 });

  // A table that comes to nothing any more, as when its players are no longer known, has none left
  write(results('ABC234', 4, []));
  assert.deepEqual(kept(), [['DEF567', ANN, 1, 5], ['DEF567', CY, 1, -5]]);
});

test('written again from the same save, nothing is written: only the cells that say whose rows are whose are read', () => {
  const { write, calls, kept } = setup();
  const once = results('ABC234', 5, [line(ANN, 100), line(BOB, -100)]);

  write(once);
  const before = kept();
  calls.made = [];

  write(once);
  write(once);

  assert.deepEqual(calls.made, ['spreadsheet.getSheetByName', 'Results.getLastRow', 'Results.getValues', 'spreadsheet.getSheetByName', 'Results.getLastRow', 'Results.getValues']);
  assert.deepEqual(kept(), before);
});

test('nothing to keep of a table and no tab: none is made', () => {
  const { write, spreadsheet, calls } = setup();

  write(results('ABC234', 1, []));

  assert.deepEqual([...spreadsheet.sheets.keys()], []);
  assert.deepEqual(calls.made, ['spreadsheet.getSheetByName']);
});

test('how many calls a write makes: a first table, another, and one replaced', () => {
  const { write, calls } = setup();

  write(results('ABC234', 1, [line(ANN, 100), line(BOB, -100)]));
  assert.deepEqual(calls.made, ['spreadsheet.getSheetByName', 'spreadsheet.insertSheet', 'Results.setValues', 'Results.getLastRow', 'Results.getValues', 'Results.setNumberFormats', 'Results.setValues', 'flush', 'cache.remove', 'cache.remove']);

  calls.made = [];
  write(results('DEF567', 1, [line(ANN, 5), line(CY, -5)]));
  assert.deepEqual(calls.made, ['spreadsheet.getSheetByName', 'Results.getLastRow', 'Results.getValues', 'Results.setNumberFormats', 'Results.setValues', 'flush', 'cache.remove', 'cache.remove']);

  // The rows of a table lie together unless someone sorted the tab, so taking the old ones out is one call
  calls.made = [];
  write(results('ABC234', 2, [line(ANN, 300), line(BOB, -300)]));
  assert.deepEqual(calls.made, ['spreadsheet.getSheetByName', 'Results.getLastRow', 'Results.getValues', 'Results.setNumberFormats', 'Results.setValues', 'flush', 'Results.deleteRows', 'flush', 'cache.remove', 'cache.remove']);
});

test('rows the tab was sorted into are still found and replaced, wherever they lie', () => {
  const { write, tab, kept } = setup();

  write(results('ABC234', 1, [line(ANN, 100), line(BOB, -60), line(CY, -40)]));
  write(results('DEF567', 1, [line(ANN, 5), line(CY, -5)]));

  // Sorted by player, as whoever runs the game might
  const sheet = tab()!;
  const order = [1, 4, 2, 3, 5];
  const sorted = order.map((row) => sheet.cells[row]!);
  const formats = order.map((row) => sheet.formats[row]!);
  sheet.cells.splice(1, 5, ...sorted);
  sheet.formats.splice(1, 5, ...formats);
  assert.deepEqual(kept().map(([tableId]) => tableId), ['ABC234', 'DEF567', 'ABC234', 'ABC234', 'DEF567']);

  write(results('ABC234', 2, [line(ANN, 1), line(BOB, -1)]));
  assert.deepEqual(kept(), [['DEF567', ANN, 1, 5], ['DEF567', CY, 1, -5], ['ABC234', ANN, 2, 1], ['ABC234', BOB, 2, -1]]);
});

test('done by hand: a row deleted comes back the next time its table is written, a figure changed stays until the table is saved again, and nothing is read by its header', () => {
  const { write, tab, kept, fresh } = setup();
  const saved = results('ABC234', 1, [line(ANN, 100), line(BOB, -60), line(CY, -40)]);
  write(saved);
  write(results('DEF567', 1, [line(ANN, 5), line(CY, -5)]));

  const sheet = tab()!;
  sheet.cells[0] = ['When', 'Where', 'Who'];
  sheet.cells[1]![4] = 250;
  assert.deepEqual(netOf(fresh().chips), { [ANN]: 255, [BOB]: -60, [CY]: -45 });

  write(saved);
  assert.equal(sheet.cells[1]![4], 250, 'the save has not changed, so the row is left as it was made');

  sheet.cells.splice(2, 1);
  sheet.formats.splice(2, 1);
  assert.deepEqual(netOf(fresh().chips), { [ANN]: 255, [CY]: -45 });

  write(saved);
  assert.deepEqual(kept(), [['DEF567', ANN, 1, 5], ['DEF567', CY, 1, -5], ['ABC234', ANN, 1, 100], ['ABC234', BOB, 1, -60], ['ABC234', CY, 1, -40]]);
  assert.deepEqual(sheet.cells[0], ['When', 'Where', 'Who'], 'the headers are whoever runs the game’s to change');

  // With the header row gone, the first row is a night like any other
  sheet.cells.splice(0, 1);
  sheet.formats.splice(0, 1);
  assert.deepEqual(netOf(fresh().chips), { [ANN]: 105, [BOB]: -60, [CY]: -45 });

  write(results('ABC234', 2, [line(ANN, 7), line(BOB, -7)]));
  assert.deepEqual(netOf(fresh().chips), { [ANN]: 12, [BOB]: -7, [CY]: -5 });
});

test('a row that cannot be read is left out and said to be, and costs no other row its place', () => {
  const good = [new Date(NOW), 'Friday', 'Ann', 'chips', 100, 10, 2, 60, 'pair of aces', 'As Ah Jc 9h 7d', 'quads:1', 1, ANN, 'ABC234', 3];
  const spoiled: [string, number, unknown][] = [
    ['a night that is no date', 0, 'last Friday'],
    ['money that is neither chips nor dollars', 3, 'euros'],
    ['an amount that is text', 4, 'lots'],
    ['a fraction of a chip', 4, 10.5],
    ['hands below nothing', 5, -1],
    ['pots that are no whole number', 6, 1.5],
    ['a biggest pot that is text', 7, 'big'],
    ['four cards', 9, 'As Ah Jc 9h'],
    ['a card that is none', 9, 'As Ah Jc 9h 1x'],
    ['the same card twice', 9, 'As As Jc 9h 7d'],
    ['a badge without a count', 10, 'quads'],
    ['a high hand that is neither 1 nor 0', 11, 2],
    ['an id no player has', 12, 'ann'],
    ['no table', 13, ''],
    ['a save that is no number', 14, 'seven'],
  ];

  for (const [what, column, value] of spoiled) {
    const { write, tab, errors, cache, run } = setup();
    write(results('DEF567', 1, [line(ANN, 5), line(CY, -5)]));

    const sheet = tab()!;
    sheet.cells.push(good.map((cell, index) => (index === column ? value : cell)), [], ['', '', '   '], [...good.slice(0, 12), BOB, 'ABC234', 3]);
    cache.entries.clear();

    assert.deepEqual(netOf(run().standings().records.chips), { [ANN]: 5, [CY]: -5, [BOB]: 100 }, what);
    assert.deepEqual(errors.rows.map((row) => [row.where, row.message]), [['store read results', 'Left out 1 rows of the Results tab that could not be read, the first of them row 4']], what);
  }

  // Blank cells for what a player never did are no slip: a row someone typed in by hand counts
  const { write, tab, fresh, errors } = setup();
  write(results('DEF567', 1, [line(ANN, 5), line(CY, -5)]));
  tab()!.cells.push([new Date(NOW), 'By hand', 'Bob', 'dollars', -12.5, 0, 0, 0, '', '', '', '', BOB, 'OLDGAME', 1, 'a note of my own']);

  assert.deepEqual(fresh().cents, [{ id: BOB, nights: 1, nightsUp: 0, net: -1250, hands: 0, won: 0, biggest: 0, best: null, badges: {}, highHands: 0 }]);
  assert.deepEqual(errors.rows, []);
});

test('rows of more than one save of a table, or the same row twice, count once: the latest save’s, a row a player', () => {
  const rows = [
    ...nightsIn(results('ABC234', 2, [line(ANN, 100), line(BOB, -100)])),
    ...nightsIn(results('ABC234', 3, [line(ANN, 300), line(CY, -300)])),
    ...nightsIn(results('ABC234', 3, [line(ANN, 300)])),
    ...nightsIn(results('DEF567', 9, [line(BOB, 1)])),
  ];

  assert.deepEqual(countedOnce(rows).map((row) => [row.tableId, row.playerId, row.version, row.net]), [['ABC234', ANN, 3, 300], ['ABC234', CY, 3, -300], ['DEF567', BOB, 9, 1]]);
  assert.deepEqual(countedOnce([]), []);
});

test('a write cut short at any one of its calls never counts a night twice or loses the one kept, and the next write puts it right', () => {
  const before = results('ABC234', 1, [line(ANN, 100), line(BOB, -100)]);
  const after = results('ABC234', 2, [line(ANN, 300), line(BOB, -250), line(CY, -50)]);
  const other = results('DEF567', 1, [line(ANN, 5), line(CY, -5)]);
  const OLD = { [ANN]: 105, [BOB]: -100, [CY]: -5 };
  const NEW = { [ANN]: 305, [BOB]: -250, [CY]: -55 };

  const clean = setup();
  clean.write(before);
  clean.write(other);
  clean.calls.made = [];
  clean.write(after);
  const steps = [...clean.calls.made];

  for (let failing = 1; failing <= steps.length; failing++) {
    const context = setup();
    const step = `call ${failing}, ${steps[failing - 1]}`;
    context.write(before);
    context.write(other);
    context.run().standings();

    context.calls.failNth(failing);
    try {
      context.write(after);
    } catch {
      // The store of tables reports it and tries again later
    }

    // Whatever the cache holds was read after the write gave up, or is what the tab says
    const cached = netOf(context.run().standings().records.chips);
    const read = netOf(context.fresh().chips);
    assert.ok([OLD, NEW].some((either) => JSON.stringify(either) === JSON.stringify(read)), `${step}: ${JSON.stringify(read)}`);

    if (!steps[failing - 1]!.startsWith('cache.')) {
      assert.deepEqual(cached, read, `${step}: the cache answers as the tab does`);
    }

    context.write(after);
    assert.deepEqual(netOf(context.fresh().chips), NEW, step);
    assert.deepEqual(context.kept().filter(([tableId]) => tableId === 'ABC234'), [['ABC234', ANN, 2, 300], ['ABC234', BOB, 2, -250], ['ABC234', CY, 2, -50]], `${step}: a row for each player, of the latest save`);
    assert.equal(context.kept().length, 5, step);
    assert.equal(context.lock.held, false);
  }
});

test('a write whose rows landed although the reply was lost is found by the next write, which adds nothing twice', () => {
  const { write, kept, lock, run, calls } = setup();
  write(results('ABC234', 1, [line(ANN, 100), line(BOB, -100)]));

  // The new rows are in, and the flush that would say so fails: the old ones are still there
  calls.made = [];
  calls.failNth(6);
  assert.throws(() => write(results('ABC234', 2, [line(ANN, 300), line(BOB, -300)])), /flush/);
  assert.equal(kept().length, 4);
  assert.equal(lock.held, false);

  const written = (() => {
    lock.waitLock();

    try {
      return run().written();
    } finally {
      lock.releaseLock();
    }
  })();
  assert.ok(Number.isNaN(written.get('ABC234')), 'rows of two saves are of no save the table has, so they are written again');

  write(results('ABC234', 2, [line(ANN, 300), line(BOB, -300)]));
  assert.deepEqual(kept(), [['ABC234', ANN, 2, 300], ['ABC234', BOB, 2, -300]]);
});

test('the standings are read from the tab once and kept for five minutes; whoever asks while they are being read waits for the lock, and a write drops them', () => {
  const { write, calls, cache, lock, run, clock } = setup();
  write(results('ABC234', 1, [line(ANN, 100), line(BOB, -100)]));
  calls.made = [];

  const first = run().standings();
  assert.deepEqual(calls.made, ['cache.get', 'cache.get', 'cache.get', 'cache.get', 'spreadsheet.getSheetByName', 'Results.getLastRow', 'Results.getValues', 'cache.put']);
  assert.equal(lock.acquisitions, 2, 'the cache is only ever filled holding the lock, so it is never older than the last write');
  assert.deepEqual([...cache.seconds.entries()], [['results:chips', 300], ['results:cents', 300]]);

  calls.made = [];
  clock.time += 60_000;
  assert.deepEqual(run().standings(), first, 'as of when they were read, not of when they were asked for');
  assert.deepEqual(calls.made, ['cache.get', 'cache.get']);
  assert.equal(lock.acquisitions, 2);

  write(results('ABC234', 2, [line(ANN, 150), line(BOB, -150)]));
  assert.deepEqual([netOf(run().standings().records.chips), run().standings().asOf], [{ [ANN]: 150, [BOB]: -150 }, clock.time]);

  // A lock that is taken is said to be busy, which the page shows and tries again
  cache.entries.clear();
  lock.busy = true;
  assert.throws(() => run().standings(), { name: 'StoreBusyError', message: 'The standings are busy, try again' });
  assert.deepEqual(lock.waits.at(-1), 3000);
});

test('a cache that cannot be asked, holds something else, or will not take the standings costs a read of the tab and never an answer', () => {
  const { write, cache, run, errors, calls } = setup();
  write(results('ABC234', 1, [line(ANN, 100), line(BOB, -100)]));
  const expected = { [ANN]: 100, [BOB]: -100 };

  cache.entries.set('results:chips', 'not json');
  assert.deepEqual(netOf(run().standings().records.chips), expected);
  assert.equal(errors.rows.at(-1)!.where, 'store read cached results');

  cache.entries.clear();
  cache.failNextWrite = true;
  assert.deepEqual(netOf(run().standings().records.chips), expected);
  assert.equal(errors.rows.at(-1)!.where, 'store cache results');
  assert.deepEqual([...cache.entries.keys()], []);

  // One half of the standings without the other, as when one ran out first, is no standings
  run().standings();
  cache.entries.delete('results:cents');
  calls.made = [];
  assert.deepEqual(netOf(run().standings().records.chips), expected);
  assert.equal(calls.count('Results.getValues'), 1);

  for (let failing = 1; failing <= 8; failing++) {
    cache.entries.clear();
    calls.made = [];
    calls.failNth(failing);

    try {
      assert.deepEqual(netOf(run().standings().records.chips), expected, `call ${failing}`);
    } catch (error) {
      assert.match(String(error), /Service failed at (spreadsheet|Results)\./, `call ${failing}: only the tab itself failing fails the answer`);
    }
  }
});

test('a player’s nights are a second request, read with the standings and kept beside them: the latest first, of the money asked for, the table by its name and date and nothing more', () => {
  const { write, calls, run, cache } = setup();
  const day = (n: number) => NOW - n * DAY_MS;

  write(results('ABC234', 1, [line(ANN, 100, { hands: 12, won: 3, biggest: 80, best: cards('As Ah Jc 9h 7d'), badges: { heater: 1 }, highHand: true }), line(BOB, -100)], { tableName: 'Friday', createdAt: day(14) }));
  write(results('DEF567', 1, [line(ANN, -40), line(BOB, 40)], { tableName: 'Sunday', createdAt: day(7) }));
  write(results('GHJ234', 1, [line(ANN, 2550), line(CY, -2550)], { tableName: 'Cash', unit: 'cents', createdAt: day(1) }));

  calls.made = [];
  assert.deepEqual(run().nights(ANN, 'chips'), [
    { at: day(7), table: 'Sunday', net: -40, hands: 0, won: 0, biggest: 0, best: null, badges: {}, highHand: false },
    { at: day(14), table: 'Friday', net: 100, hands: 12, won: 3, biggest: 80, best: cards('As Ah Jc 9h 7d'), badges: { heater: 1 }, highHand: true },
  ]);
  assert.equal(calls.count('Results.getValues'), 1, 'the nights and the standings they go with are one read');

  calls.made = [];
  assert.deepEqual(run().nights(ANN, 'chips').map((night) => night.table), ['Sunday', 'Friday']);
  assert.deepEqual(run().nights(ANN, 'cents').map((night) => [night.table, night.net]), [['Cash', 2550]]);
  assert.deepEqual(run().nights(CY, 'chips'), []);
  assert.equal(calls.count('Results.getValues'), 2, 'one read for each player and money not asked for before');
  assert.equal(calls.count('cache.put'), 2);

  // Kept beside the standings they were read with: a write that drops those drops these
  write(results('KLM234', 1, [line(ANN, 1), line(BOB, -1)], { tableName: 'Monday', createdAt: day(0) }));
  assert.deepEqual(run().nights(ANN, 'chips').map((night) => night.table), ['Monday', 'Sunday', 'Friday']);
  assert.ok([...cache.entries.keys()].every((key) => key.length < 60));
});

test('only the latest of a player’s nights are handed out, however many the record counts', () => {
  const rows: NightResult[] = Array.from({ length: NIGHTS_SHOWN + 30 }, (_night, n) => nightsIn(results(`T${n}`, 1, [line(ANN, n)], { createdAt: NOW - n * DAY_MS }))[0]!);

  const nights = nightsOf(rows, ANN, 'chips');
  assert.equal(nights.length, NIGHTS_SHOWN);
  assert.deepEqual([nights[0]!.net, nights.at(-1)!.net], [0, NIGHTS_SHOWN - 1]);
  assert.equal(recordsOf(rows).chips[0]!.nights, NIGHTS_SHOWN + 30);
});

test('a record adds a player’s nights up within one kind of money: nights and nights up, money, hands, pots, the biggest pot, the best hand, badges and high hands', () => {
  const rows = [
    ...nightsIn(results('ABC234', 1, [line(ANN, 100, { hands: 30, won: 8, biggest: 400, best: cards('As Ah Jc 9h 7d'), badges: { heater: 1, felted: 1 }, highHand: true }), line(BOB, -100, { hands: 28, won: 2, biggest: 90 })], { createdAt: NOW - 3 * DAY_MS })),
    ...nightsIn(results('DEF567', 1, [line(ANN, -30, { hands: 10, won: 1, biggest: 950, best: cards('Ks Kh Kd Kc As'), badges: { felted: 2 } }), line(BOB, 30, { hands: 10, won: 4, biggest: 50, highHand: true })], { createdAt: NOW - 2 * DAY_MS })),
    ...nightsIn(results('GHJ234', 1, [line(ANN, 0, { hands: 5 }), line(BOB, 0, { hands: 5 })], { createdAt: NOW - DAY_MS })),
    ...nightsIn(results('KLM234', 1, [line(ANN, 2550, { hands: 7 }), line(CY, -2550, { hands: 7 })], { unit: 'cents' })),
  ];

  assert.deepEqual(recordsOf(rows), {
    chips: [
      { id: ANN, nights: 3, nightsUp: 1, net: 70, hands: 45, won: 9, biggest: 950, best: cards('Ks Kh Kd Kc As'), badges: { heater: 1, felted: 3 }, highHands: 1 },
      { id: BOB, nights: 3, nightsUp: 1, net: -70, hands: 43, won: 6, biggest: 90, best: null, badges: {}, highHands: 1 },
    ],
    cents: [
      { id: ANN, nights: 1, nightsUp: 1, net: 2550, hands: 7, won: 0, biggest: 0, best: null, badges: {}, highHands: 0 },
      { id: CY, nights: 1, nightsUp: 0, net: -2550, hands: 7, won: 0, biggest: 0, best: null, badges: {}, highHands: 0 },
    ],
  });

  // In whatever order the rows lie, they add up the same
  assert.deepEqual(recordsOf([...rows].reverse()), recordsOf(rows));
});

const PLAYERS = ['AAAAAAA', 'BBBBBBB', 'CCCCCCC', 'DDDDDDD', 'EEEEEEE', 'FFFFFFF'];

test('over random nights: a player’s record is their rows added up, a table where everyone is known comes to nothing, and the Sheet and memory keep the same record however the tables were written and rewritten', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rng = seededRng(seed * 31);
    const sheet = setup();
    const memory = new MemoryResultStore(() => NOW);
    const latest = new Map<string, TableResults>();
    const versions = new Map<string, number>();

    for (let step = 0; step < 40; step++) {
      const tableId = `TABLE${rng.int(8)}`;
      const unit: Unit = Number(tableId.at(-1)) % 3 === 0 ? 'cents' : 'chips';
      const seated = PLAYERS.filter(() => rng.int(3) > 0);
      const stakes = seated.map(() => rng.int(2001) - 1000);
      const version = (versions.get(tableId) ?? 0) + 1 + rng.int(3);

      // The last player takes what makes the table come to nothing, as a table's money always does
      const players = seated.length < 2 ? [] : seated.map((playerId, index) => line(playerId, index === seated.length - 1 ? -stakes.slice(0, -1).reduce((sum, net) => sum + net, 0) : stakes[index]!, { hands: rng.int(200), won: rng.int(50), biggest: rng.int(5000), highHand: rng.int(4) === 0, badges: rng.int(3) === 0 ? { felted: 1 + rng.int(3) } : {} }));
      const written = results(tableId, version, players, { unit, createdAt: NOW - Number(tableId.at(-1)) * DAY_MS });

      versions.set(tableId, version);
      latest.set(tableId, written);

      // Now and then the same results again, as a retry or a second moment of the same save would
      for (let times = 1 + (rng.int(4) === 0 ? 1 : 0); times > 0; times--) {
        sheet.write(written);
        memory.write([written]);
      }
    }

    const rows = [...latest.values()].flatMap(nightsIn);
    const expected = recordsOf(rows);
    const byId = (records: PlayerRecord[]) => [...records].sort((a, b) => (a.id < b.id ? -1 : 1));

    for (const unit of ['chips', 'cents'] as const) {
      assert.deepEqual(byId(sheet.fresh()[unit]), byId(expected[unit]), `seed ${seed}`);
      assert.deepEqual(byId(memory.standings().records[unit]), byId(expected[unit]), `seed ${seed}`);
      assert.equal(expected[unit].reduce((sum, record) => sum + record.net, 0), 0, `seed ${seed}: all the ${unit} won are ${unit} lost`);

      for (const record of expected[unit]) {
        const mine = rows.filter((row) => row.playerId === record.id && row.unit === unit);

        assert.equal(record.nights, mine.length);
        assert.equal(record.net, mine.reduce((sum, row) => sum + row.net, 0));
        assert.equal(record.hands, mine.reduce((sum, row) => sum + row.hands, 0));
        assert.equal(record.highHands, mine.filter((row) => row.highHand).length);
        assert.deepEqual(sheet.run().nights(record.id, unit), nightsOf(rows, record.id, unit));
        assert.deepEqual(memory.nights(record.id, unit), nightsOf(rows, record.id, unit));
      }
    }

    assert.equal(sheet.kept().length, rows.length, `seed ${seed}: a row for each table and player, and no more`);
    assert.equal(new Set(sheet.kept().map(([tableId, playerId]) => `${tableId} ${playerId}`)).size, rows.length);
  }
});

test('at their fullest the standings fit the cache: every player the list can hold, a year of weekly nights each, every badge earned every night; and so do the most nights of one player', () => {
  const { write, cache, run, errors, tab } = setup();
  const ids = Array.from({ length: LIMITS.knownPlayers }, (_player, n) => `P${String(n).padStart(6, '0')}`);
  const badges = Object.fromEntries(BADGES.map((badge) => [badge.id, 9]));
  const WEEKS = 52;

  // Every player plays every week, in both kinds of money. One table a week holds them all, which no table could, to fill the tab in few writes
  for (let week = 0; week < WEEKS; week++) {
    for (const unit of ['chips', 'cents'] as const) {
      const players = ids.map((id, seat) => line(id, (seat % 2 === 0 ? 1 : -1) * 98_765_432, { name: 'W'.repeat(LIMITS.nameLength), hands: 400, won: 150, biggest: 987_654_321, best: cards('As Ks Qs Js Ts'), badges, highHand: true }));

      write(results(`${unit === 'chips' ? 'C' : 'D'}${week}`, 100_000 + week, players, { unit, tableName: 'W'.repeat(LIMITS.tableNameLength), createdAt: NOW - week * 7 * DAY_MS }));
    }
  }

  assert.equal(tab()!.getLastRow(), 1 + 2 * WEEKS * LIMITS.knownPlayers);

  const standings = run().standings();
  assert.equal(standings.records.chips.length, LIMITS.knownPlayers);
  assert.deepEqual(errors.rows, [], 'the fake cache refuses a value over 100 KB, which would be reported');

  const sizes = ['results:chips', 'results:cents'].map((key) => Buffer.byteLength(cache.entries.get(key)!, 'utf8'));
  // 62,834 bytes each as this is written, of the 100,000 an entry may be: a kind of badge added later costs about 3,000 more
  assert.ok(Math.max(...sizes) < 70_000, `the standings of one kind of money are ${sizes.join(' and ')} bytes`);

  const nights = run().nights(ids[0]!, 'cents');
  assert.equal(nights.length, WEEKS);
  const nightsKey = [...cache.entries.keys()].find((key) => key.startsWith('nights:'))!;
  const perNight = Buffer.byteLength(cache.entries.get(nightsKey)!, 'utf8') / WEEKS;
  assert.ok(perNight * NIGHTS_SHOWN < 90_000, `${Math.ceil(perNight)} bytes a night, ${NIGHTS_SHOWN} nights at most`);
  assert.deepEqual(errors.rows, []);

  // The longest cell the game writes is far inside what the fake allows the tab
  const longest = tab()!.cells.slice(1).reduce((most, row) => row.reduce((longer: number, cell) => Math.max(longer, typeof cell === 'string' ? cell.length : 0), most), 0);
  assert.ok(longest < RESULTS_TEXT_LIMIT / 2, `the longest cell is ${longest} characters`);
});
