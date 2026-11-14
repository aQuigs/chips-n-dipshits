import type { HandEvent } from '../engine/events.ts';
import type { Command } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';
import { isTurnMove, predict } from './prediction.ts';
import type { TurnMove } from './prediction.ts';
import { newEvents } from './tableChange.ts';
import type { TableChange } from './tableChange.ts';
import { turnOf } from './yourTurn.ts';

/**
 * How long a move may wait for its answer before the page marks it as not confirmed yet. Apps Script
 * answers nine moves in ten within three seconds, so the mark is for the one that is truly late.
 */
export const UNCONFIRMED_AFTER_MS = 4000;

interface Pending {
  /**
   * The move as the page shows it played, with the decision it answers by the number the hand gave it.
   * Null for a move the page cannot play out, a run-it-twice vote or a kind of move added since: of
   * that one it shows only that it is out.
   */
  played: { move: TurnMove; turn: number } | null;
  sentAt: number;
  /** The request got no answer, so the table is being asked what became of the move. */
  unanswered: boolean;
}

const sameEvent = (a: HandEvent | undefined, b: HandEvent | undefined) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/**
 * The player's own move, shown from the moment it is made until the server is seen to have dealt with
 * it. While it stands, every view that still has the same decision open is shown with the move played
 * on it (`predict`), so a view from before the server heard the move never puts the table back. The
 * first view in which that decision is no longer open ends it, whichever request brought the view and
 * whatever it says: from then on the server's word is what shows. A move the server refused, or that
 * turns out never to have reached it, is taken off again with `drop`.
 *
 * A decision is known by the number the hand gives it (`turnOf`), as it is to whatever announces a turn.
 * One move stands at a time, as one is sent at a time.
 *
 * A move the page cannot play out is kept too, as `sent` and no more: nothing of the table changes for
 * it, no view ends it, and it stands until it is dropped. A new kind of move gets that for nothing, and
 * shows more once `predict` knows it.
 */
export class PendingMove {
  private pending: Pending | null = null;

  /** Takes up a move the player made on `view`, as it goes out. Says whether it shows as played: a move of the turn that the view offers. */
  begin(move: Command, view: TableView, now: number): boolean {
    const turn = turnOf(view, view.you.seat);
    const played = isTurnMove(move) && turn !== null && predict(view, move) ? { move, turn } : null;

    this.pending = { played, sentAt: now, unanswered: false };

    return played !== null;
  }

  /** How the move that is out shows: as played, or only as sent. Null when none is out, or the server has been seen to deal with it. */
  get out(): 'played' | 'sent' | null {
    return this.pending && (this.pending.played ? 'played' : 'sent');
  }

  /** `view` with the move played on it while the move stands and the view still has its decision open; otherwise the view itself. */
  shown(view: TableView): TableView {
    const played = this.pending?.played;

    return played && turnOf(view, view.you.seat) === played.turn ? (predict(view, played.move) ?? view) : view;
  }

  /**
   * What of `change` is news to a page that has been showing the move. Call for every view from the
   * server, before it is drawn. The view before is the one that was on screen, with the move on it.
   * A view that still has the decision open goes on with the move on it. One that does not ends the
   * move, and what it tells starts after the move itself where the server played it as predicted, so
   * nothing is moved, heard or announced twice.
   */
  see(change: TableChange): TableChange {
    if (!this.pending?.played) {
      return change;
    }

    const before = change.before && this.shown(change.before);
    const view = this.shown(change.view);

    if (view !== change.view) {
      return { ...change, before, view };
    }

    this.pending = null;

    const [predicted] = before && change.before ? newEvents(change.before, before) : [];
    const events = sameEvent(predicted, change.events[0]) ? change.events.slice(1) : change.events;

    return { ...change, before, events };
  }

  /** The request for the move got no answer. Says whether that is news. */
  unanswered(): boolean {
    const news = this.pending !== null && !this.pending.unanswered;

    if (this.pending) {
      this.pending.unanswered = true;
    }

    return news;
  }

  /** Whether a move shows as played with no word from the server for so long, or after a request that failed, that the page should say so. */
  unconfirmed(now: number): boolean {
    const pending = this.pending;

    return pending?.played != null && (pending.unanswered || now - pending.sentAt >= UNCONFIRMED_AFTER_MS);
  }

  /** Lets go of the move: it was not played, or the page showed nothing of it. Says how it stood; null when none did. */
  drop(): { played: boolean; unanswered: boolean } | null {
    const pending = this.pending;

    this.pending = null;

    return pending && { played: pending.played !== null, unanswered: pending.unanswered };
  }
}
