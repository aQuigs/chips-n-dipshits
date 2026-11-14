import { asNumber, upgradeRecord } from '../engine/index.ts';
import type { Denominated, Effect, HandRecord, TableState, Unit } from '../engine/index.ts';
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
const CELL_LENGTH = 50_000;
const CHUNK_LENGTH = 40_000;

// Keeps a chunk that happens to start with = or + from being read as a formula
const CHUNK_PREFIX = '~';

// A table's row: its id, when it was saved, its version, its state, and the records held until they are copied out
const STATE_CHUNKS = 6;
const HELD_CHUNKS = 3;
const STATE_COLUMN = 4;
const HELD_COLUMN = STATE_COLUMN + STATE_CHUNKS;
const TABLE_COLUMNS = HELD_COLUMN - 1 + HELD_CHUNKS;

const HEADERS: Record<SheetKey, string[]> = {
  tables: [
    'Table',
    'Updated',
    'Version',
    'State (the game reads and writes these cells, so leave them alone)',
    ...Array.from({ length: STATE_CHUNKS - 1 }, () => ''),
    'Records on their way to the Ledger and Hands tabs (normally empty)',
  ],
  ledger: ['Time', 'Table', 'Player', 'Type', 'Amount', 'Player ID', 'Record ID', 'Transferred', 'Other player', 'Other player ID'],
  hands: ['Time', 'Table', 'Hand', 'Summary', 'Record', 'Record ID'],
};

const TEXT = '@';
const TIMESTAMP = 'yyyy-mm-dd hh:mm:ss';
const WHOLE_NUMBER = '0';

// An amount is written as its table writes it, 1.50 for 150 cents, and as a number so the column can be added up
const AMOUNT: Record<Unit, string> = { chips: WHOLE_NUMBER, cents: '0.00' };

/**
 * Where each kind of record ends up, how the cells of a row are formatted for the table it happened at,
 * and which column holds the record's id. A column added later goes after the id, so that rows written
 * before it keep their id where a retry looks for it.
 */
const RECORD_SHEETS: { type: Effect['type']; sheet: SheetKey; idColumn: number; formats(table: Denominated): string[] }[] = [
  { type: 'ledger', sheet: 'ledger', idColumn: 7, formats: ({ unit }) => [TIMESTAMP, TEXT, TEXT, TEXT, AMOUNT[unit], TEXT, TEXT, AMOUNT[unit], TEXT, TEXT] },
  { type: 'hand', sheet: 'hands', idColumn: 6, formats: () => [TIMESTAMP, TEXT, WHOLE_NUMBER, TEXT, TEXT, TEXT] },
];

// The Ledger tab gained the transfer columns after Sheets were in use, and a tab made before then has no headers for them
const GROWN_SHEETS: readonly SheetKey[] = ['ledger'];

// The engine keeps a hand's log shorter than this. Should a longer one ever arrive, its end is kept
// rather than the hand being refused: the record must fit a cell, and it holds the summary.
const SUMMARY_LENGTH = 30_000;

// The longest the cache keeps anything
const CACHE_SECONDS = 21_600;

// While records wait in a table's row its cache entries live only this long, so that before long a
// reader goes to the sheet and the copy is tried again, even if nobody at the table ever acts again
const RETRY_SECONDS = 60;

// How far up a tab a record being retried is looked for, in case it did arrive the first time
const RETRY_SCAN_ROWS = 500;

