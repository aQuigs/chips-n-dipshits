import { reaches, roleOf } from '../../engine/hosts.ts';
import type { TableView } from '../../engine/view.ts';
import { h } from '../ui.ts';

/** The viewer may send what a handler declares `by: 'host or cohost'`. */
export const hostOrCohost = (view: TableView): boolean => reaches(view.you.role, 'host or cohost');

/** The viewer may send what a handler declares `by: 'host alone'`. */
export const hostAlone = (view: TableView): boolean => reaches(view.you.role, 'host alone');

/** The mark beside a name that says who runs the table: the host's star, or a co-host's quieter one. */
export function roleMark(view: TableView, playerId: string): HTMLElement | null {
  switch (roleOf(view, playerId)) {
    case 'host':
      return h('span.host', { title: 'Host', 'aria-label': 'Host' }, '★');
    case 'cohost':
      return h('span.cohost', { title: 'Co-host', 'aria-label': 'Co-host' }, '☆');
    default:
      return null;
  }
}
