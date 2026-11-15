/*
 * The moves a player can choose ahead of their turn (pre-actions), as the page words them and offers
 * them. What each one does is the engine's to say (`engine/preAction.ts`).
 */
import { formatAmount } from '../engine/amounts.ts';
import type { Denominated } from '../engine/amounts.ts';
import type { HandEvent } from '../engine/events.ts';
import { moveChosen, standsForOnePrice } from '../engine/preAction.ts';
import type { Facing } from '../engine/preAction.ts';
import type { PreAction, PreActionKind } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';
import type { TableChange } from './tableChange.ts';

/**
 * Every choice in the order the page lays them out, from giving the hand up to paying whatever it
 * costs. Each has its place whether or not it is on offer: a bet that changes what is on offer must
 * not slide another choice under a finger already on its way down.
 */
export const AHEAD_ORDER: readonly PreActionKind[] = ['fold', 'checkFold', 'check', 'call', 'callAny'];

const NAMES: Record<PreActionKind, string> = { checkFold: 'Check/Fold', check: 'Check', call: 'Call', callAny: 'Call any', fold: 'Fold' };

/**
 * What a choice is called, as two pieces: the move, and for a call its amount, which is what the call
 * ends up costing, as on the button of the turn. Calling anything says that it checks while there is
 * nothing to call, and a call that takes the whole stack says so.
 */
export function aheadLabel(what: PreActionKind, facing: Facing, stack: number): { move: string; amount: number | null } {
  if (what === 'call' && !facing.canCheck) {
    return { move: facing.callAmount >= stack ? 'Call all in' : 'Call', amount: facing.callCost };
  }

  return { move: what === 'callAny' && facing.canCheck ? 'Check/Call any' : NAMES[what], amount: null };
}

/** The move of `seat` among `events` that only the table can have made, the player having been waiting for the action: null when they made none. */
export function moveMadeFor(events: readonly HandEvent[], seat: number | null): HandEvent | null {
  return events.find((event) => (event[0] === 'fold' || event[0] === 'check' || event[0] === 'call') && event[1] === seat) ?? null;
}

/**
 * Whether the move the table made for the viewer is the one the choice on their screen stood for:
 * `before` is what the screen was showing, and `events` what has happened since, `made` among them.
 */
function madeAsShown(before: TableView, events: readonly HandEvent[], made: HandEvent): boolean {
  const shown = before.preAction;
  const facing = before.hand?.ahead;

  if (!shown || !facing) {
    return false;
  }

  // A bet since the screen was drawn is a new price: a check or a call chosen for the old one is off, and the rest pay it or fold
  const raised = events.slice(0, events.indexOf(made)).some((event) => event[0] === 'bet' || event[0] === 'raise');
  const stoodFor = raised ? (standsForOnePrice(shown) ? null : moveChosen(shown, { ...facing, canCheck: false })) : moveChosen(shown, facing);

  return stoodFor?.type === made[0];
}

const named = ([what, amount]: PreAction, table: Denominated) => `${NAMES[what]}${amount === undefined ? '' : ` ${formatAmount(amount, table)}`}`;

/**
 * The choice came off without being made, and the player still has their turn to come or in front of
 * them: on the screen the control only stops looking pressed, which nobody hears.
 */
function droppedLine({ before, view, madeAhead }: TableChange): string | null {
  const chosen = before?.preAction ?? null;
  const hand = view.hand;
  const stillToAct = hand !== null && (hand.ahead !== null || hand.options !== null || hand.canAnswerChop);

  return chosen && !view.preAction && stillToAct && !madeAhead ? `${named(chosen, view.config)} is no longer set for your turn.` : null;
}

/** Whether the hand made this move for a player it does not wait for, who is away or giving up their seat: no choice of theirs, made ahead or otherwise. */
const unasked = (move: HandEvent): boolean => (move[0] === 'fold' || move[0] === 'check') && move[2] === true;

/**
 * The table made another move than the choice on screen stood for: they had changed it or taken it back,
 * and that got there too late. A move the hand made unasked is not that: the player stood up, here or on
 * another device, or was taken from their seat, the choice came off with the seat, and nothing was late.
 */
function tooLateLine({ before, events, madeAhead }: TableChange): string | null {
  return madeAhead && before && !unasked(madeAhead) && !madeAsShown(before, events, madeAhead) ? `That came too late: your ${madeAhead[0]} was already made.` : null;
}

/**
 * The table has a move set that the screen did not show: a choice that reached it after the page had
 * given up on it, or one made on another device. Never one tapped here, which shows from the tap.
 */
function newlySetLine({ before, view }: TableChange): string | null {
  const chosen = view.preAction;
  const shown = before?.preAction ?? null;

  return before && chosen && (shown?.[0] !== chosen[0] || shown[1] !== chosen[1]) ? `${named(chosen, view.config)} is set for your turn.` : null;
}

/**
 * What a view tells a player about the move they chose ahead that the screen alone does not: `spoken`
 * to a screen reader only, `shown` to everyone. Null for nothing to tell.
 */
export function aheadLines(change: TableChange): { spoken: string | null; shown: string | null } {
  return { spoken: droppedLine(change), shown: tooLateLine(change) ?? newlySetLine(change) };
}
