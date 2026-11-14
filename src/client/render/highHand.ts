/* How the high hand shows on the table: a mark beside the name of whoever holds it. */
import { HIGH_HAND_MARK } from '../../engine/highHand.ts';
import type { TableView } from '../../engine/view.ts';
import { h } from '../ui.ts';

/** The mark beside the name of a player who holds the high hand the bonus is paid for next; null for anyone else. */
export function highHandMark(view: TableView, playerId: string): HTMLElement | null {
  const next = view.tonight.highHand.next;
  if (!next?.playerIds.includes(playerId)) {
    return null;
  }

  const said = `Holds the high hand: ${next.name}`;

  return h('span.high-hand', { role: 'img', title: said, 'aria-label': said }, HIGH_HAND_MARK);
}
