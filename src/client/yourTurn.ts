import type { Attention, Call } from './attention.ts';
import type { TableChange } from './tableChange.ts';
import type { TableView } from '../engine/view.ts';

/** The decision the viewer at `seat` is on the clock for, or null while it is someone else's or nobody's. */
function turnOf(view: TableView | null, seat: number | null): number | null {
  const hand = view?.hand;

  return seat !== null && hand?.stage === 'betting' && hand.toAct === seat ? hand.turn : null;
}

/**
 * Gets the viewer's attention when the action reaches them, and lets it go when they act or the turn
 * passes. A turn is known by its decision's number, so two views of one turn call once, and the action
 * leaving and coming back on one street calls again.
 */
export class YourTurn {
  private readonly attention: Attention;
  private standing: { turn: number; call: Call } | null = null;

  constructor(attention: Attention) {
    this.attention = attention;
  }

  /** Called with every view put on screen. */
  see({ before, view, current }: TableChange): void {
    const turn = turnOf(view, view.you.seat);

    if (this.standing && this.standing.turn !== turn) {
      this.end();
    }

    // A turn the viewer already had when the page opened, or that began while they were away, is no news
    if (turn !== null && current && turn !== turnOf(before, before?.you.seat ?? null)) {
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
