import type { CacheLike, LockLike, RangeLike, SheetLike, SpreadsheetLike } from '../src/gas/sheets.ts';

const TEXT_FORMAT = '@';
const DECIMALS_OF_FORMAT = /^0(?:\.(0+))?$/;
const CELL_LIMIT_CHARACTERS = 50_000;
const HALF_AN_EMOJI = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CACHE_VALUE_LIMIT_BYTES = 100_000;
const CACHE_KEY_LIMIT_CHARACTERS = 250;

// The rows a tab Google makes starts with
const NEW_TAB_ROWS = 1000;

/**
 * Every call a store makes to the stand-ins that share one of these, in order, by name, such as
 * `Tables.setValues` or `cache.remove`. It can make one of them fail, to act out the service giving up
 * at that very step. A call that fails has done nothing; what was done before it stays done.
 */
export class Calls {
  made: string[] = [];
  private failing = 0;

  /** Makes the nth call from now fail, once. */
  failNth(nth: number): void {
    this.failing = this.made.length + nth;
  }

  note(name: string): void {
    this.made.push(name);

    if (this.made.length === this.failing) {
      throw new Error(`Service failed at ${name}`);
    }
  }

  /** How many calls were made whose name ends as given, such as `.getValues`. */
  count(ending: string): number {
    return this.made.filter((name) => name.endsWith(ending)).length;
  }
}

/**
 * A stand-in for a sheet that copies the behavior a store can get wrong: a string written to a cell
 * that isn't formatted as text is reinterpreted, as a formula if it starts with = or +, or as a number
 * if it looks like one. A cell takes 50,000 characters and no more, and half an emoji does not survive
 * being stored. A number shows only as many decimals as its cell's format has. Given a lock, it refuses
 * a write made without holding it, since the store keeps the cache in step with the sheet only that way.
 * Given a row limit, it refuses a write below it. Given a text limit, it refuses longer text in any cell
 * below the headers. A leading apostrophe makes the rest of a string text in a cell that isn't formatted
 * as text, and stays in one that is. A tab that is written without the lock by design (`lockFree`) takes
 * any write without it.
 */
export class FakeSheet implements SheetLike {
  cells: unknown[][] = [];
  formats: string[][] = [];
  reads = 0;
  /** The rows the tab has, written to or not, which deleting rows takes away from and appending past adds to. */
  maxRows = NEW_TAB_ROWS;
  private writesAllowed = Infinity;
  private readsAllowed = Infinity;
  private readonly lock: FakeLock | null;
  private readonly rowLimit: number;
  private readonly calls: Calls | null;
  private readonly name: string;
  private readonly lockFree: boolean;
  private readonly textLimit: number;

  /**
   * `rowLimit` is the most rows, headers included, the store may ever write to. `calls` is told of every
   * call, under the tab's `name`. `textLimit` is the most characters the store may write to a cell below the headers.
   */
  constructor(lock: FakeLock | null = null, rowLimit = Infinity, calls: Calls | null = null, name = 'Sheet', lockFree = false, textLimit = Infinity) {
    this.lock = lock;
    this.rowLimit = rowLimit;
    this.calls = calls;
    this.name = name;
    this.lockFree = lockFree;
    this.textLimit = textLimit;
  }

  private note(call: string): void {
    this.calls?.note(`${this.name}.${call}`);
  }

  /** Makes writes fail, the way the service now and then does, once `count` more have gone through. */
  refuseWritesAfter(count: number): void {
    this.writesAllowed = count;
  }

  acceptWrites(): void {
    this.writesAllowed = Infinity;
  }

  /** Makes reads of the tab's cells fail, as the service does when it cannot reach the document, once `count` more have gone through. */
  refuseReadsAfter(count: number): void {
    this.readsAllowed = count;
  }

  acceptReads(): void {
    this.readsAllowed = Infinity;
  }

  getLastRow(): number {
    this.note('getLastRow');

    return this.lastRowWithContent();
  }

  getMaxRows(): number {
    this.note('getMaxRows');

    return this.maxRows;
  }

