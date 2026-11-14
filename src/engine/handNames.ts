import { FLOP_SIZE, rankOf, suitOf } from './cards.ts';
import type { Card } from './cards.ts';
import { ACE, FLUSH, FOUR_OF_A_KIND, FULL_HOUSE, HIGH_CARD, PAIR, playerHand, STRAIGHT, STRAIGHT_FLUSH, THREE_OF_A_KIND, TWO_PAIR } from './handRank.ts';
import type { HandValue } from './handRank.ts';

/*
 * Every name a hand is given, at showdown and in a player's own hint. Kickers are left out to keep a
 * name short enough for the line under a seat on a small phone: the hint lifts the cards that play,
 * which already shows whether a kicker of one's own is among them.
 */

const RANK_WORDS: Record<number, [one: string, many: string]> = {
  2: ['deuce', 'deuces'],
  3: ['three', 'threes'],
  4: ['four', 'fours'],
  5: ['five', 'fives'],
  6: ['six', 'sixes'],
  7: ['seven', 'sevens'],
  8: ['eight', 'eights'],
  9: ['nine', 'nines'],
  10: ['ten', 'tens'],
  11: ['jack', 'jacks'],
  12: ['queen', 'queens'],
  13: ['king', 'kings'],
  14: ['ace', 'aces'],
};

const one = (rank: number) => RANK_WORDS[rank]![0];
const many = (rank: number) => RANK_WORDS[rank]![1];
const capitalized = (text: string) => text[0]!.toUpperCase() + text.slice(1);

/** Each category's name from its most significant rank and, for two pair and a full house, the second. */
const MADE_NAMES: Record<number, (first: number, second: number) => string> = {
  [STRAIGHT_FLUSH]: (first) => (first === ACE ? 'Royal flush' : `Straight flush, ${one(first)} high`),
  [FOUR_OF_A_KIND]: (first) => `Four ${many(first)}`,
  [FULL_HOUSE]: (first, second) => `Full house, ${many(first)} over ${many(second)}`,
  [FLUSH]: (first) => `Flush, ${one(first)} high`,
  [STRAIGHT]: (first) => `Straight, ${one(first)} high`,
  [THREE_OF_A_KIND]: (first) => `Three ${many(first)}`,
  [TWO_PAIR]: (first, second) => `Two pair, ${many(first)} and ${many(second)}`,
  [PAIR]: (first) => `Pair of ${many(first)}`,
  [HIGH_CARD]: (first) => `${capitalized(one(first))} high`,
};

/** Where the second rank a name needs sits among the five cards. */
const SECOND_AT: Record<number, number> = { [TWO_PAIR]: 2, [FULL_HOUSE]: 3 };

export const PLAYING_THE_BOARD = 'Playing the board';

/** A made hand in words, such as "Two pair, kings and sevens". */
export function madeHandName(value: HandValue): string {
  const ranks = value.cards.map(rankOf);

  return MADE_NAMES[value.category]!(ranks[0]!, ranks[SECOND_AT[value.category] ?? 0]!);
}

/** Names in a sentence: "Ann", "Ann and Bob", "Ann, Bob and Cat". */
export function listed(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A name as it reads inside a sentence: "wins 40 with two pair, kings and sevens". */
export function midSentence(name: string): string {
  return name[0]!.toLowerCase() + name.slice(1);
}

/** Two hole cards in words, such as "Pocket aces", "Ace-king suited" or "Seven-deuce offsuit". */
export function startingHandName(hole: readonly Card[]): string {
  const [high, low] = hole.map(rankOf).sort((a, b) => b - a) as [number, number];

  if (high === low) {
    return `Pocket ${many(high)}`;
  }

  return `${capitalized(one(high))}-${one(low)} ${suitOf(hole[0]!) === suitOf(hole[1]!) ? 'suited' : 'offsuit'}`;
}

/** What a player holds on one board, for their eyes only. */
export interface HandRead {
  name: string;
  /** The five cards that make the hand, hole and board, with as few hole cards as make it; none before the flop. */
  plays: Card[];
}

/** What two hole cards make with a board so far: the cards themselves before the flop, the made hand after. */
export function readHand(hole: readonly Card[], board: readonly Card[]): HandRead {
  if (board.length < FLOP_SIZE) {
    return { name: startingHandName(hole), plays: [] };
  }

  const value = playerHand(hole, board);
  const ownCardPlays = value.cards.some((card) => hole.includes(card));

  return { name: ownCardPlays ? madeHandName(value) : PLAYING_THE_BOARD, plays: value.cards };
}
