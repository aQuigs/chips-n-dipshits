/*
 * Plays a real game in real browsers against the local server and saves pictures of each screen to
 * screenshots/. Six players, two of them watched: the host on a desktop and one friend on a phone.
 * It doubles as an end-to-end check, since every step has to work for the next one to happen.
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

import { THEMES } from '../src/client/themes.ts';
import { startDevServer } from '../src/dev/server.ts';
import { clientPage } from './bundle.ts';

const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const STEP_TIMEOUT_MS = 20_000;
const FLOP = 3;

interface Player {
  name: string;
  page: Page;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(browser: Browser, phone: boolean): Promise<Page> {
  const context = await browser.newContext(phone ? { viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: DESKTOP });
  const page = await context.newPage();

  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.on('pageerror', (error) => {
    throw error;
  });

  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  // Run in the page, so written as text: this file is checked without the browser's types
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`  ${name}.png`);
}

async function setTheme(page: Page, id: string): Promise<void> {
  if ((await page.evaluate('document.documentElement.dataset.theme')) === id) {
    return;
  }

  await page.click('[data-action="menu"]');
  await page.click('[data-action="theme"]');

  const fonts = page.waitForResponse((response) => response.url().startsWith('https://fonts.googleapis.com/'), { timeout: 5000 }).catch(() => null);
  await page.click(`.theme-option[data-theme="${id}"]`);
  await fonts;

  await page.click('[data-action="close"]');
}

async function setDeck(page: Page, deck: string): Promise<void> {
  if ((await page.evaluate(`document.querySelector('.cnd').dataset.deck`)) === deck) {
    return;
  }

  await openFromMenu(page, 'preferences');
  await page.click(`#pref-deck .tile:has(input[value="${deck}"])`);
  await page.click('[data-action="close"]');
}

/** Each theme with the deck it comes with, then each with the four-color deck a player can choose. */
async function shotInEveryTheme(page: Page, name: string): Promise<void> {
  for (const deck of ['theme', 'four']) {
    await setDeck(page, deck);

    for (const theme of THEMES) {
      await setTheme(page, theme.id);
      await shot(page, `${name}-${theme.id}${deck === 'four' ? '-four-color' : ''}`);
    }
  }

  await setTheme(page, THEMES[0]!.id);
  await setDeck(page, 'theme');
}

async function sit(page: Page, seat: number): Promise<void> {
  await page.click(`[data-sit="${seat}"]`);
  await page.click('[data-action="confirm-sit"]');
}

const has = async (page: Page, selector: string) => (await page.locator(selector).count()) > 0;

/** The player whose turn it is, once the buttons are on their screen; null once `over` shows on the first player's screen instead. */
async function onTheClock(players: Player[], over: string): Promise<Player | null> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await has(players[0]!.page, over)) {
      return null;
    }

    for (const player of players) {
      if (await has(player.page, '.turn [data-action="fold"]:enabled')) {
        return player;
      }
    }

    await sleep(100);
  }

  throw new Error('Nobody got the action in time');
}
/**
 * Presses one of the turn buttons and waits for the page to take it. The same player can be up again
 * straight away (last to act on one street, first on the next), so "their buttons are gone" is no signal.
 */
async function act(page: Page, action: string): Promise<void> {
  const button = await page.waitForSelector(`.turn [data-action="${action}"]`);

  await button.click();
  await button.waitForElementState('hidden');
}

const boardCards = (page: Page) => page.locator('.board[data-run="0"] .card[data-card]').count();

async function say(page: Page, text: string): Promise<void> {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
}

async function openFromMenu(page: Page, action: string): Promise<void> {
  await page.click('[data-action="menu"]');
  await page.click(`.menu [data-action="${action}"]`);
}

await mkdir(OUT, { recursive: true });

const html = await clientPage({});
const server = await startDevServer({ port: 0, page: async () => html });
const browser = await chromium.launch();
const players: Player[] = [];

