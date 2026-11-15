import type { Rng } from './cards.ts';

/** A generator of numbers from 0 up to 1 that gives the same ones for the same seed (mulberry32). */
export function seededNumbers(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Draws that are the same every time for the same seed: for whatever must come out alike on every page, and for tests. Never for dealing a real hand. */
export function seededRng(seed: number): Rng {
  const next = seededNumbers(seed);

  return { int: (maxExclusive) => Math.floor(next() * maxExclusive) };
}

/** A seed from a text, the same for the same text (FNV-1a, 32 bits). */
export function seedOf(text: string): number {
  let hash = 0x811c9dc5;

  for (let at = 0; at < text.length; at++) {
    hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193);
  }

  return hash >>> 0;
}
