import type { Attention, Call } from './attention.ts';
import type { TableChange } from './tableChange.ts';
import { onTheClock } from '../engine/betting.ts';
import type { TableView } from '../engine/view.ts';

/**
 * The decision the viewer at `seat` is on the clock for, a bet or the answer to a chop, or null while it is someone else's or nobody's.
 * The number is the hand's own for the decision, and the one way the page tells one turn from another.
 */
export function turnOf(view: TableView | null, seat: number | null): number | null {
  const hand = view?.hand;

  return seat !== null && hand && onTheClock(hand) === seat ? hand.turn : null;
}

/**
 * Gets the viewer's attention when the action reaches them, and lets it go when they act or the turn
 * passes. A turn is known by its decision's number, so two views of one turn call once, and the action
 * leaving and coming back on one street calls again. A turn first shown by a view that arrived late is
 * called by the next view that is on time and still shows it, since that is often the one slow answer.
 */
export class YourTurn {
  private readonly attention: Attention;
  private standing: { turn: number; call: Call } | null = null;
  /** The turn already called, or already the viewer's when the page opened or the table went back. */
  private settled: number | null = null;

  constructor(attention: Attention) {
    this.attention = attention;
  }

  /** Called with every view put on screen. */
  see({ before, view, current, wentBack }: TableChange): void {
    const turn = turnOf(view, view.you.seat);

    if (this.standing && this.standing.turn !== turn) {
      this.end();
    }

    if (!before || wentBack) {
      this.settled = turn;
    } else if (turn !== null && current && turn !== this.settled) {
      this.settled = turn;
      this.standing = { turn, call: { why: 'turn', table: { id: view.id, name: view.config.name } } };
      this.attention.call(this.standing.call);
    }
  }

  /** Takes back whatever still shows for a turn that stands, as when the table is left. */
  end(): void {
    if (this.standing) {
      this.attention.end(this.standing.call);
      this.standing = null;
    }
  }
}
