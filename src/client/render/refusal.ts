import type { RefusalPlace } from '../connection.ts';
import { h } from '../ui.ts';

/** Finds the boxes a refusal is about, by its words. None where it is about no box of the form. */
export type Faults = (reason: string) => HTMLElement[];

export interface RefusalLine {
  /**
   * Starts a try. What the last one was told goes out of sight, and what comes back is the place to hand
   * along with this one's request: it says the reason here and marks the boxes `at` finds for it.
   */
  trying(at?: Faults): RefusalPlace;
  /** Takes the line off the page: for a form that stays up once a try went through, where room kept for words that are gone would be a gap. */
  done(): void;
}

let made = 0;

/**
 * The line just above a form's button that says why what the form asked for did not go. A toast is gone
 * in seconds, at the far end of the screen from the button just pressed, and the form may be scrolled a
 * long way from the box at fault. This is where the eye already is and stays until the next try, with the
 * boxes it is about marked and the first of them brought into sight. While a box is marked the line keeps in
 * sight with it (`pointing`, refusal.css), until the box is typed over or the form takes it away.
 *
 * It is put on the page when it first has something to say: above `button`, or `under` it for a form whose
 * box and button share a row, which then stays as it is. `byItself` makes a change that an answer brings
 * about and not the player (`TapGuard`), which the line coming up is.
 *
 * It is no live region: the page says the reason to a screen reader once, and a line that was one would be
 * read again whenever the form around it was drawn again.
 */
export function refusalLine(button: HTMLButtonElement, byItself: (change: () => void) => void, under = false): RefusalLine {
  const element = h('p.refusal', { id: `refusal-${++made}` });
  let marked: HTMLElement[] = [];

  /** Whether a box is read out with the line, beside whatever else describes it. */
  const describes = (box: HTMLElement, does: boolean): void => {
    const others = (box.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '' && id !== element.id);
    const ids = does ? [...others, element.id] : others;

    if (ids.length > 0) {
      box.setAttribute('aria-describedby', ids.join(' '));
    } else {
      box.removeAttribute('aria-describedby');
    }
  };

  const unmark = (box: HTMLElement): void => {
    box.removeAttribute('aria-invalid');
    describes(box, false);
    marked = marked.filter((other) => other !== box);
    element.classList.toggle('pointing', marked.length > 0);
  };

  // A box typed over is no longer what was refused, and one the form has since taken away or put out of sight,
  // as a preset picked does to every box of the settings, leaves the line nothing to point at
  const settle = (event: Event): void => {
    for (const box of marked) {
      if ((event.type === 'input' && event.target === box) || !box.isConnected || box.closest('[hidden]')) {
        unmark(box);
      }
    }
  };

  const say = (reason: string, boxes: HTMLElement[]): void => {
    if (!element.isConnected) {
      button[under ? 'after' : 'before'](element);

      for (const change of ['input', 'change', 'click']) {
        button.form?.addEventListener(change, settle);
      }
    }

    element.textContent = reason;
    element.classList.remove('stale');
    element.classList.toggle('pointing', boxes.length > 0);
    marked = boxes;

    for (const box of boxes) {
      box.setAttribute('aria-invalid', 'true');
      describes(box, true);
    }

    // Only as far as it takes, so what is in sight already stays where it is. The line first: the box, with the label over
    // it, has the last word, and a line left below it then keeps to the foot of what is showing (refusal.css)
    element.scrollIntoView({ block: 'nearest' });
    (boxes[0]?.closest('.field') ?? boxes[0])?.scrollIntoView({ block: 'nearest' });
  };

  return {
    trying(at) {
      element.classList.add('stale');
      marked.forEach(unmark);

      return (reason) => {
        // A form that is gone by the time of the answer has nowhere to say it
        if (!button.isConnected) {
          return false;
        }

        byItself(() => say(reason, at?.(reason) ?? []));

        return true;
      };
    },

    done() {
      if (element.isConnected) {
        byItself(() => element.remove());
      }
    },
  };
}
