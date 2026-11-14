/*
 * What every store kept in the spreadsheet shares: the parts of the Apps Script services it uses, so
 * it can be run against the stand-ins in tests/fakes.ts, and how it opens a tab and takes the lock.
 */
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

/** The first `columns` cells of every row of a tab below its headers. */
export function dataRows(sheet: SheetLike, columns: number): unknown[][] {
  const last = sheet.getLastRow();

  return last < FIRST_DATA_ROW ? [] : sheet.getRange(FIRST_DATA_ROW, 1, last - FIRST_DATA_ROW + 1, columns).getValues();
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
