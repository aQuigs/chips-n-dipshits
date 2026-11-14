import type { TableEffect } from '../effects.ts';
import { playTurnChime } from '../sound.ts';

/** A chime when the action reaches the viewer. */
export function turnChime(): TableEffect {
  return {
    run({ before, view }, { prefs, seat }) {
      const myTurn = seat !== null && view.hand?.stage === 'betting' && view.hand.toAct === seat;
      const wasMyTurn = before?.hand?.stage === 'betting' && before.hand.toAct === before.you.seat && before.hand.number === view.hand?.number && before.hand.street === view.hand?.street;

      if (myTurn && !wasMyTurn && prefs.get('sound')) {
        playTurnChime();
      }
    },
  };
}
