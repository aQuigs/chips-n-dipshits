/*
 * "Nothing comes up under a finger": when a part of the page is drawn anew by the game, none of its
 * controls takes a tap at a spot where a different control lay the moment before. A player reaching for a
 * switch as the action gets to them must not raise instead, and one tapping Fold twice must not sit out
 * with the second.
 */
import type { Page } from 'playwright';

/** Everything on a page that takes a tap, as the page has it (pageTapGuard.ts). */
const TAPPED = 'button, input, select, textarea, a[href], summary, [role="switch"], [role="button"], label.tile';

/** What lies behind a dialog and closes it when tapped. */
const BACKDROP = '.overlay';

/** The bar under the table, which also changes shape with nothing drawn anew. */
const BAR = '.controls-slot';

/** The sizes of a bet, which play nothing: only the button beside them plays what they set. One of them coming up under a finger costs nobody a chip. */
const PLAYS_NOTHING = '.turn .sizing *';

// The class the page puts on a control that takes no tap yet (pageTapGuard.ts)
const SETTLING = 'taps-settling';

/** A control that came up where a different control lay the moment before. */
export interface CameUp {
  /** What lay there, and so what a tap landing now was aimed at. */
  aimedAt: string;
  /** What has come up there. */
  cameUp: string;
  /** Where on the page the two share, as "x, y". */
  at: string;
  /** Whether a tap there, in the moment it came up, lands on it. */
  taken: boolean;
  /** The other control such a tap reaches when it does not land on this one; null when it reaches nothing that takes a tap. */
  fallsTo: string | null;
}

/** A control the page held back from a tap. */
export interface Held {
  what: string;
  /** What the page knows it by once it is drawn anew; null for a control with no mark. */
  is: string | null;
  /** When the watch saw it held, by the page's clock. */
  from: number;
  /** How long it took no tap, in milliseconds. Null for one that was taken off the page still held. */
  lasted: number | null;
  /** How long after a control of its key was first held it was let go: longer than `lasted` for one drawn again while held. */
  sinceFirst: number | null;
  /** Whether, let go, it is known for the control it was while held, and is left as it was drawn. Null while still held. */
  sameLetGo: boolean | null;
}

/** What a watch has seen. */
export interface Watched {
  found: CameUp[];
  held: Held[];
  /** Every control that came up and took a tap in that same moment, by what it says. */
  liveAtOnce: string[];
}

// Run in the page on a control: what the watch names it by
const NAMED = `(element) => element.matches(${JSON.stringify(BACKDROP)}) ? 'the backdrop of the dialog' : JSON.stringify((element.getAttribute('aria-label') || element.textContent || element.placeholder || element.id || element.tagName).trim().replace(/\\s+/g, ' ').slice(0, 30))`;

