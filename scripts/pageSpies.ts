/*
 * What a browser check puts in a page to see what the page asks of the browser: scripts run before
 * anything of the page's own, and a listener for what it says in its console.
 */
import type { Page } from 'playwright';

import type { Permission } from '../src/client/attentionWays.ts';

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
