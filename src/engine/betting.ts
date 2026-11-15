import { formatAmount } from './amounts.ts';
import type { Denominated } from './amounts.ts';
import { clockwiseAfter } from './seats.ts';
import type { Hand, HandPlayer, TableState } from './types.ts';

export type BettingAction = { type: 'fold' } | { type: 'check' } | { type: 'call' } | { type: 'raise'; to: number };

/** What the rules of a betting round ask of a player in it. */
export interface Bettor {
  seat: number;
  /** Chips put in on the current street. */
  bet: number;
  folded: boolean;
  allIn: boolean;
  /** Has acted on the current street; blinds don't count. */
  hasActed: boolean;
}

/**
 * A round of betting as its rules see it. A hand is one, and so is what a player's view shows of a
 * hand, which is how the page works out where its own move leaves the action by the engine's rule.
 */
export interface BettingRound<P extends Bettor = Bettor> {
  players: readonly P[];
  currentBet: number;
}

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
 * Why a player with these options may not make this move, in words for them; null when they may.
 * `currentBet` is the bet they face.
 */
export function objectionTo(action: BettingAction, options: BettingOptions, currentBet: number, table: Denominated): string | null {
  switch (action.type) {
    case 'fold':
      return null;

    case 'check':
      return options.canCheck ? null : `You can't check, there is a bet of ${formatAmount(currentBet, table)} to you`;

    case 'call':
      return options.canCheck ? 'There is nothing to call' : null;

    case 'raise': {
      if (!options.canRaise) {
        return "You can't raise here";
      }

      const { to } = action;
      const inRange = Number.isInteger(to) && to >= options.minRaiseTo && to <= options.maxRaiseTo;

      return inRange ? null : `A raise here must be between ${formatAmount(options.minRaiseTo, table)} and ${formatAmount(options.maxRaiseTo, table)}`;
    }
  }
}

/** The chips a move takes from the stack of a player with these options and `bet` in front of them already. */
export function chipsFor(action: BettingAction, options: BettingOptions, bet: number): number {
  switch (action.type) {
    case 'call':
      return options.callAmount;

    case 'raise':
      return action.to - bet;

    default:
      return 0;
  }
}

/**
 * True when the street's betting is over: everyone still able to bet has acted and matched the bet,
 * or nobody is left who could bet against anyone.
 */
export function bettingIsClosed(hand: BettingRound): boolean {
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

export function owesAction(hand: BettingRound, player: Bettor): boolean {
  return !player.folded && !player.allIn && (!player.hasActed || player.bet < hand.currentBet);
}

/**
 * Who the action passes to from `seat`, whose player has just acted. Null when it passes to nobody:
 * one player is left in the hand, or the street's betting is over.
 */
export function passesTo<P extends Bettor>(hand: BettingRound<P>, seat: number): P | null {
  if (hand.players.filter((p) => !p.folded).length <= 1 || bettingIsClosed(hand)) {
    return null;
  }

  return clockwiseAfter(hand.players, seat).find((p) => owesAction(hand, p)) ?? null;
}

/** The seat on the clock: deciding a bet, or answering an offer to chop the blinds. Null while the hand waits for nobody in particular. */
export function onTheClock(hand: { stage: Hand['stage']; toAct: number | null }): number | null {
  return hand.stage === 'betting' || hand.stage === 'chop' ? hand.toAct : null;
}
