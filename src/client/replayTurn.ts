import type { TableView } from '../engine/view.ts';
import type { TableChange } from './tableChange.ts';
import { turnArrived, turnOf } from './yourTurn.ts';

/** The way to get a replay off the table without the viewer asking. */
export interface ReplaySetAside {
  /**
   * Closes a hand being played back, with whatever it was opened from, so that the table and its
   * buttons are in front of the viewer, and keeps the step it was at for when they open it again.
   * Says whether one was open.
   */
  setAside(): boolean;
  /** Told with every view whether the game is waiting on the viewer, which a replay opened all the same says on its way out. */
  turn(mine: boolean): void;
}

/** Whether the viewer is being asked how many times to run it, which has a clock of its own and is nobody's turn. */
const picking = (view: TableView | null) => view?.hand?.canVote ?? false;

/**
 * What a view put on screen means for a hand being played back. It gets out of the way the moment the
 * game needs the viewer, for a decision or for a pick of how many times to run it: by itself, since a
 * replay left over the buttons would let the clock run out on a player who was only looking. One they
 * open while the game waits on them stays, and is told, so that its way out says so.
 */
export function replayAfter({ before, view }: Pick<TableChange, 'before' | 'view'>, replay: ReplaySetAside, toast: (message: string) => void): void {
  const needed = turnArrived(before, view) || (picking(view) && !picking(before));

  if (needed && replay.setAside()) {
    toast('Your turn. The replay will pick up where you left it.');
  }

  replay.turn(turnOf(view, view.you.seat) !== null || picking(view));
}
