import { nextDeadline, upgradeState } from '../engine/index.ts';
import type { Effect, HandRecord, TableState } from '../engine/index.ts';
import type { LastWords } from './putAway.ts';

/** Enough about a table to tell whether a waiting player has anything new to fetch. */
export interface TablePeek {
  version: number;
  /** When the table next changes by itself. */
  wakeAt: number | null;
}

/**
 * The outcome of one exclusive read-modify-write: the state to persist, or null to leave the table as
 * it was. A save says when it was made, by the clock the game is played on, which is what a table's
 * age is counted from.
 */
export type Txn<T> = {
  /** Ledger entries and finished hands to append to the permanent record. */
  effects: Effect[];
  result: T;
} & ({ save: TableState; at: number } | { save: null });

/** Where tables live. Implementations decide the database, the locking and any caching. */
export interface TableStore {
  /**
   * Runs `fn` with the latest saved state of a table (null if there is none) while nothing else can
   * change it, then persists what `fn` returns. If `fn` throws, nothing is saved.
   */
  transact<T>(tableId: string, fn: (state: TableState | null) => Txn<T>): T;

  /** The table as last saved. May be served from a cache. */
  read(tableId: string): TableState | null;

  /** A cheap look at a table, for callers that check often. Null if there is no such table. */
  peek(tableId: string): TablePeek | null;

  /** The latest finished hands of a table, oldest first. */
  recentHands(tableId: string, limit: number): HandRecord[];

  /**
   * Puts away up to `PUT_AWAY_AT_ONCE` of the tables `dueToLookAt` gives at `now`: from then on the
   * store has no such table, only the knowledge that it was put away. Each is asked its `lastWords`
   * before it goes, and their effects are kept like a transaction's. Housekeeping: it never throws,
   * and what it could not do waits for the next call.
   */
  putAwayOld(now: number, lastWords: LastWords): void;

  /** Whether a table the store does not have was put away, rather than never having been there. */
  wasPutAway(tableId: string): boolean;
}

/** The store could not get exclusive access to a table in time. The request is safe to retry. */
export class StoreBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreBusyError';
  }
}

export function peekOf(state: TableState): TablePeek {
  return { version: state.version, wakeAt: nextDeadline(state) };
}

/** Turns saved JSON back into a table, refusing a layout this code doesn't know how to read. */
export function restoreState(json: string): TableState {
  return upgradeState(JSON.parse(json) as TableState);
}
