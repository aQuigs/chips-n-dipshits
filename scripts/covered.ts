/*
 * "Nothing here is covered", for any screen: everything a player reads is on the screen, whole, and has
 * nothing drawn over it. It looks at every piece of text the page shows, so a check that calls it never
 * has to think of the pair of things that might collide; what is allowed to lie over what is the short
 * list below, and anything else found on top of words or figures is a failure.
 */
import type { Page } from 'playwright';

/** Something that may lie over what a player reads. */
export interface OnTop {
  /** What it is, in words, for whoever reads the list. */
  what: string;
  /** The thing on top, or something it is drawn in. */
  is: string;
  /** What it may cover; everything else it may never cover. Left out, it may cover anything: it is modal, or gone in a moment. */
  over?: string;
  /** Only within the same one of these: a seat's plate covers its own cards, never a neighbor's. */
  sameAs?: string;
  /** How much of the height of what is under it it may cover, 1 when left out. */
  upTo?: number;
}

/**
 * The things allowed on top, and what each may cover. Words a player reads that are under anything else
 * fail the check, so a new thing that floats over the table gets a line here saying what it may hide.
 */
export const ALLOWED_ON_TOP: OnTop[] = [
  { what: 'a dialog and the dimmed page behind it, which is modal', is: '.overlay' },
  { what: 'a hand played back, which is modal', is: '.replay' },
  { what: 'word that the page is out of date, which is modal', is: '.outdated' },
  { what: 'a chip, a card or a thrown thing in flight, gone when it lands', is: '.stand-in' },
  // Beside the table the chat's column is narrower than a phone, and words that take more than the bar there grow down onto the oldest line in sight
  { what: 'a toast at a table, over the chat’s bar and the chat’s lines under it, and nothing of the game or of the top bar', is: '.feed-bar > .toast', over: '.feed-bar *, .feed .entries *' },
  { what: 'a toast away from a table, over the top of the screen', is: '.cnd > .toast', over: '.brand *' },
  { what: 'a toast while a dialog or a replay is in front of the table, over the top bar they have shut off', is: '.app:has(> .overlay:not([hidden]), + .replay:not([hidden])) .toast', over: '.topbar *' },
  { what: 'a form’s reason while a box it is about is marked, kept in sight at the foot of that form and of no other', is: '.refusal.pointing', over: 'form *', sameAs: 'form' },
  { what: 'a seat’s plate, over the foot of the cards behind it, never their rank or more than half their suit', is: '.plate', over: '.hole .pip', sameAs: '.seat', upTo: 0.5 },
  { what: 'a reaction or a landed throw, over another player’s cards and name, never the board or the pot', is: '.seat-reaction:not(.own)', over: '.seat:not(.me) .hole *, .seat:not(.me) .plate .name *' },
  { what: 'a reaction or a landed throw on the viewer’s own seat, over their own name, stack and status, never their cards', is: '.seat-reaction.own', over: '.seat.me .plate *' },
  { what: 'the reaction picker the viewer opened, over the table and never the moves', is: '.react-panel', over: '.stage *' },
  { what: 'the names offered for an @ the viewer typed, over the chat and the switches above its box, never the table or the moves', is: '#mention-list', over: '.entries *, .feed-bar *, .extras *' },
];

/** Text that may be cut short along its line, keeping enough of itself to read and all of it somewhere else. */
export interface MayBeCut {
  is: string;
  /** Where the whole of it is: a `title` on it or around it, or in words where else on the screen. */
  whole: string;
  /** It may be left out altogether, as the ranks of a hand named by its kind alone are. */
  orLeftOut?: true;
}

export const MAY_BE_CUT: MayBeCut[] = [
  { is: '.plate .name > span:first-child', whole: 'title' },
  { is: '.topbar .title b', whole: 'title' },
  { is: '.feed-toggle .latest, .feed-toggle .latest *', whole: 'the opened chat' },
  { is: '.tag .name .detail', whole: 'title', orLeftOut: true },
  { is: '.sidepots', whole: 'title' },
  { is: '.waiting.choosing .waiting-for', whole: 'title' },
  { is: '.waiting.set-close .named', whole: 'title' },
];

// The least of a name that may be left to read when it is cut short, in its own font size; a shorter one shows whole
const LEAST_OF_A_NAME_EM = 3;

/** The parts of the screen that scroll: what is scrolled out of sight in one is not missing. */
export const SCROLLS = '.entries, .dialog-body, .scroll-x, .react-panel, .replay-line, .replay-log, .who-list, #mention-list, .lobby, .controls-slot';

/** The few of them that are a line swiped along. The rest scroll down, and what is past the side of one of those is cut off, not scrolled away. */
export const SWIPED = '.scroll-x, #mention-list';

/** What is missing even so when it has to be scrolled to: the moves of a turn, with the clock running on them. */
export const ALWAYS_IN_SIGHT = '.turn .buttons button, .turn .buttons button *';

/** Something a player cannot read. */
export interface Finding {
  kind: 'off the screen' | 'cut off' | 'covered';
  /** What cannot be read, and where it is in the page. */
  what: string;
  /** What is in the way. */
  by?: string;
}