  getRange(row: number, column: number, numRows: number, numColumns: number): RangeLike {
    if (row < 1 || column < 1 || numRows < 1 || numColumns < 1) {
      throw new Error(`Bad range ${row},${column} ${numRows}x${numColumns}`);
    }

    const each = (grid: unknown[][], visit: (r: number, c: number, i: number, j: number) => void): void => {
      if (grid.length !== numRows || grid.some((line) => line.length !== numColumns)) {
        throw new Error(`The data does not match the ${numRows}x${numColumns} range`);
      }

      for (let i = 0; i < numRows; i++) {
        for (let j = 0; j < numColumns; j++) {
          visit(row - 1 + i, column - 1 + j, i, j);
        }
      }
    };

    return {
      getValues: (): unknown[][] => {
        this.note('getValues');

        if (this.readsAllowed <= 0) {
          throw new Error('Service Spreadsheets failed while accessing the document');
        }

        this.readsAllowed -= 1;
        this.reads += 1;

        return Array.from({ length: numRows }, (_line, i) =>
          Array.from({ length: numColumns }, (_cell, j) => this.cells[row - 1 + i]?.[column - 1 + j] ?? ''),
        );
      },

      setValues: (values: unknown[][]): void => {
        this.note('setValues');
        this.mustBeWritable(row - 1 + numRows, values.flat());

        if (values.some((line, i) => row + i > 1 && line.some((value) => typeof value === 'string' && value.length > this.textLimit))) {
          throw new Error(`Text longer than the ${this.textLimit} characters a cell of this tab may hold`);
        }

        each(values, (r, c, i, j) => {
          (this.cells[r] ??= [])[c] = this.interpret(values[i]![j], this.formats[r]?.[c]);
        });
        this.maxRows = Math.max(this.maxRows, row - 1 + numRows);
      },

      setNumberFormats: (formats: string[][]): void => {
        this.note('setNumberFormats');

        each(formats, (r, c, i, j) => {
          (this.formats[r] ??= [])[c] = formats[i]![j]!;
        });
      },
    };
  }

  /**
   * A cell as someone looking at the sheet reads it. A number is drawn with the decimals its cell's
   * format gives it, so 1.5 in a cell formatted for whole numbers reads 2.
   */
  shown(row: number, column: number): string {
    const value = this.cells[row - 1]?.[column - 1] ?? '';
    const decimals = DECIMALS_OF_FORMAT.exec(this.formats[row - 1]?.[column - 1] ?? '');

    return typeof value === 'number' && decimals ? value.toFixed(decimals[1]?.length ?? 0) : String(value);
  }

  deleteRow(row: number): void {
    this.note('deleteRow');
    this.mustHoldLock();
    this.cells.splice(row - 1, 1);
    this.formats.splice(row - 1, 1);
    this.maxRows -= 1;
  }

  deleteRows(row: number, howMany: number): void {
    this.note('deleteRows');
    this.mustHoldLock();

    if (row < 1 || howMany < 1 || row - 1 + howMany > this.maxRows) {
      throw new Error(`Bad rows to delete: ${howMany} from ${row}`);
    }

    this.cells.splice(row - 1, howMany);
    this.formats.splice(row - 1, howMany);
    this.maxRows -= howMany;
  }

  /** As Google does: below the last row with content, in a row of its own however many come at once, adding a row to the tab when it is full. */
  appendRow(values: unknown[]): void {
    this.note('appendRow');

    const row = this.lastRowWithContent();
    this.mustBeWritable(row + 1, values);

    this.cells[row] = values.map((value, column) => this.interpret(value, this.formats[row]?.[column]));
    this.maxRows = Math.max(this.maxRows, row + 1);
  }

  private lastRowWithContent(): number {
    for (let row = this.cells.length - 1; row >= 0; row--) {
      if ((this.cells[row] ?? []).some((cell) => cell !== '' && cell !== undefined)) {
        return row + 1;
      }
    }

    return 0;
  }

  private mustBeWritable(lastRow: number, values: unknown[]): void {
    this.mustHoldLock();

    if (lastRow > this.rowLimit) {
      throw new Error(`A write to row ${lastRow} of a tab that may have ${this.rowLimit} rows`);
    }

    if (this.writesAllowed <= 0) {
      throw new Error('Service Spreadsheets failed while accessing the document');
    }

    this.writesAllowed -= 1;

    if (values.some((value) => typeof value === 'string' && value.length > CELL_LIMIT_CHARACTERS)) {
      throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
    }
  }

  private mustHoldLock(): void {
    if (this.lock && !this.lock.held && !this.lockFree) {
      throw new Error('A write to the sheet without holding the script lock');
    }
  }

