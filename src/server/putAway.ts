/*
 * Putting old tables away: which tables are old enough, how many go at a time, and what a table is
 * asked as it goes. Every store that keeps tables follows these, so the game behaves the same over a
 * Sheet and in memory.
 */
import type { Effect, TableState } from '../engine/index.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a table may go without being saved before it is put away. `PUT_AWAY_MESSAGE` names it in words. */
export const PUT_AWAY_AFTER_MS = 14 * DAY_MS;

/** What someone who asks for a table that was put away is told. */
export const PUT_AWAY_MESSAGE = 'This table was put away after two weeks without play.';

/** How many tables one sweep puts away at most, so that it stays a small part of the request that carries it. */
export const PUT_AWAY_AT_ONCE = 3;

/** How many old tables one sweep looks at: more than it may put away, so that it has others to turn to when it must leave some where they are. */
export const LOOKED_AT_AT_ONCE = 2 * PUT_AWAY_AT_ONCE;

/**
 * Whether a table last saved at `changedAt` has gone unchanged long enough to be put away. Looking at
 * a table saves nothing, so a page left open on a dead table does not keep it.
 */
export function dueToBePutAway(changedAt: number, now: number): boolean {
  return now - changedAt >= PUT_AWAY_AFTER_MS;
}

/**
 * The tables a sweep looks at, in the order it takes them: of those due, the longest unchanged, as
 * many as it may put away, and then the rest of what it may look at from further down the list, from
 * a place that moves with the time of the sweep. A table the store must leave where it is stays among
 * the oldest for good, and a sweep that only ever looked at the oldest would, behind enough of those,
 * never reach another. Tables saved at the same moment go by their id, so every store takes them in
 * the same order.
 */
export function dueToLookAt<T extends { id: string; changedAt: number }>(tables: T[], now: number): T[] {
  const due = tables.filter((table) => dueToBePutAway(table.changedAt, now)).sort((a, b) => a.changedAt - b.changedAt || (a.id < b.id ? -1 : 1));
  const rest = due.slice(PUT_AWAY_AT_ONCE);
  const more = LOOKED_AT_AT_ONCE - PUT_AWAY_AT_ONCE;
  const from = rest.length > more ? now % (rest.length - more + 1) : 0;

  return [...due.slice(0, PUT_AWAY_AT_ONCE), ...rest.slice(from, from + more)];
}

/**
 * Asked of a table as it is put away: handed its last state, it answers with whatever of the table
 * still belongs in the permanent record, as effects. The store keeps those as it keeps the effects of a
 * transaction, so what a tab wants of a table's end reaches it the way the end of a night does.
 */
export type LastWords = (state: TableState, at: number) => Effect[];

/** A table's last words, or none when asking fails: a table is put away whatever becomes of them. */
export function lastWordsOf(state: TableState, at: number, ask: LastWords): Effect[] {
  try {
    return ask(state, at);
  } catch (error) {
    console.error(error);

    return [];
  }
}
