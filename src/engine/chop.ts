/*
 * When a hand can be chopped and how a big blind answers without being asked; the hand itself (`hand.ts`)
 * makes the offer, takes the answer and ends the hand, through the same end as any other. The rules are
 * in the README's house rules.
 */
import type { Hand, HandPlayer, Seat, TableState } from './types.ts';

/** In the hand as a blind posted in full, and nothing else: not an ante, a missed blind or a raise. */
function postedTheBlindAlone(player: HandPlayer | undefined, blind: number): boolean {
  return player !== undefined && !player.folded && player.committed === blind && player.bet === blind && player.dead === 0;
}

/**
 * The hand as it stands could be chopped: a hand with blinds dealt to three players or more, before the
 * flop, where every player but the two blinds has folded and the pot is exactly the two blinds as posted.
 * Nothing else is in it: no ante of either kind, no straddle, no missed blind live or dead, and no chip of
 * anyone who folded. Both blinds posted in full, so a blind all in for less, and a hand with no small blind,
 * can't be chopped.
 */
export function blindsOnly(hand: Hand, folding: number | null = null): boolean {
  const small = hand.players.find((player) => player.seat === hand.sbSeat);
  const big = hand.players.find((player) => player.seat === hand.bbSeat);
  const others = hand.players.filter((player) => player !== small && player !== big);

  if (hand.bombPot || hand.street !== 'preflop' || hand.players.length < 3 || hand.straddles.length > 0) {
    return false;
  }

  return postedTheBlindAlone(small, hand.smallBlind) && postedTheBlindAlone(big, hand.bigBlind) && others.every((player) => (player.folded || player.seat === folding) && player.committed === 0 && player.dead === 0);
}

/** The hand's small blind could offer a chop once the action is on them: the table allows it, the hand is `blindsOnly`, and nobody has offered one in it. */
function chopIsOpen(state: TableState, hand: Hand, folding: number | null = null): boolean {
  return state.config.allowChop && hand.stage === 'betting' && !hand.chopOffered && blindsOnly(hand, folding);
}

const bothAlwaysChop = (state: TableState, hand: Hand) => [hand.sbSeat, hand.bbSeat].every((blind) => state.seats[blind]?.alwaysChop === true);

/** The player in `seat` may offer a chop now: they are the small blind, on the clock, and the chop is open. */
export function mayOfferChop(state: TableState, seat: number): boolean {
  const hand = state.hand;

  return hand !== null && hand.toAct === seat && seat === hand.sbSeat && chopIsOpen(state, hand);
}

/** The action is reaching `seat`, and the hand is chopped then and there because both blinds always chop. */
export function chopsUnasked(state: TableState, hand: Hand, seat: number): boolean {
  return seat === hand.sbSeat && chopIsOpen(state, hand) && bothAlwaysChop(state, hand);
}

/** The player on the clock in `seat` folding would chop the hand then and there: they are the last in but the blinds, and both blinds always chop. */
export function foldChops(state: TableState, seat: number): boolean {
  const hand = state.hand;

  return hand !== null && hand.toAct === seat && seat !== hand.sbSeat && seat !== hand.bbSeat && chopIsOpen(state, hand, seat) && bothAlwaysChop(state, hand);
}

/**
 * How a big blind answers an offer without being asked: yes when they always chop, no when they are
 * away or leaving, as anything else they would be asked is checked or folded for them; null when they are asked.
 */
export function answerUnasked(seat: Seat): boolean | null {
  if (seat.alwaysChop) {
    return true;
  }

  return seat.away || seat.leaving ? false : null;
}

/** Takes back every player's standing choice to chop, as the table stops allowing chops, so allowing them again starts from nobody chopping unasked. */
export function stopChoppingUnasked(state: TableState): void {
  for (const seat of state.seats) {
    if (seat) {
      seat.alwaysChop = false;
    }
  }
}
