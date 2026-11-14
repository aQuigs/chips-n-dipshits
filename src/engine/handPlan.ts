/*
 * The hand about to be dealt, decided from the table as it stands before a card or a chip moves:
 * where the button is, who is dealt in and what each of them has to post. Nothing else decides any
 * of it; `startHand` carries the plan out.
 */
import type { Rng } from './cards.ts';
import { forcedBets, positionsOf } from './forcedBets.ts';
import type { ForcedBet, Positions } from './forcedBets.ts';
import { eligibleSeats, seatsClockwiseAfter } from './seats.ts';
import type { BombPot, TableState } from './types.ts';

export interface HandPlan extends Positions {
  button: number;
  /** Every forced bet of the hand, in the order they are posted. */
  bets: ForcedBet[];
}

/**
 * Plans the next hand for a table with at least two players able to play. `bombPot` says the hand is
 * one, which the caller has settled by then. Reads the table and changes nothing; `rng` is drawn from
 * only when there is no button to move on from.
 */
export function planHand(state: TableState, bombPot: BombPot | null, rng: Rng): HandPlan {
  const seats = eligibleSeats(state);
  const button = state.buttonSeat === null ? seats[rng.int(seats.length)]! : seatsClockwiseAfter(seats, state.buttonSeat)[0]!;
  const positions = positionsOf(seats, button);

  return { button, ...positions, bets: forcedBets(state, positions, bombPot) };
}
