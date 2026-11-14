import type { TableView } from '../../engine/view.ts';

export const nightOver = (view: TableView): boolean => view.nightEndedAt !== null;

export const onLastHand = (view: TableView): boolean => view.hand !== null && view.handsLeft === 0;

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
