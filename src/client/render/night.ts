import type { TableView } from '../../engine/view.ts';

export const nightOver = (view: TableView): boolean => view.nightEndedAt !== null;

export const onLastHand = (view: TableView): boolean => view.hand !== null && view.handsLeft === 0;

/**
 * What starting the dealing is called from where the game stands, on the table's own button and in the
 * menu alike. With a hand still on the table the game was paused during it and plays it out, so
 * starting only takes the pause back.
 */
export function startText(view: TableView): string {
  if (view.hand) {
    return 'Call off the pause';
  }

  return view.handCount === 0 ? 'Start the game' : 'Resume the game';
}

/** A count of the hands still to be dealt, as it is said wherever the night's last hands are counted. */
export const handsText = (count: number): string => `${count} more hand${count === 1 ? '' : 's'}`;

/**
 * How many hands are left tonight, or null while no last hands are called. Worded so that nobody
 * wonders whether the hand being played is one of them.
 */
export function lastHandsText(view: TableView): string | null {
  const left = view.handsLeft;

  if (left === null) {
    return null;
  }

  if (!view.hand) {
    return `${handsText(left)} to play`;
  }

  return left === 0 ? 'Last hand of the night' : `${handsText(left)} after this one`;
}
