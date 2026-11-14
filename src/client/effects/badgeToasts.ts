import type { TableEffect } from '../effects.ts';
import { badgeText } from '../tonightText.ts';

/**
 * Tells a player of a badge they have just earned, in a toast: one for all they earned at once.
 * Everyone else, watchers too, reads it in the play-by-play.
 */
export function badgeToasts(): TableEffect {
  return {
    run({ earned, view }, { toast }) {
      const mine = earned.filter((news) => news.playerId === view.you.id).map((news) => badgeText(news.badge)).filter(Boolean);

      if (mine.length > 0) {
        toast(`You earned ${mine.length < 2 ? mine.join('') : `${mine.slice(0, -1).join(', ')} and ${mine.at(-1)}`}`);
      }
    },
  };
}
