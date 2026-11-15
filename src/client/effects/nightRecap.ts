import type { TableEffect } from '../effects.ts';
import { nightOver } from '../render/night.ts';
import { RECAP_GONE } from '../spoken.ts';

/**
 * When the night ends, the night's numbers are put in front of everyone at the table, once. A night
 * ends between hands, so its end comes in a view with no hand on the table, and such a view ends the
 * hold on the last hand's result (`Suspense`) before any of it is told: the recap never comes while a
 * river lies face down.
 *
 * When the night is played on, the recap that came that way goes again, and says why, on every page
 * it came to: a watcher's and a waiting player's as well. What it showed as the night's end is now
 * only the night so far, a hand is on its way with a clock on it, and whoever is first to act would
 * be on that clock behind a dialog they never opened.
 */
export function nightRecap(): TableEffect {
  return {
    run(change, { dialogs, toast }) {
      if (change.nightEnded) {
        // A night that someone started again before the viewer was free to look is no longer over, and its recap would say "so far"
        dialogs.offer({ kind: 'tonight' }, nightOver);
      }

      if (change.before && nightOver(change.before) && !nightOver(change.view) && dialogs.withdraw('tonight')) {
        toast(RECAP_GONE);
      }
    },
  };
}
