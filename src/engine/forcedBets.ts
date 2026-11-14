import { seatsClockwiseAfter } from './seats.ts';
import { straddleLine } from './straddles.ts';
import type { BombPot, PassedOver, Post, StraddlePost, TableState } from './types.ts';

/**
 * Chips a player has to put in before the cards are played. A player short of `amount` posts what
 * they have and is all in.
 *
 * `what` names the bet, and is how anything that reads the list tells one kind from another: the big
 * blind from a missed one posted beside it, say.
 *
 * `as` says how the chips count once they are in:
 * - `live`: a bet on the first street, in front of the player. It counts toward the price to call.
 * - `contribution`: straight into the pot as the player's own stake, which caps what they can win from
 *   each opponent when side pots are worked out. No part of any bet.
 * - `dead`: straight into the main pot, for whoever wins it, whatever they put in themselves.
 */
export interface ForcedBet {
  seat: number;
  what: Post;
  amount: number;
  as: 'live' | 'contribution' | 'dead';
}

/** Where the seats dealt into a hand sit. */
export interface Positions {
  /** The seat the button is on, which nobody need be playing from. */
  button: number;
  /** Every seat dealt in, clockwise from the button's left, so the button's own seat comes last when someone plays from it. */
  order: readonly number[];
  /** The seat the small blind falls on, which posts it only when it is dealt in. */
  sbSeat: number;
  bbSeat: number;
  /** Seats coming back in by posting the blinds they owe, beside the hand's own blinds. */
  posting?: readonly number[];
}

/**
 * Where the blinds fall when there is no hand before to go on from: on the two seats left of the
 * button, except heads-up, where the button posts the small blind.
 */
export function positionsOf(dealtIn: readonly number[], button: number): Positions {
  const order = seatsClockwiseAfter(dealtIn, button);
  const headsUp = dealtIn.length === 2;

  return { button, order, sbSeat: headsUp ? button : order[0]!, bbSeat: headsUp ? order[0]! : order[1]! };
}

/** The antes and the blinds of a hand that has them, missed ones included, in the order they are posted: every forced bet but the straddles. */
function antesAndBlinds(state: TableState, { order, sbSeat, bbSeat, posting = [] }: Positions): ForcedBet[] {
  const { smallBlind, bigBlind, ante, anteFrom } = state.config;
  const bets: ForcedBet[] = [];

  if (ante > 0 && anteFrom === 'everyone') {
    for (const seat of order) {
      bets.push({ seat, what: 'ante', amount: ante, as: 'contribution' });
    }
  }

  // Ahead of the blinds: a missed big blind is as big as the big blind, and the betting still has to start from the big blind's left
  for (const seat of posting) {
    const { owesBigBlind, owesSmallBlind } = state.seats[seat]!;

    // The live one first, so a player short of both has what they could post in front of them
    if (owesBigBlind) {
      bets.push({ seat, what: 'missed big blind', amount: bigBlind, as: 'live' });
    }

    if (owesSmallBlind) {
      bets.push({ seat, what: 'dead small blind', amount: smallBlind, as: 'dead' });
    }
  }

  if (order.includes(sbSeat)) {
    bets.push({ seat: sbSeat, what: 'small blind', amount: smallBlind, as: 'live' });
  }

  bets.push({ seat: bbSeat, what: 'big blind', amount: bigBlind, as: 'live' });

  // After the blind, so a big blind who can't cover both posts the blind first and puts what is left toward the ante
  if (ante > 0 && anteFrom === 'bigBlind') {
    bets.push({ seat: bbSeat, what: 'big blind ante', amount: ante, as: 'dead' });
  }

  return bets;
}

/** What the players of a hand post before the cards, with what is kept of its straddles. */
export interface HandPosts {
  /** Every forced bet, in the order they are posted. */
  bets: ForcedBet[];
  /** The straddles among them, in the same order. */
  straddles: StraddlePost[];
  /** Players who asked to straddle and post none, each with the reason. */
  passedOver: PassedOver[];
}

/**
 * Everything posted in the hand about to be dealt, worked out from the table's settings and its seats
 * before any chips move. `bombPot` says the hand is one, which the caller has settled by then.
 */
export function handPosts(state: TableState, positions: Positions, bombPot: BombPot | null = null): HandPosts {
  // All a bomb pot asks for: no blinds, no straddle, and it takes the place of the table's ante
  if (bombPot) {
    return { bets: positions.order.map((seat) => ({ seat, what: 'bomb pot', amount: bombPot.amount, as: 'contribution' })), straddles: [], passedOver: [] };
  }

  const bets = antesAndBlinds(state, positions);
  const owedFirst = (seat: number) => bets.filter((bet) => bet.seat === seat).reduce((sum, bet) => sum + bet.amount, 0);

  // A straddle has to be covered by what the antes and blinds leave its player
  const { posts: straddles, passedOver } = straddleLine(state, positions, (seat) => state.seats[seat]!.stack - owedFirst(seat));

  // After the blinds and each bigger than the last, so the last straddle is the bet the betting starts from
  return { bets: [...bets, ...straddles.map((post): ForcedBet => ({ ...post, as: 'live' }))], straddles, passedOver };
}

/** Every forced bet of the hand about to be dealt, in the order they are posted. */
export function forcedBets(state: TableState, positions: Positions, bombPot: BombPot | null = null): ForcedBet[] {
  return handPosts(state, positions, bombPot).bets;
}

/**
 * The forced bet the betting starts from: the biggest live one, and of two the same size the later, so a
 * live bet that must not move where the action starts is listed before the big blind. What it asks for
 * is the price to call and the least a raise can add, even when its player was short of it, and the
 * action starts on its left, so its player acts last before the flop. Every hand with blinds has one,
 * the big blind. A bomb pot has no live bet and so nothing to open: its betting starts on the flop.
 */
export function openingBet(bets: readonly ForcedBet[]): ForcedBet {
  const live = bets.filter((bet) => bet.as === 'live');

  return live.reduce((opening, bet) => (bet.amount >= opening.amount ? bet : opening));
}
