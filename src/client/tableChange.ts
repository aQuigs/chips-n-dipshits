import type { HandEvent } from '../engine/events.ts';
import type { FeedEntry } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';

// Older than this when it reaches the page, a thing is something the viewer missed, as while their phone slept, not something happening
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
  /**
   * What has just happened in the hand on the table: its events past those the view before had, or
   * all of them when the hand began since. None when the view is not `current`.
   */
  events: HandEvent[];
  /**
   * The view shows the table as it is happening, so whatever changed in it is news. False when it is
   * catching the viewer up: the first view, a table that went back, and any view that brought
   * something they missed.
   */
  current: boolean;
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
  if (!before || wentBack) {
    return { before, view, feed: [], events: [], current: false };
  }

  // A line is known by its number and its time together: a table put back to an earlier state numbers its next lines like ones it had
  const known = new Map(before.feed.map((entry) => [entry.seq, entry.at]));
  const lines = view.feed.filter((entry) => known.get(entry.seq) !== entry.at);
  const feed = lines.filter((entry) => now - entry.at <= FRESH_MS);

  // Events carry no time of their own. A line that is already old, or a view that is, says this view
  // holds things the viewer missed, and its events cannot be told apart from those
  const current = feed.length === lines.length && now - view.now <= FRESH_MS;

  return { before, view, feed, events: current ? newEvents(before, view) : [], current };
}

function newEvents(before: TableView, view: TableView): HandEvent[] {
  if (!view.hand) {
    return [];
  }

  // A hand that outgrows what is recorded has its list emptied for good, which leaves nothing past what was had
  const had = before.hand?.number === view.hand.number ? before.hand.events.length : 0;

  return view.hand.events.slice(had);
}
