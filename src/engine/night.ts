/*
 * The night at a table: the last hands the host calls, and the end of the night, after which nothing is
 * dealt until play starts again. `endNight` is the only way a night ends and `restartNight` the only
 * way one starts again, so whatever has to happen at those moments goes in them.
 */
import { turnAway } from './seating.ts';
import { addFeed } from './seats.ts';
import type { Ctx, TableState } from './types.ts';
import { LIMITS, wholeNumber } from './validate.ts';

export function nightIsOver(state: TableState): boolean {
  return state.nightEndedAt !== null;
}

/** Hands still to be dealt before the night ends, not counting the one on the table; null while no last hands are called. */
export function handsLeft(state: TableState): number | null {
  return state.lastHand === null ? null : state.lastHand - state.handCount;
}

/** How the chat puts when the night ends, with `count` hands still to come and a hand on the table or not. */
function endsAfter(count: number, duringHand: boolean): string {
  if (!duringHand) {
    return `after ${count} more hand${count === 1 ? '' : 's'}`;
  }

  return count === 0 ? 'after this hand' : `after this hand and ${count} more`;
}

/**
 * Calls, changes or calls off the last hands. `hands` counts those still to be dealt, so a hand on the
 * table is not one of them, and 0 makes it the last. `by` is how the chat names whoever called them.
 */
export function callLastHands(state: TableState, ctx: Ctx, by: string, hands: unknown): void {
  if (hands === null) {
    if (state.lastHand !== null) {
      state.lastHand = null;
      addFeed(state, ctx.now, 'system', null, `${by} called off the last hands, so play goes on`);
    }
    return;
  }

  const count = wholeNumber(hands, 'The number of hands', state.hand ? 0 : 1, LIMITS.lastHands);
  const lastHand = state.handCount + count;
  if (lastHand === state.lastHand) {
    return;
  }

  const verb = state.lastHand === null ? 'calls' : 'now calls';
  state.lastHand = lastHand;
  addFeed(state, ctx.now, 'system', null, `${by} ${verb} it a night ${endsAfter(count, state.hand !== null)}`);
}

/** Called each time a dealt hand is cleared off the table, whatever kind of hand it was. */
export function countHandPlayed(state: TableState, ctx: Ctx): void {
  if (state.lastHand !== null && state.handCount >= state.lastHand) {
    endNight(state, ctx, 'That was the last hand. The night is over');
  }
}

/**
 * Ends the night, between hands: nothing is dealt, and nobody buys chips, until play starts again.
 * A called bomb pot was for a hand that now never comes, so it is called off; the count of hands toward
 * the next bomb pot is kept. Ending a night that is already over does nothing. `saying` is the chat's line.
 */
export function endNight(state: TableState, ctx: Ctx, saying: string): void {
  if (nightIsOver(state)) {
    return;
  }

  if (state.hand) {
    throw new Error('A night ends between hands');
  }

  state.nightEndedAt = ctx.now;
  state.lastHand = null;
  state.running = false;
  state.nextHandAt = null;
  addFeed(state, ctx.now, 'system', null, saying);

  if (state.bombPotCalled) {
    state.bombPotCalled = false;
    addFeed(state, ctx.now, 'system', null, 'The bomb pot that was called is off');
  }

  turnAway(
    state,
    ctx,
    () => true,
    (name, request) => `The night is over, so ${name}'s request for ${request.kind === 'seat' ? 'a seat' : 'chips'} is dropped`,
  );

  ctx.effects.push({ type: 'nightEnded', night: { at: ctx.now, tableId: state.id } });
}

/** Starts play again after the night ended, which makes it not over. `by` is how the chat names whoever did. */
export function restartNight(state: TableState, ctx: Ctx, by: string): void {
  if (!nightIsOver(state)) {
    return;
  }

  state.nightEndedAt = null;
  state.running = true;
  addFeed(state, ctx.now, 'system', null, `${by} started play again`);
}
