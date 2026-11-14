import { listed } from '../../engine/handNames.ts';
import type { TableEffect } from '../effects.ts';
import { badgeText } from '../tonightText.ts';

/**
 * Tells a player of the badges they have just earned, in a toast: one for all they earned at once.
 * Everyone else, watchers too, reads it in the play-by-play.
 */
export function badgeToasts(): TableEffect {
  return {
    run({ earned }, { toast }) {
      if (earned.length > 0) {
        toast(`You earned ${listed(earned.map(badgeText))}`);
      }
    },
  };
}
