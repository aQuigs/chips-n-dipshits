import type { TableView } from '../engine/view.ts';
import { handsText, nightOver, onLastHand } from './render/night.ts';

/** The few words in the top bar that say how the table stands. */
export interface Headline {
  says: string;
  /** It tells a state of the table, not just which hand is being played, and is drawn to be noticed. */
  news: boolean;
}

const state = (says: string): Headline => ({ says, news: true });

/**
 * How the table stands, in the fewest words, for everyone at it. Of the things that hold at once the
 * one that changes what happens soonest is said, in this order: the night is over; this hand is the
 * last; the game is stopped or stops after this hand; nobody can be dealt to; the next hand is a bomb
 * pot; how many hands are left. With none of them it is the number of the hand, which says only that
 * the game is going.
 */
export function headline(view: TableView): Headline {
  const hand = view.hand;

  if (nightOver(view)) {
    return state('Night over');
  }

  if (onLastHand(view)) {
    return state('Last hand');
  }

  if (!view.running) {
    // With a hand on the table the pause waits for it, and can still be called off
    return state(hand ? 'Pausing' : view.handCount === 0 ? 'Not started' : 'Paused');
  }

  // The game is on with fewer than two players to deal to: the table and the bar under it say for whom, where there is room to
  if (!hand && view.nextHandAt === null) {
    return state('Waiting');
  }

  // At a table that plays one every hand it is no news, and would be all the pill ever said
  if (view.nextBombPot && view.config.bombPotEvery !== 1) {
    return state('Bomb pot next');
  }

  if (view.handsLeft !== null) {
    return state(handsText(view.handsLeft));
  }

  return { says: hand ? `Hand #${hand.number}` : 'Next hand', news: false };
}
