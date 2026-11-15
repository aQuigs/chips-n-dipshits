import { asNumber, resultsOf, upgradeRecord } from '../engine/index.ts';
import type { Denominated, Effect, HandRecord, TableState } from '../engine/index.ts';
import type { ErrorLog } from '../server/errorLog.ts';
import { dueToLookAt, lastWordsOf, PUT_AWAY_AT_ONCE } from '../server/putAway.ts';
import type { LastWords } from '../server/putAway.ts';
import { idleLongEnough, NEVER_SETTLED, SETTLE_EVERY_MS, settleIdle } from '../server/resultStore.ts';
import type { ResultWriter, SavedTable, Settled } from '../server/resultStore.ts';
import { peekOf, restoreState, StoreBusyError } from '../server/store.ts';
import type { TablePeek, TableStore, Txn } from '../server/store.ts';
import { RESULTS_TAB } from './sheetResultStore.ts';
import { AMOUNT, dataRows, FIRST_DATA_ROW, HeldReports, openTab, TEXT, TIMESTAMP, underLock, WHOLE_NUMBER } from './sheets.ts';
import type { CacheLike, LockLike, SheetLike, SpreadsheetLike } from './sheets.ts';

export interface SheetStoreDeps {
  /** Opened only when the cache can't answer, since opening the spreadsheet is the slow part of a request. */
  spreadsheet: () => SpreadsheetLike;
  cache: CacheLike;
  lock: LockLike;
  /** Pushes pending writes to the spreadsheet, so they are there before the lock is let go. */
  flush: () => void;
  /** Where what goes wrong and is carried on through is reported. */
  errors?: ErrorLog;
  /** Where what a table came to for its players is written. Left out, nothing is kept of the end of a night. */
  results?: ResultWriter;
}

/** Tells of something that went wrong but stops nothing: where, and what. */
type Noted = (where: string, error: unknown) => void;

type SheetKey = 'tables' | 'ledger' | 'hands';

const BUSY = 'The table is busy, try again';

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
export const TABLE_COLUMNS = HELD_COLUMN - 1 + HELD_CHUNKS;

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

// Plain text everywhere, or the sheet would turn an id like 2E5678 into a number
const TABLE_FORMATS = Array.from({ length: TABLE_COLUMNS }, () => TEXT);

const ARCHIVE = 'Archive';

// A table that was put away keeps the cells of its row, in the columns they had, so that it can be put back by
// hand. After them comes what tells it from the others without opening its state
const ARCHIVE_HEADERS = [...HEADERS.tables, ...Array.from({ length: TABLE_COLUMNS - HEADERS.tables.length }, () => ''), 'Name', 'Created', 'Players', 'Put away'];
const ARCHIVE_FORMATS = [...TABLE_FORMATS, TEXT, TIMESTAMP, TEXT, TIMESTAMP];

// What the Archive says of a table is for a person to read, and one cell too long would stop every table it is written with
const DESCRIPTION_LENGTH = 1000;

const EMPTY_ROW = Array.from({ length: TABLE_COLUMNS }, () => '');

/** What happened that has a tab to go to. */
type Recorded = Effect;

/**
 * A kind of record that is a row of its own in a tab, added below those already there: how the cells
 * of a row are formatted for the table it happened at, and which column holds the record's id. A
 * column added later goes after the id, so that rows written before it keep their id where a retry looks for it.
 */
interface RowOfItsOwn {
  type: 'ledger' | 'hand';
  tab: string;
  sheet: SheetKey;
  idColumn: number;
  formats(table: Denominated): string[];
}

/**
 * The end of a night is no row: it has the table's results written again as the table then stands,
 * by whoever keeps them, in place of what was kept before. However many ends wait, and however late
 * they are seen to, that is one write of the latest figures.
 */
interface ResultsAgain {
  type: 'nightEnded';
  tab: string;
}

