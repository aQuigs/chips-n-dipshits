/*
 * When a table's results are written: at the end of a night, when the table is put away, and by a
 * look at the tables nobody has touched for a while. In whatever order these come and however often,
 * and whichever of their calls fails, a table and a player are one row with the latest figures.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resultsOf } from '../src/engine/index.ts';
import type { Effect, TableResults } from '../src/engine/index.ts';
import { RESULTS_TAB, SheetResultStore } from '../src/gas/sheetResultStore.ts';
import { SheetStore } from '../src/gas/sheetStore.ts';
import { SETTLE_AFTER_MS } from '../src/server/api.ts';
import { MemoryErrorLog } from '../src/server/memoryErrorLog.ts';
import { MemoryResultStore } from '../src/server/memoryResultStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PUT_AWAY_AFTER_MS } from '../src/server/putAway.ts';
import { nightsIn, recordsOf, SETTLE_EVERY_MS, SETTLED_AT_ONCE } from '../src/server/resultStore.ts';
import type { PlayerRecord, ResultStore } from '../src/server/resultStore.ts';
import { LAST_WORDS } from '../src/server/service.ts';
import type { TableStore } from '../src/server/store.ts';
import { Calls, FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import { DAY_MS, seededRng, TestTable } from './helpers.ts';
import { chance, pick } from './randomPlay.ts';
import { ANN, BOB, CY, known, RESULTS_TEXT_LIMIT } from './resultHelpers.ts';

const NOW = Date.UTC(2026, 10, 14, 20);
const MINUTE_MS = 60_000;

/** A row as a test tells it from another: table, player, the save it is of, and the money. */
type Row = [tableId: string, playerId: string, version: number, net: number];

const rowsOf = (results: TableResults): Row[] => nightsIn(results).map((row) => [row.tableId, row.playerId, row.version, row.net]);
const sorted = (rows: Row[]): Row[] => [...rows].sort((a, b) => (`${a[0]} ${a[1]}` < `${b[0]} ${b[1]}` ? -1 : 1));
const byId = (records: PlayerRecord[]) => [...records].sort((a, b) => (a.id < b.id ? -1 : 1));

/** The game's stores as one run of the script has them. Over the Sheet every run is a new pair, as every request is. */
interface Stores {
  run(): { store: TableStore; results: ResultStore };
  /** Every row kept, as it lies. */
  rows(): Row[];
  clock: { time: number };
}

function inTheSheet() {
  const lock = new FakeLock();
  const calls = new Calls();
  const spreadsheet = new FakeSpreadsheet(lock, {}, calls, [], { [RESULTS_TAB]: RESULTS_TEXT_LIMIT });
  const cache = new FakeCache(calls);
  const clock = { time: NOW, now: () => clock.time };
  const errors = new MemoryErrorLog(clock);
  const flush = () => calls.note('flush');

  const run = (withResults = true) => {
    const results = new SheetResultStore({ spreadsheet: () => spreadsheet, cache, lock, flush, clock, errors });

    return { results, store: new SheetStore({ spreadsheet: () => spreadsheet, cache, lock, flush, errors, results: withResults ? results : undefined }) };
  };

  const rows = (): Row[] => (spreadsheet.sheets.get(RESULTS_TAB)?.cells ?? []).slice(1).map((row) => [row[13], row[12], row[14], row[4]] as Row);
  const idsIn = (tab: string) => (spreadsheet.sheets.get(tab)?.cells ?? []).slice(1).map((row) => String(row[0] ?? '')).filter((id) => id !== '');

  return { run, rows, clock, lock, calls, spreadsheet, cache, errors, idsIn };
}

function inMemory(): Stores {
  const clock = { time: NOW };
  const results = new MemoryResultStore(() => clock.time);
  const store = new MemoryStore(results);

  return { run: () => ({ store, results }), rows: () => results.rows().map((row) => [row.tableId, row.playerId, row.version, row.net]), clock };
}