// Run in the page. Notes where every control is, and from then on compares the page, each time anything on it is
// drawn anew, shown or hidden, or the bar changes shape, with how things lay before, asking of each control that came up where
// another had been what a tap there would reach. A control is told from another as the page tells them apart,
// by its id and its data marks. Every control the page holds back is tapped the moment it is, where it lies
const WATCH = `(({ tapped, backdrop, bar, playsNothing, settling, byName }) => {
  const named = ${NAMED};
  const reaches = (element, x, y) => element.contains(document.elementFromPoint(x, y));
  // A tap passes through a control that is held back to what it lies on, which is around it; under a dialog or a replay it reaches the cover instead
  const inSightThough = (element, x, y) => document.elementFromPoint(x, y)?.contains(element) ?? false;
  const middle = (box) => [(box.left + box.right) / 2, (box.top + box.bottom) / 2];

  // As the page knows a control (controlKey in src/client/ui.ts): by its id, else its tag with every data-*, name and value attribute
  const marksOf = (element) => {
    const marks = [...element.attributes].filter(({ name }) => name.startsWith('data-') || name === 'name' || name === 'value').map(({ name, value }) => name + '=' + value).sort();

    return element.id !== '' ? '#' + element.id : marks.length > 0 ? [element.tagName, ...marks].join(' ') : null;
  };

  // The part of a control that is in sight: what it scrolls in cuts the rest off, and nobody aims at what they cannot see
  const inSight = (element) => {
    let { left, top, right, bottom } = element.getBoundingClientRect();

    for (let around = element.parentElement; around; around = around.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(around);

      if (overflowX !== 'visible' || overflowY !== 'visible') {
        const cut = around.getBoundingClientRect();

        [left, top, right, bottom] = [Math.max(left, cut.left), Math.max(top, cut.top), Math.min(right, cut.right), Math.min(bottom, cut.bottom)];
      }
    }

    return { left, top, right, bottom };
  };

  // A backdrop takes its tap, which closes the dialog, in the strips of it that show around the dialog
  const around = (element) => {
    const all = element.getBoundingClientRect();
    const dialog = element.firstElementChild?.getBoundingClientRect();

    return !dialog ? [] : [
      { left: all.left, top: all.top, right: all.right, bottom: dialog.top },
      { left: all.left, top: dialog.bottom, right: all.right, bottom: all.bottom },
      { left: all.left, top: dialog.top, right: dialog.left, bottom: dialog.bottom },
      { left: dialog.right, top: dialog.top, right: all.right, bottom: dialog.bottom },
    ];
  };

  // What a tap reaches where it lies, or what lies there in plain sight and refuses the tap. Not what a dialog
  // covers or what is scrolled out of sight, which nobody is aiming at. One switched off counts: the button just
  // tapped is, and the second tap of two is on its way to it
  const controls = () =>
    [
      ...[...document.querySelectorAll(tapped)].filter((element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).map((element) => ({ element, is: marksOf(element), box: inSight(element) })),
      ...[...document.querySelectorAll(backdrop)].flatMap((element) => around(element).map((box) => ({ element, is: null, box }))),
    ]
      .map((control) => ({ ...control, held: control.element.classList.contains(settling) }))
      .filter(({ element, box, held }) => box.right - box.left >= 2 && box.bottom - box.top >= 2 && (reaches(element, ...middle(box)) || (held && inSightThough(element, ...middle(box)))));

  // In a list with a row to a player the name is whose a button is, and what a finger aims at: with it, two buttons the
  // page gives the same marks are still seen as two, and the one that comes up in the other's place as taking its tap
  const same = (a, b) => a.element === b.element || (a.is !== null && a.is === b.is && (!byName || named(a.element) === named(b.element)));
  const watched = { before: controls(), found: [], told: new Set(), held: [], liveAtOnce: [] };

  const compare = () => {
    const now = controls();

    for (const up of now.filter((control) => !control.element.matches(playsNothing))) {
      if (!up.held && !up.element.disabled && !watched.before.some((was) => same(was, up))) {
        watched.liveAtOnce.push(named(up.element));
      }

      for (const was of watched.before) {
        const [left, top, right, bottom] = [Math.max(up.box.left, was.box.left), Math.max(up.box.top, was.box.top), Math.min(up.box.right, was.box.right), Math.min(up.box.bottom, was.box.bottom)];
        const pair = named(was.element) + ' > ' + named(up.element);

        if (same(up, was) || right - left <= 2 || bottom - top <= 2 || watched.told.has(pair)) {
          continue;
        }

        const [x, y] = middle({ left, top, right, bottom });
        const reached = document.elementFromPoint(x, y);
        const taken = up.element.contains(reached);
        const other = taken ? null : reached?.closest(tapped + ', [tabindex]:not([tabindex="-1"])');

        watched.told.add(pair);
        watched.found.push({ aimedAt: named(was.element), cameUp: named(up.element), at: Math.round(x) + ', ' + Math.round(y), taken, fallsTo: other ? named(other) : null });
      }
    }

    watched.before = now;
  };

  // A part that unfolds in place is drawn already, and only stops being hidden. Only one that holds a control and is shown or
  // hidden for real is looked at: the page hides a part of words, or one hidden already, with no thought for a tap, and may do it
  // as a style lets other controls come up, which the page holds back when the bar changes shape and not a moment sooner
  const showsOrHides = ({ type, target, oldValue }) => type === 'attributes' && (oldValue === null) === target.hidden && (target.matches(tapped) || target.querySelector(tapped) !== null);

  new MutationObserver((changes) => {
    if (changes.some((change) => change.type === 'childList' || showsOrHides(change))) {
      compare();
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
  new ResizeObserver(compare).observe(document.querySelector(bar));

  // Every control the page holds back, for how long, and a tap on each the moment it is held. A control drawn again
  // while held is a new element with the old one's key, and the time since the first of them was held is kept by key
  const holding = new Map();
  const streaks = new Map();

  // Under a held backdrop lies the whole page: a tap anywhere around the dialog must reach nothing that takes one
  const underTheBackdrop = (held) => {
    const all = held.getBoundingClientRect();
    const dialog = held.firstElementChild?.getBoundingClientRect();
    const fell = new Set();

    for (let across = 0.5; across < 8; across += 1) {
      for (let down = 0.5; down < 12; down += 1) {
        const [x, y] = [all.left + (all.width * across) / 8, all.top + (all.height * down) / 12];
        const reached = document.elementFromPoint(x, y);
        const other = reached?.closest(tapped + ', [tabindex]:not([tabindex="-1"])');

        if (dialog && x > dialog.left && x < dialog.right && y > dialog.top && y < dialog.bottom) {
          continue;
        }

        if (other && !fell.has(named(other))) {
          fell.add(named(other));
          watched.found.push({ aimedAt: '"the page under the dialog"', cameUp: named(held), at: Math.round(x) + ', ' + Math.round(y), taken: false, fallsTo: named(other) });
        }

        for (const kind of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          reached?.dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y }));
        }
      }
    }
  };

  new MutationObserver((changes) => {
    for (const { target } of changes) {
      const held = target.classList.contains(settling);

      if (held && !holding.has(target)) {
        // Tapped where it can be seen: the rest of it is cut off by what it scrolls in, and a tap there is on something else
        const seen = inSight(target);
        const [x, y] = middle(seen);
        const reached = seen.right > seen.left && seen.bottom > seen.top ? document.elementFromPoint(x, y) : null;

        const key = marksOf(target) ?? target;
        const streak = streaks.get(key);
        const from = performance.now();

        // A hold of the same control that began within one hold's length of the last is the same hold going on
        streaks.set(key, { first: streak && from - streak.last < 400 ? streak.first : from, last: from });
        holding.set(target, { what: named(target), is: marksOf(target), from, lasted: null, sinceFirst: null, sameLetGo: null });
        watched.held.push(holding.get(target));

        // A backdrop lies around its dialog: its own middle is the dialog, where a tap is on whichever line of it is there
        if (target.matches(backdrop)) {
          underTheBackdrop(target);
        } else {
          for (const kind of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            reached?.dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y }));
          }
        }
      } else if (!held && holding.has(target)) {
        holding.get(target).lasted = performance.now() - holding.get(target).from;
        holding.get(target).sinceFirst = performance.now() - streaks.get(marksOf(target) ?? target).first;
        holding.get(target).sameLetGo = marksOf(target) === holding.get(target).is && target.getAttribute('class') !== '';
        holding.delete(target);
      }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });

  window.__underTheFinger = watched;
})`;

