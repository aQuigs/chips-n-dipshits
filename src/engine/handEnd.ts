/*
 * The end of a hand: everything that happens once a finished hand has been taken off the table. It is
 * one list, run in order from one place, so that whatever a hand's end sets off is found here and
 * nothing has to be remembered by whoever settles a hand.
 */
import { countHandPlayed } from './night.ts';
import { reseatAfterHand } from './reseating.ts';
import { addPendingChips, vacateSeat } from './seats.ts';
import type { Ctx, TableState } from './types.ts';

/** One thing that happens when a hand ends. */
export type AtHandEnd = (state: TableState, ctx: Ctx) => void;

/** Players who gave up their seat during the hand leave it, and chips that waited for its end reach their stacks. */
function settleSeats(state: TableState, ctx: Ctx): void {
  state.seats.forEach((seat, index) => {
    if (!seat) {
      return;
    }

    if (seat.leaving) {
      vacateSeat(state, ctx, index);
    } else {
      addPendingChips(state, ctx, index);
    }
  });
}

/**
 * What happens when a hand ends, in the order it happens. The order matters: seats are moved once
 * those leaving have gone, and the night can end only when everything else about the hand is done.
 */
const AT_HAND_END: AtHandEnd[] = [settleSeats, reseatAfterHand, countHandPlayed];

/** Call once for every hand, right after it is taken off the table. */
export function handEnded(state: TableState, ctx: Ctx): void {
  for (const happen of AT_HAND_END) {
    happen(state, ctx);
  }
}
