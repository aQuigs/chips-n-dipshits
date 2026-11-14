/*
 * What the table has seen of a player's hole cards, card by card. The state and a view keep a flag
 * for each card (`shown`), in the order the cards were dealt, the first being the one on the player's
 * left; a hand event, a record and the hand's facts keep the cards themselves, null in place of one
 * that stayed face down. Nothing that is turned face up is ever turned down again.
 */
import type { Card } from './cards.ts';

/**
 * Whether the table has seen every one of a player's cards, from what it has seen of each: its flag,
 * or the card itself with null for one face down. The one question anything asks of a hand that may
 * be half shown, such as whether it is seven-deuce or has a chance to win.
 */
export function fullyShown(each: readonly (Card | null)[]): each is Card[];
export function fullyShown(each: readonly boolean[]): boolean;
export function fullyShown(each: readonly (Card | boolean | null)[]): boolean {
  return each.length > 0 && each.every((seen) => seen !== null && seen !== false);
}

/** The cards as the table sees them: each one shown, and null in place of one face down. */
export function asSeen(cards: readonly Card[], shown: readonly boolean[]): (Card | null)[] {
  return cards.map((card, nth) => (shown[nth] ? card : null));
}
