import { holds, holdsUnderTap, outOfSightAt, replacedAt, shownAt, stillHeld } from './tapGuard.ts';
import type { Box, Drawing, Hold, Spot } from './tapGuard.ts';
import { controlKey } from './ui.ts';
import type { Redrawn } from './ui.ts';

/**
 * The mark on a control that takes no tap yet. The stylesheet makes it so (base.css). A class, which is
 * no part of what a control is known by (`controlKey`): a control held back is the same control.
 */
const SETTLING = 'taps-settling';

/** Everything on a page that takes a tap. A tile is the label over a radio that is not drawn, and takes the tap for it. */
const TAPPED = 'button, input, select, textarea, a[href], summary, [role="switch"], [role="button"], label.tile';

/** What lies behind a dialog and closes it when tapped. It takes that tap only around the dialog. */
const BACKDROP = '.overlay';

/** The sizes of a bet play nothing, only the button beside them does: one of them under a finger costs nobody a chip, so they are never held back. */
const PLAYS_NOTHING = '.sizing *';

/** How much of the page a finger is over when it taps no control: the backdrop that closes a dialog is as wide as the screen, and the finger over as much of it as the least a control here is made for one. */
const FINGER_PX = 44;

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
  // A tap passes through a control that is held back to what it lies on, which is around it; under a dialog or a replay it reaches the cover instead
  const reached = (control: Element, { left, top, right, bottom }: Box) => {
    const hit = right > left && bottom > top ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2) : null;

    return hit !== null && (control.contains(hit) || (control.classList.contains(SETTLING) && hit.contains(control)));
  };

  const controls = [...document.querySelectorAll(TAPPED)].map((control): Spot<Element> => ({ control, is: marksOf(control), box: inSight(control, cuts), forGood: control.matches(COMMITS_FOR_GOOD) }));
  const backdrops = [...document.querySelectorAll(BACKDROP)].flatMap((control) => around(control).map((box): Spot<Element> => ({ control, is: null, box, forGood: false })));

  return [...controls, ...backdrops].filter((spot) => reached(spot.control, spot.box));
}

function underFinger({ clientX, clientY }: MouseEvent): Box {
  return { left: clientX - FINGER_PX / 2, top: clientY - FINGER_PX / 2, right: clientX + FINGER_PX / 2, bottom: clientY + FINGER_PX / 2 };
}

