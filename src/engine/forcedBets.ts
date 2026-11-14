import { seatsClockwiseAfter } from './seats.ts';
import type { BombPot, Post, TableState } from './types.ts';

const STRADDLE_BIG_BLINDS = 2;

/**
 * Chips a player has to put in before the cards are played. A player short of `amount` posts what
 * they have and is all in.
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
  /** Every seat dealt in, clockwise from the button's left, so the button comes last. */
  order: readonly number[];
  sbSeat: number;
  bbSeat: number;
}

/** The blinds are the two seats left of the button, except heads-up, where the button posts the small blind. */
export function positionsOf(dealtIn: readonly number[], button: number): Positions {
  const order = seatsClockwiseAfter(dealtIn, button);
  const headsUp = dealtIn.length === 2;

  return { order, sbSeat: headsUp ? button : order[0]!, bbSeat: headsUp ? order[0]! : order[1]! };
}

/**
 * Every forced bet of the hand about to be dealt, in the order they are posted, worked out from the
 * table's settings and its seats before any chips move. `bombPot` says the hand is one, which the
 * caller has settled by then.
 */
export function forcedBets(state: TableState, { order, sbSeat, bbSeat }: Positions, bombPot: BombPot | null = null): ForcedBet[] {
  // All a bomb pot asks for: no blinds, no straddle, and it takes the place of the table's ante
  if (bombPot) {
    return order.map((seat) => ({ seat, what: 'bomb pot', amount: bombPot.amount, as: 'contribution' }));
  }

  const { smallBlind, bigBlind, ante, anteFrom, allowStraddle } = state.config;
  const bets: ForcedBet[] = [];

  if (ante > 0 && anteFrom === 'everyone') {
    for (const seat of order) {
      bets.push({ seat, what: 'ante', amount: ante, as: 'contribution' });
    }
  }

  bets.push({ seat: sbSeat, what: 'small blind', amount: smallBlind, as: 'live' });
  bets.push({ seat: bbSeat, what: 'big blind', amount: bigBlind, as: 'live' });

  // After the blind, so a big blind who can't cover both posts the blind first and puts what is left toward the ante
  if (ante > 0 && anteFrom === 'bigBlind') {
    bets.push({ seat: bbSeat, what: 'big blind ante', amount: ante, as: 'dead' });
  }

  // Under the gun is the seat after the big blind, which three-handed is the button
  const underTheGun = order[2];
  const straddle = STRADDLE_BIG_BLINDS * bigBlind;
  if (allowStraddle && underTheGun !== undefined) {
    const seat = state.seats[underTheGun]!;
    const owedFirst = bets.filter((bet) => bet.seat === underTheGun).reduce((sum, bet) => sum + bet.amount, 0);

    // A straddle is posted whole or not at all
    if (seat.straddle && seat.stack - owedFirst >= straddle) {
      bets.push({ seat: underTheGun, what: 'straddle', amount: straddle, as: 'live' });
    }
  }

  return bets;
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
