import type { Effect, HandRecord, TableState } from '../engine/index.ts';
import { peekOf, restoreState, StoreBusyError } from '../server/store.ts';
import type { TablePeek, TableStore, Txn } from '../server/store.ts';

/** The parts of the Apps Script services this store uses, so it can be run against stand-ins in tests. */
export interface RangeLike {
  getValues(): unknown[][];
  setValues(values: unknown[][]): unknown;
  setNumberFormats(formats: string[][]): unknown;
}

export interface SheetLike {
  getLastRow(): number;
  getRange(row: number, column: number, numRows: number, numColumns: number): RangeLike;
}

export interface SpreadsheetLike {
  getSheetByName(name: string): SheetLike | null;
  insertSheet(name: string): SheetLike;
}

export interface CacheLike {
  get(key: string): string | null;
  put(key: string, value: string, expirationInSeconds: number): void;
  putAll(values: Record<string, string>, expirationInSeconds: number): void;
  remove(key: string): void;
}

export interface LockLike {
  waitLock(timeoutInMillis: number): void;
  releaseLock(): void;
}

export interface SheetStoreDeps {
  /** Opened only when the cache can't answer, since opening the spreadsheet is the slow part of a request. */
  spreadsheet: () => SpreadsheetLike;
  cache: CacheLike;
  lock: LockLike;
  /** Pushes pending writes to the spreadsheet, so they are there before the lock is let go. */
  flush: () => void;
}

type SheetKey = 'tables' | 'ledger' | 'hands';

const SHEET_NAMES: Record<SheetKey, string> = { tables: 'Tables', ledger: 'Ledger', hands: 'Hands' };

// A cell holds at most 50,000 characters, so long text is spread over several
const CHUNK_LENGTH = 40_000;

// Keeps a chunk that happens to start with = or + from being read as a formula
const CHUNK_PREFIX = '~';

// A table's row: its id, when it was saved, its version, its state, and the records still to be copied out
const STATE_CHUNKS = 6;
const UNSAVED_CHUNKS = 3;
const STATE_COLUMN = 4;
const UNSAVED_COLUMN = STATE_COLUMN + STATE_CHUNKS;
const TABLE_COLUMNS = UNSAVED_COLUMN - 1 + UNSAVED_CHUNKS;

const HEADERS: Record<SheetKey, string[]> = {
  tables: [
    'Table',
    'Updated',
    'Version',
    'State (the game reads and writes these cells, so leave them alone)',
    ...Array.from({ length: STATE_CHUNKS - 1 }, () => ''),
    'Records on their way to the Ledger and Hands tabs (normally empty)',
  ],
  ledger: ['Time', 'Table', 'Player', 'Type', 'Chips', 'Player ID'],
  hands: ['Time', 'Table', 'Hand', 'Summary', 'Record'],
};

const TEXT = '@';
const TIMESTAMP = 'yyyy-mm-dd hh:mm:ss';
const WHOLE_NUMBER = '0';

/** Where each kind of record ends up. */
const RECORD_SHEETS: { type: Effect['type']; sheet: SheetKey; formats: string[] }[] = [
  { type: 'ledger', sheet: 'ledger', formats: [TIMESTAMP, TEXT, TEXT, TEXT, WHOLE_NUMBER, TEXT] },
  { type: 'hand', sheet: 'hands', formats: [TIMESTAMP, TEXT, WHOLE_NUMBER, TEXT, TEXT] },
];

// The engine keeps a hand's log shorter than this. Should a longer one ever arrive, its end is kept
// rather than the hand being refused: the record must fit a cell, and it holds the summary.
const SUMMARY_LENGTH = 30_000;

// The longest the cache keeps anything
const CACHE_SECONDS = 21_600;

// The cache takes 100 KB per key; leave headroom
const CACHE_VALUE_BYTES = 95_000;

// How long to remember that a table doesn't exist, so a mistyped link doesn't hit the sheet on every poll
const MISSING_SECONDS = 30;
const MISSING = 'none';

const LOCK_WAIT_MS = 20_000;
const FIRST_DATA_ROW = 2;

// History is read from the bottom of the Hands tab, a page at a time, and gives up this far back
const HAND_SCAN_ROWS = 300;
const HAND_SCAN_PAGES = 10;

const stateKey = (tableId: string) => `state:${tableId}`;
const peekKey = (tableId: string) => `peek:${tableId}`;
const rowKey = (tableId: string) => `row:${tableId}`;

/** An upper bound on the UTF-8 size of a string whose characters all fit in one UTF-16 unit or pair. */
function utf8Bytes(text: string): number {
  const nonAscii = text.replace(/[\x00-\x7f]/g, '').length;

  return text.length + 2 * nonAscii;
}

/** Spreads text over a fixed number of cells; null when it is more than they hold. */
function toCells(text: string, count: number): string[] | null {
  const cells: string[] = [];

  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + CHUNK_LENGTH, text.length);

    // The two halves of an emoji are only a character together, so they go in the same cell
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }

    cells.push(CHUNK_PREFIX + text.slice(start, end));
    start = end;
  }

  if (cells.length > count) {
    return null;
  }

  while (cells.length < count) {
    cells.push('');
  }

  return cells;
}

