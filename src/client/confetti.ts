import { seededNumbers } from '../engine/seeded.ts';

/**
 * How many pieces a burst throws. Each is one small element with one animation of transform and
 * opacity, which the browser runs off the main thread; two dozen read as a burst on a phone's seat and
 * stay far inside what an old phone draws at full speed.
 */
export const CONFETTI_PIECES = 24;

/** How many colors confetti comes in, each a token of the theme (`styles/celebrations.css`). */
export const CONFETTI_COLORS = 5;

/** One piece of a burst, as thrown from the winner's seat. */
export interface ConfettiPiece {
  /** Which way it flies, in degrees off the line from the seat to the middle of the table. */
  angle: number;
  /** How far it flies, as a share of the table's shorter side. */
  reach: number;
  /** How far it spins on the way, in degrees. */
  spin: number;
  /** Milliseconds after the burst starts that it is thrown. */
  after: number;
  color: number;
}

// Fanned out to either side of the line to the middle, so the burst stays over the table
const FAN_DEGREES = 140;
const LEAST_REACH = 0.14;
const MORE_REACH = 0.3;
const MOST_SPIN = 720;
const MOST_LATE_MS = 120;

/** The pieces of one burst, laid out from `seed`: the same seed throws the same burst. */
export function confettiBurst(seed: number): ConfettiPiece[] {
  const next = seededNumbers(seed);

  return Array.from({ length: CONFETTI_PIECES }, () => ({
    angle: (next() - 0.5) * FAN_DEGREES,
    reach: LEAST_REACH + next() * MORE_REACH,
    spin: (next() - 0.5) * MOST_SPIN,
    after: Math.round(next() * MOST_LATE_MS),
    color: Math.floor(next() * CONFETTI_COLORS),
  }));
}
