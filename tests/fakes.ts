import type { CacheLike, LockLike, RangeLike, SheetLike, SpreadsheetLike } from '../src/gas/sheetStore.ts';

const TEXT_FORMAT = '@';
const DECIMALS_OF_FORMAT = /^0(?:\.(0+))?$/;
const CELL_LIMIT_CHARACTERS = 50_000;
const HALF_AN_EMOJI = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CACHE_VALUE_LIMIT_BYTES = 100_000;
const CACHE_KEY_LIMIT_CHARACTERS = 250;

/**
 * A stand-in for a sheet that copies the behavior a store can get wrong: a string written to a cell
 * that isn't formatted as text is reinterpreted, as a formula if it starts with = or +, or as a number
 * if it looks like one. A cell takes 50,000 characters and no more, and half an emoji does not survive
 * being stored. A number shows only as many decimals as its cell's format has.
 */
export class FakeSheet implements SheetLike {
  cells: unknown[][] = [];
  formats: string[][] = [];
  reads = 0;
  private writesAllowed = Infinity;

  /** Makes writes fail, the way the service now and then does, once `count` more have gone through. */
  refuseWritesAfter(count: number): void {
    this.writesAllowed = count;
  }

  acceptWrites(): void {
    this.writesAllowed = Infinity;
  }

  getLastRow(): number {
    for (let row = this.cells.length - 1; row >= 0; row--) {
      if ((this.cells[row] ?? []).some((cell) => cell !== '' && cell !== undefined)) {
        return row + 1;
      }
    }

    return 0;
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
        this.reads += 1;

        return Array.from({ length: numRows }, (_line, i) =>
          Array.from({ length: numColumns }, (_cell, j) => this.cells[row - 1 + i]?.[column - 1 + j] ?? ''),
        );
      },

      setValues: (values: unknown[][]): void => {
        if (this.writesAllowed <= 0) {
          throw new Error('Service Spreadsheets failed while accessing the document');
        }

        this.writesAllowed -= 1;

        if (values.flat().some((value) => typeof value === 'string' && value.length > CELL_LIMIT_CHARACTERS)) {
          throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
        }

        each(values, (r, c, i, j) => {
          (this.cells[r] ??= [])[c] = this.interpret(values[i]![j], this.formats[r]?.[c]);
        });
      },

      setNumberFormats: (formats: string[][]): void => {
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
    this.cells.splice(row - 1, 1);
    this.formats.splice(row - 1, 1);
  }

  private interpret(value: unknown, format: string | undefined): unknown {
    if (typeof value !== 'string') {
      return value;
    }

    if (format === TEXT_FORMAT) {
      return value.replace(HALF_AN_EMOJI, '\uFFFD');
    }

    if (/^[=+]/.test(value)) {
      return '#ERROR!';
    }

    return value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
  }
}

export class FakeSpreadsheet implements SpreadsheetLike {
  sheets = new Map<string, FakeSheet>();

  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name: string): FakeSheet {
    const sheet = new FakeSheet();
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

  get(key: string): string | null {
    if (key.length > CACHE_KEY_LIMIT_CHARACTERS) {
      throw new Error('Argument too large: key');
    }

    return this.entries.get(key) ?? null;
  }

  put(key: string, value: string, expirationInSeconds: number): void {
    this.putAll({ [key]: value }, expirationInSeconds);
  }

  putAll(values: Record<string, string>, expirationInSeconds: number): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('The cache is unavailable');
    }

    for (const [key, value] of Object.entries(values)) {
      if (Buffer.byteLength(value, 'utf8') > CACHE_VALUE_LIMIT_BYTES) {
        throw new Error('Argument too large: value');
      }

      this.entries.set(key, value);
      this.seconds.set(key, expirationInSeconds);
    }
  }

  remove(key: string): void {
    this.entries.delete(key);
  }
}

/** A lock that fails loudly on the mistakes that matter: taking it twice, or never letting it go. */
export class FakeLock implements LockLike {
  held = false;
  busy = false;
  acquisitions = 0;

  waitLock(): void {
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