function fromCells(cells: unknown[]): string {
  return cells.map((cell) => String(cell).slice(CHUNK_PREFIX.length)).join('');
}

/** The cells that hold records in a table's row until they are copied out. If they can't all fit, the oldest give way. */
function unsavedCells(records: Effect[]): string[] {
  for (let kept = records; ; kept = kept.slice(1)) {
    const cells = toCells(kept.length > 0 ? JSON.stringify(kept) : '', UNSAVED_CHUNKS);

    if (cells) {
      return cells;
    }

    console.error('No room left to hold a record until it can be copied out', kept[0]);
  }
}

interface TableRow {
  state: TableState;
  /** Records saved with the table that have not reached the Ledger and Hands tabs. */
  unsaved: Effect[];
}

function parseRow(values: unknown[]): TableRow {
  const unsaved = fromCells(values.slice(UNSAVED_COLUMN - 1, UNSAVED_COLUMN - 1 + UNSAVED_CHUNKS));

  return {
    state: restoreState(fromCells(values.slice(STATE_COLUMN - 1, STATE_COLUMN - 1 + STATE_CHUNKS))),
    unsaved: unsaved ? (JSON.parse(unsaved) as Effect[]) : [],
  };
}

function recordRow(record: Effect): unknown[] {
  if (record.type === 'ledger') {
    const { at, tableId, name, kind, amount, playerId } = record.entry;

    return [new Date(at), tableId, name, kind, amount, playerId];
  }

  const hand = record.record;
  const fitted = hand.summary.length <= SUMMARY_LENGTH ? hand : { ...hand, summary: `…${hand.summary.slice(-SUMMARY_LENGTH)}` };

  return [new Date(hand.at), hand.tableId, hand.number, fitted.summary, JSON.stringify(fitted)];
}

/**
 * Keeps every table in a Google Sheet. The sheet is the source of truth; the script cache only saves
 * reads. Every write, and every refill of the cache, happens under the script lock, so the cache can
 * never be left holding something older than the sheet.
 */
export class SheetStore implements TableStore {
  private readonly deps: SheetStoreDeps;
  private readonly sheets = new Map<SheetKey, SheetLike>();

  constructor(deps: SheetStoreDeps) {
    this.deps = deps;
  }

  transact<T>(tableId: string, fn: (state: TableState | null) => Txn<T>): T {
    return this.locked(() => {
      const found = this.locate(tableId);
      const txn = fn(found ? found.state : null);

      if (txn.save) {
        this.persist(txn.save, found ? found.row : null, [...(found ? found.unsaved : []), ...txn.effects]);
      }

      return txn.result;
    });
  }

  read(tableId: string): TableState | null {
    const cached = this.deps.cache.get(stateKey(tableId));
    if (cached) {
      return restoreState(cached);
    }

    if (this.deps.cache.get(peekKey(tableId)) === MISSING) {
      return null;
    }

    return this.reload(tableId);
  }

  peek(tableId: string): TablePeek | null {
    const cached = this.deps.cache.get(peekKey(tableId));
    if (cached === MISSING) {
      return null;
    }

    if (cached) {
      return JSON.parse(cached) as TablePeek;
    }

    const state = this.reload(tableId);

    return state ? peekOf(state) : null;
  }

  recentHands(tableId: string, limit: number): HandRecord[] {
    const sheet = this.sheet('hands');
    const found: HandRecord[] = [];
    let lastRow = sheet.getLastRow();

    // Other tables' hands are in between, so keep paging up until there are enough of this one's
    for (let page = 0; page < HAND_SCAN_PAGES && lastRow >= FIRST_DATA_ROW && found.length < limit; page++) {
      const firstRow = Math.max(FIRST_DATA_ROW, lastRow - HAND_SCAN_ROWS + 1);
      const rows = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, HEADERS.hands.length).getValues();
      const mine = rows.filter((row) => String(row[1]) === tableId).map((row) => JSON.parse(String(row[4])) as HandRecord);

      found.unshift(...mine);
      lastRow = firstRow - 1;
    }

