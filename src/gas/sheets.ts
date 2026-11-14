/*
 * What every store kept in the spreadsheet shares: the parts of the Apps Script services it uses, so
 * it can be run against the stand-ins in tests/fakes.ts, how it opens a tab and takes the lock, and how
 * it reports what it carries on through.
 */
import type { Unit } from '../engine/index.ts';
import { NOWHERE } from '../server/errorLog.ts';
import type { ErrorLog, Failure } from '../server/errorLog.ts';
import { StoreBusyError } from '../server/store.ts';

export interface RangeLike {
  getValues(): unknown[][];
  setValues(values: unknown[][]): unknown;
  setNumberFormats(formats: string[][]): unknown;
}

export interface SheetLike {
  getLastRow(): number;
  getMaxRows(): number;
  getRange(row: number, column: number, numRows: number, numColumns: number): RangeLike;
  deleteRow(rowPosition: number): unknown;
  deleteRows(rowPosition: number, howMany: number): unknown;
  /** Adds a row below the last one with content. Google makes it safe against other appends at the same moment, without the lock. */
  appendRow(rowContents: unknown[]): unknown;
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

export const TEXT = '@';
export const TIMESTAMP = 'yyyy-mm-dd hh:mm:ss';
export const WHOLE_NUMBER = '0';
export const FIRST_DATA_ROW = 2;

/** An amount is written as its table writes it, 1.50 for 150 cents, and as a number so the column can be added up. */
export const AMOUNT: Record<Unit, string> = { chips: WHOLE_NUMBER, cents: '0.00' };

const LOCK_WAIT_MS = 20_000;

/**
 * Runs `work` holding the script lock, which every write to the spreadsheet needs. `busy` is what a
 * caller who couldn't get it is told. `waitMs` is how long to wait for it: less than usual for work
 * that can as well be left for another time.
 */
export function underLock<T>(lock: LockLike, busy: string, work: () => T, waitMs = LOCK_WAIT_MS): T {
  try {
    lock.waitLock(waitMs);
  } catch {
    throw new StoreBusyError(busy);
  }

  try {
    return work();
  } finally {
    lock.releaseLock();
  }
}

/**
 * What a store reports of the failures it carries on through. Apps Script's log is told at once, and
 * the error log once the lock is let go, so that reporting never keeps anyone waiting for it.
 */
export class HeldReports {
  private readonly errors: ErrorLog;
  private held: Failure[] = [];

  constructor(errors: ErrorLog = NOWHERE) {
    this.errors = errors;
  }

  failed(where: string, error: unknown, tableId: string | null = null): void {
    console.error(where, error);
    this.held.push({ where, error, tableId });
  }

  /** Does `work`, which may take the lock, and then reports what was held, whether it finished or not. */
  after<T>(work: () => T): T {
    try {
      return work();
    } finally {
      const held = this.held;
      this.held = [];

      for (const failure of held) {
        this.errors.report(failure);
      }
    }
  }
}

/** The first `columns` cells of every row of a tab below its headers. */
export function dataRows(sheet: SheetLike, columns: number): unknown[][] {
  const last = sheet.getLastRow();

  return last < FIRST_DATA_ROW ? [] : sheet.getRange(FIRST_DATA_ROW, 1, last - FIRST_DATA_ROW + 1, columns).getValues();
}

/** The first row below the headers that none of `rows` takes, for a tab that fills the rows cleared by hand before it grows. */
export function freeRow(rows: readonly { row: number }[]): number {
  const taken = new Set(rows.map(({ row }) => row));
  let row = FIRST_DATA_ROW;

  while (taken.has(row)) {
    row += 1;
  }

  return row;
}

/**
 * A tab by its name. One that isn't there is made, with its headers, only when `create` says so,
 * which must be under the lock but for the Errors tab; otherwise it is null. A Sheet made before a tab was thought of gets it
 * the first time something is written to it. With `formats`, one for each header, every row the new
 * tab has is formatted by them, for rows that are appended rather than formatted as they are written.
 */
export function openTab(spreadsheet: SpreadsheetLike, name: string, headers: string[], create: boolean, formats?: string[]): SheetLike | null {
  const found = spreadsheet.getSheetByName(name);
  if (found || !create) {
    return found;
  }

  const made = spreadsheet.insertSheet(name);

  if (formats) {
    const rows = made.getMaxRows();
    made.getRange(1, 1, rows, formats.length).setNumberFormats(Array.from({ length: rows }, () => formats));
  }

  made.getRange(1, 1, 1, headers.length).setValues([headers]);

  return made;
}
