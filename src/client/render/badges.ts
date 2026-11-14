/* How a player's badges look wherever they are shown: the page knows them only through the list in `badges.ts`. */
import { badgeOf } from '../../engine/badges.ts';
import type { EarnedBadge } from '../../engine/badges.ts';
import { badgeText, timesText } from '../tonightText.ts';
import { h } from '../ui.ts';

/** A player's badges as their marks, small enough to sit beside a name; null when they have none. */
export function badgeMarks(badges: readonly EarnedBadge[]): HTMLElement | null {
  if (badges.length === 0) {
    return null;
  }

  return h(
    'span.badges',
    null,
    badges.map(({ id, times }) => {
      const badge = badgeOf(id)!;

      return h('span.badge', { role: 'img', 'aria-label': `${badge.name}${timesText(times)}`, title: `${badge.name}: ${badge.description}`, 'data-badge': id }, badge.mark, times > 1 ? h('small', null, `×${times}`) : null);
    }),
  );
}

/** A player's badges named and described, for where there is room; null when they have none. */
export function badgeList(badges: readonly EarnedBadge[]): HTMLElement | null {
  if (badges.length === 0) {
    return null;
  }

  return h(
    'ul.badge-list',
    null,
    badges.map((earned) => h('li', { 'data-badge': earned.id }, h('b', null, badgeText(earned)), h('small', null, badgeOf(earned.id)!.description))),
  );
}
