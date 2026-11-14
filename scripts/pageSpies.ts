/*
 * What a browser check puts in a page to see what the page asks of the browser: scripts run before
 * anything of the page's own, and a listener for what it says in its console.
 */
import type { Page } from 'playwright';

import type { Permission } from '../src/client/attentionWays.ts';
import type { Box } from './rig.ts';

/** Run in the page: notifications that are written down, not shown, with the browser's answer so far and the one it gives when asked. */
export const NOTICES = (permission: Permission, answer = permission) => `(() => {
  window.notices = [];
  window.asks = [];
  window.Notification = class {
    static permission = ${JSON.stringify(permission)};
    static requestPermission() {
      window.asks.push(navigator.userActivation.isActive);
      window.Notification.permission = ${JSON.stringify(answer)};
      return Promise.resolve(window.Notification.permission);
    }
    constructor(title, options) {
      Object.assign(this, { title, options, open: true });
      window.notices.push(this);
    }
    close() {
      this.open = false;
    }
  };
})()`;

// Run in the page: every title the page gives its tab
export const TITLES = `(() => {
  window.titles = [];
  const own = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
  Object.defineProperty(Document.prototype, 'title', {
    get() { return own.get.call(this); },
    set(value) { window.titles.push(value); own.set.call(this, value); },
    configurable: true,
  });
})()`;

/** The page's console warnings and errors from now on. */
export function complaints(page: Page): string[] {
  const said: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      said.push(message.text());
    }
  });

  return said;
}

/**
 * Run in the page before anything of its own: switches animations off, as a viewer can in Preferences,
 * unless the page already holds a choice. A check measures where things rest, and one caught mid-flight
 * would fail on a slow machine only. The checks that are about motion open their pages without it.
 */
export const STILL = `(() => {
  try {
    if (localStorage.getItem('cnd.motion') === null) {
      localStorage.setItem('cnd.motion', 'off');
    }
  } catch {
    // A page with no storage of its own, as the blank one a tab starts on
  }
})()`;

// Run in the page: the box around several things on it, and the seat a card or a bet belongs to
const AROUND = `(elements) => {
  const boxes = elements.map((element) => element.getBoundingClientRect());

  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}`;
const SEAT_OF = `(element) => element.closest('[data-seat]')?.dataset.seat ?? element.dataset.bet`;

/** Where things lie on a table, by seat for what every seat has. */
export interface Spots {
  felt: Box;
  /** The pot, or the result that stands where it stood once the hand is over. */
  pot: Box;
  plates: Record<number, Box>;
  /** A seat's two cards together. */
  cards: Record<number, Box>;
  /** The place a seat keeps for its cards, which has their height and, once they are folded, no width. */
  holes: Record<number, Box>;
  bets: Record<number, Box>;
}

/** Run in the page: the spots of the table it shows. */
export const SPOTS = `(() => {
  const around = ${AROUND};
  const seatOf = ${SEAT_OF};
  const bySeat = (selector, parts) => Object.fromEntries([...document.querySelectorAll(selector)].map((element) => [seatOf(element), around(parts ? [...element.querySelectorAll(parts)] : [element])]));
  const pot = document.querySelector('.pot') ?? document.querySelector('.center > .message') ?? document.querySelector('.center');

  return {
    felt: around([document.querySelector('.felt')]),
    pot: around([pot]),
    plates: bySeat('.seat[data-seat] .plate'),
    cards: bySeat('.seat[data-seat] .hole:not(.none)', '.card'),
    holes: bySeat('.seat[data-seat] .hole'),
    bets: bySeat('.bet[data-bet]'),
  };
})()`;

/** One thing the page set moving, as `MOTION` wrote it down. */
export interface Flight {
  /** The move it is part of, by its name (`MoveName`). */
  name: string;
  /** A card the table draws or one standing in for it, a seat's two cards standing in for ones it no longer draws, a pile of chips, or a piece of confetti. */
  what: 'card' | 'cards' | 'chips' | 'confetti';
  /** A stand-in for something the table no longer draws, there only for the move. */
  standIn: boolean;
  /** Whose it is, where the table says: the seat of a card or of a bet it draws. */
  seat: number | null;
  /** The board a card lies on. */
  board: number | null;
  text: string;
  /** Which element of the table's part of the screen it is, counted in the order they are drawn. A stand-in comes after everything the table draws. */
  index: number;
  /** What of it the animation changes, as CSS properties. */
  properties: string[];
  /** Where it is as the move starts, and where as it ends. */
  from: Box;
  to: Box;
  /** Milliseconds it waits before it starts, and how long it then takes. */
  delay: number;
  duration: number;
  /** The frame of the page it was set off in, counted from when the page opened. */
  frame: number;
}

/**
 * Run in the page: writes down in `window.flights` every animation the page starts, with where what it
 * moves is at either end. Read the moment each begins, so a slow machine sees what a fast one does.
 * Setting `window.holdAt` to a share of a move stops every move from then on at that point of its own
 * time, in the air, until `window.land()` lets them all finish. `window.frame` counts the page's frames.
 */
export const MOTION = `(() => {
  window.flights = [];
  window.holdAt = null;
  window.frame = 0;

  const count = () => {
    window.frame += 1;
    requestAnimationFrame(count);
  };
  requestAnimationFrame(count);

  const held = [];
  const animate = Element.prototype.animate;
  const around = ${AROUND};
  const seatOf = ${SEAT_OF};
  const number = (text) => (text === undefined ? null : Number(text));

  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    // A seat's two cards are what is seen of the place that holds them, which is shorter than they are
    const seen = this.classList.contains('hole') ? [...this.children] : [this];
    const whereAt = (time) => {
      animation.currentTime = time;

      return around(seen);
    };

    window.flights.push({
      name: options.id,
      what: this.classList.contains('bet') ? 'chips' : this.classList.contains('hole') ? 'cards' : this.classList.contains('confetti') ? 'confetti' : 'card',
      standIn: this.classList.contains('stand-in'),
      seat: number(seatOf(this)),
      board: number(this.closest('[data-run]')?.dataset.run),
      text: this.textContent.trim(),
      index: [...this.closest('.stage').querySelectorAll('*')].indexOf(this),
      properties: [...new Set(frames.flatMap(Object.keys))].filter((key) => !['offset', 'easing', 'composite'].includes(key)),
      from: whereAt(options.delay),
      to: whereAt(options.delay + options.duration - 0.001),
      delay: options.delay,
      duration: options.duration,
      frame: window.frame,
    });

    animation.currentTime = 0;

    if (window.holdAt !== null) {
      animation.currentTime = options.delay + options.duration * window.holdAt;
      animation.pause();
      held.push(animation);
    }

    return animation;
  };

  window.land = () => held.splice(0).forEach((animation) => animation.playState === 'paused' && animation.finish());
})()`;
