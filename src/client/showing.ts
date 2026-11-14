/* Showing your cards once a hand is over, as the page offers it: either card, or both, and the other one later. */
import type { Card } from '../engine/cards.ts';
import { cardWords } from '../engine/handNames.ts';
import type { SeatView, TableView } from '../engine/view.ts';

/** What the page offers the viewer to show: the hand, and the places of their cards still face down to the table, 0 on their left. */
export interface ShowOffer {
  hand: number;
  places: number[];
}

/** What the viewer may show now, or null when they may show nothing. */
export function showOffer(view: TableView): ShowOffer | null {
  const hand = view.hand;
  const seat = view.you.seat === null ? null : view.seats[view.you.seat];
  if (!hand?.canShow || !seat) {
    return null;
  }

  return { hand: hand.number, places: seat.shown.flatMap((shown, place) => (shown ? [] : [place])) };
}

/** Whether a show sent with no answer back is worth sending again: the view still offers that hand, and one of those cards. */
export function showStillOffered(view: TableView | null, hand: number, places: readonly number[]): boolean {
  const offer = view && showOffer(view);

  return offer?.hand === hand && places.some((place) => offer.places.includes(place));
}

/**
 * What a screen reader says of a seat with some of its cards turned up and some not, said by another
 * player or a watcher: "Pam shows the ace of spades; the other card is face down". Null for a seat
 * with all its cards up or none, which the cards themselves say.
 */
export function halfShownLabel(seat: SeatView): string | null {
  const cards = seat.cards ?? [];
  const up = cards.filter((card): card is Card => card !== null);

  if (up.length === 0 || up.length === cards.length) {
    return null;
  }

  return `${seat.name} shows ${up.map(cardWords).join(' and ')}; the other card is face down`;
}
