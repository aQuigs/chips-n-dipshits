import type { TableEffect } from '../effects.ts';
import { nightOver } from '../render/night.ts';

/**
 * When the night ends, the night's numbers are put in front of everyone at the table, once. A night
 * ends between hands, so its end comes in a view with no hand on the table, and such a view ends the
 * hold on the last hand's result (`Suspense`) before any of it is told: the recap never comes while a
 * river lies face down.
 */
export function nightRecap(): TableEffect {
  return {
    run(change, { dialogs }) {
      if (change.nightEnded) {
        // A night that someone started again before the viewer was free to look is no longer over, and its recap would say "so far"
        dialogs.offer({ kind: 'tonight' }, nightOver);
      }
    },
  };
}
