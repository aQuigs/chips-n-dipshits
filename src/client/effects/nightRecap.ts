import type { TableEffect } from '../effects.ts';
import { nightOver } from '../render/night.ts';

/** When the night ends, the night's numbers are put in front of everyone at the table, once. */
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
