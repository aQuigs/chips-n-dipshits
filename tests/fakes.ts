import type { CacheLike, LockLike, RangeLike, SheetLike, SpreadsheetLike } from '../src/gas/sheetStore.ts';

const TEXT_FORMAT = '@';
const CACHE_VALUE_LIMIT_BYTES = 100_000;

/**
 * A stand-in for a sheet that copies the behavior a store can get wrong: a string written to a cell
 * that isn't formatted as text is reinterpreted, as a formula if it starts with = or +, or as a number
 * if it looks like one.
 */
export class FakeSheet implements SheetLike {
  cells: unknown[][] = [];
  formats: string[][] = [];
  reads = 0;

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

  deleteRow(row: number): void {
    this.cells.splice(row - 1, 1);
    this.formats.splice(row - 1, 1);
  }

  private interpret(value: unknown, format: string | undefined): unknown {
    if (typeof value !== 'string' || format === TEXT_FORMAT) {
      return value;
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
  failNextWrite = false;

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  put(key: string, value: string): void {
    this.putAll({ [key]: value });
  }

  putAll(values: Record<string, string>): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('The cache is unavailable');
    }

    for (const [key, value] of Object.entries(values)) {
      if (Buffer.byteLength(value, 'utf8') > CACHE_VALUE_LIMIT_BYTES) {
        throw new Error('Argument too large: value');
      }

      this.entries.set(key, value);
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
