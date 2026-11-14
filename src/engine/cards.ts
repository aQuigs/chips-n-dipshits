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

export const SUIT_SYMBOLS: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

export function prettyCard(card: Card): string {
  const rank = card[0] === 'T' ? '10' : card[0]!;

  return rank + SUIT_SYMBOLS[suitOf(card)]!;
}

export function prettyCards(cards: readonly Card[]): string {
  return cards.map(prettyCard).join(' ');
}

const SUIT_OF_SYMBOL = new Map(Object.entries(SUIT_SYMBOLS).map(([suit, symbol]) => [symbol, suit]));
const WRITTEN_CARD = new RegExp(`(?<![\\p{L}\\p{N}])(?:10|[2-9JQKA])([${Object.values(SUIT_SYMBOLS).join('')}])(?![\\p{L}\\p{N}])`, 'gu');

/** Text split around each card written in it by `prettyCard`, with that card's suit. */
export function splitWrittenCards(text: string): { text: string; suit: string | null }[] {
  const parts: { text: string; suit: string | null }[] = [];
  let from = 0;

  for (const match of text.matchAll(WRITTEN_CARD)) {
    if (match.index > from) {
      parts.push({ text: text.slice(from, match.index), suit: null });
    }

    parts.push({ text: match[0], suit: SUIT_OF_SYMBOL.get(match[1]!)! });
    from = match.index + match[0].length;
  }

  if (from < text.length) {
    parts.push({ text: text.slice(from), suit: null });
  }

  return parts;
}