const STORES: [string, () => Stores][] = [['in the Sheet', inTheSheet], ['in memory', inMemory]];

/** A table of its own id whose players are who `identities` says, with chips in front of each. */
function night(id: string, identities: (string | null)[]): TestTable {
  const t = new TestTable({ stacks: identities.map(() => 1000), names: identities.map((identity, seat) => identity?.slice(0, 3) ?? `Guest ${seat}`), config: { name: `Table ${id}` }, seed: id.length + id.charCodeAt(id.length - 1) });

  t.state.id = id;
  known(t, identities);

  return t;
}

/** A hand that moves the blinds, so that the table comes to something else than before. A player alone has nobody to play. */
function play(t: TestTable): void {
  if (t.state.seats.filter((seat) => seat).length > 1) {
    t.deal();
    t.foldOut();
  }
}

const ended = (t: TestTable, at: number): Effect => ({ type: 'nightEnded', night: { at, tableId: t.state.id } });

/** Saves the table as the service does: a version on, with what happened. */
function save(stores: Stores, t: TestTable, effects: Effect[] = []): string {
  t.state.version += 1;

  return stores.run().store.transact(t.state.id, () => ({ save: t.state, at: stores.clock.time, effects, result: 'saved' }));
}

/** What a poll does: looks at the table and changes nothing, which is when records waiting in its row are tried again. */
const visit = (stores: Stores, t: TestTable) => stores.run().store.transact(t.state.id, (state) => ({ save: null, effects: [], result: state?.version ?? null }));