try {
  // ---- Lobby, table, seats ----
  const host: Player = { name: 'Quigs', page: await open(browser, false) };
  players.push(host);

  await host.page.goto(server.url);
  await shot(host.page, '01-lobby-desktop');

  await host.page.fill('#host-name', host.name);
  await host.page.click('[data-action="create-table"]');
  await host.page.waitForSelector('#table-link');
  await shot(host.page, '02-invite-desktop');

  const link = await host.page.inputValue('#table-link');
  await host.page.click('[data-action="close"]');
  await shot(host.page, '03-empty-table-desktop');
  await sit(host.page, 0);

  const friends: [name: string, seat: number, phone: boolean][] = [
    ['Danny', 3, true],
    ['Marge', 1, false],
    ['Stu', 5, false],
    ['Big Al', 6, false],
    ['Pocket Pam', 8, false],
  ];
  for (const [name, seat, phone] of friends) {
    const page = await open(browser, phone);
    await page.goto(link);

    if (phone) {
      await page.waitForSelector('[data-action="join-table"]:enabled');
      await shot(page, '04-join-phone');
    }

    await page.fill('#join-name', name);
    await page.click('[data-action="join-table"]');
    await sit(page, seat);

    await host.page.waitForSelector('.banner [data-action="approve"]');
    if (phone) {
      await shot(host.page, '05-seat-request-desktop');
      await shot(page, '05-seat-request-phone');
    }

    await host.page.click('.banner [data-action="approve"]');
    await page.waitForSelector('.seat.me');
    players.push({ name, page });
  }

  const phone = players[1]!;
  const watched = new Set([host, phone]);

  await shot(host.page, '06-ready-desktop');
  await host.page.click('.message [data-action="start"]');

  // ---- Hand 1: bets on every street, down to a showdown ----
  const captured = new Set<Player>();

  for (let player = await onTheClock(players, '.message.result'); player; player = await onTheClock(players, '.message.result')) {
    const page = player.page;
    const board = await boardCards(page);
    const canCheck = await has(page, '[data-action="check"]');

    if (board === FLOP && !canCheck && watched.has(player) && !captured.has(player)) {
      captured.add(player);
      await shotInEveryTheme(page, player === host ? '07-your-turn-desktop' : '07-your-turn-phone');
    }

    // The watched players let someone else bet first, so their pictures show chips in front of people
    if (canCheck && board >= FLOP && !watched.has(player)) {
      await page.click('.presets button:has-text("½ pot")');
      await act(page, 'raise');
    } else {
      await act(page, canCheck ? 'check' : 'call');
    }
  }

  await phone.page.waitForSelector('.message.result');
  await shot(host.page, '08-showdown-desktop');
  await shot(phone.page, '08-showdown-phone');

  // ---- Paused: chat and the dialogs ----
  await openFromMenu(host.page, 'pause');
  await say(host.page, 'Pay the man');
  await phone.page.click('.feed-toggle');
  await say(phone.page, 'That river was criminal');
  await say(players[3]!.page, 'Rebuy incoming');
  await host.page.waitForSelector('.table:not(:has(.board))');
  await shot(host.page, '09-paused-desktop');
  await shot(phone.page, '09-chat-phone');
  await phone.page.click('.feed-toggle');

  for (const dialog of ['ledger', 'players', 'settings']) {
    await openFromMenu(host.page, dialog);
    await shot(host.page, `10-${dialog}-desktop`);
    await host.page.click('[data-action="close"]');
  }

  await openFromMenu(host.page, 'history');
  await host.page.click('.history summary');
  await shot(host.page, '10-history-desktop');
  await host.page.click('[data-action="close"]');

  await phone.page.click('[data-action="menu"]');
  await shot(phone.page, '10-menu-phone');
  await phone.page.click('.menu [data-action="ledger"]');
  await shot(phone.page, '10-ledger-phone');
  await phone.page.click('[data-action="close"]');
  await phone.page.click('[data-action="menu"]');
  await phone.page.click('.menu [data-action="theme"]');
  await shot(phone.page, '10-theme-phone');
  await phone.page.click('[data-action="close"]');

  // ---- Carrying on from another device by personal link ----
  await host.page.click('[data-action="invite"]');
  const memberLink = await host.page.inputValue('#member-link');
  await host.page.click('[data-action="close"]');

  const secondDevice = await open(browser, true);
  await secondDevice.goto(memberLink);
  await secondDevice.waitForSelector('[data-action="confirm-member"]');
  await shot(secondDevice, '10-personal-link-phone');
  await secondDevice.click('[data-action="confirm-member"]');
  await secondDevice.waitForSelector('.seat.me');
  await secondDevice.context().close();

  // ---- Hand 2: everyone all in, run twice ----
  await openFromMenu(host.page, 'start');

  let first = true;
  for (let player = await onTheClock(players, '[data-action="rit-yes"]'); player; player = await onTheClock(players, '[data-action="rit-yes"]')) {
    const page = player.page;

    if (first) {
      first = false;
      await page.click('.presets button:has-text("All in")');
      await act(page, 'raise');
    } else {
      await act(page, 'call');
    }
  }

  await phone.page.waitForSelector('[data-action="rit-yes"]');
  await shot(host.page, '11-run-it-twice-vote-desktop');
  await shot(phone.page, '11-run-it-twice-vote-phone');

  for (const { page } of players) {
    await act(page, 'rit-yes');
  }

  await host.page.waitForSelector('.boards.twice');
  await host.page.waitForSelector('.message.result');
  await phone.page.waitForSelector('.message.result');
  await shot(host.page, '12-ran-twice-desktop');
  await shot(phone.page, '12-ran-twice-phone');

  // ---- Busted players buy back in ----
  await openFromMenu(host.page, 'pause');
  await host.page.waitForSelector('.table:not(:has(.board))');

  for (const player of players) {
    if (player !== host && (await has(player.page, '[data-action="rebuy"].strong'))) {
      await player.page.click('[data-action="rebuy"]');
      await player.page.click('[data-action="confirm-rebuy"]');
      await host.page.waitForSelector('.banner [data-action="approve"]');
      await shot(host.page, '13-rebuy-request-desktop');
      await host.page.click('.banner [data-action="approve"]');
      await host.page.waitForSelector('.banner', { state: 'detached' });
      break;
    }
  }

  await shot(host.page, '14-after-desktop');
  await shot(phone.page, '14-after-phone');
  console.log(`Saved to ${OUT}`);
} catch (error) {
  // What each player was looking at when it went wrong
  for (const [index, player] of players.entries()) {
    await player.page.screenshot({ path: `${OUT}failed-${index}-${player.name.replace(/\W/g, '')}.png` }).catch(() => undefined);
  }

  throw error;
} finally {
  await browser.close();
  await server.close();
}
