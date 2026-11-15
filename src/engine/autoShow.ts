/* A player's standing choices to show (`AutoShow`), carried out by `hand.ts` in the request that ends a hand. */
import type { AutoShow, Seat } from './types.ts';

/** Every choice, in the order the page offers them. */
export const AUTO_SHOWS: readonly AutoShow[] = ['lost', 'foldedTo'];

export function isAutoShow(value: unknown): value is AutoShow {
  return AUTO_SHOWS.includes(value as AutoShow);
}

export function chooseAutoShow(seat: Seat, when: AutoShow, on: boolean): void {
  seat.autoShow = AUTO_SHOWS.filter((each) => (each === when ? on : seat.autoShow.includes(each)));
}
