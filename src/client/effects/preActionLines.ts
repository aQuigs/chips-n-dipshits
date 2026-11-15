import type { TableEffect } from '../effects.ts';
import { aheadLines } from '../preActions.ts';

/** Tells a player what became of the move they chose ahead of their turn, where the screen alone would not. */
export function preActionLines(): TableEffect {
  return {
    run(change, { announce, toast }) {
      const { spoken, shown } = aheadLines(change);

      if (spoken) {
        announce(spoken);
      }

      if (shown) {
        toast(shown);
      }
    },
  };
}
