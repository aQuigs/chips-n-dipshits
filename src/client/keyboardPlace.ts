import { controlKey } from './ui.ts';

const CONTROLS = 'button, input, select, textarea, summary, a[href]';

/**
 * Where the keyboard belongs in a part of the page that its viewer leaves and is brought back to: on
 * the control they pressed to leave it, a row's button that opens a question. And when that control is
 * gone, as the button on the row of a player just removed, on the one that does the same for the next
 * row: a list is worked down, and from the top of it the next row is a long way off. A control that is
 * folded away takes no keyboard, so the button that unfolds its part of the row stands for it.
 *
 * Only ever made for a control that opens something, which is what its like on another row does too.
 * One that plays or sends at a press must never be handed the keyboard this way: a second press of
 * Enter would do for another player what was meant for none.
 */
export class KeyboardPlace {
  /** What the control is known by, then its like on the rows after it, then those before it, nearest first. */
  private readonly nearest: string[];

  private constructor(nearest: string[]) {
    this.nearest = nearest;
  }

  /** The place of the control of `part` that `pressed` is, or is inside; null when it is in none. */
  static of(pressed: Element | null, part: Element): KeyboardPlace | null {
    const control = pressed?.closest<HTMLElement>(CONTROLS) ?? null;

    if (!control || !part.contains(control)) {
      return null;
    }

    const action = control.dataset.action;
    const alike = action === undefined ? [control] : [...part.querySelectorAll(`[data-action="${CSS.escape(action)}"]`)];
    const at = alike.indexOf(control);

    return new KeyboardPlace([...alike.slice(at), ...alike.slice(0, at).reverse()].map(controlKey));
  }

  /** The control of `part`, as it is drawn now, that the keyboard belongs on; null when none of them is left. */
  find(part: Element): HTMLElement | null {
    const drawn = new Map<string, HTMLElement>();

    for (const control of part.querySelectorAll<HTMLElement>(`:is(${CONTROLS}):not(:disabled)`)) {
      if (!drawn.has(controlKey(control))) {
        drawn.set(controlKey(control), control);
      }
    }

    const control = this.nearest.map((key) => drawn.get(key)).find((found) => found !== undefined) ?? null;
    const folded = control?.closest('[hidden]') ?? null;

    return folded === null ? control : part.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(folded.id)}"]`);
  }
}