for (const [kind, make] of STORES) {
  test(`${kind}: the end of a night writes the table's rows as that save has them, and a night played on and ended again replaces them`, () => {
    const stores = make();
    const t = night('ABC234', [ANN, BOB, CY]);

    save(stores, t);
    assert.deepEqual(stores.rows(), [], 'a table saved is not a night ended');

    play(t);
    save(stores, t, [ended(t, stores.clock.time)]);
    assert.deepEqual(stores.rows(), rowsOf(resultsOf(t.state)));
    assert.deepEqual(stores.rows().map(([, playerId]) => playerId), [ANN, BOB, CY]);
    const first = stores.rows();

    play(t);
    save(stores, t);
    assert.deepEqual(stores.rows(), first, 'played on, the rows are those of the night as it ended, until it is written again');

    play(t);
    save(stores, t, [ended(t, stores.clock.time)]);
    assert.deepEqual(stores.rows(), rowsOf(resultsOf(t.state)));
    assert.notDeepEqual(stores.rows(), first);
    assert.equal(stores.rows().length, 3);

    // Two ends in one save, as nothing stops an effect being there twice, are one write
    save(stores, t, [ended(t, stores.clock.time), ended(t, stores.clock.time)]);
    assert.deepEqual(stores.rows(), rowsOf(resultsOf(t.state)));
  });

  test(`${kind}: a table nobody has saved for three hours has its rows written by the next look, where it stands and mid-hand or not; one saved since is left for later`, () => {
    const stores = make();
    const idle = night('ABC234', [ANN, BOB, CY]);
    const busy = night('DEF567', [ANN, BOB]);

    play(idle);
    idle.deal();
    save(stores, idle);
    stores.clock.time += SETTLE_AFTER_MS - MINUTE_MS;
    play(busy);
    save(stores, busy);

    stores.run().store.settleIdle(stores.clock.time);
    assert.deepEqual(stores.rows(), [], 'a minute short of three hours');

    stores.clock.time += SETTLE_EVERY_MS;
    stores.run().store.settleIdle(stores.clock.time);
    assert.deepEqual(stores.rows(), rowsOf(resultsOf(idle.state)));
    assert.equal(stores.rows().reduce((sum, row) => sum + row[3], 0), 0, 'chips in the pot count as whoever put them there’s');
    assert.equal(idle.state.hand?.stage, 'betting');
    assert.deepEqual(stores.run().store.read('ABC234'), idle.state, 'the table is where it was, as it was');

    // Played on after that, it is written again once it has been left alone as long
    idle.foldOut();
    play(idle);
    save(stores, idle);
    stores.clock.time += SETTLE_AFTER_MS;
    stores.run().store.settleIdle(stores.clock.time);
    assert.deepEqual(sorted(stores.rows()), sorted([...rowsOf(resultsOf(idle.state)), ...rowsOf(resultsOf(busy.state))]));
  });

  test(`${kind}: a look is asked for at most every five minutes, sees to three tables at most, the latest played first, and gets to the rest the next time`, () => {
    const stores = make();
    const tables = ['AAA222', 'BBB222', 'CCC222', 'DDD222', 'EEE222'].map((id) => night(id, [ANN, BOB]));

    // Saved a minute apart, the first the longest ago
    tables.forEach((t) => {
      play(t);
      save(stores, t);
      stores.clock.time += MINUTE_MS;
    });
    stores.clock.time += SETTLE_AFTER_MS;

    stores.run().store.settleIdle(stores.clock.time);
    assert.deepEqual([...new Set(stores.rows().map(([tableId]) => tableId))].sort(), ['CCC222', 'DDD222', 'EEE222']);
    assert.equal(SETTLED_AT_ONCE, 3);

    stores.clock.time += SETTLE_EVERY_MS - 1;
    stores.run().store.settleIdle(stores.clock.time);
    assert.equal(new Set(stores.rows().map(([tableId]) => tableId)).size, 3, 'asked again too soon, nothing is looked at');

    stores.clock.time += 1;
    stores.run().store.settleIdle(stores.clock.time);
    assert.deepEqual(sorted(stores.rows()), sorted(tables.flatMap((t) => rowsOf(resultsOf(t.state)))));
  });

  test(`${kind}: making a table looks too, without being asked: an idle table is written, and the table just saved never is`, () => {
    const stores = make();
    const old = night('ABC234', [ANN, BOB]);
    play(old);
    save(stores, old);
    stores.clock.time += SETTLE_AFTER_MS;

    const made = night('NEW234', [ANN, BOB]);
    play(made);
    save(stores, made);
    stores.run().store.putAwayOld(stores.clock.time, LAST_WORDS);

    assert.deepEqual(stores.rows(), rowsOf(resultsOf(old.state)));
  });

  test(`${kind}: a table that is put away has its rows written as it last stood, ended or not, and they stay when it is gone`, () => {
    const stores = make();
    const t = night('OLD234', [ANN, BOB, CY]);
    const solo = night('OLD567', [ANN]);

    play(t);
    save(stores, t, [ended(t, stores.clock.time)]);
    play(t);
    save(stores, t);
    save(stores, solo);
    const last = rowsOf(resultsOf(t.state));

    stores.clock.time += PUT_AWAY_AFTER_MS;
    stores.run().store.putAwayOld(stores.clock.time, LAST_WORDS);

    assert.equal(stores.run().store.read('OLD234'), null);
    assert.equal(stores.run().store.wasPutAway('OLD234'), true);
    assert.equal(stores.run().store.wasPutAway('OLD567'), true, 'a table with nothing to keep goes all the same');
    assert.deepEqual(stores.rows(), last);

    stores.clock.time += DAY_MS;
    stores.run().store.putAwayOld(stores.clock.time, LAST_WORDS);
    stores.run().store.settleIdle(stores.clock.time);
    assert.deepEqual(stores.rows(), last);
  });

  test(`${kind}: every order and repetition of the moments leaves a row for each table and player with the latest figures, and no player's record counts a night twice`, () => {
    const reached = { ended: 0, endedAgain: 0, looked: 0, putAway: 0, rewritten: 0, emptied: 0 };

    for (let seed = 1; seed <= 30; seed++) {
      const rng = seededRng(seed * 613);
      const stores = make();
      // One where everyone is known, one with a guest, and one with a player alone, which is nobody's night
      const tables = [night('AAA222', [ANN, BOB, CY]), night('BBB222', [ANN, null, BOB]), night('CCC222', [CY])];
      const savedAt = new Map<string, number>();
      const kept = new Map<string, TableResults>();
      const gone = new Set<string>();
      const endedOnce = new Set<string>();

      const keep = (t: TestTable) => {
        const results = resultsOf(t.state);
        const before = kept.get(results.tableId);

        reached.rewritten += before && before.version !== results.version ? 1 : 0;
        kept.set(results.tableId, results);
      };

      /** What a look at `now` writes: every table left alone for long enough. There are never more of them than one look sees to. */
      const looked = () => {
        for (const t of tables) {
          if (!gone.has(t.state.id) && savedAt.has(t.state.id) && stores.clock.time - savedAt.get(t.state.id)! >= SETTLE_AFTER_MS) {
            keep(t);
          }
        }
      };

      for (let step = 0; step < 40; step++) {
        const here = tables.filter((t) => !gone.has(t.state.id));
        const t = here.length > 0 ? pick(rng, here)! : null;
        const moment = rng.int(7);

        if (moment <= 1 && t) {
          play(t);
          save(stores, t);
          savedAt.set(t.state.id, stores.clock.time);
        } else if (moment === 2 && t) {
          if (chance(rng, 50)) {
            play(t);
          }

          save(stores, t, [ended(t, stores.clock.time)]);
          savedAt.set(t.state.id, stores.clock.time);
          keep(t);
          reached.endedAgain += endedOnce.has(t.state.id) ? 1 : 0;
          reached.ended += 1;
          endedOnce.add(t.state.id);
        } else if (moment === 3) {
          stores.clock.time += pick(rng, [SETTLE_EVERY_MS, SETTLE_AFTER_MS, SETTLE_AFTER_MS, PUT_AWAY_AFTER_MS])!;
        } else if (moment === 4) {
          // Far enough from any look before it to be one
          stores.clock.time += SETTLE_EVERY_MS;
          stores.run().store.settleIdle(stores.clock.time);
          looked();
          reached.looked += 1;
        } else if (moment === 5) {
          stores.run().store.putAwayOld(stores.clock.time, LAST_WORDS);

          for (const old of here) {
            if (savedAt.has(old.state.id) && stores.clock.time - savedAt.get(old.state.id)! >= PUT_AWAY_AFTER_MS) {
              keep(old);
              gone.add(old.state.id);
              reached.putAway += 1;
            }
          }

          looked();
        } else if (t && savedAt.has(t.state.id)) {
          visit(stores, t);
        }

        const expected = [...kept.values()].flatMap(rowsOf);
        const what = `seed ${seed} step ${step}`;

        assert.deepEqual(sorted(stores.rows()), sorted(expected), what);
        assert.equal(new Set(stores.rows().map(([tableId, playerId]) => `${tableId} ${playerId}`)).size, expected.length, `${what}: a row a table and player`);

        if (step % 8 === 0) {
          const records = recordsOf([...kept.values()].flatMap(nightsIn));

          assert.deepEqual(byId(stores.run().results.standings().records.chips), byId(records.chips), what);
          assert.ok(records.chips.every((record) => record.nights <= 2), 'two tables is two nights at most');
        }

        for (const id of gone) {
          assert.equal(stores.run().store.read(id), null, what);
        }
      }

      reached.emptied += kept.has('CCC222') && kept.get('CCC222')!.players.length === 0 ? 1 : 0;
    }

    for (const [what, times] of Object.entries(reached)) {
      assert.ok(times > 0, `the moments never came to: ${what}`);
    }
  });
}

