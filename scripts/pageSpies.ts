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

/** One thing the page set moving, as `MOTION` wrote it down. */
export interface Flight {
  /** A card the table draws, a seat's two cards standing in for ones it no longer draws, or a pile of chips. */
  what: 'card' | 'cards' | 'chips';
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
  const number = (text) => (text === undefined ? null : Number(text));

  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    // A seat's two cards are what is seen of the place that holds them, which is shorter than they are
    const seen = this.classList.contains('hole') ? [...this.children] : [this];
    const whereAt = (time) => {
      animation.currentTime = time;
      const boxes = seen.map((element) => element.getBoundingClientRect());
      return {
        left: Math.min(...boxes.map((box) => box.left)),
        top: Math.min(...boxes.map((box) => box.top)),
        right: Math.max(...boxes.map((box) => box.right)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
      };
    };

    window.flights.push({
      what: this.classList.contains('bet') ? 'chips' : this.classList.contains('hole') ? 'cards' : 'card',
      standIn: this.classList.contains('stand-in'),
      seat: number(this.closest('[data-seat]')?.dataset.seat ?? this.dataset.bet),
      board: number(this.closest('[data-run]')?.dataset.run),
      text: this.textContent.trim(),
      index: [...this.closest('.stage').querySelectorAll('*')].indexOf(this),
      properties: [...new Set(frames.flatMap(Object.keys))].filter((key) => key !== 'offset'),
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
