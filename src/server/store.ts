import { nextDeadline, STATE_SCHEMA } from '../engine/index.ts';
import type { Effect, HandRecord, TableState } from '../engine/index.ts';

/** Enough about a table to tell whether a waiting player has anything new to fetch. */
export interface TablePeek {
  version: number;
  /** When the table next changes by itself. */
  wakeAt: number | null;
}

/** The outcome of one exclusive read-modify-write. */
export interface Txn<T> {
  /** The state to persist, or null to leave the table as it was. */
  save: TableState | null;
  /** Ledger entries and finished hands to append to the permanent record. */
  effects: Effect[];
  result: T;
}

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
  const state = JSON.parse(json) as TableState;

  if (state.schema !== STATE_SCHEMA) {
    throw new Error(`Table ${state.id} was saved with schema ${state.schema}, but this code reads schema ${STATE_SCHEMA}`);
  }

  return state;
}
