/**
 * The key for each button a key presses. A letter is the first letter of what its button says, and
 * is matched by what the key types, not where it sits, so it follows the player's keyboard layout.
 */
export const HOTKEYS = {
  fold: 'F',
  /** Check, or call: whichever the button says at the time. */
  pass: 'C',
  /** Goes to the amount; Enter there makes the bet or raise. */
  raise: 'R',
  /** The size buttons, in the order they are shown. */
  sizes: ['1', '2', '3', '4', '5'],
  /** How many times to run it, by the number picked: once, twice, three times. Three times starts like twice, so it is its number. */
  runs: ['O', 'T', '3'],
} as const;

/**
 * How long a key is ignored after the buttons are drawn anew, when the turn arrives or what they do
 * changes. It is about the time it takes to see the change, so a key pressed within it was meant for
 * the buttons as they were: the C meant to check that lands just as a bet turns it into a call.
 */
export const KEYS_SETTLE_MS = 500;

/** Where the keys work: a device with a mouse or trackpad, which is a device with a keyboard. Never a phone. */
export const KEYBOARD_QUERY = '(hover: hover) and (pointer: fine)';

/** The keys as the Preferences dialog lists them. */
export const HOTKEY_LIST: readonly { term: string; meaning: string }[] = [
  { term: HOTKEYS.fold, meaning: 'Fold' },
  { term: HOTKEYS.pass, meaning: 'Check or call' },
  { term: HOTKEYS.raise, meaning: 'Go to the amount: Enter bets or raises, Esc goes back' },
  { term: `${HOTKEYS.sizes[0]} to ${HOTKEYS.sizes.at(-1)}`, meaning: 'The bet sizes, in the order shown' },
  { term: HOTKEYS.runs.join(' / '), meaning: 'Run it once, twice or three times' },
];

/** Where the keyboard is: on the table, in the raise amount, or in anything else that takes typing. */
export type KeyFocus = 'table' | 'amount' | 'typing';

export interface KeyPress {
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** What is on the screen when a key is pressed. */
export interface KeyScene {
  /** The preference is on and the device has a keyboard. */
  enabled: boolean;
  focus: KeyFocus;
  dialogOpen: boolean;
  /** The keys of the buttons showing that can be pressed now. */
  keys: { has(key: string): boolean };
  /** How long ago the buttons were drawn. */
  sinceDrawn: number;
}

/** Press the button with this key, put the keyboard in the raise amount, or take it back out to the table. */
export type KeyAction = { kind: 'press'; key: string } | { kind: 'aim' } | { kind: 'leave' };

/** What kind of place an element holding the keyboard is. A slider takes no letters or digits, so it is the table's. */
export function focusOf(element: { tagName: string; id: string; type?: string; isContentEditable: boolean } | null): KeyFocus {
  if (!element) {
    return 'table';
  }

  if (element.id === 'raise-amount') {
    return 'amount';
  }

  if (element.tagName === 'INPUT' && element.type === 'range') {
    return 'table';
  }

  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable ? 'typing' : 'table';
}

/** What a key press means, if anything. */
export function keyAction(press: KeyPress, scene: KeyScene): KeyAction | null {
  // A held modifier makes it the browser's key, and a held key repeating is not a second press
  if (!scene.enabled || scene.dialogOpen || press.repeat || press.ctrlKey || press.metaKey || press.altKey || scene.focus === 'typing') {
    return null;
  }

  const settled = scene.sinceDrawn >= KEYS_SETTLE_MS;

  if (scene.focus === 'amount') {
    if (press.key === 'Escape') {
      return { kind: 'leave' };
    }

    return press.key === 'Enter' && settled && scene.keys.has(HOTKEYS.raise) ? { kind: 'press', key: HOTKEYS.raise } : null;
  }

  const key = press.key.length === 1 ? press.key.toUpperCase() : '';

  if (!settled || !scene.keys.has(key)) {
    return null;
  }

  return key === HOTKEYS.raise ? { kind: 'aim' } : { kind: 'press', key };
}
