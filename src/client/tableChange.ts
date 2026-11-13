import type { FeedEntry } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';

// Older than this when it reaches the page, a line is something the viewer missed, as while their phone slept, not something happening
const FRESH_MS = 10_000;

/** What a view that has just been put on screen brought with it. */
export interface TableChange {
  /** The table as it was showing until now; null when this is the first the page has seen of it. */
  before: TableView | null;
  view: TableView;
  /**
   * The chat and play-by-play lines that are news: not in the view before, and only moments old.
   * None for the first view, whose lines were all said before the viewer got here.
   */
  feed: FeedEntry[];
}

/**
 * What `view` adds to `before`, the one shown until now, so that whatever reacts to the table hears
 * of each thing once. Views reach the page late, or after the table has been put back to an earlier
 * state; this is the one place that has to know.
 *
 * `now` is the server's time as the page reckons it, which is well past the view's own when the view
 * was slow to arrive. `wentBack` says the table itself returned to an earlier state, so nothing in
 * the view is news.
 */
export function tableChange(before: TableView | null, view: TableView, now: number, wentBack = false): TableChange {
  return { before, view, feed: before && !wentBack ? newLines(before, view, now) : [] };
}

function newLines(before: TableView, view: TableView, now: number): FeedEntry[] {
  // A line is known by its number and its time together: a table put back to an earlier state numbers its next lines like ones it had
  const known = new Map(before.feed.map((entry) => [entry.seq, entry.at]));

  return view.feed.filter((entry) => known.get(entry.seq) !== entry.at && now - entry.at <= FRESH_MS);
}
