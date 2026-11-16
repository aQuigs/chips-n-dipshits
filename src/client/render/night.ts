import type { TableView } from '../../engine/view.ts';

export const nightOver = (view: TableView): boolean => view.nightEndedAt !== null;

export const onLastHand = (view: TableView): boolean => view.hand !== null && view.handsLeft === 0;

/**
 * Whether the game has the two players it takes. Until it has, starting it is not offered: a game
 * started early deals its first hand as the second player sits down, and everyone who sits down after
 * that begins the night owing a big blind.
 */
export const enoughSeated = (view: TableView): boolean => view.seats.filter((seat) => seat !== null).length >= 2;

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

/** What the same button says it is doing while the table has not answered. */
export function startingText(view: TableView): string {
  if (view.hand) {
    return 'Calling it off…';
  }

  return view.handCount === 0 ? 'Starting…' : 'Resuming…';
}

const hands = (count: number) => `${count} more hand${count === 1 ? '' : 's'}`;

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
    return `${hands(left)} to play`;
  }

  return left === 0 ? 'Last hand of the night' : `${hands(left)} after this one`;
}