// ---- Over the Sheet: what each moment costs, and what a failing call leaves ----

test('a night’s end adds to the save one look at whose rows are whose and one write of the rows; a save that ends no night makes no call it did not make before', () => {
  const sheet = inTheSheet();
  const t = night('ABC234', [ANN, BOB, CY]);
  save(sheet, t);
  play(t);

  sheet.calls.made = [];
  save(sheet, t, [ended(t, NOW)]);
  assert.deepEqual(sheet.calls.made, [
    'spreadsheet.getSheetByName',
    'cache.get',
    'Tables.getValues',
    'Tables.setValues',
    'flush',
    // The first row ever written is what makes the tab
    'spreadsheet.getSheetByName',
    'spreadsheet.insertSheet',
    'Results.setValues',
    'Results.getLastRow',
    'Results.getValues',
    'Results.setNumberFormats',
    'Results.setValues',
    'flush',
    'cache.remove',
    'cache.remove',
    'Tables.setValues',
    'flush',
    'cache.put',
  ]);

  // Without anywhere to write results the same save is the table's row and nothing else, as it was before there were any
  const plain = inTheSheet();
  const withResults = inTheSheet();

  for (const context of [plain, withResults]) {
    const stores = { ...context, run: () => context.run(context === withResults) };
    const other = night('ABC234', [ANN, BOB, CY]);
    save(stores, other);
    play(other);
    context.calls.made = [];
    save(stores, other);
    visit(stores, other);
  }

  assert.deepEqual(withResults.calls.made, plain.calls.made);
});

