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
function chimeWay(sounds: Sounds): AttentionWay {
  return {
    ability: () => 'yes',
    call: (call) => sounds.play(SOUND_FOR[call.why]),
    end: () => undefined,
  };
}

// What stands for a way this device or page can't do
const UNABLE: AttentionWay = { ability: () => 'no', call: () => undefined, end: () => undefined };

/** `vibrate` is null on a device that can't. */
function buzzWay(vibrate: ((pattern: number[]) => void) | null, touch: Touch, sight: Sight): AttentionWay {
  if (!vibrate) {
    return UNABLE;
  }

  return {
    ability: () => 'yes',
    call: () => {
      // Browsers refuse it before a touch, with a warning, and ignore it out of sight
      if (touch.touched && !sight.away()) {
        vibrate(BUZZ_PATTERN);
      }
    },
    end: () => undefined,
  };
}

/** The element the flash is drawn on, as `styles/attention.css` draws it. */
interface FlashHost {
  dataset: Record<string, string | undefined>;
  /** Read only to make the browser lay out the page, so a flash that follows another starts over. */
  readonly offsetWidth: number;
}

/**
 * Marks `host` with the reason for as long as it stands. The stylesheet plays the flash once when the
 * mark appears, or shows a steady highlight for as long as it is there when motion is turned down.
 */
function flashWay(host: FlashHost): AttentionWay {
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

export interface Notices {
  permission(): Permission;
  request(): Promise<Permission>;
  /** One per `tag` at a time: a second with the same tag takes the place of the first. Returns the way to close it. */
  show(title: string, tag: string, onClick: () => void): () => void;
}

/** Brings the page's tab forward, as tapping its notification should. */
export type Focus = () => void;

const ABILITY_OF: Record<Permission, Ability> = { granted: 'yes', default: 'ask', denied: 'blocked' };

/**
 * Shows something for a call only while the player is away, and takes it back when the call ends or they
 * come back. `show` returns the way to take it back.
 */
function whileAway(sight: Sight, show: (call: Call) => () => void): Pick<AttentionWay, 'call' | 'end'> {
  let shown: { call: Call; takeBack: () => void } | null = null;

  const takeBack = () => {
    shown?.takeBack();
    shown = null;
  };

  sight.onBack(takeBack);

  return {
    call: (call) => {
      if (sight.away()) {
        takeBack();
        shown = { call, takeBack: show(call) };
      }
    },
    end: (call) => {
      if (shown?.call === call) {
        takeBack();
      }
    },
  };
}

/** `notices` is null where the page can't have them. */
function notifyWay(notices: Notices | null, sight: Sight, focus: Focus): AttentionWay {
  if (!notices) {
    return UNABLE;
  }

  return {
    ability: () => ABILITY_OF[notices.permission()],
    ask: async () => ABILITY_OF[await notices.request()],
    ...whileAway(sight, (call) => {
      const close = notices.show(WORDS_FOR[call.why](call.table.name), `cnd-${call.table.id}`, () => {
        focus();
        close();
      });

      return close;
    }),
  };
}

export interface TabTitle {
  title: string;
}

export interface Timers {
  every(ms: number, act: () => void): () => void;
}

/** The tab's title says why the page wants the player, blinking. `tab` is null where the page doesn't own it. */
function tabTitleWay(tab: TabTitle | null, sight: Sight, timers: Timers): AttentionWay {
  if (!tab) {
    return UNABLE;
  }

  return {
    ability: () => 'yes',
    ...whileAway(sight, (call) => {
      const own = tab.title;
      const words = WORDS_FOR[call.why](call.table.name);
      let swaps = 0;
      const swap = () => (tab.title = `${TITLE_MARKS[swaps++ % TITLE_MARKS.length]} ${words}`);

      swap();
      const stop = timers.every(TITLE_SWAP_MS, swap);

      return () => {
        stop();
        tab.title = own;
      };
    }),
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