    return found.slice(-limit);
  }

  private locked<T>(work: () => T): T {
    try {
      this.deps.lock.waitLock(LOCK_WAIT_MS);
    } catch {
      throw new StoreBusyError('The table is busy, try again');
    }

    try {
      return work();
    } finally {
      this.deps.lock.releaseLock();
    }
  }

  /** Reads a table from the sheet into the cache. Under the lock, so a write can't slip in between the two. */
  private reload(tableId: string): TableState | null {
    return this.locked(() => {
      const found = this.locate(tableId);

      if (!found) {
        this.deps.cache.put(peekKey(tableId), MISSING, MISSING_SECONDS);
        return null;
      }

      this.remember(found.state, found.row);

      return found.state;
    });
  }

  private sheet(key: SheetKey): SheetLike {
    const known = this.sheets.get(key);
    if (known) {
      return known;
    }

    const spreadsheet = this.deps.spreadsheet();
    let sheet = spreadsheet.getSheetByName(SHEET_NAMES[key]);

    if (!sheet) {
      sheet = spreadsheet.insertSheet(SHEET_NAMES[key]);
      sheet.getRange(1, 1, 1, HEADERS[key].length).setValues([HEADERS[key]]);
    }

    this.sheets.set(key, sheet);

    return sheet;
  }

  private locate(tableId: string): ({ row: number } & TableRow) | null {
    const sheet = this.sheet('tables');
    const rowAt = (row: number) => sheet.getRange(row, 1, 1, TABLE_COLUMNS).getValues()[0]!;

    // The remembered row is only a hint: rows move if someone sorts or deletes in the sheet
    const hint = Number(this.deps.cache.get(rowKey(tableId)));
    if (hint >= FIRST_DATA_ROW) {
      const values = rowAt(hint);

      if (String(values[0]) === tableId) {
        return { row: hint, ...parseRow(values) };
      }
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < FIRST_DATA_ROW) {
      return null;
    }

    const ids = sheet.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, 1).getValues();
    const index = ids.findIndex((row) => String(row[0]) === tableId);
    if (index < 0) {
      return null;
    }

    const row = index + FIRST_DATA_ROW;

    return { row, ...parseRow(rowAt(row)) };
  }

  private persist(state: TableState, knownRow: number | null, records: Effect[]): void {
    let row: number;

    try {
      // One write holds the table and the records of what just happened to it, so neither is saved without the other
      row = this.writeTable(state, knownRow, records);
      this.deps.flush();
    } catch (error) {
      // Whatever did or didn't reach the sheet, the cache must not keep serving the old table
      this.forget(state.id);
      throw error;
    }

    if (records.length > 0) {
      this.copyOut(row, records);
    }

    // The save itself succeeded, so a cache that can't be refreshed is only emptied, not treated as a failure
    try {
      this.remember(state, row);
    } catch {
      this.forget(state.id);
    }
  }

  private writeTable(state: TableState, knownRow: number | null, records: Effect[]): number {
    const sheet = this.sheet('tables');
    const json = JSON.stringify(state);
    const stateCells = toCells(json, STATE_CHUNKS);

    if (!stateCells) {
      throw new Error(`Table ${state.id} has grown to ${json.length} characters, more than its row can hold`);
    }

    const row = knownRow ?? Math.max(sheet.getLastRow(), 1) + 1;
    const range = sheet.getRange(row, 1, 1, TABLE_COLUMNS);

    // Plain text everywhere, or the sheet would turn an id like 2E5678 into a number
    if (knownRow === null) {
      range.setNumberFormats([Array.from({ length: TABLE_COLUMNS }, () => TEXT)]);
    }

    range.setValues([[state.id, new Date().toISOString(), String(state.version), ...stateCells, ...unsavedCells(records)]]);

    return row;
  }

  /**
   * Copies the records saved in a table's row to the Ledger and Hands tabs, then takes them off the
   * row. Whatever can't be written stays there and goes out with the table's next save, so a failing
   * write costs no record and never holds up the game.
   */
  private copyOut(row: number, records: Effect[]): void {
    const waiting: Effect[] = [];

    for (const { type, sheet, formats } of RECORD_SHEETS) {
      const mine = records.filter((record) => record.type === type);
      if (mine.length === 0) {
        continue;
      }

      try {
        this.appendRows(sheet, mine.map(recordRow), formats);
        this.deps.flush();
      } catch (error) {
        console.error(error);
        waiting.push(...mine);
      }
    }

    if (waiting.length === records.length) {
      return;
    }

    try {
      this.sheet('tables').getRange(row, UNSAVED_COLUMN, 1, UNSAVED_CHUNKS).setValues([unsavedCells(waiting)]);
      this.deps.flush();
    } catch (error) {
      // They were copied, so the worst that can follow is that the next save copies them again
      console.error(error);
    }
  }

  private appendRows(key: SheetKey, rows: unknown[][], formats: string[]): void {
    const sheet = this.sheet(key);
    const range = sheet.getRange(Math.max(sheet.getLastRow(), 1) + 1, 1, rows.length, formats.length);

    range.setNumberFormats(rows.map(() => formats));
    range.setValues(rows);
  }

  private remember(state: TableState, row: number): void {
    const json = JSON.stringify(state);
    const entries: Record<string, string> = {
      [peekKey(state.id)]: JSON.stringify(peekOf(state)),
      [rowKey(state.id)]: String(row),
    };

    if (utf8Bytes(json) <= CACHE_VALUE_BYTES) {
      entries[stateKey(state.id)] = json;
    } else {
      this.deps.cache.remove(stateKey(state.id));
    }

    this.deps.cache.putAll(entries, CACHE_SECONDS);
  }

  private forget(tableId: string): void {
    for (const key of [stateKey(tableId), peekKey(tableId), rowKey(tableId)]) {
      try {
        this.deps.cache.remove(key);
      } catch {
        // Nothing more can be done; the entry expires by itself
      }
    }
  }
}
