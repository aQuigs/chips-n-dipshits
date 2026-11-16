import { onTheClock } from '../engine/betting.ts';
import type { TableView } from '../engine/view.ts';
import { warnAt } from './spoken.ts';

/** Seconds as a clock shows them, minutes first: "32s" is also how a player writes three-deuce suited. */
export function clockText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * When the viewer's own clock runs out, as the server tells time: they are on the clock for a bet or
 * for the answer to a chop, at a table that has one. Null otherwise: a pick of how many times to run it
 * is on nobody's clock.
 */
export function ownDeadline(view: TableView): number | null {
  const hand = view.hand;
  const mine = hand !== null && view.you.seat !== null && onTheClock(hand) === view.you.seat;

  return mine && view.config.actionSeconds > 0 ? hand.deadline : null;
}

/**
 * Whether the viewer's own clock is down to the seconds they are warned at (`warnAt`), or under them.
 * `now` is the server's time as the page reckons it.
 */
export function runningOut(view: TableView, now: number): boolean {
  const deadline = ownDeadline(view);
  const mark = warnAt(view.config.actionSeconds);

  return deadline !== null && mark !== null && Math.ceil((deadline - now) / 1000) <= mark;
}