/** Tables saved so long ago, by their ids, each of two known players who have played a hand. */
function aged(sheet: ReturnType<typeof inTheSheet>, hoursAgo: Record<string, number>): Map<string, TestTable> {
  const tables = new Map<string, TestTable>();
  const now = sheet.clock.time;

  for (const [id, hours] of Object.entries(hoursAgo)) {
    const t = night(id, id.startsWith('SOLO') ? [ANN] : [ANN, BOB]);
    play(t);
    sheet.clock.time = now - hours * 60 * MINUTE_MS;
    save(sheet, t);
    tables.set(id, t);
  }

  sheet.clock.time = now;

  return tables;
}

const sweep = (sheet: ReturnType<typeof inTheSheet>) => sheet.run().store.putAwayOld(sheet.clock.time, LAST_WORDS);

test('what making a table costs in calls: with no table left alone nothing more than before, with all of them seen to one look in the cache, and with tables to write a bounded number', () => {
  // Nothing idle: the sweep reads the same cells of the Tables tab as it did, a column wider
  const quiet = inTheSheet();
  aged(quiet, { NEW222: 1, NEW333: 2 });
  quiet.calls.made = [];
  sweep(quiet);
  assert.deepEqual(quiet.calls.made, ['spreadsheet.getSheetByName', 'Tables.getLastRow', 'Tables.getValues']);

  // One table to write
  const one = inTheSheet();
  const tables = aged(one, { NEW222: 1, IDLE22: 5 });
  one.calls.made = [];
  sweep(one);
  assert.deepEqual(one.calls.made, [
    'spreadsheet.getSheetByName',
    'Tables.getLastRow',
    'Tables.getValues',
    'cache.get',
    // Which saves the rows kept are of: no tab yet, so none
    'spreadsheet.getSheetByName',
    'Tables.getValues',
    // The first row ever written is what makes the tab
    'spreadsheet.getSheetByName',
    'spreadsheet.insertSheet',
    'Results.setValues',
    'Results.getLastRow',
    'Results.getValues',
    'Results.setNumberFormats',
    'Results.setValues',
    'flush',
    'cache.remove',
    'cache.remove',
    'cache.put',
  ]);
  assert.deepEqual(one.rows(), rowsOf(resultsOf(tables.get('IDLE22')!.state)));

  // Seen to, it costs the next table made one look in the cache, and a table that is nobody's night the same
  one.calls.made = [];
  sweep(one);
  assert.deepEqual(one.calls.made, ['spreadsheet.getSheetByName', 'Tables.getLastRow', 'Tables.getValues', 'cache.get']);

  const solo = inTheSheet();
  aged(solo, { SOLO22: 5, SOLO33: 6 });
  sweep(solo);
  assert.deepEqual([...solo.spreadsheet.sheets.keys()], ['Tables'], 'no tab is made for nobody’s night');
  solo.calls.made = [];
  sweep(solo);
  assert.deepEqual(solo.calls.made, ['spreadsheet.getSheetByName', 'Tables.getLastRow', 'Tables.getValues', 'cache.get']);

  // The most: three tables read and their rows written in one write, however many wait
  const most = inTheSheet();
  aged(most, { AAA222: 9, BBB222: 8, CCC222: 7, DDD222: 6, EEE222: 5, FFF222: 4, SOLO22: 10 });
  sweep(most);
  most.calls.made = [];
  sweep(most);
  assert.deepEqual(most.calls.made, [
    'spreadsheet.getSheetByName',
    'Tables.getLastRow',
    'Tables.getValues',
    'cache.get',
    'spreadsheet.getSheetByName',
    'Results.getLastRow',
    'Results.getValues',
    'Tables.getValues',
    'Tables.getValues',
    'Tables.getValues',
    'Results.getLastRow',
    'Results.getValues',
    'Results.setNumberFormats',
    'Results.setValues',
    'flush',
    'cache.remove',
    'cache.remove',
    'cache.put',
  ]);
  assert.equal(new Set(most.rows().map(([tableId]) => tableId)).size, 6);

  // After which the table that is nobody's night gets its turn, and then there is nothing left to do
  sweep(most);
  most.calls.made = [];
  sweep(most);
  assert.deepEqual(most.calls.made, ['spreadsheet.getSheetByName', 'Tables.getLastRow', 'Tables.getValues', 'cache.get']);
});