/** Where each kind of record ends up. */
const RECORD_SHEETS: (RowOfItsOwn | ResultsAgain)[] = [
  { type: 'ledger', tab: SHEET_NAMES.ledger, sheet: 'ledger', idColumn: 7, formats: ({ unit }) => [TIMESTAMP, TEXT, TEXT, TEXT, AMOUNT[unit], TEXT, TEXT, AMOUNT[unit], TEXT, TEXT] },
  { type: 'hand', tab: SHEET_NAMES.hands, sheet: 'hands', idColumn: 6, formats: () => [TIMESTAMP, TEXT, WHOLE_NUMBER, TEXT, TEXT, TEXT] },
  { type: 'nightEnded', tab: RESULTS_TAB },
];

// The engine keeps a hand's log shorter than this. Should a longer one ever arrive, its end is kept
// rather than the hand being refused: the record must fit a cell, and it holds the summary.
const SUMMARY_LENGTH = 30_000;

// The longest the cache keeps anything
const CACHE_SECONDS = 21_600;

// While records wait in a table's row its cache entries live only this long, so that before long a
// reader goes to the sheet and the copy is tried again, even if nobody at the table ever acts again
const RETRY_SECONDS = 60;

/**
 * Whether records being copied to their tabs may have been tried before. One that was may be there
 * already, since a write that reported failure can have landed all the same, and it may lie under any
 * number of rows other tables have written since. So it is looked for through its whole tab before it
 * is written again; a first copy is written without a look, which keeps that read off every ordinary save.
 */
type Attempt = 'first' | 'again';

// The cache takes 100 KB per key; leave headroom. A table past this is still saved, but every poll then reads it from the sheet under the lock
export const CACHE_VALUE_BYTES = 95_000;

// How long to remember that a table isn't there, so a mistyped link, or a page left open on a table that was put
// away, doesn't hit the sheet on every poll. `AWAY` says the table is in the Archive
const MISSING_SECONDS = 30;
const MISSING = 'none';
const AWAY = 'away';

// Putting old tables away can wait for the next new table, so it does not queue for the lock as a move does
const PUT_AWAY_LOCK_WAIT_MS = 1000;

// What the store remembers of the tables whose results it has seen to (`Settled`)
const SETTLED_KEY = 'settled';

const SAVED_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

// History is read from the bottom of the Hands tab, a page at a time, and gives up this far back
const HAND_SCAN_ROWS = 300;
const HAND_SCAN_PAGES = 10;

const isGone = (peek: string | null) => peek === MISSING || peek === AWAY;

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
  record: Recorded;
}

/** Those of the effects that `kept` says have somewhere to go, each under an id made from `made`, which says what made them, and its place among them. */
function heldOf(effects: Effect[], made: string, kept: (effect: Effect) => boolean): Held[] {
  return effects.flatMap((record, index) => (kept(record) ? [{ id: `${made}:${index}`, record }] : []));
}

/**
 * The cells that keep records in a table's row until they are copied out. If they can't all fit, hands
 * give way before money, oldest first, and each dropped is `noted`.
 */
function heldCells(held: Held[], noted: Noted = () => undefined): string[] {
  for (let kept = held; ; ) {
    const cells = toCells(kept.length > 0 ? JSON.stringify(kept) : '', HELD_CHUNKS);
    if (cells) {
      if (kept.length < held.length) {
        noted('store hold records', `No room left in the row to hold ${held.length - kept.length} records until they are copied out, so they were dropped`);
      }

      return cells;
    }

    const oldestHand = kept.findIndex((item) => item.record.type === 'hand');
    const dropped = Math.max(oldestHand, 0);

    kept = kept.filter((_item, index) => index !== dropped);
  }
}

function isHeld(value: unknown): value is Held {
  const { id, record } = (value ?? {}) as Partial<Held>;
  if (typeof id !== 'string' || typeof record !== 'object' || record === null) {
    return false;
  }

  if (record.type === 'nightEnded') {
    return typeof record.night === 'object' && record.night !== null;
  }

  return record.type === 'ledger'
    ? typeof record.entry === 'object' && record.entry !== null
    : record.type === 'hand' && typeof record.record?.summary === 'string';
}

