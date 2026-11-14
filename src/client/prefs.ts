import type { Card } from '../engine/cards.ts';
import { HOTKEY_LIST } from './hotkeys.ts';
import { DEFAULT_THEME, THEMES } from './themes.ts';

interface PrefBase<Kind extends string, Value> {
  kind: Kind;
  label: string;
  /** The small print under the label. */
  hint?: string;
  /** The heading it goes under in the Preferences dialog. One without a group has a control of its own elsewhere, and the dialog passes it by. */
  group?: string;
  default: Value;
  /**
   * Shows the choice on the app's own element, so a stylesheet can react to it with no script:
   * "attribute" as `data-<key>` (on or off, the option, or the number), "property" as the custom
   * property `--<key>`. The key is spelled with dashes there: `cardBack` is `data-card-back`.
   */
  css?: 'attribute' | 'property';
  /** Lines drawn under the control in the Preferences dialog, each a term and what it stands for: the keys a preference turns on, say. */
  glossary?: readonly { term: string; meaning: string }[];
}

export interface OnOffPref extends PrefBase<'onOff', boolean> {
  /** Drawn as a small switch beside the others of its group, its label alone saying what it does and its hint kept for a pointer resting on it. */
  compact?: boolean;
  /** Said in place of the hint while the device will not have it switched on. Left out, it is the browser's settings that say no. */
  blocked?: string;
}

export interface ChoicePref extends PrefBase<'choice', string> {
  options: readonly { value: string; label: string }[];
  /**
   * Cards to draw beside each option, face down where null, so a choice that changes how cards look
   * is shown rather than named. Each sample carries its option the way `css: 'attribute'` shows it,
   * so the stylesheet that draws the table draws the sample too.
   */
  preview?: readonly (Card | null)[];
}

export interface RangePref extends PrefBase<'range', number> {
  min: number;
  max: number;
  step: number;
}

export type Pref = OnOffPref | ChoicePref | RangePref;
type PrefValue = boolean | string | number;

type ValueOf<P extends Pref> = P extends OnOffPref ? boolean : P extends RangePref ? number : string;

/**
 * What each viewer may set for themselves, kept in their browser. An entry here is all a new
 * preference takes: the Preferences dialog draws its control from it, in this order.
 */
export const PREFERENCES = {
  // Chosen with the theme picker, on the front page and in the menu
  theme: { kind: 'choice', label: 'Theme', options: THEMES.map((theme) => ({ value: theme.id, label: theme.name })), default: DEFAULT_THEME },
  sound: { kind: 'onOff', label: 'Sound', hint: 'Chips, cards, and a chime when it is your turn', group: 'Sound', default: true },
  volume: { kind: 'range', label: 'Volume', hint: 'Plays a sample as you set it', group: 'Sound', min: 0, max: 100, step: 10, default: 50 },
  deck: {
    kind: 'choice',
    label: 'Deck',
    group: 'Cards',
    options: [
      { value: 'theme', label: 'Theme' },
      { value: 'two', label: 'Two colors' },
      { value: 'four', label: 'Four colors' },
    ],
    default: 'theme',
    css: 'attribute',
    preview: ['As', 'Ah', 'Ad', 'Ac'],
  },
  cardBack: {
    kind: 'choice',
    label: 'Card back',
    group: 'Cards',
    options: [
      { value: 'theme', label: 'Theme' },
      { value: 'lattice', label: 'Lattice' },
      { value: 'dots', label: 'Dots' },
      { value: 'gingham', label: 'Gingham' },
      { value: 'felt', label: 'Felt' },
    ],
    default: 'theme',
    css: 'attribute',
    preview: [null],
  },
  handHint: {
    kind: 'onOff',
    label: 'Hand hint',
    hint: 'Names what your cards make and lifts the cards that make it',
    group: 'Cards',
    default: true,
    css: 'attribute',
  },
  // A device that asks for less motion has none, whatever is chosen
  motion: {
    kind: 'onOff',
    label: 'Animations',
    hint: 'Cards are dealt around the table and chips slide to the pot',
    blocked: 'Off while this device asks for less motion',
    group: 'Cards',
    default: true,
  },
  // The ways of getting a player's attention (attentionWays.ts) beside the chime, each left out where the device can't do it.
  // After the cards, so they stay in sight when Preferences opens on a small phone
  buzz: { kind: 'onOff', label: 'Buzz', hint: 'Two short buzzes on a phone', group: 'When it’s your turn', compact: true, default: true },
  flash: { kind: 'onOff', label: 'Flash', hint: 'The table lights up for a moment', group: 'When it’s your turn', compact: true, default: true },
  notify: { kind: 'onOff', label: 'Notification', hint: 'While the game is in another tab', group: 'When it’s your turn', compact: true, default: true },
  tabTitle: { kind: 'onOff', label: 'Tab title', hint: 'The tab’s name flashes while you are in another tab', group: 'When it’s your turn', compact: true, default: true },
  // Off on a phone whatever is chosen: there the keys do nothing and no key is shown
  hotkeys: {
    kind: 'onOff',
    label: 'Keyboard shortcuts',
    hint: 'On a computer, keys for your moves, shown on the buttons',
    group: 'Keyboard',
    default: true,
    css: 'attribute',
    glossary: HOTKEY_LIST,
  },
} satisfies Record<string, Pref>;