test('a look asked for with the standings: nothing but a look in the cache when one was made lately, and the lock is not waited for as a move waits', () => {
  const sheet = inTheSheet();
  aged(sheet, { IDLE22: 5 });

  sheet.run().store.settleIdle(sheet.clock.time);
  assert.equal(sheet.rows().length, 2);
  assert.deepEqual(sheet.lock.waits.at(-1), 1000);

  sheet.calls.made = [];
  sheet.clock.time += SETTLE_EVERY_MS - 1;
  sheet.run().store.settleIdle(sheet.clock.time);
  assert.deepEqual(sheet.calls.made, ['cache.get']);

  // A lock someone else holds is no failure: the next asking looks
  sheet.clock.time += 1;
  sheet.lock.busy = true;
  assert.doesNotThrow(() => sheet.run().store.settleIdle(sheet.clock.time));
  assert.deepEqual(sheet.errors.rows, []);
  sheet.lock.busy = false;

  // What the cache remembered is lost: the tables are looked at again, and nothing is written twice
  sheet.cache.entries.clear();
  sheet.calls.made = [];
  sheet.run().store.settleIdle(sheet.clock.time);
  assert.deepEqual(sheet.calls.made, ['cache.get', 'spreadsheet.getSheetByName', 'Tables.getLastRow', 'Tables.getValues', 'cache.get', 'spreadsheet.getSheetByName', 'Results.getLastRow', 'Results.getValues', 'cache.put']);
  assert.equal(sheet.rows().length, 2);
});

test('a row of the Tables tab that is no table this code can load is left alone by a look, once, and costs no other table its turn', () => {
  const sheet = inTheSheet();
  const tables = aged(sheet, { AAA222: 5, BBB222: 6 });
  const tab = sheet.spreadsheet.sheets.get('Tables')!;

  tab.cells[1]![3] = 'not a table';
  sweep(sheet);
  assert.deepEqual(sheet.rows(), rowsOf(resultsOf(tables.get('BBB222')!.state)));
  assert.deepEqual(sheet.errors.rows, []);

  sheet.calls.made = [];
  sweep(sheet);
  assert.equal(sheet.calls.count('Tables.getValues'), 1, 'nothing is read of it again while it stays as it is');
});

