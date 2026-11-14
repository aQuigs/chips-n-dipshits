/*
 * Which hands are bomb pots. A hand becomes one because the host called it or because the table plays
 * one every so many hands, and this is the only place that is decided.
 */
import type { BombPot, BombPotBoards, TableConfig, TableState } from './types.ts';

const BOARDS: Record<BombPotBoards, number> = { one: 1, two: 2 };

/** Whether the table's count makes the next hand dealt a bomb pot, called or not. */
function dueByCount(state: TableState): boolean {
  const { bombPotEvery } = state.config;

  return bombPotEvery > 0 && state.handsSinceBombPot + 1 >= bombPotEvery;
}

/** The bomb pot the next hand dealt would be as the table stands, or null for an ordinary hand. */
export function bombPotDue(state: TableState): BombPot | null {
  return state.bombPotCalled || dueByCount(state) ? bombPotOf(state.config) : null;
}

/** The bomb pot a table with these settings plays. */
export function bombPotOf(config: TableConfig): BombPot {
  const amount = config.bombPotAmount;
  const boards = BOARDS[config.bombPotBoards];

  return boards > 1 ? { amount, boards } : { amount };
}

/** How many boards a hand of this kind is dealt on. */
export function boardsDealt(bombPot: BombPot | null): number {
  return bombPot?.boards ?? 1;
}

/** What a bomb pot is called, as it reads inside a sentence. */
export function bombPotName(bombPot: BombPot): string {
  return boardsDealt(bombPot) > 1 ? 'double-board bomb pot' : 'bomb pot';
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
