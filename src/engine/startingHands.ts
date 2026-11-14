/*
 * A starting hand as players write it: two ranks, the higher first, then `s` for suited only or `o`
 * for offsuit only, or neither for both ("72", "J4s", "72o"); a pair is its rank twice ("AA") and is
 * never suited. A ten is T. This is the one form a hand is kept and shown in, whatever was typed.
 */
import { RANKS, rankOf, suitOf } from './cards.ts';
import type { Card } from './cards.ts';
import { GameError } from './types.ts';

export type Suitedness = 's' | 'o';

const HOW_TO_WRITE = 'Write two ranks, such as 72 or AA, with s after them for suited only or o for offsuit only, such as J4s or 72o. A ten is T or 10';

const MOST_QUOTED = 8;

const TYPED = /^(10|[2-9TJQKA])(10|[2-9TJQKA])([SO]?)$/;

/** The rank's letter in `RANKS`, from a rank as typed, 10 being a ten. */
const rankLetter = (typed: string): string => (typed === '10' ? 'T' : typed);

/** A hand as typed, in any case and either order, in the one form it is kept in; refused in words that say how to write one. */
export function parseStartingHand(typed: string): string {
  const match = TYPED.exec(typed.replace(/\s+/g, '').toUpperCase());

  if (!match) {
    const shown = typed.trim();
    // Quoted back only when short, as a player types a hand: anything longer is no slip of the finger
    const what = shown.length <= MOST_QUOTED ? `“${shown}”` : 'That';

    throw new GameError(shown === '' ? `A bounty needs a hand. ${HOW_TO_WRITE}` : `${what} isn't a hand. ${HOW_TO_WRITE}`);
  }

  const [high, low] = [rankLetter(match[1]!), rankLetter(match[2]!)].sort((a, b) => RANKS.indexOf(b) - RANKS.indexOf(a)) as [string, string];
  const suitedness = match[3]!.toLowerCase();

  if (high === low && suitedness !== '') {
    throw new GameError(`A pair is never suited or offsuit: write it as ${high}${low}`);
  }

  return `${high}${low}${suitedness}`;
}

/** Whether a hand in kept form names suited hands only or offsuit hands only, which makes it narrower than the same ranks written bare. */
export function suitednessOf(hand: string): Suitedness | null {
  return (hand[2] as Suitedness | undefined) ?? null;
}

/** Whether two hole cards are the hand, written in kept form. */
export function isStartingHand(cards: readonly Card[], hand: string): boolean {
  if (cards.length !== 2) {
    return false;
  }

  const [high, low] = cards.map(rankOf).sort((a, b) => b - a);
  const suited = suitOf(cards[0]!) === suitOf(cards[1]!);
  const suitedness = suitednessOf(hand);

  return high === rankOf(hand[0]!) && low === rankOf(hand[1]!) && (suitedness === null || (suitedness === 's') === suited);
}