/**
 * Whether this device can do what an on/off preference switches on. 'no' leaves the preference out of
 * the dialog; 'ask' shows it off until the player's tap gets the browser's leave; 'blocked' shows it off
 * and says what on the device will not have it.
 */
export type Ability = 'yes' | 'no' | 'ask' | 'blocked';

/** What knows the abilities of this device. A preference it knows nothing of is one any device can follow. */
export interface Abilities {
  of(key: string): Ability;
  /** Asks the browser's leave for what `key` switches on. Only from inside the player's own tap. */
  ask(key: string): Promise<Ability>;
}

/**
 * Where choices are kept between visits. The platform's `Memory` is one; only what the store uses is
 * asked for here, which also lets it be tested without a browser.
 */
export interface PrefMemory {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** The part of an element a choice is shown on. */
export interface PrefHost {
  dataset: Record<string, string | undefined>;
  style: { setProperty(name: string, value: string): void };
}

// Choices are kept under the names and in the words the page used before there was a registry
// (cnd.sound is "on" or "off", cnd.theme is the theme's id), so one made back then still holds
const KEY_PREFIX = 'cnd.';

function encode(value: PrefValue): string {
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
}

/** What a kept text stands for. Anything the preference could not have kept, as after its options changed, reads as the default. */
function decode(pref: Pref, text: string | null): PrefValue {
  switch (pref.kind) {
    case 'onOff':
      return text === 'on' ? true : text === 'off' ? false : pref.default;
    case 'choice':
      return text !== null && pref.options.some((option) => option.value === text) ? text : pref.default;
    case 'range': {
      const value = text === null || text.trim() === '' ? NaN : Number(text);

      return Number.isFinite(value) ? Math.min(pref.max, Math.max(pref.min, value)) : pref.default;
    }
  }
}

const dashed = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * One viewer's choices. A browser that refuses to keep anything, or throws when asked, costs only
 * that the choices last for the visit instead of beyond it.
 */
export class Preferences<R extends Record<string, Pref>> {
  readonly registry: R;
  private readonly memory: PrefMemory;
  private readonly host: PrefHost | null;
  private readonly chosen = new Map<string, string>();
  private readonly watchers = new Map<string, Set<(value: never) => void>>();

  /** `host` is the element the choices that ask for it are shown on. */
  constructor(registry: R, memory: PrefMemory, host: PrefHost | null = null) {
    this.registry = registry;
    this.memory = memory;
    this.host = host;

    for (const key of Object.keys(registry)) {
      this.show(key);
    }
  }

  get<K extends keyof R & string>(key: K): ValueOf<R[K]> {
    return decode(this.registry[key]!, this.kept(key)) as ValueOf<R[K]>;
  }

  set<K extends keyof R & string>(key: K, value: ValueOf<R[K]>): void {
    const text = encode(value);

    this.chosen.set(key, text);

    try {
      this.memory.set(KEY_PREFIX + key, text);
    } catch {
      // Kept for this visit only
    }

    this.show(key);

    for (const watcher of this.watchers.get(key) ?? []) {
      (watcher as (value: PrefValue) => void)(this.get(key));
    }
  }

  /** Calls `watcher` whenever the choice is made anew. Returns the way to stop. */
  watch<K extends keyof R & string>(key: K, watcher: (value: ValueOf<R[K]>) => void): () => void {
    const watchers = this.watchers.get(key) ?? new Set();

    this.watchers.set(key, watchers);
    watchers.add(watcher);

    return () => watchers.delete(watcher);
  }

  /**
   * What the browser has comes first, so a choice made in another tab of it holds here too. What was
   * chosen during this visit stands in when the browser kept nothing or throws.
   */
  private kept(key: string): string | null {
    try {
      const text = this.memory.get(KEY_PREFIX + key);
      if (text !== null) {
        return text;
      }
    } catch {
      // The same as having kept nothing
    }

    return this.chosen.get(key) ?? null;
  }

  private show(key: string): void {
    const pref = this.registry[key]!;
    if (!this.host || !pref.css) {
      return;
    }

    const text = encode(decode(pref, this.kept(key)));

    if (pref.css === 'attribute') {
      this.host.dataset[key] = text;
    } else {
      this.host.style.setProperty(`--${dashed(key)}`, text);
    }
  }
}

/** The store over the app's own registry, which is the one every part of the page is handed. */
export type AppPreferences = Preferences<typeof PREFERENCES>;
