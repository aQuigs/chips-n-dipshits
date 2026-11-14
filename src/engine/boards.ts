/*
 * The boards a hand is played on: how many, and from where they differ. A hand is dealt on one, and a
 * rule that gives it more says so here. This is the only place that lays a board out or puts a card on
 * one, so the dealing, the runout, the showdown, the view and a replay all go by what it keeps on the
 * hand, and none of them works out for itself which board comes next.
 */
import { FLOP_SIZE } from './cards.ts';
import type { Card } from './cards.ts';
import { splitAmount } from './pots.ts';
import type { Hand, Street } from './types.ts';

export const BOARD_SIZE = 5;

const STREET_BY_BOARD_LENGTH: Record<number, Street> = { 3: 'flop', 4: 'turn', 5: 'river' };

/** What a hand keeps of its boards. A replay keeps the same, so its boards are laid out by the same rules. */
export type Boards = Pick<Hand, 'boards' | 'runs' | 'runIndex' | 'sharedBoardLength'>;

/** The boards of a hand as it is dealt: one, with nothing on it. */
export function newBoards(): Boards {
  return { boards: [[]], runs: 1, runIndex: 0, sharedBoardLength: 0 };
}

/**
 * Betting is over with cards to come, and the rest of the hand is dealt `count` times over: from here
 * it is played on that many boards, which have the cards already out in common.
 */
export function runOut(hand: Boards, count: number): void {
  hand.runs = count;
  hand.sharedBoardLength = hand.boards[0]!.length;
}

function isComplete(board: readonly Card[]): boolean {
  return board.length === BOARD_SIZE;
}

/** Whether every board the hand is played on is out with all its cards. */
export function boardsComplete(hand: Boards): boolean {
  return hand.boards.length === hand.runs && hand.boards.every(isComplete);
}

/**
 * Puts a street's cards on a board and says which street that makes there. When it leaves every board
 * on the table with all its cards and the hand is played on more, the next one is laid, from the cards
 * the boards have in common, to be dealt in its turn.
 */
export function addStreet(hand: Boards, board: number, cards: readonly Card[]): Street {
  const onto = hand.boards[board]!;

  onto.push(...cards);

  if (hand.boards.length < hand.runs && hand.boards.every(isComplete)) {
    hand.boards.push(hand.boards[0]!.slice(0, hand.sharedBoardLength));
    hand.runIndex = hand.boards.length - 1;
  }

  return STREET_BY_BOARD_LENGTH[onto.length]!;
}

/** One street's cards as they went onto one board. */
export interface StreetDealt {
  board: number;
  street: Street;
  cards: Card[];
}

/** Deals the next street from the deck, to every board still being dealt, and says what went where. */
export function dealStreet(hand: Boards & Pick<Hand, 'deck'>): StreetDealt[] {
  const first = hand.runIndex;

  return hand.boards.slice(first).map((onto, offset) => {
    const cards: Card[] = [];

    for (let count = onto.length === 0 ? FLOP_SIZE : 1; count > 0; count--) {
      cards.push(hand.deck.pop()!);
    }

    return { board: first + offset, street: addStreet(hand, first + offset, cards), cards };
  });
}

/** What each board plays for of a pot: equal shares, with the chips that don't divide going to the first boards. */
export function potShares(hand: Boards, amount: number): number[] {
  return [...splitAmount(amount, hand.boards.map((_board, index) => index)).values()];
}
