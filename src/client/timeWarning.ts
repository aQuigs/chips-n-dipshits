import type { TableView } from '../engine/view.ts';
import { warnAt } from './spoken.ts';

/**
 * Word to a player who cannot see their clock that it is running down: once for each decision, when
 * the seconds left reach the mark for a clock of that length, and never for a clock too short to act
 * on the warning.
 */
export class TimeWarning {
  /** The decision last warned of, by its hand and its number in the hand. */
  private warned: string | null = null;

  /** The whole seconds left to say now, or null. `now` is the server's time as the page reckons it. */
  due(view: TableView, now: number): number | null {
    const hand = view.hand;
    const mine = hand !== null && hand.deadline !== null && (hand.options !== null || hand.canVote || hand.canAnswerChop);
    const mark = warnAt(view.config.actionSeconds);

    if (!mine || mark === null) {
      return null;
    }

    const left = Math.ceil((hand.deadline! - now) / 1000);
    const decision = `${hand.number}.${hand.turn}.${hand.stage}`;

    // Past the mark by more than a moment, the page came to the turn late: the seat says "on the clock", and a figure already stale helps nobody
    if (left > mark || left < mark - 1 || this.warned === decision) {
      return null;
    }

    this.warned = decision;

    return left;
  }
}
