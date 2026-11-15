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

/** Whether `view` puts its viewer on the clock for a decision that the view before it did not show as theirs. */
export function turnArrived(before: TableView | null, view: TableView): boolean {
  const turn = turnOf(view, view.you.seat);

  return turn !== null && turn !== turnOf(before, before?.you.seat ?? null);
}

/**
 * Tells a turn that is news from one the viewer already knows of. A turn is known by its decision's
 * number, so two views of one turn are told once, and the action leaving and coming back on one street
 * is told again. A turn first shown by a view that arrived late is told by the next view that is on
 * time and still shows it, since that is often the one slow answer.
 */
export class NewTurns {
  /** The turn already told, or already the viewer's when the page opened or the table went back. */
  private settled: number | null = null;

  /** The decision this view is the one to tell the viewer of, or null. Called with every view put on screen. */
  take({ before, view, current, wentBack }: TableChange): number | null {
    const turn = turnOf(view, view.you.seat);

    if (!before || wentBack) {
      this.settled = turn;

      return null;
    }

    if (turn === null || !current || turn === this.settled) {
      return null;
    }

    this.settled = turn;

    return turn;
  }
}

/**
 * Gets the viewer's attention when the action reaches them, and lets it go when they act or the turn
 * passes: once for each turn that is news (`NewTurns`).
 */
export class YourTurn {
  private readonly attention: Attention;
  private readonly turns = new NewTurns();
  private standing: { turn: number; call: Call } | null = null;

  constructor(attention: Attention) {
    this.attention = attention;
  }

  /** Called with every view put on screen. */
  see(change: TableChange): void {
    const { view } = change;

    if (this.standing && this.standing.turn !== turnOf(view, view.you.seat)) {
      this.end();
    }

    const turn = this.turns.take(change);

    if (turn !== null) {
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
