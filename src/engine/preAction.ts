/*
 * A move chosen ahead of a player's turn: who may choose one, which are on offer, what each comes to
 * once the action is there, and which a bet takes off. The hand itself (`hand.ts`) keeps the choice with
 * the player's part of the hand, drops it and plays it, by the move a tap would have made. The rules are
 * in the README's house rules.
 */
import { bettingOptions, owesAction } from './betting.ts';
import type { BettingAction, BettingOptions } from './betting.ts';
import type { Hand, HandPlayer, PreAction, PreActionKind, TableState } from './types.ts';

export const PRE_ACTIONS: readonly PreActionKind[] = ['checkFold', 'check', 'call', 'callAny', 'fold'];

export function isPreAction(value: unknown): value is PreActionKind {
  return PRE_ACTIONS.includes(value as PreActionKind);
}

/** What a move chosen ahead goes by, of what its player would be offered if the action reached them now. */
export type Facing = Pick<BettingOptions, 'canCheck' | 'callAmount' | 'callCost'>;

/**
 * What the player would face if the action reached them now, or null when they have no turn to choose
 * a move for: the hand is not at its betting, they are on the clock already, they owe it no move as
 * things stand (folded, all in, or their bet matched with nobody having raised since), or the table
 * plays their turns for them (away, or giving up their seat).
 */
export function facingOf(state: TableState, hand: Hand, player: HandPlayer): Facing | null {
  const seat = state.seats[player.seat]!;
  const waiting = hand.stage === 'betting' && hand.toAct !== player.seat && owesAction(hand, player) && !seat.away && !seat.leaving;

  if (!waiting) {
    return null;
  }

  const { canCheck, callAmount, callCost } = bettingOptions(state, hand, player);

  return { canCheck, callAmount, callCost };
}

/**
 * `what` as a hand keeps it for a player who faces `facing`, or null when it is not on offer to them:
 * a check, alone or with a fold behind it, only while checking is free, and a call only while there is
 * a bet, which is the bet it is kept for.
 */
export function preActionFor(what: PreActionKind, facing: Facing): PreAction | null {
  switch (what) {
    case 'check':
    case 'checkFold':
      return facing.canCheck ? [what] : null;

    case 'call':
      return facing.canCheck ? null : [what, facing.callAmount];

    case 'callAny':
    case 'fold':
      return [what];
  }
}

/**
 * The move a pre-action comes to for a player the action has reached, who faces `facing`. Null when it
 * no longer stands for anything they chose: a check with a bet to them, or a call of another amount
 * than the one it was kept for.
 */
export function moveChosen([what, amount]: PreAction, facing: Facing): BettingAction | null {
  switch (what) {
    case 'checkFold':
      return { type: facing.canCheck ? 'check' : 'fold' };

    case 'check':
      return facing.canCheck ? { type: 'check' } : null;

    case 'call':
      return !facing.canCheck && facing.callAmount === amount ? { type: 'call' } : null;

    case 'callAny':
      return { type: facing.canCheck ? 'check' : 'call' };

    case 'fold':
      return { type: 'fold' };
  }
}

/** Whether a pre-action was chosen for one price, nothing or a bet, and so is off the moment someone bets or raises. */
export function standsForOnePrice([what]: PreAction): boolean {
  return what === 'check' || what === 'call';
}
