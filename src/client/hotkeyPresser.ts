import { focusOf, KEYBOARD_QUERY, keyAction } from './hotkeys.ts';
import type { AppPreferences } from './prefs.ts';

/** What the keys need from the page they work in. */
export interface KeyHost {
  /** The element the app is drawn in. Keys are its own only while the keyboard is in it or nowhere, since a page can hold two apps. */
  root: HTMLElement;
  /** The bar under the table, which holds the buttons the keys press; null away from a table. */
  controls(): HTMLElement | null;
  dialogOpen(): boolean;
}

/**
 * Turns key presses into presses of the buttons under the table. A key clicks the very button a tap
 * would, so a move sent by key goes the way a tapped one does, turn lock and all; a locked button is
 * disabled, and a click on it is no click.
 */
export class HotkeyPresser {
  private readonly prefs: AppPreferences;
  private readonly host: KeyHost;
  private readonly keyboard = matchMedia(KEYBOARD_QUERY);
  private drawnAt = -Infinity;

  constructor(prefs: AppPreferences, host: KeyHost) {
    this.prefs = prefs;
    this.host = host;
  }

  /** Call whenever the buttons under the table may be new to the player: drawn anew, or uncovered by a dialog or a hidden tab. */
  shown(): void {
    this.drawnAt = performance.now();
  }

  /** For the page's keydown. */
  handle(event: KeyboardEvent): void {
    const controls = this.host.controls();
    const active = document.activeElement as HTMLElement | null;
    if (!controls || (active && active !== document.body && !this.host.root.contains(active))) {
      return;
    }

    const buttons = new Map([...controls.querySelectorAll<HTMLButtonElement>('.turn button[data-hotkey]:enabled')].map((button) => [button.dataset.hotkey!, button]));
    const action = keyAction(event, {
      enabled: this.prefs.get('hotkeys') && this.keyboard.matches,
      focus: focusOf(active as HTMLInputElement | null),
      dialogOpen: this.host.dialogOpen(),
      keys: buttons,
      sinceDrawn: performance.now() - this.drawnAt,
    });

    if (!action) {
      return;
    }

    // The key is spent: R would otherwise be typed into the amount it just went to, and Enter or Escape handled twice
    event.preventDefault();

    if (action.kind === 'press') {
      const button = buttons.get(action.key);

      // Focus first, as a tap does: leaving the amount puts the bet it will make in the box, where a typed 5 becomes the smallest raise
      button?.focus();
      button?.click();
    } else if (action.kind === 'aim') {
      const amount = controls.querySelector<HTMLInputElement>('#raise-amount');

      amount?.focus();
      amount?.select();
    } else {
      active?.blur();
    }
  }
}
