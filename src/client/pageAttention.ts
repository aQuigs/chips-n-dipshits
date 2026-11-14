import { waysFor } from './attentionWays.ts';
import type { AttentionWays } from './attention.ts';
import type { Notices, WayParts } from './attentionWays.ts';

/** The ways as this browser offers them. */
export function pageWays(parts: Pick<WayParts, 'sounds' | 'touch' | 'root' | 'ownsTab'>): AttentionWays {
  return waysFor({
    ...parts,
    sight: {
      hidden: () => document.hidden,
      onShown: (listener) => document.addEventListener('visibilitychange', () => !document.hidden && listener()),
    },
    handheld: matchMedia('(pointer: coarse)').matches,
    vibrate: typeof navigator.vibrate === 'function' ? (pattern) => void navigator.vibrate(pattern) : null,
    notices: typeof Notification === 'function' ? browserNotices() : null,
    tab: document,
    focus: () => window.focus(),
    timers: {
      every: (ms, act) => {
        const timer = setInterval(act, ms);

        return () => clearInterval(timer);
      },
    },
  });
}

function browserNotices(): Notices {
  return {
    permission: () => Notification.permission,
    request: () => Notification.requestPermission(),
    show: (title, tag, onClick) => {
      const notice = new Notification(title, { tag });

      notice.onclick = onClick;

      return () => notice.close();
    },
  };
}
