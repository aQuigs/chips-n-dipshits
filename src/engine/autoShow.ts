/*
 * A player's standing choices to show cards the table would let them keep face down: a hand that lost
 * at a showdown, and the cards of a hand everyone folded to them. They are kept with the seat and
 * carried out by the engine in the request that ends the hand, so they hold while the player's page is
 * closed. Nobody but the player sees them.
 */
import type { AutoShow, Seat, TableState } from './types.ts';

/** Every choice, in the order the page offers them. */
export const AUTO_SHOWS: readonly AutoShow[] = ['lost', 'foldedTo'];

export function isAutoShow(value: unknown): value is AutoShow {
  return AUTO_SHOWS.includes(value as AutoShow);
}

export function chooseAutoShow(seat: Seat, when: AutoShow, on: boolean): void {
  seat.autoShow = AUTO_SHOWS.filter((each) => (each === when ? on : seat.autoShow.includes(each)));
}

/** Whether the player in `seat` shows at `when`. Read as the hand ends, so a choice changed during a hand holds for that hand. */
export function showsAt(state: TableState, seat: number, when: AutoShow): boolean {
  return state.seats[seat]?.autoShow.includes(when) ?? false;
}
