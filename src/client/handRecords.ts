import type { TableView } from '../engine/view.ts';

/**
 * The number of the last hand on record, 0 before there is one. A hand goes on record when it is
 * cleared from the table, some seconds after its result shows: the one on the table is never there yet.
 */
export function lastOnRecord(view: TableView): number {
  return view.hand ? view.hand.number - 1 : view.handCount;
}
