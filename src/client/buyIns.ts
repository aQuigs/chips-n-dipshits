/*
 * What the page offers a player who is buying chips, for a seat or for the seat they have, and what it
 * says of chips they have asked the host for. Worked out from the view alone, and tested without a page.
 */
import { formatAmount } from '../engine/amounts.ts';
import type { Denominated } from '../engine/amounts.ts';
import type { TableConfig } from '../engine/types.ts';
import type { RequestView, SeatView, TableView } from '../engine/view.ts';
import type { Words } from './words.ts';

const SUGGESTED_BIG_BLINDS = 100;

/** The buy-in the page suggests: a hundred big blinds, as near to that as the table's range allows. */
export function suggestedBuyIn({ minBuyIn, maxBuyIn, bigBlind }: TableConfig): number {
  return Math.min(maxBuyIn, Math.max(minBuyIn, bigBlind * SUGGESTED_BIG_BLINDS));
}

const seatOf = (view: TableView): SeatView | null => (view.you.seat === null ? null : (view.seats[view.you.seat] ?? null));

/** The most the viewer can still add: what is left under the table's maximum, less chips already on their way. Nothing for someone watching. */
export function roomToAdd(view: TableView): number {
  const seat = seatOf(view);

  return seat ? Math.max(0, view.config.maxBuyIn - seat.stack - seat.pendingAdd) : 0;
}

/**
 * What the viewer last bought in for, where the view can tell. It holds what they have bought in all
 * (the ledger) and how many times they bought again (the night's numbers), so their last buy is known
 * only until they make a second one.
 */
function lastBought(view: TableView): number | null {
  const bought = view.ledger.find((row) => row.playerId === view.you.id)?.buyIn ?? 0;
  const again = view.tonight.players.find((row) => row.playerId === view.you.id)?.rebuys ?? 0;

  return bought > 0 && again === 0 ? bought : null;
}

/**
 * The amount the Add chips dialog starts on: the player's own, which is what they last bought in for or
 * else the buy-in the page suggests, and never more than there is room for. Not the most the table
 * allows: a tap made in haste would ask the host for that.
 */
export function offeredToAdd(view: TableView): number {
  return Math.min(lastBought(view) ?? suggestedBuyIn(view.config), roomToAdd(view));
}

/**
 * Whether the viewer has no chips, none on their way and none riding on a hand: the one time the page
 * asks them to add some. All in with cards to come they may have chips again without buying any.
 */
export function outOfChips(view: TableView): boolean {
  const seat = seatOf(view);
  const riding = seat !== null && seat.inHand && !seat.folded && view.hand !== null && view.hand.stage !== 'done';

  return seat !== null && seat.stack + seat.pendingAdd === 0 && !riding;
}

/** The viewer's request for chips that waits for the host, if they have one. */
export function chipsAsked(view: TableView): RequestView | null {
  return view.requests.find((request) => request.playerId === view.you.id && request.kind === 'rebuy') ?? null;
}

/** What the page says of chips asked for, as it says of a seat asked for: in brief without the host, whom a phone's row has no room for. */
export function askedSays(request: RequestView, table: Denominated): Words {
  const amount = formatAmount(request.amount, table);

  return { full: `Asked the host for ${amount} more${table.unit === 'chips' ? ' chips' : ''}`, brief: `Asked for ${amount}` };
}
