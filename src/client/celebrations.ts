import { BOARD_SIZE } from '../engine/boards.ts';
import { SEAT_COUNT } from '../engine/types.ts';
import { movesSeen } from './handMoves.ts';
import { MOVE_MS } from './motion.ts';
import type { BoardCard, Move, Place } from './motion.ts';
import type { TableChange } from './tableChange.ts';

/** A player who takes at least this many big blinds from one hand gets confetti. */
export const BIG_POT_BIG_BLINDS = 50;

/** How long the last card of an all-in runout lies face down before it is turned over. */
export const FACE_DOWN_MS = 900;

/** With several boards, how long after one board's last card starts to turn the next one's does. */
export const NEXT_BOARD_MS = 550;

/** The longest the end of a hand is held back, from the view that brought it to the last card face up. */
export const MOST_SWEAT_MS = 2000;

/**
 * What a sweat leaves of the pause before the next hand once the cards are up: the pot going to the
 * winner, the confetti, and a moment to read the result. The hold shrinks to leave it.
 */
export const AFTER_SWEAT_MS = 2500;

// What a sweat leaves before the next card of a runout is dealt, when it is not the hand's last
const BEFORE_NEXT_STREET_MS = 300;

// A hold shorter than this is no beat at all, and the card simply comes face up
const LEAST_FACE_DOWN_MS = 300;

// How far through the pile's slide to the winner the confetti is thrown
const PILE_LANDING = 0.8;

/** The last card of each board, turned over in order, and how long after the view each starts to turn. */
export interface Sweat {
  turns: (BoardCard & { at: number })[];
  /** How many of the change's events come up to the cards: those after them are the result. */
  upTo: number;
}

/** A player who took a big pot. */
export interface BigPot {
  seat: number;
  /** All they took, from every pot and on every board. */
  amount: number;
}

/**
 * Whether a change brings the last card of a board in an all-in runout: everyone left is all in with
 * their cards face up, nobody has a decision to make, and the hand is about to be settled. Only the
 * very last card of each board is held, never the turn, and the hold is fitted into the time before
 * the table moves on by itself.
 */
export function sweatOf({ view, events, now }: TableChange): Sweat | null {
  const hand = view.hand;
  if (!hand || hand.deadline === null || !hand.events.some((event) => event[0] === 'runs')) {
    return null;
  }

  // A board's last card is in the street that deals it; a runout deals every card after the betting is over
  const last = events.flatMap((event, nth) => (event[0] === 'street' && event[2].includes(hand.boards[event[1]]?.[BOARD_SIZE - 1] ?? '') ? [{ board: event[1], nth }] : []));
  if (last.length === 0) {
    return null;
  }

  const turning = MOVE_MS.facedown + MOVE_MS.reveal;
  const waits = last.map((_card, nth) => FACE_DOWN_MS + nth * NEXT_BOARD_MS);
  // Counted from when the page shows the view, which a slow answer makes later than the server made it
  const room = Math.min(MOST_SWEAT_MS, hand.deadline - Math.max(now, view.now) - (hand.stage === 'done' ? AFTER_SWEAT_MS : BEFORE_NEXT_STREET_MS)) - turning;
  const shrink = Math.min(1, room / waits.at(-1)!);
  if (shrink * FACE_DOWN_MS < LEAST_FACE_DOWN_MS) {
    return null;
  }

  const turns = last.map(({ board }, nth) => ({ board, card: BOARD_SIZE - 1, at: Math.round(waits[nth]! * shrink) }));

  return { turns, upTo: last.at(-1)!.nth + 1 };
}

/**
 * The players a change pays a big pot: at least `BIG_POT_BIG_BLINDS` big blinds taken from the hand,
 * every pot and board together, each winner of a split pot by their own share. A bomb pot is big by
 * design, so what everyone put in to start it does not count toward the mark.
 */
export function bigPotsOf({ view, events }: TableChange): BigPot[] {
  const hand = view.hand;
  if (!hand) {
    return [];
  }

  const started = hand.events.reduce((sum, event) => sum + (event[0] === 'post' && event[2] === 'bomb pot' ? event[3] : 0), 0);
  const mark = BIG_POT_BIG_BLINDS * hand.bigBlind + started;
  const taken = new Map<number, number>();

  for (const event of events) {
    if (event[0] === 'win') {
      taken.set(event[1], (taken.get(event[1]) ?? 0) + event[2]);
    }
  }

  return [...taken].filter(([, amount]) => amount >= mark).map(([seat, amount]) => ({ seat, amount }));
}

/** Each last card lying face down, then turned over where it lies. */
export function sweatMoves(sweat: Sweat | null): Move[] {
  return (sweat?.turns ?? []).flatMap(({ board, card, at }): Move[] => {
    const place: Place = { at: 'board', board, card };

    return [
      { name: 'facedown', from: place, to: place, after: at },
      { name: 'reveal', to: place, after: at + MOVE_MS.facedown },
    ];
  });
}

/** A burst of confetti over each big pot's winner, thrown as their pile of chips lands. */
export function confettiMoves(change: TableChange, viewer: number | null): Move[] {
  const pots = bigPotsOf(change);
  if (pots.length === 0) {
    return [];
  }

  const piles = movesSeen(change, viewer).filter((move) => move.name === 'chips' && move.from?.at === 'pot');
  const hand = change.view.hand!.number;

  return pots.map(({ seat }) => {
    const winner: Place = { at: 'seat', seat };
    const pile = piles.find((move) => move.to.at === 'seat' && move.to.seat === seat);

    return { name: 'confetti', from: winner, to: winner, after: Math.round((pile?.after ?? 0) + MOVE_MS.chips * PILE_LANDING), seed: hand * SEAT_COUNT + seat };
  });
}

/** Everything a change celebrates on the table of the viewer at `viewer`: the sweat of the last cards, and confetti for a big pot. */
export function celebrationMoves(change: TableChange, viewer: number | null): Move[] {
  return [...sweatMoves(sweatOf(change)), ...confettiMoves(change, viewer)];
}
