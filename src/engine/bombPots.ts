/*
 * Which hands are bomb pots. A hand becomes one because the host called it or because the table plays
 * one every so many hands, and this is the only place that is decided.
 */
import type { BombPot, TableState } from './types.ts';

/** Whether the table's count makes the next hand dealt a bomb pot, called or not. */
function dueByCount(state: TableState): boolean {
  const { bombPotEvery } = state.config;

  return bombPotEvery > 0 && state.handsSinceBombPot + 1 >= bombPotEvery;
}

/** The bomb pot the next hand dealt would be as the table stands, or null for an ordinary hand. */
export function bombPotDue(state: TableState): BombPot | null {
  return state.bombPotCalled || dueByCount(state) ? { amount: state.config.bombPotAmount } : null;
}

/** Whether the next hand is a bomb pot only because one was called, so that calling it off makes it an ordinary hand. */
export function bombPotHangsOnCall(state: TableState): boolean {
  return state.bombPotCalled && !dueByCount(state);
}

/**
 * Settles what kind of hand is about to be dealt, for good: the hand keeps the answer, and the call or
 * the count that made it a bomb pot is used up.
 */
export function claimBombPot(state: TableState): BombPot | null {
  const bombPot = bombPotDue(state);

  state.bombPotCalled = false;

  // Not counted while bomb pots come only when called, so switching the count on starts it from the next hand
  state.handsSinceBombPot = bombPot || state.config.bombPotEvery === 0 ? 0 : state.handsSinceBombPot + 1;

  return bombPot;
}
