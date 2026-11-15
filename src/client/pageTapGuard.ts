import { holds, stillAimedAt } from './tapGuard.ts';
import type { Box, Drawing, Hold, Spot } from './tapGuard.ts';
import { controlKey } from './ui.ts';
import type { Redrawn } from './ui.ts';

/**
 * The mark on a control that takes no tap yet. The stylesheet makes it so (base.css). A class, which is
 * no part of what a control is known by (`controlKey`): a control held back is the same control.
 */
const SETTLING = 'taps-settling';

/** Everything on a page that takes a tap. */
const TAPPED = 'button, input, select, textarea, a[href], summary, [role="switch"], [role="button"]';

/** What lies behind a dialog and closes it when tapped. It takes that tap only around the dialog. */
const BACKDROP = '.overlay';

/** The sizes of a bet play nothing, only the button beside them does: one of them under a finger costs nobody a chip, so they are never held back. */
const PLAYS_NOTHING = '.sizing *';

/** A tap on one of these cannot be taken back: a vote on how many times to run it counts, and a card shown has been seen. */
const COMMITS_FOR_GOOD = '[data-action^="rit-"], [data-action="show-card"], [data-action="show"]';

const unmarked = new Map<string, string>();

/** What a control is known by once it is drawn anew (`controlKey`). Null for one with nothing to tell it from the next of its kind, which is the same only as itself. */
function marksOf(control: Element): string | null {
  const key = controlKey(control);

  if (!unmarked.has(control.tagName)) {
    unmarked.set(control.tagName, controlKey(document.createElement(control.tagName)));
  }

  return key === unmarked.get(control.tagName) ? null : key;
}

/** The box of everything that cuts off what scrolls out of it, found once for a look at the page. */
type Cuts = Map<Element, Box | null>;

function cutOf(around: Element, cuts: Cuts): Box | null {
  if (!cuts.has(around)) {
    const { overflowX, overflowY } = getComputedStyle(around);

    cuts.set(around, overflowX === 'visible' && overflowY === 'visible' ? null : around.getBoundingClientRect());
  }

  return cuts.get(around)!;
}

/** The part of `element` that is in sight: a button half scrolled out of the bar is under no finger where it cannot be seen. */
function inSight(element: Element, cuts: Cuts): Box {
  let { left, top, right, bottom } = element.getBoundingClientRect();

  for (let around = element.parentElement; around; around = around.parentElement) {
    const cut = cutOf(around, cuts);

    if (cut) {
      [left, top, right, bottom] = [Math.max(left, cut.left), Math.max(top, cut.top), Math.min(right, cut.right), Math.min(bottom, cut.bottom)];
    }
  }

  return { left, top, right, bottom };
}

/** Where a backdrop takes a tap: the strips of it that show above, below and beside its dialog. */
function around(backdrop: Element): Box[] {
  const dialog = backdrop.firstElementChild?.getBoundingClientRect();
  const all = backdrop.getBoundingClientRect();

  if (!dialog) {
    return [];
  }

  return [
    { left: all.left, top: all.top, right: all.right, bottom: dialog.top },
    { left: all.left, top: dialog.bottom, right: all.right, bottom: all.bottom },
    { left: all.left, top: dialog.top, right: dialog.left, bottom: dialog.bottom },
    { left: dialog.right, top: dialog.top, right: all.right, bottom: dialog.bottom },
  ];
}

/**
 * Every control of the page that a tap would reach where it lies, or would but for this guard: not what
 * a dialog covers, nor what is scrolled out of sight. One that is switched off counts: the button just
 * tapped is off until the table answers, and the second tap of two is on its way to it.
 */
function lying(): Spot<Element>[] {
  const cuts: Cuts = new Map();
  const reached = (control: Element, { left, top, right, bottom }: Box) =>
    right > left && bottom > top && (control.classList.contains(SETTLING) || control.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)));

  const controls = [...document.querySelectorAll(TAPPED)].map((control): Spot<Element> => ({ control, is: marksOf(control), box: inSight(control, cuts), forGood: control.matches(COMMITS_FOR_GOOD) }));
  const backdrops = [...document.querySelectorAll(BACKDROP)].flatMap((control) => around(control).map((box): Spot<Element> => ({ control, is: null, box, forGood: false })));

  return [...controls, ...backdrops].filter((spot) => reached(spot.control, spot.box));
}

/** Takes the mark off a control, and leaves it as it was drawn: no empty `class` for a control that had none. */
function unmark(control: Element): void {
  control.classList.remove(SETTLING);

  if (control.classList.length === 0) {
    control.removeAttribute('class');
  }
}

/**
 * The tap guard (`tapGuard.ts`) of a page. Every part that is drawn anew by the game and holds
 * controls is given it (`Slot`); it looks at the whole page around each such redraw, since a part that
 * grows moves its neighbors, and one that goes uncovers what lay under it.
 */
export class TapGuard implements Redrawn {
  private readonly shapes = new ResizeObserver(() => this.moved());
  private drawings: Drawing<Element>[] = [];
  /** Every control as it lay when last looked at, which is what was there before when a part changes shape with no drawing of its own. */
  private last: Spot<Element>[] = [];
  private held: Hold<Element>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private playersOwn = false;

  /** Guards against `part` changing shape with nothing drawn anew, as the bar does when the chat beside it opens, goes down for a turn or comes back, and when the screen is turned. */
  watchShape(part: HTMLElement): void {
    this.shapes.observe(part);
    part.addEventListener('scroll', () => (this.last = lying()), { passive: true });
  }

  leaving(): void {
    if (!this.playersOwn) {
      this.left(lying());
    }
  }

  drawn(): void {
    if (!this.playersOwn) {
      this.hold();
    }
  }

  /**
   * Runs a redraw that is the player's own doing and no surprise to them, a dialog they open or close:
   * nothing it brings up is held back. What they do in the bar is not such a redraw: a second tap on a
   * move must not land on what the first one brought up.
   */
  byThePlayer(redraw: () => void): void {
    this.playersOwn = true;

    try {
      redraw();
    } finally {
      this.playersOwn = false;
    }
  }

  dispose(): void {
    this.shapes.disconnect();
    this.letGo(Infinity);
  }

  private moved(): void {
    this.left(this.last);
    this.hold();
  }

  // Time here is the real clock and a timer, never the table's: a finger moves in real time, and a hold has to end by itself
  private left(spots: Spot<Element>[]): void {
    const at = performance.now();

    this.drawings = [...stillAimedAt(this.drawings, at), { left: at, spots }];
  }

  /** Looks at the page as it now stands, and holds back what has come up where something else lay. */
  private hold(): void {
    const at = performance.now();

    this.last = lying();
    this.letGo(Infinity);
    this.held = holds(
      this.drawings,
      this.last.filter((spot) => !spot.control.matches(PLAYS_NOTHING)),
      at,
      this.held,
    );

    for (const { spot } of this.held) {
      spot.control.classList.add(SETTLING);
    }

    this.letGo(at);
  }

  /** Lets go of every control whose time is over at `at`, and comes back for the next one. `held` keeps them all until the page is looked at again: a control drawn again has the rest of its time. */
  private letGo(at: number): void {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;

    const waiting = this.held.filter((hold) => hold.until > at);
    const stillHeld = new Set(waiting.map((hold) => hold.spot.control));

    for (const { spot } of this.held) {
      if (!stillHeld.has(spot.control)) {
        unmark(spot.control);
      }
    }

    if (waiting.length > 0) {
      const next = Math.min(...waiting.map((hold) => hold.until));

      this.timer = setTimeout(() => this.letGo(performance.now()), next - performance.now());
    }
  }
}
