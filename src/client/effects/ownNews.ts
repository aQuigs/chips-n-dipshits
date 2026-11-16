import type { TableEffect } from '../effects.ts';
import { timedOutText, turnedDownText } from '../ownNews.ts';

/**
 * Tells a player what has just happened to them alone, which the bar under the table goes on saying
 * (`ownNews.ts`): the clock ran out on them, or the host turned down what they asked for. Everyone
 * else reads it in the play-by-play, where the player it happened to may never look.
 */
export function ownNews(): TableEffect {
  return {
    run({ events, turnedDown, view }, { seat, toast }) {
      const mine = seat === null ? null : view.seats[seat];

      if (mine && events.some((event) => event[0] === 'timeout' && event[1] === seat)) {
        toast(timedOutText(view, mine));
      } else if (turnedDown) {
        toast(`${turnedDownText(turnedDown)}.`);
      }
    },
  };
}