test('every call after the save of a night’s end failed in turn: the save answers as it did, the failure is in the error log, and the next look at the table writes the rows once', () => {
  const clean = inTheSheet();
  const first = night('ABC234', [ANN, BOB, CY]);
  save(clean, first);
  play(first);
  clean.calls.made = [];
  save(clean, first, [ended(first, NOW)]);
  const steps = [...clean.calls.made];
  const savedBy = steps.indexOf('flush') + 1;

  for (const kind of ['spreadsheet.insertSheet', 'Results.getValues', 'Results.setNumberFormats', 'Results.setValues', 'cache.remove', 'Tables.setValues', 'cache.put']) {
    assert.ok(steps.slice(savedBy).includes(kind), `the save being failed makes no call to ${kind}`);
  }

  for (let failing = savedBy + 1; failing <= steps.length; failing++) {
    const context = inTheSheet();
    const step = `call ${failing}, ${steps[failing - 1]}`;
    const t = night('ABC234', [ANN, BOB, CY]);
    save(context, t);
    play(t);

    context.calls.made = [];
    context.calls.failNth(failing);
    assert.equal(save(context, t, [ended(t, NOW)]), 'saved', step);
    assert.equal(context.lock.held, false, step);
    assert.deepEqual(context.run().store.read('ABC234'), t.state, step);
    assert.equal(context.errors.rows.length, 1, `${step}: ${JSON.stringify(context.errors.rows)}`);
    assert.equal(context.errors.rows[0]!.tableId, 'ABC234', step);

    // The next request for the table tries again, and one after that finds nothing left to do
    visit(context, t);
    assert.deepEqual(context.rows(), rowsOf(resultsOf(t.state)), step);
    const tried = context.calls.made.length;
    visit(context, t);
    visit(context, t);
    assert.deepEqual(context.calls.made.slice(tried).filter((call) => /\.(setValues|deleteRows)$/.test(call)), [], step);
    assert.deepEqual(netOf(context), { [ANN]: netIn(t, ANN), [BOB]: netIn(t, BOB), [CY]: netIn(t, CY) }, step);
  }
});

const netIn = (t: TestTable, playerId: string) => resultsOf(t.state).players.find((player) => player.playerId === playerId)!.net;

function netOf(sheet: ReturnType<typeof inTheSheet>): Record<string, number> {
  sheet.cache.entries.clear();

  return Object.fromEntries(sheet.run().results.standings().records.chips.map((record) => [record.id, record.net]));
}

test('a night ended whose rows could not be written, then played on: the next save writes the rows as the table stands then', () => {
  const sheet = inTheSheet();
  const t = night('ABC234', [ANN, BOB, CY]);
  save(sheet, t);
  play(t);

  // The Results tab refuses everything for a while
  sheet.calls.made = [];
  sheet.calls.failNth(6);
  save(sheet, t, [ended(t, NOW)]);
  assert.deepEqual(sheet.rows(), []);
  assert.equal(sheet.errors.rows.at(-1)!.where, 'store copy to Results');

  play(t);
  play(t);
  save(sheet, t);
  assert.deepEqual(sheet.rows(), rowsOf(resultsOf(t.state)), 'the latest figures, of the latest save');
});