  private interpret(value: unknown, format: string | undefined): unknown {
    if (typeof value !== 'string') {
      return value;
    }

    if (format === TEXT_FORMAT) {
      return value.replace(HALF_AN_EMOJI, '\uFFFD');
    }

    if (value.startsWith("'")) {
      return value.slice(1).replace(HALF_AN_EMOJI, '\uFFFD');
    }

    if (/^[=+]/.test(value)) {
      return '#ERROR!';
    }

    return value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
  }
}

export class FakeSpreadsheet implements SpreadsheetLike {
  sheets = new Map<string, FakeSheet>();
  private readonly lock: FakeLock | null;
  private readonly rowLimits: Record<string, number>;
  private readonly calls: Calls | null;
  private readonly lockFree: Set<string>;
  private readonly textLimits: Record<string, number>;

  /**
   * With a lock, every sheet in it refuses writes made without holding it, but for the tabs named in
   * `lockFree`, which are made and written without it by design. `rowLimits` caps the rows of the tabs
   * it names, and `textLimits` the text in each of their cells below the headers. `calls` is told of
   * every call to it and to its tabs.
   */
  constructor(lock: FakeLock | null = null, rowLimits: Record<string, number> = {}, calls: Calls | null = null, lockFree: string[] = [], textLimits: Record<string, number> = {}) {
    this.lock = lock;
    this.rowLimits = rowLimits;
    this.calls = calls;
    this.lockFree = new Set(lockFree);
    this.textLimits = textLimits;
  }

  getSheetByName(name: string): FakeSheet | null {
    this.calls?.note('spreadsheet.getSheetByName');

    return this.sheets.get(name) ?? null;
  }

  insertSheet(name: string): FakeSheet {
    this.calls?.note('spreadsheet.insertSheet');

    if (this.lock && !this.lock.held && !this.lockFree.has(name)) {
      throw new Error('A tab made without holding the script lock');
    }

    if (this.sheets.has(name)) {
      throw new Error(`A sheet with the name "${name}" already exists. Please enter another name.`);
    }

    const sheet = new FakeSheet(this.lock, this.rowLimits[name], this.calls, name, this.lockFree.has(name), this.textLimits[name]);
    this.sheets.set(name, sheet);

    return sheet;
  }
}

/** A cache that refuses oversized values the way the real one does, and can be emptied to act out an eviction. */
export class FakeCache implements CacheLike {
  entries = new Map<string, string>();
  /** How long each key was last asked to be kept. Nothing expires by itself; a test empties `entries` to act that out. */
  seconds = new Map<string, number>();
  failNextWrite = false;
  private readonly calls: Calls | null;

  constructor(calls: Calls | null = null) {
    this.calls = calls;
  }

  get(key: string): string | null {
    this.calls?.note('cache.get');
    this.checkKey(key);

    return this.entries.get(key) ?? null;
  }

  put(key: string, value: string, expirationInSeconds: number): void {
    this.putAll({ [key]: value }, expirationInSeconds);
  }

  putAll(values: Record<string, string>, expirationInSeconds: number): void {
    this.calls?.note('cache.put');

    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('The cache is unavailable');
    }

    for (const [key, value] of Object.entries(values)) {
      this.checkKey(key);

      if (Buffer.byteLength(value, 'utf8') > CACHE_VALUE_LIMIT_BYTES) {
        throw new Error('Argument too large: value');
      }

      this.entries.set(key, value);
      this.seconds.set(key, expirationInSeconds);
    }
  }

  remove(key: string): void {
    this.calls?.note('cache.remove');
    this.checkKey(key);
    this.entries.delete(key);
  }

  private checkKey(key: string): void {
    if (key.length > CACHE_KEY_LIMIT_CHARACTERS) {
      throw new Error('Argument too large: key');
    }
  }
}

/** A lock that fails loudly on the mistakes that matter: taking it twice, or never letting it go. */
export class FakeLock implements LockLike {
  held = false;
  busy = false;
  acquisitions = 0;
  /** How long each caller was prepared to wait for it, in the order they asked. */
  waits: number[] = [];

  waitLock(timeoutInMillis = 0): void {
    this.waits.push(timeoutInMillis);

    if (this.busy) {
      throw new Error('Lock timeout: another process was holding the lock for too long.');
    }

    if (this.held) {
      throw new Error('The lock was requested while already held');
    }

    this.held = true;
    this.acquisitions += 1;
  }

  releaseLock(): void {
    this.held = false;
  }
}
