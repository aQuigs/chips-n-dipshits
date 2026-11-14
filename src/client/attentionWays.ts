import type { AttentionWay, AttentionWays, Call, Why } from './attention.ts';
import type { Ability } from './prefs.ts';
import type { SoundName, Sounds } from './sound.ts';
import type { Touch } from './touch.ts';

const SOUND_FOR: Record<Why, SoundName> = { turn: 'turn' };

/** What a notification or the tab's title says, which is all a lock screen shows: no cards, no amounts. */
const WORDS_FOR: Record<Why, (table: string) => string> = { turn: (table) => `Your turn at ${table}` };

// Two short pulses: one is easy to take for the phone settling on the table
export const BUZZ_PATTERN = [120, 80, 120];

// The tab's title changes this often, about as fast as a glance away notices without it being a strobe
export const TITLE_SWAP_MS = 1000;

// The title blinks between these in front of the words. Both say it is the player's turn, so a browser
// that runs the swaps of a tab long out of sight only once a minute still shows it
const TITLE_MARKS = ['●', '○'];

/** Whether the player is away from the page, and word of when they come back. */
export interface Sight {
  /** Out of sight, as in another tab or on a phone asleep, or behind another window. */
  away(): boolean;
  onBack(listener: () => void): void;
}

/** The chime, through the sounds, which hold it to the sound switch and volume. */
export function chimeWay(sounds: Sounds): AttentionWay {
  return {
    ability: () => 'yes',
    call: (call) => sounds.play(SOUND_FOR[call.why]),
    end: () => undefined,
  };
}

/** `vibrate` is null on a device that can't. */
export function buzzWay(vibrate: ((pattern: number[]) => void) | null, touch: Touch, sight: Sight): AttentionWay {
  return {
    ability: () => (vibrate ? 'yes' : 'no'),
    call: () => {
      // Browsers refuse it before a touch, with a warning, and ignore it out of sight
      if (vibrate && touch.touched && !sight.away()) {
        vibrate(BUZZ_PATTERN);
      }
    },
    end: () => undefined,
  };
}

/** The element the flash is drawn on, as `styles/attention.css` draws it. */
export interface FlashHost {
  dataset: Record<string, string | undefined>;
  /** Read only to make the browser lay out the page, so a flash that follows another starts over. */
  readonly offsetWidth: number;
}

/**
 * Marks `host` with the reason for as long as it stands. The stylesheet plays the flash once when the
 * mark appears, or shows a steady highlight for as long as it is there when motion is turned down.
 */
export function flashWay(host: FlashHost): AttentionWay {
  return {
    ability: () => 'yes',
    call: (call) => {
      delete host.dataset.attention;
      void host.offsetWidth;
      host.dataset.attention = call.why;
    },
    end: () => void delete host.dataset.attention,
  };
}

/** What the browser says to notifications from the page, as `Notification.permission` has it. */
export type Permission = 'granted' | 'default' | 'denied';

/** The browser's notifications. */
export interface Notices {
  permission(): Permission;
  request(): Promise<Permission>;
  /** One per `tag` at a time: a second with the same tag takes the place of the first. Returns the way to close it. */
  show(title: string, tag: string, onClick: () => void): () => void;
}

/** Brings the page's tab forward, as tapping its notification should. */
export type Focus = () => void;

const ABILITY_OF: Record<Permission, Ability> = { granted: 'yes', default: 'ask', denied: 'blocked' };

/** A notification while the player is away, taken back when the call ends or the player comes back. `notices` is null where the page can't have them. */
export function notifyWay(notices: Notices | null, sight: Sight, focus: Focus): AttentionWay {
  let shown: { call: Call; close: () => void } | null = null;

  const close = () => {
    shown?.close();
    shown = null;
  };

  sight.onBack(close);

  return {
    ability: () => (notices ? ABILITY_OF[notices.permission()] : 'no'),
    ask: async () => (notices ? ABILITY_OF[await notices.request()] : 'no'),
    call: (call) => {
      if (!notices || !sight.away()) {
        return;
      }

      close();

      shown = {
        call,
        close: notices.show(WORDS_FOR[call.why](call.table.name), `cnd-${call.table.id}`, () => {
          focus();
          close();
        }),
      };
    },
    end: (call) => {
      if (shown && shown.call.why === call.why && shown.call.table.id === call.table.id) {
        close();
      }
    },
  };
}

/** The tab's title. */
export interface TabTitle {
  title: string;
}

export interface Timers {
  every(ms: number, act: () => void): () => void;
}

/** While the player is away, the tab's title says why the page wants them, blinking, until they come back. `tab` is null where the page doesn't own it. */
export function tabTitleWay(tab: TabTitle | null, sight: Sight, timers: Timers): AttentionWay {
  let showing: { call: Call; own: string; stop: () => void } | null = null;

  const restore = () => {
    if (showing && tab) {
      showing.stop();
      tab.title = showing.own;
    }

    showing = null;
  };

  sight.onBack(restore);

  return {
    ability: () => (tab ? 'yes' : 'no'),
    call: (call) => {
      if (!tab || !sight.away()) {
        return;
      }

      restore();

      const own = tab.title;
      const words = WORDS_FOR[call.why](call.table.name);
      let swaps = 0;
      const swap = () => (tab.title = `${TITLE_MARKS[swaps++ % TITLE_MARKS.length]} ${words}`);

      swap();
      showing = { call, own, stop: timers.every(TITLE_SWAP_MS, swap) };
    },
    end: (call) => {
      if (showing?.call.why === call.why && showing.call.table.id === call.table.id) {
        restore();
      }
    },
  };
}

/** What the ways are made from: the page's sounds and element, and what the browser offers, each null where it has none. */
export interface WayParts {
  sounds: Sounds;
  touch: Touch;
  /** The app's own element, which the flash marks. */
  root: FlashHost;
  sight: Sight;
  /** False in a frame of another site, such as Google's, where the page may neither name the tab nor ask for notifications. */
  ownsTab: boolean;
  /** A phone or a tablet, held in the hand or lying on the table. */
  handheld: boolean;
  vibrate: ((pattern: number[]) => void) | null;
  notices: Notices | null;
  tab: TabTitle;
  focus: Focus;
  timers: Timers;
}

/** Every way, each with what it needs only where this browser and this page can do it. */
export function waysFor(parts: WayParts): AttentionWays {
  const { sight, ownsTab, handheld } = parts;

  return {
    sound: chimeWay(parts.sounds),
    // Desktop browsers have the call but nothing to buzz
    buzz: buzzWay(handheld ? parts.vibrate : null, parts.touch, sight),
    flash: flashWay(parts.root),
    // A phone's browser shows notifications only from a service worker, which the page doesn't have
    notify: notifyWay(ownsTab && !handheld ? parts.notices : null, sight, parts.focus),
    tabTitle: tabTitleWay(ownsTab ? parts.tab : null, sight, parts.timers),
  };
}