/** Those of `spots` whose tap plays something, which are the ones a tap is ever kept from. */
const playing = (spots: Spot<Element>[]): Spot<Element>[] => spots.filter((spot) => !spot.control.matches(PLAYS_NOTHING));

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
  private whenFree: ReturnType<typeof setTimeout> | null = null;
  /**
   * When the page became busy with what it is drawing, null while it is free. Every part it replaces
   * before it is free again is replaced as of then (`replacedAt`): it takes no tap in between, so one
   * that comes down while an earlier part is built lands on what a later part brings.
   */
  private busySince: number | null = null;
  private playersOwn = false;
  /** What the player last tapped, as it lay at the tap: where the second tap of two lands. */
  private tapped: Drawing<Element> | null = null;

  // Noted on its way down to what it taps, before anything the tap does has changed the page
  private readonly noteTap = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest(TAPPED);
    const spot = control ? { control, is: marksOf(control), box: inSight(control, new Map()) } : target && { control: target, is: null, box: underFinger(event) };

    this.tapped = spot && { left: performance.now(), spots: [{ ...spot, forGood: false }] };
  };

  constructor() {
    document.addEventListener('click', this.noteTap, true);
  }

  /** Guards against `part` changing shape with nothing drawn anew, as the bar does when the chat beside it opens, goes down for a turn or comes back, and when the screen is turned. */
  watchShape(part: HTMLElement): void {
    this.shapes.observe(part);
    // At every step of a scroll, not once it has stopped: a change of shape right behind it is measured against where things lay then
    part.addEventListener('scroll', () => (this.last = lying()), { passive: true });
  }

  /**
   * The page begins to draw what the game brought. Each guarded part says so itself as it is replaced;
   * this is for whoever draws something slow ahead of them, as a table is ahead of its bar.
   */
  busy(): number {
    // The real clock and a timer, never the table's: a finger moves in real time, and a hold has to end by itself
    this.busySince ??= performance.now();
    // What was replaced leaves the screen, and what came up starts its hold, once the page is next free to show it
    this.whenFree ??= setTimeout(() => this.shown(), 0);

    return this.busySince;
  }

  leaving(): void {
    if (!this.playersOwn) {
      // Before looking at where things lie, which lays out all the page has built so far
      const since = this.busy();

      this.drawings = replacedAt(this.drawings, lying(), since);
    }
  }

  drawn(): void {
    if (!this.playersOwn) {
      this.hold();
    }
  }

  /**
   * Runs a redraw that is the player's own doing and no surprise to them, a dialog they open or close:
   * what it brings up or uncovers is live at once, but for what comes up under the tap that made it
   * (`holdsUnderTap`). What they do in the bar is not such a redraw: a second tap on a move must not
   * land on what the first one brought up.
   */
  byThePlayer(redraw: () => void): void {
    // Before the redraw, not after it: a second tap that comes down while a slow phone builds a dialog waits for it, and lands on what was built
    const began = performance.now();

    this.playersOwn = true;

    try {
      redraw();
    } finally {
      this.playersOwn = false;
    }

    this.holdUnderTheTap(began);
  }

  /**
   * Runs a change of the page that is no slot's redraw: the game's own doing, a replay that opens or is
   * set aside by itself, or a choice of the player's that moves what they were not aiming at, a text
   * size that resizes the dialog it is picked in. What it brings up or uncovers is held back like
   * anything drawn anew.
   */
  byItself(change: () => void): void {
    this.leaving();

    try {
      change();
    } finally {
      this.drawn();
    }
  }

  dispose(): void {
    document.removeEventListener('click', this.noteTap, true);
    this.shapes.disconnect();
    clearTimeout(this.whenFree ?? undefined);
    clearTimeout(this.timer ?? undefined);
    this.unmarkAll();
    this.held = [];
  }

  private moved(): void {
    this.drawings = replacedAt(this.drawings, this.last, this.busy());
    this.hold();
  }

  /** Looks at the page as it now stands, and holds back what has come up where something else lay. */
  private hold(): void {
    const at = performance.now();

    this.last = lying();
    this.unmarkAll();
    this.held = holds(this.drawings, playing(this.last), at, this.held);

    for (const { spot } of this.held) {
      spot.control.classList.add(SETTLING);
    }

    this.letGo(at);
  }

  /** Holds back what the player's own redraw brought up where they tapped, beside whatever is held already. */
  private holdUnderTheTap(began: number): void {
    const cameUp = this.tapped ? holdsUnderTap(this.tapped, playing(lying()), began) : [];

    if (cameUp.length === 0) {
      return;
    }

    const again = new Set(cameUp.map(({ spot }) => spot.control));

    this.held = [...this.held.filter(({ spot }) => !again.has(spot.control)), ...cameUp];

    for (const { spot } of cameUp) {
      spot.control.classList.add(SETTLING);
    }

    this.whenFree ??= setTimeout(() => this.shown(), 0);
    this.letGo(performance.now());
  }

  private shown(): void {
    const at = performance.now();

    this.whenFree = null;
    this.busySince = null;
    this.drawings = outOfSightAt(this.drawings, at);
    this.held = shownAt(this.held, at);
    this.letGo(at);
  }

  private unmarkAll(): void {
    for (const { spot } of this.held) {
      unmark(spot.control);
    }
  }

  /** Lets go of every control whose time is over at `at`, and comes back for the next one. `held` keeps them all until the page is looked at again: a control drawn again has the rest of its time. */
  private letGo(at: number): void {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;

    const waiting = stillHeld(this.held, at);
    const marked = new Set(waiting.map((hold) => hold.spot.control));

    for (const { spot } of this.held) {
      if (!marked.has(spot.control)) {
        unmark(spot.control);
      }
    }

    const ends = waiting.flatMap(({ until }) => (until === null ? [] : [until]));

    if (ends.length > 0) {
      this.timer = setTimeout(() => this.letGo(performance.now()), Math.min(...ends) - performance.now());
    }
  }
}
