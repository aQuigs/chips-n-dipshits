import type { TableEffect } from '../effects.ts';
import { followHand } from '../handMoves.ts';

/** Cards dealt around the table, bets sliding in and gathering to the pot, and the pot going to whoever won it, as the hand happens. */
export function handMoves(): TableEffect {
  return {
    run: (change, { seat, motion }) => followHand(change, seat, motion),
  };
}
