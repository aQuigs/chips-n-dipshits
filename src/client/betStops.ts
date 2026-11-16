import type { TableConfig } from '../engine/types.ts';

/** With fewer big blinds than this between the least raise and all in the range is short, and stepped by the small blind. */
const SHORT_RANGE_BLINDS = 10;

/**
 * Where the slider of a bet stops: at the least raise, at all in, and between them at every whole
 * step of the blinds, which are amounts someone would say aloud. The slider counts these stops and not
 * chips, so both ends are exact however the range divides.
 */
export interface BetStops {
  /** The number of the stop that is all in. The least raise is stop 0. */
  last: number;
  amountAt(stop: number): number;
  /** The stop nearest an amount that came from elsewhere, the box or a size button: where the slider stands for it. */
  stopOf(amount: number): number;
}

export function betStops(least: number, most: number, stakes: Pick<TableConfig, 'smallBlind' | 'bigBlind'>): BetStops {
  const step = Math.max(1, most - least < SHORT_RANGE_BLINDS * stakes.bigBlind ? stakes.smallBlind : stakes.bigBlind);
  const below = Math.floor(least / step);
  // The whole steps that lie between the two ends, and are neither
  const between = Math.max(0, Math.ceil(most / step) - 1 - below);
  const last = most > least ? between + 1 : 0;
  const amountAt = (stop: number): number => (stop <= 0 ? least : stop >= last ? most : (below + stop) * step);
  const off = (stop: number, amount: number): number => Math.abs(amountAt(stop) - amount);

  return {
    last,
    amountAt,
    stopOf(amount) {
      // The whole step nearest the amount, and then whichever of it and the stops at its sides is nearest: an end is no whole step
      const near = Math.min(Math.max(Math.round(amount / step) - below, 0), last);

      return [near - 1, near, near + 1].filter((stop) => stop >= 0 && stop <= last).reduce((best, stop) => (off(stop, amount) < off(best, amount) ? stop : best));
    },
  };
}
