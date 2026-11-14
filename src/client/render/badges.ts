/* How a player's badges look wherever they are shown: the page knows them only through the list in `badges.ts`. */
import { badgeOf } from '../../engine/badges.ts';
import type { Badge, EarnedBadge } from '../../engine/badges.ts';
import { timesText } from '../tonightText.ts';
import { h } from '../ui.ts';

/** The badges this page knows, each with how many times it was earned. */
function known(badges: readonly EarnedBadge[]): { badge: Badge; times: number }[] {
  return badges.flatMap(({ id, times }) => {
    const badge = badgeOf(id);

    return badge ? [{ badge, times }] : [];
  });
}

/** A player's badges as their marks, small enough to sit beside a name; null when they have none. */
export function badgeMarks(badges: readonly EarnedBadge[]): HTMLElement | null {
  const shown = known(badges);
  if (shown.length === 0) {
    return null;
  }

  return h(
    'span.badges',
    null,
    shown.map(({ badge, times }) =>
      h('span.badge', { role: 'img', 'aria-label': `${badge.name}${timesText(times)}`, title: `${badge.name}: ${badge.description}`, 'data-badge': badge.id }, badge.mark, times > 1 ? h('small', null, `×${times}`) : null),
    ),
  );
}

/** A player's badges named and described, for where there is room; null when they have none. */
export function badgeList(badges: readonly EarnedBadge[]): HTMLElement | null {
  const shown = known(badges);
  if (shown.length === 0) {
    return null;
  }

  return h(
    'ul.badge-list',
    null,
    shown.map(({ badge, times }) => h('li', { 'data-badge': badge.id }, h('b', null, `${badge.mark} ${badge.name}${timesText(times)}`), h('small', null, badge.description))),
  );
}
