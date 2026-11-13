import type { TableView } from '../../engine/view.ts';
import { h } from '../ui.ts';

/** The mark beside a name that says who runs the table: the host's star, or a co-host's quieter one. */
export function roleMark(view: TableView, playerId: string): HTMLElement | null {
  if (playerId === view.hostId) {
    return h('span.host', { title: 'Host', 'aria-label': 'Host' }, '★');
  }

  if (view.cohostIds.includes(playerId)) {
    return h('span.cohost', { title: 'Co-host', 'aria-label': 'Co-host' }, '☆');
  }

  return null;
}
