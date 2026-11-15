/*
 * "Nothing comes up under a finger": when a part of the page is drawn anew by the game, none of its
 * controls takes a tap at a spot where a different control lay the moment before. A player reaching for a
 * switch as the action gets to them must not raise instead, and one tapping Fold twice must not sit out
 * with the second.
 */
import type { Page } from 'playwright';

/** Everything on a page that takes a tap. */
export const TAPPED = 'button, input, select, textarea, a[href], summary, [role="switch"], [role="button"]';

/** What lies behind a dialog and closes it when tapped. */
export const BACKDROP = '.overlay';

/** The bar under the table, which also changes shape with nothing drawn anew. */
export const BAR = '.controls-slot';

/** The sizes of a bet, which play nothing: only the button beside them plays what they set. One of them coming up under a finger costs nobody a chip. */
export const PLAYS_NOTHING = '.turn .sizing *';

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
  /** How long it took no tap, in milliseconds. */
  lasted: number;
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

// Run in the page. Notes where every control is, and from then on compares the page, each time anything on it is
// drawn anew or the bar changes shape, with how things lay before, asking of each control that came up where
// another had been what a tap there would reach. A control is told from another as the page tells them apart,
// by its id and its data marks. Every control the page holds back is tapped the moment it is, where it lies
const WATCH = `(({ tapped, backdrop, bar, playsNothing, settling }) => {
  const named = (element) => element.matches(backdrop) ? 'the backdrop of the dialog' : JSON.stringify((element.getAttribute('aria-label') || element.textContent || element.placeholder || element.id || element.tagName).trim().replace(/\\s+/g, ' ').slice(0, 30));
  const reaches = (element, x, y) => element.contains(document.elementFromPoint(x, y));
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
      .filter(({ element, box, held }) => box.right - box.left >= 2 && box.bottom - box.top >= 2 && (held || reaches(element, ...middle(box))));

  const same = (a, b) => a.element === b.element || (a.is !== null && a.is === b.is);
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

  new MutationObserver(compare).observe(document.body, { childList: true, subtree: true });
  new ResizeObserver(compare).observe(document.querySelector(bar));

  // Every control the page holds back, for how long, and a tap on each the moment it is held
  const holding = new Map();

  new MutationObserver((changes) => {
    for (const { target } of changes) {
      const held = target.classList.contains(settling);

      if (held && !holding.has(target)) {
        const [x, y] = middle(target.getBoundingClientRect());
        const reached = document.elementFromPoint(x, y);

        holding.set(target, { what: named(target), is: marksOf(target), from: performance.now(), lasted: null, sameLetGo: null });
        watched.held.push(holding.get(target));

        for (const kind of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          reached?.dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y }));
        }
      } else if (!held && holding.has(target)) {
        holding.get(target).lasted = performance.now() - holding.get(target).from;
        holding.get(target).sameLetGo = marksOf(target) === holding.get(target).is && target.getAttribute('class') !== '';
        holding.delete(target);
      }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });

  window.__underTheFinger = watched;
})`;

/** Notes where every control on the page is, and watches the page from then on. */
export async function watchTheBar(page: Page): Promise<void> {
  await page.evaluate(`${WATCH}(${JSON.stringify({ tapped: TAPPED, backdrop: BACKDROP, bar: BAR, playsNothing: PLAYS_NOTHING, settling: SETTLING })})`);
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

/** Every control that has come up where a different one lay, since the watch began. */
export const cameUp = async (page: Page): Promise<CameUp[]> => (await watched(page)).found;

/** Every control the page has held back from a tap since the watch began, once none is held any more. */
export const heldBack = async (page: Page): Promise<Held[]> => (await watched(page)).held;

/** What is wrong with what came up, in words; empty when a tap in that moment does nothing at all. */
export const tellingOf = (found: CameUp): string[] => [
  ...(found.taken ? [`  a tap for ${found.aimedAt} at ${found.at} lands on ${found.cameUp}`] : []),
  ...(found.fallsTo ? [`  a tap for ${found.aimedAt} at ${found.at}, held off ${found.cameUp}, lands on ${found.fallsTo}`] : []),
];
