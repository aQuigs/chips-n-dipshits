import { celebrationMoves } from '../celebrations.ts';
import type { TableEffect } from '../effects.ts';

/** The last card of an all-in runout turned over after a held beat, and confetti over whoever takes a big pot. */
export function celebrations(): TableEffect {
  return {
    run: (change, { seat, motion }) => motion.play(celebrationMoves(change, seat)),
  };
}