/** Reads the held cells of a row. Whatever in them isn't a record is left out, and `noted`: the table matters more than what someone did to these cells. */
function heldFrom(text: string, noted: Noted): Held[] {
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
    noted('store read records', 'Set aside waiting records in the row that could not be read');
  }

  return held;
}

interface TableRow {
  state: TableState;
  /** Records saved with the table that have not reached the Ledger and Hands tabs. */
  held: Held[];
}

/** The JSON a row's state cells hold between them. */
function stateText(values: unknown[]): string {
  return fromCells(values.slice(STATE_COLUMN - 1, STATE_COLUMN - 1 + STATE_CHUNKS));
}

function parseRow(values: unknown[], noted: Noted): TableRow {
  return {
    state: restoreState(stateText(values)),
    held: heldFrom(fromCells(values.slice(HELD_COLUMN - 1, HELD_COLUMN - 1 + HELD_CHUNKS)), noted),
  };
}

/**
 * When a row's Updated cell says its table was last saved, or null when it says nothing this code can
 * read. A table with no such time counts as new, never as old.
 */
function savedAt(cell: unknown): number | null {
  const time = cell instanceof Date ? cell.getTime() : typeof cell === 'string' && SAVED_TIME.test(cell) ? Date.parse(cell) : NaN;

  return Number.isNaN(time) ? null : time;
}

/**
 * The table a row's state cells hold, as it was saved: null when they do not hold the table the row
 * is under, which is then nothing this code may move. It is not loaded as a table, so one saved by
 * code too old to be loaded is still known for what it is.
 */
