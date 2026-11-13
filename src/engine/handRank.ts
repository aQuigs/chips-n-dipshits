import { rankOf, suitOf } from './cards.ts';
import type { Card } from './cards.ts';

export const HIGH_CARD = 0;
export const PAIR = 1;
export const TWO_PAIR = 2;
export const THREE_OF_A_KIND = 3;
export const STRAIGHT = 4;
export const FLUSH = 5;
export const FULL_HOUSE = 6;
export const FOUR_OF_A_KIND = 7;
export const STRAIGHT_FLUSH = 8;

export interface HandValue {
  /** Higher beats lower; equal scores tie. */
  score: number;
  category: number;
  /** The five cards that make the hand, most significant first. */
  cards: Card[];
  name: string;
}

const HAND_SIZE = 5;
const ACE = 14;
const WHEEL_HIGH = 5;

// One more than the highest rank, so each tiebreak rank is one base-15 digit below the category
const SCORE_BASE = 15;

const RANK_NAMES: Record<number, [singular: string, plural: string]> = {
  2: ['Two', 'Twos'],
  3: ['Three', 'Threes'],
  4: ['Four', 'Fours'],
  5: ['Five', 'Fives'],
  6: ['Six', 'Sixes'],
  7: ['Seven', 'Sevens'],
  8: ['Eight', 'Eights'],
  9: ['Nine', 'Nines'],
  10: ['Ten', 'Tens'],
  11: ['Jack', 'Jacks'],
  12: ['Queen', 'Queens'],
  13: ['King', 'Kings'],
  14: ['Ace', 'Aces'],
};

function one(rank: number): string {
  return RANK_NAMES[rank]![0];
}

function many(rank: number): string {
  return RANK_NAMES[rank]![1];
}

interface FiveCardValue {
  category: number;
  /** Ranks that break ties within the category, most significant first. */
  tiebreak: number[];
}

/** Ranks exactly five cards. Runs for every five-card subset of a hand, so it stays allocation-light. */
function evaluateFive(cards: readonly Card[]): FiveCardValue {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((card) => suitOf(card) === suitOf(cards[0]!));

  // Runs of equal ranks, then bigger groups first and higher ranks next, which is the order ties are broken in
  const groups: [rank: number, count: number][] = [];
  for (const rank of ranks) {
    const last = groups[groups.length - 1];

    if (last && last[0] === rank) {
      last[1] += 1;
    } else {
      groups.push([rank, 1]);
    }
  }
  groups.sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const groupRanks = groups.map(([rank]) => rank);
  const biggest = groups[0]![1];
  const second = groups[1]?.[1] ?? 0;

  let straightHigh = 0;
  if (groups.length === HAND_SIZE) {
    if (ranks[0]! - ranks[4]! === HAND_SIZE - 1) {
      straightHigh = ranks[0]!;
    } else if (ranks[0] === ACE && ranks[1] === WHEEL_HIGH) {
      straightHigh = WHEEL_HIGH;
    }
  }

  if (straightHigh && flush) {
    return { category: STRAIGHT_FLUSH, tiebreak: [straightHigh] };
  }

  if (biggest === 4) {
    return { category: FOUR_OF_A_KIND, tiebreak: groupRanks };
  }

  if (biggest === 3 && second === 2) {
    return { category: FULL_HOUSE, tiebreak: groupRanks };
  }

  if (flush) {
    return { category: FLUSH, tiebreak: ranks };
  }

  if (straightHigh) {
    return { category: STRAIGHT, tiebreak: [straightHigh] };
  }

  if (biggest === 3) {
    return { category: THREE_OF_A_KIND, tiebreak: groupRanks };
  }

  if (biggest === 2 && second === 2) {
    return { category: TWO_PAIR, tiebreak: groupRanks };
  }

  if (biggest === 2) {
    return { category: PAIR, tiebreak: groupRanks };
  }

  return { category: HIGH_CARD, tiebreak: ranks };
}

/** The five cards in the order they matter: pairs and sets before kickers, and a wheel's ace last. */
function inPlayingOrder(cards: readonly Card[], value: FiveCardValue): Card[] {
  const isStraight = value.category === STRAIGHT || value.category === STRAIGHT_FLUSH;
  const position = (card: Card): number => {
    if (isStraight) {
      return value.tiebreak[0] === WHEEL_HIGH && rankOf(card) === ACE ? HAND_SIZE : -rankOf(card);
    }

    return value.tiebreak.indexOf(rankOf(card));
  };

  return [...cards].sort((a, b) => position(a) - position(b));
}

function scoreOf(value: FiveCardValue): number {
  let score = value.category;

  for (let i = 0; i < HAND_SIZE; i++) {
    score = score * SCORE_BASE + (value.tiebreak[i] ?? 0);
  }

  return score;
}

function nameOf(value: FiveCardValue): string {
  const [first, second] = value.tiebreak as [number, number];

  switch (value.category) {
    case STRAIGHT_FLUSH:
      return first === ACE ? 'Royal Flush' : `Straight Flush, ${one(first)} high`;
    case FOUR_OF_A_KIND:
      return `Four of a Kind, ${many(first)}`;
    case FULL_HOUSE:
      return `Full House, ${many(first)} full of ${many(second)}`;
    case FLUSH:
      return `Flush, ${one(first)} high`;
    case STRAIGHT:
      return `Straight, ${one(first)} high`;
    case THREE_OF_A_KIND:
      return `Three of a Kind, ${many(first)}`;
    case TWO_PAIR:
      return `Two Pair, ${many(first)} and ${many(second)}`;
    case PAIR:
      return `Pair of ${many(first)}`;
    default:
      return `${one(first)} high`;
  }
}

const subsetIndexesByCount = new Map<number, number[][]>();

/** Every way to pick five positions out of a hand of the given size, worked out once per size. */
function fiveCardSubsets(count: number): number[][] {
  const known = subsetIndexesByCount.get(count);
  if (known) {
    return known;
  }

  const subsets: number[][] = [];
  const picked: number[] = [];

  const pick = (start: number): void => {
    if (picked.length === HAND_SIZE) {
      subsets.push([...picked]);
      return;
    }

    for (let i = start; i < count; i++) {
      picked.push(i);
      pick(i + 1);
      picked.pop();
    }
  };

  pick(0);
  subsetIndexesByCount.set(count, subsets);

  return subsets;
}

/** The best five-card poker hand that can be made from five or more cards. */
export function evaluateHand(cards: readonly Card[]): HandValue {
  if (cards.length < HAND_SIZE) {
    throw new Error(`A poker hand needs at least ${HAND_SIZE} cards, got ${cards.length}`);
  }

  let best: FiveCardValue | null = null;
  let bestCards: Card[] = [];
  let bestScore = -1;

  for (const indexes of fiveCardSubsets(cards.length)) {
    const five = indexes.map((index) => cards[index]!);
    const value = evaluateFive(five);
    const score = scoreOf(value);

    if (score > bestScore) {
      best = value;
      bestCards = five;
      bestScore = score;
    }
  }

  return { score: bestScore, category: best!.category, cards: inPlayingOrder(bestCards, best!), name: nameOf(best!) };
}
