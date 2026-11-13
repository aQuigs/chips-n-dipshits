import type { Hand, HandPlayer, TableState } from './types.ts';

export interface BettingOptions {
  canCheck: boolean;
  /** Chips a call puts in; 0 when there is nothing to call. */
  callAmount: number;
  /** What the call ends up costing once chips no opponent can match have come back. */
  callCost: number;
  canRaise: boolean;
  /** Smallest and largest total bet for the street that a raise may make. */
  minRaiseTo: number;
  maxRaiseTo: number;
}

/** What the player in a seat may do when the action is on them. */
export function bettingOptions(state: TableState, hand: Hand, player: HandPlayer): BettingOptions {
  const stack = state.seats[player.seat]!.stack;
  const owed = hand.currentBet - player.bet;
  const callAmount = Math.min(owed, stack);
  const opponents = hand.players.filter((p) => p !== player && !p.folded);

  // An all-in for less than a full raise doesn't let someone who already acted raise again
  const facingFullRaise = !player.hasActed || owed >= hand.minRaise;
  const someoneCanRespond = opponents.some((p) => !p.allIn);
  const maxRaiseTo = player.bet + stack;

  const coverable = Math.max(0, ...opponents.map((p) => p.bet + state.seats[p.seat]!.stack));
  const callCost = Math.max(0, Math.min(callAmount, coverable - player.bet));

  return {
    canCheck: owed === 0,
    callAmount,
    callCost,
    canRaise: stack > owed && facingFullRaise && someoneCanRespond,
    minRaiseTo: Math.min(hand.currentBet + hand.minRaise, maxRaiseTo),
    maxRaiseTo,
  };
}

/**
 * True when the street's betting is over: everyone still able to bet has acted and matched the bet,
 * or nobody is left who could bet against anyone.
 */
export function bettingIsClosed(hand: Hand): boolean {
  const live = hand.players.filter((p) => !p.folded);
  const active = live.filter((p) => !p.allIn);

  if (active.length === 0) {
    return true;
  }

  // The only player with chips has nothing to decide once every all-in bet is covered
  if (active.length === 1) {
    const only = active[0]!;
    const toMatch = Math.max(0, ...live.filter((p) => p !== only).map((p) => p.bet));

    if (only.bet >= toMatch) {
      return true;
    }
  }

  return active.every((p) => p.hasActed && p.bet === hand.currentBet);
}

export function owesAction(hand: Hand, player: HandPlayer): boolean {
  return !player.folded && !player.allIn && (!player.hasActed || player.bet < hand.currentBet);
}
