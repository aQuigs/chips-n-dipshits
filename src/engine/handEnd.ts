/* The end of a hand: everything that happens once a finished hand has been taken off the table, as one list run from one place. */
import { earnBadges } from './badges.ts';
import { handFacts } from './handFacts.ts';
import { takeHighHand } from './highHand.ts';
import type { HandFacts } from './handFacts.ts';
import { countHandPlayed } from './night.ts';
import { reseatAfterHand } from './reseating.ts';
import { addPendingChips, vacateSeat } from './seats.ts';
import { countHand } from './tonight.ts';
import type { Ctx, HandRecord, TableState } from './types.ts';

/** One thing that happens when a hand ends, told what the hand came to. The hand is off the table by then. */
type AtHandEnd = (state: TableState, ctx: Ctx, facts: HandFacts) => void;

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
 * What happens when a hand ends, in the order it happens. What reads the hand's facts comes first,
 * the night's numbers before anything that might want them; then the table is put in order for the
 * next hand, seats being moved once those leaving have gone; and the count that can end the night
 * comes last, so that whatever a night's end reads is complete.
 */
const AT_HAND_END: AtHandEnd[] = [
  // Badges are earned from what the count made of the hand, and before the night can end, so the last hand's are in its recap
  (state, ctx, facts) => earnBadges(state, ctx, facts, countHand(state.tonight, facts)),
  takeHighHand,
  settleSeats,
  reseatAfterHand,
  countHandPlayed,
];

/** Call once for every hand, with its record, right after it is taken off the table. */
export function handEnded(record: HandRecord, state: TableState, ctx: Ctx): void {
  const facts = handFacts(record);

  for (const happen of AT_HAND_END) {
    happen(state, ctx, facts);
  }
}
