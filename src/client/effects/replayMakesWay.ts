import type { TableEffect } from '../effects.ts';
import { replayAfter } from '../replayTurn.ts';

/** A hand being played back makes way for the viewer's turn. */
export function replayMakesWay(): TableEffect {
  return { run: (change, { replay, toast }) => replayAfter(change, replay, toast) };
}
