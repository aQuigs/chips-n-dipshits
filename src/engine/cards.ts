/** A card is its rank followed by its suit, e.g. "As", "Td", "2c". */
export type Card = string;

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

export interface Rng {
  /** A uniformly distributed integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

export function freshDeck(): Card[] {
  const deck: Card[] = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(rank + suit);
    }
  }

  return deck;
}

export function shuffledDeck(rng: Rng): Card[] {
  const deck = freshDeck();

  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const swap = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = swap;
  }

  return deck;
}

/** 2 for a deuce up to 14 for an ace. */
export function rankOf(card: Card): number {
  return RANKS.indexOf(card[0]!) + 2;
}

export function suitOf(card: Card): string {
  return card[1]!;
}

const SUIT_SYMBOLS: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

export function prettyCard(card: Card): string {
  const rank = card[0] === 'T' ? '10' : card[0]!;

  return rank + SUIT_SYMBOLS[suitOf(card)]!;
}

export function prettyCards(cards: readonly Card[]): string {
  return cards.map(prettyCard).join(' ');
}