function savedTable(json: string, id: string): Record<string, unknown> | null {
  try {
    const saved: unknown = JSON.parse(json);

    return typeof saved === 'object' && saved !== null && (saved as { id?: unknown }).id === id ? (saved as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What the Archive says of a saved table for whoever looks through it: its name, when it was made and who bought chips at it. */
function describe(saved: Record<string, unknown>): unknown[] {
  const { config, createdAt, members } = saved as { config?: { name?: unknown } | null; createdAt?: unknown; members?: unknown };
  const everyone = (Array.isArray(members) ? members : []) as ({ name?: unknown; buyIn?: unknown } | null)[];
  const players = everyone.flatMap((member) => (member && typeof member.buyIn === 'number' && member.buyIn > 0 ? [String(member.name)] : []));

  const created = new Date(typeof createdAt === 'number' ? createdAt : NaN);

  return [String(config?.name ?? '').slice(0, DESCRIPTION_LENGTH), Number.isNaN(created.getTime()) ? '' : created, players.join(', ').slice(0, DESCRIPTION_LENGTH)];
}

/** A table as its row in the Tables tab tells of it without its state. */
interface Saved extends SavedTable {
  row: number;
}

/** A table on its way to the Archive. */
interface Leaving {
  id: string;
  row: number;
  /** The Archive already has this save of it, from a sweep that got that far and then failed. */
  archived: boolean;
  /** Its row in the Archive. */
  cells: unknown[];
}

const saveOf = (id: unknown, version: unknown) => `${String(id)}:${String(version)}`;

/**
 * One save of a table, told from the first three cells of its row. When it was saved is part of it: a
 * table put back by hand from an older row of the Archive comes to the versions it had before, and
 * those are other saves, which the Archive does not have.
 */
const savedAs = ([id, updated, version]: unknown[]) => `${saveOf(id, version)}:${String(savedAt(updated))}`;

function recordRow({ id, record }: Held & { record: Extract<Recorded, { type: RowOfItsOwn['type'] }> }, table: Denominated, noted: Noted): unknown[] {
  if (record.type === 'ledger') {
    const entry = record.entry;
    const amount = asNumber(entry.amount, table);

    // Amount is what a player paid or was paid, so adding it up for one player gives what they owe. Chips moved
    // between players, a transfer or the high-hand bonus, are no such thing: they show up in that player's
    // cash-out, so they are written beside the column instead, with the other player and Type saying which
    return 'otherId' in entry
      ? [new Date(entry.at), entry.tableId, entry.name, entry.kind, '', entry.playerId, id, amount, entry.otherName, entry.otherId]
      : [new Date(entry.at), entry.tableId, entry.name, entry.kind, amount, entry.playerId, id, '', '', ''];
  }

  const hand = record.record;
  const fitted = hand.summary.length <= SUMMARY_LENGTH ? hand : { ...hand, summary: `…${hand.summary.slice(-SUMMARY_LENGTH)}` };
  let json = JSON.stringify(fitted);

  // The engine keeps a hand's events far shorter than this as well. A record too long for its cell would be
  // refused every time it is tried, so it goes without its events rather than never arriving
  if (json.length > CELL_LENGTH) {
    noted('store copy to Hands', `Hand ${hand.number}'s record was too long for its cell, so it was saved without its events`);
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
  private readonly reports: HeldReports;
  private readonly sheets = new Map<SheetKey, SheetLike>();

  constructor(deps: SheetStoreDeps) {
    this.deps = deps;
    this.reports = new HeldReports(deps.errors);
  }

  transact<T>(tableId: string, fn: (state: TableState | null) => Txn<T>): T {
    return this.locked(() => {
      const found = this.locate(tableId);
      const txn = fn(found ? found.state : null);

      if (txn.save !== null) {
        // A table's version changes with every save, which makes these ids one of a kind
        const fresh = heldOf(txn.effects, saveOf(txn.save.id, txn.save.version), this.kept);

        this.persist(txn.save, txn.at, found ? found.row : null, found ? found.held : [], fresh);
      } else if (found && found.held.length > 0) {
        this.copyOut(found.row, found.held, 'again', found.state);
      }

      return txn.result;
    });
  }

  read(tableId: string): TableState | null {
    const cached = this.deps.cache.get(stateKey(tableId));
    if (cached) {
      return restoreState(cached);
    }

    if (isGone(this.deps.cache.get(peekKey(tableId)))) {
      return null;
    }

    return this.reload(tableId);
  }

  peek(tableId: string): TablePeek | null {
    const cached = this.deps.cache.get(peekKey(tableId));
    if (isGone(cached)) {
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

  putAwayOld(now: number, lastWords: LastWords): void {
    this.reports.after(() => {
      try {
        underLock(this.deps.lock, BUSY, () => this.sweep(now, lastWords), PUT_AWAY_LOCK_WAIT_MS);
      } catch (error) {
        // Whatever was not put away is still in the Tables tab, where the next new table finds it. Giving up on a lock
        // that was taken is what a sweep is meant to do, and no failure
        if (error instanceof StoreBusyError) {
          console.error(error);
        } else {
          this.reports.failed('store put away', error);
        }
      }
    });
  }

  settleIdle(now: number): void {
    this.reports.after(() => {
      try {
        // Asked without the lock, so that a look made lately costs the standings nothing more than this
        if (!this.deps.results || now - this.settled().at < SETTLE_EVERY_MS) {
          return;
        }

        underLock(
          this.deps.lock,
          BUSY,
          () => {
            const tables = this.sheet('tables');

            this.settleResults(tables, this.savedTimes(tables), now, true);
          },
          PUT_AWAY_LOCK_WAIT_MS,
        );
      } catch (error) {
        // As with putting tables away, giving up on a lock that was taken is no failure: the next look does it
        if (error instanceof StoreBusyError) {
          console.error(error);
        } else {
          this.reports.failed('store settle results', error);
        }
      }
    });
  }

  wasPutAway(tableId: string): boolean {
    const known = this.deps.cache.get(peekKey(tableId));
    if (isGone(known)) {
      return known === AWAY;
    }

    // Looked for once more, under the lock: a table that has come to be there since must never be noted as gone
    return this.locked(() => !this.locate(tableId) && this.rememberGone(tableId));
  }

  /** Whether an effect has somewhere to go: the end of a night only when the store was given a place for results. */
  private readonly kept = (effect: Effect): boolean => effect.type !== 'nightEnded' || this.deps.results !== undefined;

  /** What notes a failure at one table. */
  private noter(tableId: string | null): Noted {
    return (where, error) => this.reports.failed(where, error, tableId);
  }

  private locked<T>(work: () => T): T {
    return this.reports.after(() => underLock(this.deps.lock, BUSY, work));
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
        this.rememberGone(tableId);
        return null;
      }

      const settled = found.held.length === 0 || this.copyOut(found.row, found.held, 'again', found.state);
      this.remember(found.state, found.row, settled);

      return found.state;
    });
  }

  private sheet(key: SheetKey): SheetLike {
    const known = this.sheets.get(key);
    if (known) {
      return known;
    }

    const sheet = openTab(this.deps.spreadsheet(), SHEET_NAMES[key], HEADERS[key], true)!;

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
        return { row: hint, ...parseRow(values, this.noter(tableId)) };
      }
    }

    const index = dataRows(sheet, 1).findIndex((row) => String(row[0]) === tableId);
    if (index < 0) {
      return null;
    }

    const row = index + FIRST_DATA_ROW;

    return { row, ...parseRow(rowAt(row), this.noter(tableId)) };
  }

  private persist(state: TableState, at: number, knownRow: number | null, leftOver: Held[], fresh: Held[]): void {
    const held = [...leftOver, ...fresh];
    let row: number;

    try {
      // One write holds the table and the records of what just happened to it, so neither is saved without the other
      row = this.writeTable(state, at, knownRow, held);
      this.deps.flush();
    } catch (error) {
      // Whatever did or didn't reach the sheet, the cache must not keep serving the old table
      this.forget(state.id);
      throw error;
    }

    const settled = held.length === 0 || this.copyOut(row, held, leftOver.length > 0 ? 'again' : 'first', state);

    // The save itself succeeded, so a cache that can't be refreshed is only emptied, not treated as a failure of the request
    try {
      this.remember(state, row, settled);
    } catch (error) {
      this.reports.failed('store cache after save', error, state.id);
      this.forget(state.id);
    }
  }

  private writeTable(state: TableState, at: number, knownRow: number | null, held: Held[]): number {
    const sheet = this.sheet('tables');
    const json = JSON.stringify(state);
    const stateCells = toCells(json, STATE_CHUNKS);

    if (!stateCells) {
      throw new Error(`Table ${state.id} has grown to ${json.length} characters, more than its row can hold`);
    }

    const row = knownRow ?? this.rowForNew(sheet);
    const range = sheet.getRange(row, 1, 1, TABLE_COLUMNS);

    if (knownRow === null) {
      range.setNumberFormats([TABLE_FORMATS]);
    }

    range.setValues([[state.id, new Date(at).toISOString(), String(state.version), ...stateCells, ...heldCells(held, this.noter(state.id))]]);

    return row;
  }

  /**
   * The row a new table takes: the first one that a table put away left empty, so that the tab stops
   * growing, or else the one after the last. Only a row with nothing in a table's cells is taken: one
   * that merely lost its id is somebody's, and is left as it is.
   */
  private rowForNew(sheet: SheetLike): number {
    const ids = dataRows(sheet, 1);
    const empty = ids.findIndex((row) => row[0] === '') + FIRST_DATA_ROW;

    if (empty >= FIRST_DATA_ROW && sheet.getRange(empty, 1, 1, TABLE_COLUMNS).getValues()[0]!.every((cell) => cell === '')) {
      return empty;
    }

    return FIRST_DATA_ROW + ids.length;
  }

  /**
   * Copies the records held in a table's row to their tabs, the table's results among them when a
   * night ended, then takes them off the row. Whatever can't be written stays held and is tried again the next time the row is read, so a
   * failing write costs no record and never holds up the game. Returns whether the row is now clear.
   *
   * A record that may have been tried before is looked for in its tab first (`Attempt`). If that look
   * fails the record waits like any other: late is put right by the next try, twice by nobody.
   */
  private copyOut(row: number, held: Held[], attempt: Attempt, state: TableState): boolean {
    const waiting: Held[] = [];
    const table = state.config;
    const noted = this.noter(state.id);

    for (const kind of RECORD_SHEETS) {
      const mine = held.filter((item) => item.record.type === kind.type);
      if (mine.length === 0) {
        continue;
      }

      try {
        if (kind.type === 'nightEnded') {
          this.deps.results?.write([resultsOf(state)]);
          continue;
        }

        const { sheet, idColumn } = kind;
        const arrived = attempt === 'again' ? this.idsIn(sheet, idColumn) : new Set<string>();
        const fresh = mine.filter((item) => !arrived.has(item.id)) as (Held & { record: Extract<Recorded, { type: RowOfItsOwn['type'] }> })[];

        // The Ledger tab gained the columns for chips moved between players after Sheets were in use. Only such a
        // line fills them, so only then is a tab made before checked for their headers, which keeps that read off every other copy
        if (fresh.some(({ record }) => record.type === 'ledger' && 'otherId' in record.entry)) {
          headBlankColumns(this.sheet(sheet), HEADERS[sheet]);
        }

        this.appendRows(this.sheet(sheet), fresh.map((item) => recordRow(item, table, noted)), kind.formats(table));
        this.deps.flush();
      } catch (error) {
        // Waits in the table's row for the next try
        noted(`store copy to ${kind.tab}`, error);
        waiting.push(...mine);
      }
    }

    if (waiting.length === held.length) {
      return false;
    }

    try {
      this.sheet('tables').getRange(row, HELD_COLUMN, 1, HELD_CHUNKS).setValues([heldCells(waiting, noted)]);
      this.deps.flush();
    } catch (error) {
      // The row still lists what was copied; the retry will find those in their tabs and only clear the list
      noted('store clear copied records', error);

      return false;
    }

    return waiting.length === 0;
  }

  /** The id of every record in a tab: one read of its id column, however long the tab has grown. */
  private idsIn(key: SheetKey, idColumn: number): Set<string> {
    const sheet = this.sheet(key);
    const lastRow = sheet.getLastRow();
    if (lastRow < FIRST_DATA_ROW) {
      return new Set();
    }

    const ids = sheet.getRange(FIRST_DATA_ROW, idColumn, lastRow - FIRST_DATA_ROW + 1, 1).getValues();

    return new Set(ids.map((row) => String(row[0])));
  }

  private appendRows(sheet: SheetLike, rows: unknown[][], formats: string[]): void {
    if (rows.length === 0) {
      return;
    }

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

  /**
   * Moves old tables from the Tables tab to the Archive, under the lock. Each step leaves every table
   * in at least one of the two: a table is written to the Archive, and that write pushed through,
   * before anything of it is taken out of Tables, and its cache entries go before its row does, so the
   * cache never answers for a table the tab no longer has. Its row is emptied, never deleted: no other
   * table's row moves, so no row number remembered for another table is made wrong.
   */
  private sweep(now: number, lastWords: LastWords): void {
    const tables = this.sheet('tables');
    const saved = this.savedTimes(tables);
    const gone = this.putAway(tables, dueToLookAt(saved, now), now, lastWords);

    try {
      this.settleResults(tables, saved.filter((table) => !gone.has(table.id)), now, false);
    } catch (error) {
      this.reports.failed('store settle results', error);
    }
  }

  /** Puts away as many of the tables that are `due` as one sweep may, and gives back the ids of those that are leaving. */
  private putAway(tables: SheetLike, due: Saved[], now: number, lastWords: LastWords): Set<string> {
    if (due.length === 0) {
      return new Set();
    }

    const archive = this.archive(false);
    const kept = archive ? this.archivedSaves(archive) : new Set<string>();
    const leaving: Leaving[] = [];

    for (const candidate of due) {
      if (leaving.length === PUT_AWAY_AT_ONCE) {
        break;
      }

      try {
        const ready = this.readyToLeave(tables, candidate.id, candidate.row, now, lastWords, kept);
        if (ready) {
          leaving.push(ready);
        }
      } catch (error) {
        this.reports.failed('store put away', error, candidate.id);
      }
    }

    const unkept = leaving.filter((table) => !table.archived);
    if (unkept.length > 0) {
      this.appendRows(archive ?? this.archive(true)!, unkept.map((table) => table.cells), ARCHIVE_FORMATS);
      this.deps.flush();
    }

    for (const table of this.whereTheyWere(tables, leaving)) {
      try {
        for (const key of [stateKey(table.id), peekKey(table.id), rowKey(table.id)]) {
          this.deps.cache.remove(key);
        }

        tables.getRange(table.row, 1, 1, TABLE_COLUMNS).setValues([EMPTY_ROW]);
      } catch (error) {
        // Still in both tabs, and finished by a later sweep
        this.reports.failed('store put away', error, table.id);
      }
    }

    if (leaving.length > 0) {
      this.deps.flush();
    }

    return new Set(leaving.map((table) => table.id));
  }

  /**
   * Sees to the results of the tables nobody has changed for a while, as `settleIdle` has it, under the
   * lock. Each table that needs writing is one read of its row and one write of its results, and what
   * is remembered of the look spares the next one both: with nothing new to see to, this is one read of
   * the cache. `asked` says the look was asked for by itself.
   */
  private settleResults(tables: SheetLike, saved: Saved[], now: number, asked: boolean): void {
    const results = this.deps.results;
    if (!results || (!asked && !saved.some((table) => idleLongEnough(table, now)))) {
      return;
    }

    const before = this.settled();
    const after = settleIdle(
      saved,
      now,
      before,
      results,
      (table) => this.loadIdle(tables, table),
      (error, table) => this.reports.failed('store settle results', error, table?.id),
      asked,
    );

    if (after !== before) {
      this.rememberSettled(after);
    }
  }

  /** A table read from its row for its results, or null when the row does not hold a table this code can load: one saved by code too old, or cells someone changed. */
  private loadIdle(tables: SheetLike, table: Saved): TableState | null {
    const values = tables.getRange(table.row, 1, 1, TABLE_COLUMNS).getValues()[0]!;
    const json = stateText(values);

    if (String(values[0]) !== table.id || !savedTable(json, table.id)) {
      return null;
    }

    try {
      return restoreState(json);
    } catch {
      return null;
    }
  }

  /** What is remembered of the tables whose results were seen to. A cache that can't be asked, or holds something else, remembers nothing. */
  private settled(): Settled {
    try {
      const kept = JSON.parse(this.deps.cache.get(SETTLED_KEY) ?? 'null') as Partial<Settled> | null;

      return kept && typeof kept.at === 'number' && kept.seen && kept.failed ? { at: kept.at, seen: kept.seen, failed: kept.failed } : NEVER_SETTLED;
    } catch (error) {
      this.reports.failed('store read settled tables', error);

      return NEVER_SETTLED;
    }
  }

  /** Only a memory: one that can't be kept has the same tables looked at again. */
  private rememberSettled(settled: Settled): void {
    try {
      this.deps.cache.put(SETTLED_KEY, JSON.stringify(settled), CACHE_SECONDS);
    } catch (error) {
      this.reports.failed('store remember settled tables', error);
    }
  }

  /**
   * Those of the tables that are leaving whose rows still name them. The lock keeps the game out of
   * the tab while a sweep runs, but not a person: rows sorted or deleted by hand since they were read
   * would have another table where one of these was, and emptying a row is the one thing a sweep does
   * that cannot be done again. One read, of the cells between the first of the rows and the last.
   */
  private whereTheyWere(tables: SheetLike, leaving: Leaving[]): Leaving[] {
    if (leaving.length === 0) {
      return [];
    }

    const rows = leaving.map((table) => table.row);
    const first = Math.min(...rows);
    const ids = tables.getRange(first, 1, Math.max(...rows) - first + 1, 1).getValues();

    return leaving.filter((table) => String(ids[table.row - first]?.[0]) === table.id);
  }

  /** Every row of the Tables tab that names a table and says when it was last saved, read without its state. */
  private savedTimes(tables: SheetLike): Saved[] {
    return dataRows(tables, 3).flatMap(([id, updated, version], index) => {
      const changedAt = savedAt(updated);
      const save = Number(version);

      // A version that is no number is still told from every real one, and from itself the next time
      return id !== '' && changedAt !== null ? [{ id: String(id), row: FIRST_DATA_ROW + index, changedAt, version: Number.isInteger(save) ? save : -1 }] : [];
    });
  }

  /**
   * Reads an old table's row and gets it ready to go: asks it its last words, and sees every record of
   * it to its tab. Null when it stays where it is this time: the row is not all something this code
   * wrote, or a record of it could not be copied out, which the next sweep tries again.
   */
  private readyToLeave(tables: SheetLike, id: string, row: number, now: number, lastWords: LastWords, kept: Set<string>): Leaving | null {
    const values = tables.getRange(row, 1, 1, TABLE_COLUMNS).getValues()[0]!;
    const json = stateText(values);
    const saved = String(values[0]) === id ? savedTable(json, id) : null;
    const heldAs = values.slice(HELD_COLUMN - 1, HELD_COLUMN - 1 + HELD_CHUNKS);
    const held = heldFrom(fromCells(heldAs), this.noter(id));

    // Whatever is in the cells for waiting records and is not such records would be gone once they are settled
    if (!saved || heldCells(held).some((cell, index) => cell !== heldAs[index])) {
      this.reports.failed('store put away', `Left row ${row} of the Tables tab where it is, since it does not read as the table it names`, id);

      return null;
    }

    const archived = kept.has(savedAs(values));
    let state: TableState | null = null;

    try {
      state = restoreState(json);
    } catch {
      // Saved by code too old to load, or by a newer version than this: put away as it is, with nothing asked of it
    }

    // A table the Archive already has was asked when it got there, by the sweep that could not finish
    const waiting = new Set(held.map((item) => item.id));
    const fresh = state && !archived ? heldOf(lastWordsOf(state, now, lastWords), `${saveOf(id, values[2])}:away`, this.kept).filter((item) => !waiting.has(item.id)) : [];

    if (held.length + fresh.length > 0 && !(state && this.settle(row, held, fresh, state))) {
      return null;
    }

    return { id, row, archived, cells: [...values.slice(0, HELD_COLUMN - 1), ...heldCells([]), ...describe(saved), new Date(now)] };
  }

  /**
   * Sees the records of a table that is leaving to their tabs: those still held in its row, and `fresh`
   * ones, which are held there first, as a save holds them, so that a copy that fails leaves them where
   * the next try finds them. Returns whether none is left waiting.
   */
  private settle(row: number, held: Held[], fresh: Held[], state: TableState): boolean {
    const all = [...held, ...fresh];

    if (fresh.length > 0) {
      this.sheet('tables').getRange(row, HELD_COLUMN, 1, HELD_CHUNKS).setValues([heldCells(all, this.noter(state.id))]);
      this.deps.flush();
    }

    return this.copyOut(row, all, 'again', state);
  }

  /** The Archive tab, which the first table to be put away makes. Until then there is none, which is nothing put away. */
  private archive(create: boolean): SheetLike | null {
    return openTab(this.deps.spreadsheet(), ARCHIVE, ARCHIVE_HEADERS, create);
  }

  /** Every save of a table the Archive holds. A tab left without its headers, as when making it failed halfway, gets them. */
  private archivedSaves(archive: SheetLike): Set<string> {
    const lastRow = archive.getLastRow();
    const rows = lastRow < 1 ? [] : archive.getRange(1, 1, lastRow, 3).getValues();

    if (rows.length === 0 || rows[0]![0] === '') {
      headBlankColumns(archive, ARCHIVE_HEADERS);
    }

    return new Set(rows.slice(1).map(savedAs));
  }

  /**
   * Notes for a while that a table isn't in the Tables tab, and whether that is because it was put
   * away, which it answers. The Archive is asked once and the cache remembers, so a page left open on
   * such a table costs one look, not one with every poll.
   */
  private rememberGone(tableId: string): boolean {
    const archive = this.archive(false);
    const away = archive !== null && dataRows(archive, 1).some((row) => String(row[0]) === tableId);

    // Anything the cache still has of the table has outlived it
    this.forget(tableId);
    this.deps.cache.put(peekKey(tableId), away ? AWAY : MISSING, MISSING_SECONDS);

    return away;
  }
}
