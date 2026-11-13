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

const HEADERS: Record<SheetKey, string[]> = {
  tables: ['Table', 'Updated', 'Version', 'State (the game reads and writes these cells, so leave them alone)'],
  ledger: ['Time', 'Table', 'Player', 'Type', 'Chips', 'Player ID'],
  hands: ['Time', 'Table', 'Hand', 'Summary', 'Record'],
};

const TEXT = '@';
const TIMESTAMP = 'yyyy-mm-dd hh:mm:ss';
const WHOLE_NUMBER = '0';
const LEDGER_FORMATS = [TIMESTAMP, TEXT, TEXT, TEXT, WHOLE_NUMBER, TEXT];
const HAND_FORMATS = [TIMESTAMP, TEXT, WHOLE_NUMBER, TEXT, TEXT];

// A cell holds at most 50,000 characters, so a table's JSON is spread over several
const CHUNK_LENGTH = 40_000;
const STATE_CHUNKS = 6;
const STATE_COLUMN = 4;
const TABLE_COLUMNS = STATE_COLUMN - 1 + STATE_CHUNKS;

// Keeps a chunk that happens to start with = or + from being read as a formula
const CHUNK_PREFIX = '~';

// The longest the cache keeps anything
const CACHE_SECONDS = 21_600;

// The cache takes 100 KB per key; leave headroom
const CACHE_VALUE_BYTES = 95_000;

// How long to remember that a table doesn't exist, so a mistyped link doesn't hit the sheet on every poll
const MISSING_SECONDS = 30;
const MISSING = 'none';

const LOCK_WAIT_MS = 20_000;
const HAND_SCAN_ROWS = 300;
const FIRST_DATA_ROW = 2;

const stateKey = (tableId: string) => `state:${tableId}`;
const peekKey = (tableId: string) => `peek:${tableId}`;
const rowKey = (tableId: string) => `row:${tableId}`;

/** An upper bound on the UTF-8 size of a string whose characters all fit in one UTF-16 unit or pair. */
function utf8Bytes(text: string): number {
  const nonAscii = text.replace(/[\x00-\x7f]/g, '').length;

  return text.length + 2 * nonAscii;
}

function stateFromRow(values: unknown[]): TableState {
  const json = values
    .slice(STATE_COLUMN - 1)
    .map((cell) => String(cell).slice(CHUNK_PREFIX.length))
    .join('');

  return restoreState(json);
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
        this.persist(txn.save, found ? found.row : null, txn.effects);
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
    const lastRow = sheet.getLastRow();
    if (lastRow < FIRST_DATA_ROW) {
      return [];
    }

    const firstRow = Math.max(FIRST_DATA_ROW, lastRow - HAND_SCAN_ROWS + 1);
    const rows = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, HEADERS.hands.length).getValues();

    return rows
      .filter((row) => String(row[1]) === tableId)
      .slice(-limit)
      .map((row) => JSON.parse(String(row[4])) as HandRecord);
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

  private locate(tableId: string): { row: number; state: TableState } | null {
    const sheet = this.sheet('tables');
    const rowAt = (row: number) => sheet.getRange(row, 1, 1, TABLE_COLUMNS).getValues()[0]!;

    // The remembered row is only a hint: rows move if someone sorts or deletes in the sheet
    const hint = Number(this.deps.cache.get(rowKey(tableId)));
    if (hint >= FIRST_DATA_ROW) {
      const values = rowAt(hint);

      if (String(values[0]) === tableId) {
        return { row: hint, state: stateFromRow(values) };
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

    return { row, state: stateFromRow(rowAt(row)) };
  }

  private persist(state: TableState, knownRow: number | null, effects: Effect[]): void {
    let row: number;

    try {
      row = this.writeTable(state, knownRow);
      this.appendEffects(effects);
      this.deps.flush();
    } catch (error) {
      // Whatever did or didn't reach the sheet, the cache must not keep serving the old table
      this.forget(state.id);
      throw error;
    }

    // The save itself succeeded, so a cache that can't be refreshed is only emptied, not treated as a failure
    try {
      this.remember(state, row);
    } catch {
      this.forget(state.id);
    }
  }

  private writeTable(state: TableState, knownRow: number | null): number {
    const sheet = this.sheet('tables');
    const json = JSON.stringify(state);

    const chunks: string[] = [];
    for (let start = 0; start < json.length; start += CHUNK_LENGTH) {
      chunks.push(CHUNK_PREFIX + json.slice(start, start + CHUNK_LENGTH));
    }

    if (chunks.length > STATE_CHUNKS) {
      throw new Error(`Table ${state.id} has grown to ${json.length} characters, more than its row can hold`);
    }

    while (chunks.length < STATE_CHUNKS) {
      chunks.push('');
    }

    const row = knownRow ?? Math.max(sheet.getLastRow(), 1) + 1;
    const range = sheet.getRange(row, 1, 1, TABLE_COLUMNS);

    // Plain text everywhere, or the sheet would turn an id like 2E5678 into a number
    if (knownRow === null) {
      range.setNumberFormats([Array.from({ length: TABLE_COLUMNS }, () => TEXT)]);
    }

    range.setValues([[state.id, new Date().toISOString(), String(state.version), ...chunks]]);

    return row;
  }

  private appendEffects(effects: Effect[]): void {
    const ledger: unknown[][] = [];
    const hands: unknown[][] = [];

    for (const effect of effects) {
      if (effect.type === 'ledger') {
        const { at, tableId, name, kind, amount, playerId } = effect.entry;
        ledger.push([new Date(at), tableId, name, kind, amount, playerId]);
      } else {
        const { at, tableId, number, summary } = effect.record;
        hands.push([new Date(at), tableId, number, summary, JSON.stringify(effect.record)]);
      }
    }

    this.appendRows('ledger', ledger, LEDGER_FORMATS);
    this.appendRows('hands', hands, HAND_FORMATS);
  }

  private appendRows(key: SheetKey, rows: unknown[][], formats: string[]): void {
    if (rows.length === 0) {
      return;
    }

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