test('every call of a look failed in turn: nothing is thrown, what failed is in the error log, and a later look leaves every idle table one row a player', () => {
  const hours = { AAA222: 5, BBB222: 6, SOLO22: 7, NEW222: 1 };
  const clean = inTheSheet();
  aged(clean, hours);
  clean.calls.made = [];
  clean.run().store.settleIdle(clean.clock.time);
  const steps = [...clean.calls.made];

  for (let failing = 1; failing <= steps.length; failing++) {
    const context = inTheSheet();
    const step = `call ${failing}, ${steps[failing - 1]}`;
    const tables = aged(context, hours);
    const expected = sorted([...rowsOf(resultsOf(tables.get('AAA222')!.state)), ...rowsOf(resultsOf(tables.get('BBB222')!.state))]);

    context.calls.made = [];
    context.calls.failNth(failing);
    assert.doesNotThrow(() => context.run().store.settleIdle(context.clock.time), step);
    assert.equal(context.lock.held, false, step);
    assert.equal(context.errors.rows.length, 1, `${step}: ${JSON.stringify(context.errors.rows)}`);

    for (let later = 0; later < 2; later++) {
      context.clock.time += SETTLE_EVERY_MS;
      context.run().store.settleIdle(context.clock.time);
    }

    assert.deepEqual(sorted(context.rows()), expected, step);
    assert.deepEqual(netOf(context), { [ANN]: expected[0]![3] + expected[2]![3], [BOB]: expected[1]![3] + expected[3]![3] }, step);
  }
});

test('every call of a sweep that puts tables away failed in turn: making the table is never failed, no table leaves without its rows, and later sweeps finish with a row a player', () => {
  const days = (n: number) => n * 24;
  const hours = { OLD222: days(30), OLD333: days(20), IDLE22: 5, NEW222: 1 };
  const clean = inTheSheet();
  aged(clean, hours);
  clean.calls.made = [];
  sweep(clean);
  const steps = [...clean.calls.made];

  assert.deepEqual(clean.idsIn('Tables').sort(), ['IDLE22', 'NEW222']);
  assert.deepEqual(clean.idsIn('Archive').sort(), ['OLD222', 'OLD333']);
  assert.equal(new Set(clean.rows().map(([tableId]) => tableId)).size, 3);

  for (let failing = 1; failing <= steps.length; failing++) {
    const context = inTheSheet();
    const step = `call ${failing}, ${steps[failing - 1]}`;
    const tables = aged(context, hours);
    const expected = sorted(['OLD222', 'OLD333', 'IDLE22'].flatMap((id) => rowsOf(resultsOf(tables.get(id)!.state))));

    context.calls.made = [];
    context.calls.failNth(failing);
    assert.doesNotThrow(() => sweep(context), step);
    assert.equal(context.lock.held, false, step);
    assert.ok(context.errors.rows.length >= 1, step);

    // A table that has left the Tables tab has its rows already
    for (const id of ['OLD222', 'OLD333']) {
      if (!context.idsIn('Tables').includes(id)) {
        assert.equal(context.rows().filter(([tableId]) => tableId === id).length, 2, `${step}: ${id} left without its rows`);
      }
    }

    sweep(context);
    sweep(context);
    assert.deepEqual(context.idsIn('Tables').sort(), ['IDLE22', 'NEW222'], step);
    assert.deepEqual(context.idsIn('Archive').sort(), ['OLD222', 'OLD333'], step);
    assert.deepEqual(sorted(context.rows()), expected, step);
  }
});

test('a table put away whose rows a look had written already costs the sweep one look at whose rows are whose, and writes none again', () => {
  const sheet = inTheSheet();
  aged(sheet, { OLD222: 14 * 24 - 5 });
  sweep(sheet);
  const before = sheet.rows();
  assert.equal(before.length, 2);

  sheet.clock.time += 5 * 60 * MINUTE_MS;
  sheet.calls.made = [];
  sweep(sheet);

  assert.deepEqual(sheet.idsIn('Archive'), ['OLD222']);
  assert.deepEqual(sheet.rows(), before);
  assert.deepEqual(sheet.calls.made.filter((call) => call.startsWith('Results.')), ['Results.getLastRow', 'Results.getValues']);
});
