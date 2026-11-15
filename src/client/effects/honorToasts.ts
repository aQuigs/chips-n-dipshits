import { HIGH_HAND_MARK } from '../../engine/highHand.ts';
import { listed, midSentence } from '../../engine/handNames.ts';
import type { TableEffect } from '../effects.ts';
import { badgeText } from '../tonightText.ts';

/**
 * Tells a player of the badges they have just earned and of the high hand they have just taken, in
 * one toast, since both come as a hand is cleared and a second toast would replace the first.
 * Everyone else, watchers too, reads them in the play-by-play.
 */
export function honorToasts(): TableEffect {
  return {
    run({ earned, tookHighHand, view }, { toast }) {
      const highHand = tookHighHand && view.tonight.highHand.next;
      const badges = earned.length > 0 ? `You earned ${listed(earned.map(badgeText))}` : null;
      const taken = highHand ? `${HIGH_HAND_MARK} the high hand with ${midSentence(highHand.name)}` : null;

      if (badges && taken) {
        toast(`${badges}, and ${taken}`);
      } else if (badges || taken) {
        toast(badges ?? `You have ${taken}`);
      }
    },
  };
}