// Run in the page. Every text node's lines, each shrunk to where its letters are, held to the screen, to every
// box that clips it, and to everything drawn over it.
const LOOK = `(({ onTop, mayBeCut, scrolls, swiped, inSight, leastEm }) => {
  const findings = [];
  const seen = new Set();
  const screen = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };

  // A thing a tap passes through still hides what is under it, so for the look every element takes the tap
  const hitAll = document.createElement('style');
  hitAll.textContent = '* { pointer-events: auto !important; }';
  document.head.append(hitAll);

  const boxOf = (rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  const inside = (box, around, slack = 1) => box.left >= around.left - slack && box.right <= around.right + slack && box.top >= around.top - slack && box.bottom <= around.bottom + slack;
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const shown = (element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  const where = (element) => {
    const parts = [];

    for (let at = element; at && at !== document.body && parts.length < 4; at = at.parentElement) {
      const seat = at.dataset.seat !== undefined && at.classList.contains('seat') ? '[data-seat="' + at.dataset.seat + '"]' : '';
      const name = at.id ? '#' + at.id : at.classList.length > 0 ? '.' + [...at.classList].slice(0, 2).join('.') : at.tagName.toLowerCase();

      parts.unshift(name + seat);
    }

    return parts.join(' > ');
  };
  const said = (element) => JSON.stringify((typeof element.value === 'string' ? element.value : (element.textContent ?? '')).trim().replace(/\\s+/g, ' ').slice(0, 40));
  const told = (element) => said(element) + ' at ' + where(element);

  const found = (kind, element, by) => {
    const key = [kind, where(element), said(element), by && where(by)].join('|');

    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ kind, what: told(element), ...(by ? { by: told(by) } : {}) });
    }
  };

  // Lines of text, each shrunk to where its letters are: the box of a line of text has room over its capitals
  // and under its baseline that nothing is drawn in
  const shrunk = (rects) =>
    [...rects]
      .filter((rect) => rect.width > 1 && rect.height > 1)
      .map((rect) => ({ left: rect.left + 1, right: rect.right - 1, top: rect.top + rect.height * 0.18, bottom: rect.bottom - rect.height * 0.18 }));

  const lines = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);

    return shrunk(range.getClientRects());
  };

  const textNodes = (element) => [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim() !== '');

  // Words a stylesheet writes before or after an element in a line of text, which no text node holds: they are
  // read where the element's own line boxes are. Only in a line, where those boxes are the words and no more
  const writes = (element, style) =>
    style.display === 'inline' &&
    ['::before', '::after'].some((which) => {
      const [content] = getComputedStyle(element, which).content.split(' / ');

      return /"[^"]*[^\\s"][^"]*"/.test(content);
    });

  // Everything that is drawn: what has words of its own, by their lines, and what has a face of its own, by its box
  const FACES = new Set(['IMG', 'INPUT', 'SELECT', 'TEXTAREA', 'CANVAS', 'VIDEO', 'svg']);
  const solid = (color) => {
    const parts = color.match(/[\\d.]+/g) ?? [];

    return parts.length < 4 || Number(parts[3]) > 0.05;
  };
  const drawn = [];
  const read = [];

  for (const element of document.body.querySelectorAll('*')) {
    // Not what is there for a screen reader alone, nor the way past the table, which is drawn only once the keyboard is on it
    if (element === hitAll || !shown(element) || element.closest('.unseen, .skip:not(:focus-visible)')) {
      continue;
    }

    const style = getComputedStyle(element);
    const words = [...textNodes(element).flatMap(lines), ...(writes(element, style) ? shrunk(element.getClientRects()) : [])];
    const typed = (element.tagName === 'INPUT' && !['range', 'checkbox', 'radio'].includes(element.type) && element.value !== '') || element.tagName === 'SELECT';

    if (solid(style.backgroundColor) || style.backgroundImage !== 'none' || parseFloat(style.borderTopWidth) > 0 || FACES.has(element.tagName)) {
      const box = element.getBoundingClientRect();

      if (box.width > 1 && box.height > 1) {
        drawn.push({ element, boxes: [boxOf(box)] });
      }
    } else if (words.length > 0) {
      drawn.push({ element, boxes: words });
    }

    if (words.length > 0) {
      read.push({ element, boxes: words });
    } else if (typed) {
      const box = element.getBoundingClientRect();

      // What is typed sits within the field's padding, which is all of it that has to be clear
      read.push({ element, boxes: [{ left: box.left + 6, right: box.right - 6, top: box.top + box.height * 0.3, bottom: box.bottom - box.height * 0.3 }], typed: true });
    }
  }

  const clips = (style, axis) => (axis === 'x' ? style.overflowX : style.overflowY) !== 'visible';

  // The box a clipping element lets its content show in
  const windowOf = (element) => {
    const box = element.getBoundingClientRect();

    return { left: box.left + element.clientLeft, top: box.top + element.clientTop, right: box.left + element.clientLeft + element.clientWidth, bottom: box.top + element.clientTop + element.clientHeight };
  };

  for (const { element, boxes, typed } of read) {
    // A stand-in is a picture of something in flight, read where it lands
    if (element.closest('.stand-in')) {
      continue;
    }

    for (const box of boxes) {
      // Scrolled out of sight is not missing: only what its scroller shows whole, the way it scrolls, is looked at
      let scroller = element.closest(scrolls);
      let outOfSight = false;

      while (scroller && !outOfSight) {
        const frame = windowOf(scroller);

        outOfSight = scroller.matches(swiped) ? box.left < frame.left - 0.5 || box.right > frame.right + 0.5 : box.top < frame.top - 0.5 || box.bottom > frame.bottom + 0.5;
        scroller = scroller.parentElement?.closest(scrolls) ?? null;
      }

      if (outOfSight) {
        if (element.matches(inSight)) {
          found('off the screen', element);
        }

        continue;
      }

      // Held to every box that clips it, which leaves the part of it that shows. What is typed in a field scrolls inside the field, which is the field's own affair
      let cut = false;
      let leftOut = false;
      let showing = box;

      for (let around = typed ? element.parentElement : element; around && around !== document.documentElement && !cut; around = around.parentElement) {
        const style = getComputedStyle(around);
        const frame = windowOf(around);

        if (frame.right - frame.left < 1 && style.display.startsWith('inline')) {
          continue;
        }

        // A part that scrolls cuts nothing off the way it scrolls, and anything past its edge the other way
        const scrollsAlong = around.matches(scrolls) ? (around.matches(swiped) ? 'x' : 'y') : null;
        const overX = scrollsAlong !== 'x' && clips(style, 'x') && (box.left < frame.left - 1 || box.right > frame.right + 1);
        const overY = scrollsAlong !== 'y' && clips(style, 'y') && (box.top < frame.top - 1 || box.bottom > frame.bottom + 1);

        if (overX || overY) {
          const short = mayBeCut.find((entry) => element.matches(entry.is));
          const whole = short && (short.whole !== 'title' || element.closest('[title], [aria-label]') !== null);
          const least = Math.min(box.right - box.left, leastEm * parseFloat(getComputedStyle(element).fontSize));

          showing = meet(showing, frame);

          // Cut short along its line only, with the whole of it kept elsewhere and enough of it left to read
          cut = !(whole && !overY && showing.right - showing.left >= least - 1);
          leftOut ||= Boolean(whole && short.orLeftOut);
        }
      }

      if (leftOut) {
        continue;
      }

      if (cut) {
        found('cut off', element);
        continue;
      }

      if (!inside(showing, screen)) {
        found('off the screen', element);
        continue;
      }

      for (const other of drawn) {
        if (other.element === element || other.element.contains(element) || element.contains(other.element)) {
          continue;
        }

        for (const cover of other.boxes) {
          const shared = meet(showing, cover);

          if (shared.right - shared.left <= 1 || shared.bottom - shared.top <= 1) {
            continue;
          }

          const stack = document.elementsFromPoint((shared.left + shared.right) / 2, (shared.top + shared.bottom) / 2);
          const above = stack.indexOf(other.element);
          const below = stack.indexOf(element);

          // Which of two seats is drawn over the other is only the order they come in the page, which neither
          // may count on: where they meet, what is read counts as under the other seat whichever is on top
          const [seat, otherSeat] = [element.closest('.seat'), other.element.closest('.seat')];
          const twoSeats = seat !== null && otherSeat !== null && seat !== otherSeat;

          if (above === -1 || below === -1 || (above > below && !twoSeats)) {
            continue;
          }

          const share = (shared.bottom - shared.top) / (box.bottom - box.top);
          // Nothing is excused for what it covers of itself: inside a dialog one line may no more lie on another than outside it
          const allowed = onTop.some(
            (entry) =>
              other.element.closest(entry.is) !== null &&
              element.closest(entry.is) === null &&
              (entry.over === undefined || element.matches(entry.over)) &&
              (entry.sameAs === undefined || other.element.closest(entry.sameAs) === element.closest(entry.sameAs)) &&
              share <= (entry.upTo ?? 1) + 0.02,
          );

          if (!allowed) {
            found('covered', element, other.element);
          }
        }
      }
    }
  }

  hitAll.remove();

  return findings;
})`;

/** Everything on the page a player cannot read: off the screen, cut off, or under something not allowed over it. */
export async function unreadable(page: Page): Promise<Finding[]> {
  return page.evaluate(`${LOOK}(${JSON.stringify({ onTop: ALLOWED_ON_TOP, mayBeCut: MAY_BE_CUT, scrolls: SCROLLS, swiped: SWIPED, inSight: ALWAYS_IN_SIGHT, leastEm: LEAST_OF_A_NAME_EM })})`) as Promise<Finding[]>;
}

/** A finding in words, for a failure's message. */
export const telling = (finding: Finding): string => `  ${finding.kind}: ${finding.what}${finding.by ? `\n    under ${finding.by}` : ''}`;
