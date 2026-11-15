import type { TableEffect } from '../effects.ts';
import { soundsOf } from '../handSounds.ts';

/** Chips, cards, a knock for a check, a sting for an all-in and a flourish for a win, as the hand happens. */
export function handSounds(): TableEffect {
  return {
    run(change, { seat, sounds }) {
      for (const { sound } of soundsOf(change, seat)) {
        sounds.play(sound);
      }
    },
  };
}
