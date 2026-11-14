import type { EarnedBadge } from '../engine/badges.ts';
import type { HandEvent } from '../engine/events.ts';
import type { FeedEntry, Reaction } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';

// Older than this when it reaches the page, a thing is something the viewer missed, as while their phone slept, not something happening
const FRESH_MS = 10_000;

/**
 * Older than this when it reaches the page, a reaction has had its moment. It reaches the other pages at
 * their next poll, which on Apps Script is two or three seconds after it is made, and is seen for three.
 */
export const REACTION_FRESH_MS = 6000;

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
  /** The table returned to an earlier state: the Sheet was restored, or the viewer's own move, shown early, was taken off again. */
  wentBack: boolean;
  /** The server's time as the page reckons it when the view was put on screen, which is later than the view's own when it was slow to arrive. */
  now: number;
  /**
   * The night has ended and this is the view to say so: the first `current` one that shows an end not
   * already told. What happens for everyone when a night ends hangs off this.
   */
  nightEnded: boolean;
  /** The badges the viewer has earned that this is the first `current` view to show, in the order of the list. */
  earned: EarnedBadge[];
  /** The viewer has come to hold the high hand, and this is the first `current` view to show it. */
  tookHighHand: boolean;
  /**
   * Other players' reactions and throws that are news: not in the view before, and only moments old.
   * The viewer's own are told when they make them (`ShownTable.react`), never again when the server
   * sends them back.
   */
  reactions: Reaction[];
}

/** What is told once, even past a late view: by the first view on time that shows it, and never by a page that opened after it. */
interface Told {
  nightEndedAt: number | null;
  /** How many times the viewer has earned each badge, by its id. */
  badges: Map<string, number>;
  /** The number of the hand the high hand the viewer holds was shown in, or null when they hold none. */
  highHand: number | null;
}

const badgesOf = (view: TableView): EarnedBadge[] => view.tonight.players.find((row) => row.playerId === view.you.id)?.badges ?? [];

/** The hand the high hand the viewer holds was shown in: the next to be paid, which is the night's own until that is paid. */
function heldHighHand(view: TableView): number | null {
  const next = view.tonight.highHand.next;

  return next?.playerIds.includes(view.you.id) ? next.hand : null;
}

/** What a view has to tell of these, all of it. */
function toldIn(view: TableView | null): Told {
  return {
    nightEndedAt: view?.nightEndedAt ?? null,
    badges: new Map(view ? badgesOf(view).map((badge) => [badge.id, badge.times]) : []),
    highHand: view && heldHighHand(view),
  };
}

const newBadges = (view: TableView, told: Told): EarnedBadge[] => badgesOf(view).filter((badge) => badge.times > (told.badges.get(badge.id) ?? 0));

/**
 * What `view` adds to `before`, the one shown until now, so that whatever reacts to the table hears
 * of each thing once. Views reach the page late, or after the table has been put back to an earlier
 * state; this is the one place that has to know.
 *
 * `now` is the server's time as the page reckons it, which is well past the view's own when the view
 * was slow to arrive. `wentBack` says the table itself returned to an earlier state, so nothing in
 * the view is news. `told` is the end of the night, the badges and the high hand already told, which `TableNews`
 * remembers past a view that came late.
 */
export function tableChange(before: TableView | null, view: TableView, now: number, wentBack = false, told = toldIn(before)): TableChange {
  if (!before || wentBack) {
    return { before, view, feed: [], events: [], current: false, wentBack, nightEnded: false, earned: [], tookHighHand: false, reactions: [], now };
  }

  // A line is known by its number and its time together: a table put back to an earlier state numbers its next lines like ones it had
  const known = new Map(before.feed.map((entry) => [entry.seq, entry.at]));
  const lines = view.feed.filter((entry) => known.get(entry.seq) !== entry.at);
  const feed = lines.filter((entry) => now - entry.at <= FRESH_MS);

  // Events carry no time of their own. A line that is already old, or a view that is, says this view
  // holds things the viewer missed, and its events cannot be told apart from those
  const current = feed.length === lines.length && now - view.now <= FRESH_MS;

  // Compared by time, so a night started again and ended again between two views is still news
  const nightEnded = current && view.nightEndedAt !== null && view.nightEndedAt !== told.nightEndedAt;

  const held = heldHighHand(view);
  const tookHighHand = current && held !== null && held !== told.highHand;

  return { before, view, feed, events: current ? newEvents(before, view) : [], current, wentBack, nightEnded, earned: current ? newBadges(view, told) : [], tookHighHand, reactions: newReactions(before, view, now), now };
}

/** A reaction is known by who made it and when: nobody makes two at once. */
const reactionKey = (reaction: Reaction): string => `${reaction.from}@${reaction.at}`;

/**
 * The reactions `view` has that `before` did not, made by someone else, that are still fresh. Each
 * carries its own time, so a late view loses only what has had its moment, and what one view has
 * shown, on time or too late, the next does not show again.
 */
function newReactions(before: TableView, view: TableView, now: number): Reaction[] {
  const known = new Set(before.reactions.map(reactionKey));

  return view.reactions.filter((reaction) => reaction.from !== view.you.id && !known.has(reactionKey(reaction)) && now - reaction.at <= REACTION_FRESH_MS);
}

/**
 * The changes of one table screen, one view after another. The end of the night, the badges earned
 * and the high hand taken are told by the first view on time that shows them, so one that came late passes them on
 * rather than losing them; what the page found already there when it opened, or after the table
 * went back, is never told.
 */
export class TableNews {
  private told: Told | null = null;

  change(before: TableView | null, view: TableView, now: number, wentBack = false): TableChange {
    const change = tableChange(before, view, now, wentBack, this.told ?? toldIn(before));
    if (!before || wentBack || change.current) {
      this.told = toldIn(view);
    }

    return change;
  }
}

/** What has happened in the hand `view` shows since `before` was showing: all of it when the hand began since. */
export function newEvents(before: TableView, view: TableView): HandEvent[] {
  if (!view.hand) {
    return [];
  }

  // A hand that outgrows what is recorded has its list emptied for good, which leaves nothing past what was had
  const had = before.hand?.number === view.hand.number ? before.hand.events.length : 0;

  return view.hand.events.slice(had);
}
