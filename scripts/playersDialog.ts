/*
 * How a browser check reaches the Players dialog: a table to open it at, a player's row and the buttons
 * on it, and the dialogs it gives way to. Shared by the checks of its rows (`playersChecks.ts`) and of
 * the questions asked from it (`confirmChecks.ts`).
 */
import type { Page } from 'playwright';

import { tabTo } from './accessibilityChecks.ts';
import type { Rig, RigTable } from './rig.ts';

export const HOST = 'Quigs';
export const EIGHT = [HOST, 'Danny', 'Marge', 'Stu', 'Big Al', 'Pocket Pam', 'Zed', 'Mo'];
export const WATCHER = 'Kibitz';

/** The first `seats` of eight seated with nothing dealt, the first of them hosting, and someone watching. */
export function seatedAndWatched(rig: Rig, seats = EIGHT.length): RigTable {
  const table = rig.table(
    EIGHT.slice(0, seats).map((name) => ({ name, stack: 2000 })),
    { name: 'Friday Night' },
  );

  table.join(WATCHER);

  return table;
}

export const row = (name: string) => `.dialog li:has(b:text-is("${name}"))`;
export const on = (name: string, action: string) => `${row(name)} [data-action="${action}"]`;
export const more = (name: string) => on(name, 'more');
// A player removed from their seat is still at the table, on a row among those watching: only a seated row sets a stack
export const seated = (name: string) => on(name, 'set-stack');
// A row's button as a screen reader names it, in plain CSS, which is what the page itself can be asked with
export const named = (says: string, name: string) => `.dialog button[aria-label="${says}, ${name}"]`;

export const ANSWER = '.dialog [data-action="confirm"]';
export const CANCEL = '.dialog .buttons button:not([data-action])';
export const CLOSE = '.dialog [data-action="close"]';

export const dialogNamed = (page: Page, name: string) => page.waitForSelector(`.overlay .dialog[aria-label=${JSON.stringify(name)}]`);
export const noDialog = (page: Page) => page.waitForSelector('.overlay .dialog', { state: 'detached' });

export async function fromMenu(page: Page, press: (selector: string) => Promise<unknown>, action: string): Promise<void> {
  await press('[data-action="menu"]');
  await press(`.menu [data-action="${action}"]`);
  await page.waitForFunction(`document.querySelector('.menu') === null`);
}

export async function playersFromTheKeyboard(page: Page): Promise<void> {
  await page.focus('[data-action="menu"]');
  await page.keyboard.press('Enter');
  await tabTo(page, '.menu-item[data-action="players"]');
  await page.keyboard.press('Enter');
  await dialogNamed(page, 'Players');
}

/** Whose row the keyboard is on, and what on it. */
export const keyboardOn = (page: Page) => page.evaluate(`document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'nothing'`) as Promise<string>;