// The cache takes 100 KB per key; leave headroom. A table past this is still saved, but every poll then reads it from the sheet under the lock
export const CACHE_VALUE_BYTES = 95_000;

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
export function utf8Bytes(text: string): number {
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

/** A ledger entry or finished hand on its way to its tab. The id is how a retry tells that it already arrived. */
interface Held {
  id: string;
  record: Effect;
}

/** The cells that keep records in a table's row until they are copied out. If they can't all fit, hands give way before money, oldest first. */
function heldCells(held: Held[]): string[] {
  for (let kept = held; ; ) {
    const cells = toCells(kept.length > 0 ? JSON.stringify(kept) : '', HELD_CHUNKS);
    if (cells) {
      return cells;
    }

    const oldestHand = kept.findIndex((item) => item.record.type === 'hand');
    const dropped = Math.max(oldestHand, 0);

    console.error('No room left to hold a record until it can be copied out', kept[dropped]);
    kept = kept.filter((_item, index) => index !== dropped);
  }
}

function isHeld(value: unknown): value is Held {
  const { id, record } = (value ?? {}) as Partial<Held>;
  if (typeof id !== 'string' || typeof record !== 'object' || record === null) {
    return false;
  }

  return record.type === 'ledger'
    ? typeof record.entry === 'object' && record.entry !== null
    : record.type === 'hand' && typeof record.record?.summary === 'string';
}

/** Reads the held cells of a row. Whatever in them isn't a record is left out: the table matters more than what someone did to these cells. */
function heldFrom(text: string): Held[] {
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  const held = Array.isArray(parsed) ? parsed.filter(isHeld) : [];

  if (!Array.isArray(parsed) || held.length < parsed.length) {
    console.error('Set aside waiting records that could not be read', text);
  }

  return held;
}

interface TableRow {
  state: TableState;
  /** Records saved with the table that have not reached the Ledger and Hands tabs. */
  held: Held[];
}

function parseRow(values: unknown[]): TableRow {
  return {
    state: restoreState(fromCells(values.slice(STATE_COLUMN - 1, STATE_COLUMN - 1 + STATE_CHUNKS))),
    held: heldFrom(fromCells(values.slice(HELD_COLUMN - 1, HELD_COLUMN - 1 + HELD_CHUNKS))),
  };
}

function recordRow({ id, record }: Held, table: Denominated): unknown[] {
  if (record.type === 'ledger') {
    const entry = record.entry;
    const amount = asNumber(entry.amount, table);

    // Amount is what a player paid or was paid, so adding it up for one player gives what they owe. A transfer is
    // no such thing: the chips it moved show up in that player's cash-out, so it is written beside the column instead
    return entry.kind === 'transfer'
      ? [new Date(entry.at), entry.tableId, entry.name, entry.kind, '', entry.playerId, id, amount, entry.otherName, entry.otherId]
      : [new Date(entry.at), entry.tableId, entry.name, entry.kind, amount, entry.playerId, id, '', '', ''];
  }

  const hand = record.record;
  const fitted = hand.summary.length <= SUMMARY_LENGTH ? hand : { ...hand, summary: `…${hand.summary.slice(-SUMMARY_LENGTH)}` };
  let json = JSON.stringify(fitted);

  // The engine keeps a hand's events far shorter than this as well. A record too long for its cell would be
  // refused every time it is tried, so it goes without its events rather than never arriving
  if (json.length > CELL_LENGTH) {
    console.error('A hand record too long for its cell was saved without its events', hand.tableId, hand.number);
    json = JSON.stringify({ ...fitted, events: [] });
  }

  return [new Date(hand.at), hand.tableId, hand.number, fitted.summary, json, id];
}

/** Gives a tab the headers it lacks, leaving any that someone has renamed. A record matters more than its header, so a failure here stops nothing. */
function headBlankColumns(sheet: SheetLike, headers: string[]): void {
  try {
    const range = sheet.getRange(1, 1, 1, headers.length);
    const [present = []] = range.getValues();

    if (headers.some((_header, index) => present[index] === '')) {
      range.setValues([headers.map((header, index) => (present[index] === '' ? header : present[index]))]);
    }
  } catch (error) {
    console.error(error);
  }
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
      const save = txn.save;

      if (save) {
        // A table's version changes with every save, which makes these ids one of a kind
        const fresh = txn.effects.map((record, index) => ({ id: `${save.id}:${save.version}:${index}`, record }));

        this.persist(save, found ? found.row : null, found ? found.held : [], fresh);
      } else if (found && found.held.length > 0) {
        this.copyOut(found.row, found.held, true, found.state.config);
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
      const mine = rows.filter((row) => String(row[1]) === tableId).map((row) => upgradeRecord(JSON.parse(String(row[4])) as HandRecord));

      found.unshift(...mine);
      lastRow = firstRow - 1;
    }

    // A hand that had to wait in its table's row sits below later ones
    return found.sort((a, b) => a.number - b.number).slice(-limit);
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
      // When a table's cache entries run out, every player's poll arrives here at once; the first one refills them.
      // Both entries must be back, or whichever is missing would send its readers here again and again
      const refilled = this.deps.cache.get(stateKey(tableId));
      if (refilled && this.deps.cache.get(peekKey(tableId))) {
        return restoreState(refilled);
      }

      const found = this.locate(tableId);

      if (!found) {
        this.deps.cache.put(peekKey(tableId), MISSING, MISSING_SECONDS);
        return null;
      }

      const settled = found.held.length === 0 || this.copyOut(found.row, found.held, true, found.state.config);
      this.remember(found.state, found.row, settled);

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
    } else if (GROWN_SHEETS.includes(key)) {
      headBlankColumns(sheet, HEADERS[key]);
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

  private persist(state: TableState, knownRow: number | null, leftOver: Held[], fresh: Held[]): void {
    const held = [...leftOver, ...fresh];
    let row: number;

    try {
      // One write holds the table and the records of what just happened to it, so neither is saved without the other
      row = this.writeTable(state, knownRow, held);
      this.deps.flush();
    } catch (error) {
      // Whatever did or didn't reach the sheet, the cache must not keep serving the old table
      this.forget(state.id);
      throw error;
    }

    const settled = held.length === 0 || this.copyOut(row, held, leftOver.length > 0, state.config);

    // The save itself succeeded, so a cache that can't be refreshed is only emptied, not treated as a failure
    try {
      this.remember(state, row, settled);
    } catch {
      this.forget(state.id);
    }
  }

  private writeTable(state: TableState, knownRow: number | null, held: Held[]): number {
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

    range.setValues([[state.id, new Date().toISOString(), String(state.version), ...stateCells, ...heldCells(held)]]);

    return row;
  }

  /**
   * Copies the records held in a table's row to the Ledger and Hands tabs, then takes them off the
   * row. Whatever can't be written stays held and is tried again the next time the row is read, so a
   * failing write costs no record and never holds up the game. Returns whether the row is now clear.
   *
   * `retrying` says some of these were tried before. A write that reported failure may have landed all
   * the same, so those are looked for in their tab first and not written twice.
   */
  private copyOut(row: number, held: Held[], retrying: boolean, table: Denominated): boolean {
    const waiting: Held[] = [];

    for (const { type, sheet, idColumn, formats } of RECORD_SHEETS) {
      const mine = held.filter((item) => item.record.type === type);
      if (mine.length === 0) {
        continue;
      }

      const rowFormats = formats(table);

      try {
        const arrived = retrying ? this.recentIds(sheet, idColumn) : new Set<string>();
        const rows = mine.filter((item) => !arrived.has(item.id)).map((item) => recordRow(item, table));

        this.appendRows(sheet, rows, rowFormats);
        this.deps.flush();
      } catch (error) {
        console.error(error);
        waiting.push(...mine);
      }
    }

    if (waiting.length === held.length) {
      return false;
    }

    try {
      this.sheet('tables').getRange(row, HELD_COLUMN, 1, HELD_CHUNKS).setValues([heldCells(waiting)]);
      this.deps.flush();
    } catch (error) {
      // The row still lists what was copied; the retry will find those in their tabs and only clear the list
      console.error(error);

      return false;
    }

    return waiting.length === 0;
  }

  /** The ids of the records at the bottom of a tab. */
  private recentIds(key: SheetKey, idColumn: number): Set<string> {
    const sheet = this.sheet(key);
    const lastRow = sheet.getLastRow();
    if (lastRow < FIRST_DATA_ROW) {
      return new Set();
    }

    const firstRow = Math.max(FIRST_DATA_ROW, lastRow - RETRY_SCAN_ROWS + 1);
    const ids = sheet.getRange(firstRow, idColumn, lastRow - firstRow + 1, 1).getValues();

    return new Set(ids.map((row) => String(row[0])));
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

  /** `settled` is false while records wait in the table's row, which keeps the cache from hiding them for long. */
  private remember(state: TableState, row: number, settled: boolean): void {
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

    this.deps.cache.putAll(entries, settled ? CACHE_SECONDS : RETRY_SECONDS);
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