/**
 * Notes where every control on the page is, and watches the page from then on. `byName` tells two controls
 * apart by what they say as well as by their marks: for a list of players, where it is the name that says
 * whose a button is, and a button that kept its marks and its place under another name is another's.
 */
export async function watchTheBar(page: Page, byName = false): Promise<void> {
  await page.evaluate(`${WATCH}(${JSON.stringify({ tapped: TAPPED, backdrop: BACKDROP, bar: BAR, playsNothing: PLAYS_NOTHING, settling: SETTLING, byName })})`);
}

/**
 * Waits until the page holds no control back from a tap. A check that asks the page what a tap reaches, or
 * compares its markup with another moment's, in the third of a second after a control came up in another's
 * place, waits for this first: the mark is on the control for that long.
 */
export async function tapsLive(page: Page): Promise<void> {
  await page.waitForFunction(`!document.querySelector('.${SETTLING}')`);
}

/** What the watch has seen, once the page holds no control back any more. */
export async function watched(page: Page): Promise<Watched> {
  await tapsLive(page);

  return page.evaluate(`(({ found, held, liveAtOnce }) => ({ found, held, liveAtOnce }))(window.__underTheFinger)`) as Promise<Watched>;
}

/** What the watch names the control at `selector` by, in what it has seen: a check that looks for one control there asks for it by this. */
export const namedByTheWatch = (page: Page, selector: string) => page.evaluate(`(${NAMED})(document.querySelector(${JSON.stringify(selector)}))`) as Promise<string>;

/** What the watch names each control by that is on the page now and in no dialog: all that a dialog can have uncovered by going. */
export const namedOutsideDialogs = (page: Page) =>
  page.evaluate(`[...document.querySelectorAll(${JSON.stringify(TAPPED)})].filter((control) => !control.closest(${JSON.stringify(BACKDROP)})).map(${NAMED})`) as Promise<string[]>;

/** Every control that has come up where a different one lay, since the watch began. */
export const cameUp = async (page: Page): Promise<CameUp[]> => (await watched(page)).found;

/** What is wrong with what came up, in words; empty when a tap in that moment does nothing at all. */
export const tellingOf = (found: CameUp): string[] => [
  ...(found.taken ? [`  a tap for ${found.aimedAt} at ${found.at} lands on ${found.cameUp}`] : []),
  ...(found.fallsTo ? [`  a tap for ${found.aimedAt} at ${found.at}, held off ${found.cameUp}, lands on ${found.fallsTo}`] : []),
];
