import { boardsDealt } from '../../engine/bombPots.ts';
import type { TableEffect } from '../effects.ts';
import { soundsHeard } from '../handSounds.ts';

/** Chips, cards, a knock for a check, a sting for an all-in and a flourish for a win, as the hand happens. */
export function handSounds(): TableEffect {
  return {
    run({ events, view }, { seat, sounds }) {
      for (const sound of soundsHeard(events, seat, boardsDealt(view.hand?.bombPot ?? null))) {
        sounds.play(sound);
      }
    },
  };
}
