import type { Rng } from '../engine/index.ts';

const BYTES_PER_DRAW = 4;
const DRAW_RANGE = 2 ** (8 * BYTES_PER_DRAW);

/** Turns a source of random bytes into unbiased integers. The quality of the shuffle is the quality of the source. */
export class ByteRng implements Rng {
  private pool: number[] = [];
  private readonly moreBytes: () => number[];

  /** `moreBytes` returns a fresh batch of random bytes (0 to 255) each time it is called. */
  constructor(moreBytes: () => number[]) {
    this.moreBytes = moreBytes;
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > DRAW_RANGE) {
      throw new Error(`Cannot draw a random integer below ${maxExclusive}`);
    }

    // Draws past the last whole multiple are thrown away; taking them modulo would favor low results
    const limit = Math.floor(DRAW_RANGE / maxExclusive) * maxExclusive;

    for (;;) {
      let draw = 0;
      for (let i = 0; i < BYTES_PER_DRAW; i++) {
        draw = draw * 256 + this.nextByte();
      }

      if (draw < limit) {
        return draw % maxExclusive;
      }
    }
  }

  private nextByte(): number {
    if (this.pool.length === 0) {
      this.pool = this.moreBytes();

      if (this.pool.length === 0) {
        throw new Error('The random source returned no bytes');
      }
    }

    return this.pool.pop()!;
  }
}
