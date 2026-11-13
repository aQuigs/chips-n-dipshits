/*
 * Checks, in real browsers, the things that only matter once the page is served by Apps Script: there
 * the address is what remembers a player's seat, and requests are slow enough to get lost or to
 * overlap. A stand-in for Apps Script's host object is put in the page, on top of the local server.
 */
import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import type { Browser, Page, Route } from 'playwright';

import { startDevServer } from '../src/dev/server.ts';
import { clientPage } from './bundle.ts';

const STEP_TIMEOUT_MS = 20_000;
const SLOW_ANSWER_MS = 3000;
const MOVES = ['fold', 'check', 'call', 'raise'];

// Runs in the page before anything else: google.script as Apps Script provides it, with the page told
// its table and member the way doGet tells it, and the address kept through the host
const STAND_IN_HOST = `
(() => {
  const query = new URLSearchParams(location.search);
  const boot = { baseUrl: location.origin + '/', table: query.get('table'), me: query.get('me') };
  Object.defineProperty(window, 'CND_BOOT', { get: () => boot, set: () => {}, configurable: true });

  const runner = (succeed, fail) => ({
    withSuccessHandler: (handler) => runner(handler, fail),
    withFailureHandler: (handler) => runner(succeed, handler),
    api(body) {
      fetch('/api', { method: 'POST', body })
        .then((response) => response.text())
        .then((text) => succeed && succeed(text), (error) => fail && fail(error));
    },
  });

  window.google = {
    script: {
      get run() { return runner(null, null); },
      history: {
        replace(_state, parameters) {
          const search = new URLSearchParams(parameters).toString();
          history.replaceState(null, '', location.pathname + (search ? '?' + search : ''));
        },
      },
    },
  };
})();
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(STAND_IN_HOST);

  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.on('pageerror', (error) => {
    throw error;
  });

  return page;
}

const inAddress = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);
const remembered = (page: Page, tableId: string) => page.evaluate(`localStorage.getItem('cnd.seat.${tableId}')`) as Promise<string | null>;
const moveOf = (route: Route): string | null => {
  const body = JSON.parse(route.request().postData() ?? '{}') as { op?: string; command?: { type: string } };

  return body.op === 'act' && body.command && MOVES.includes(body.command.type) ? body.command.type : null;
};

async function createTable(page: Page, url: string, name: string): Promise<string> {
  await page.goto(url);
  await page.fill('#host-name', name);
  await page.click('[data-action="create-table"]');
  await page.waitForSelector('#table-link');
  await page.click('[data-action="close"]');

  return inAddress(page, 'table')!;
}

async function sit(page: Page, seat: number): Promise<void> {
  await page.click(`[data-sit="${seat}"]`);
  await page.click('[data-action="confirm-sit"]');
}

async function say(page: Page, text: string): Promise<void> {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
  await page.waitForSelector(`.feed li:has-text("${text}")`);
}

const html = await clientPage({});
const server = await startDevServer({ port: 0, page: async () => html });
const browser = await chromium.launch();

try {
  const host = await open(browser);
  const tableId = await createTable(host, server.url, 'Quigs');
  const hostMember = inAddress(host, 'me')!;
  assert.ok(hostMember, "the host's seat rides in the address");

  console.log('A personal link survives a request that fails');
  {
    const page = await open(browser);
    let failed = false;

    await page.route('**/api', (route) => {
      if (failed) {
        return route.continue();
      }

      failed = true;

      return route.abort('failed');
    });

    await page.goto(`${server.url}?table=${tableId}&me=${hostMember}`);
    await page.waitForSelector('[data-action="confirm-member"]');
    assert.equal(failed, true);
    assert.equal(inAddress(page, 'me'), hostMember, 'the address still names the member');

    await page.click('[data-action="confirm-member"]');
    await page.waitForSelector('.stage .table');
    assert.equal(inAddress(page, 'me'), hostMember);

    // Leaving for the lobby must not throw the seat away either
    await page.click('[data-action="menu"]');
    await page.click('.menu [data-action="lobby"]');
    await page.waitForSelector('[data-action="create-table"]');
    assert.equal(inAddress(page, 'me'), hostMember, 'the address keeps the seat while the lobby is showing');

    await page.reload();
    await page.waitForSelector('.stage .table');
    await page.context().close();
  }

  console.log("Saying no to someone else's link goes back to your own seat");
  {
    const page = await open(browser);
    await page.goto(`${server.url}?table=${tableId}`);
    await page.fill('#join-name', 'Bob');
    await page.click('[data-action="join-table"]');
    await page.waitForSelector('.stage .table');

    const bob = await remembered(page, tableId);
    assert.ok(bob);

    await page.goto(`${server.url}?table=${tableId}&me=${hostMember}`);
    await page.click('[data-action="decline-member"]');
    await page.waitForSelector('.stage .table');

    assert.equal(await remembered(page, tableId), bob, 'this browser is still Bob');
    assert.equal(inAddress(page, 'me'), bob);
    await page.context().close();
  }

  console.log('Before the first hand the bar under the table agrees with the table');
  {
    await sit(host, 0);
    await host.waitForSelector('.seat.me');
    assert.match(await host.innerText('.controls .waiting'), /not started/);

    await host.click('.message [data-action="start"]');
    await host.waitForSelector('.message:has-text("Waiting for at least two")');
    await host.waitForSelector('.controls .waiting:has-text("Waiting for at least two")');

    // Pausing a game that has dealt no hand puts both back to "not started"
    await host.click('[data-action="menu"]');
    await host.click('.menu [data-action="pause"]');
    await host.waitForSelector('.message [data-action="start"]:has-text("Start the game")');
    await host.waitForSelector('.controls .waiting:has-text("not started")');
  }

  const friend = await open(browser);
  await friend.goto(`${server.url}?table=${tableId}`);
  await friend.fill('#join-name', 'Danny');
  await friend.click('[data-action="join-table"]');
  await sit(friend, 1);
  await host.click('.banner [data-action="approve"]');
  await friend.waitForSelector('.seat.me');
  await host.click('.message [data-action="start"]');

  // Heads-up, whoever has the button acts first
  const first = await Promise.race([host, friend].map((page) => page.waitForSelector('.turn [data-action="fold"]:enabled').then(() => page)));
  const second = first === host ? friend : host;

  console.log('A bet being sized survives a chat message, and the buttons stay usable');
  {
    await first.fill('#raise-amount', '137');
    await say(first, 'thinking');

    assert.equal(await first.inputValue('#raise-amount'), '137');
    assert.match(await first.innerText('.turn .btn.raise'), /137/);
    assert.equal(await first.locator('.turn [data-action="fold"]:enabled').count(), 1);
  }

  console.log('While a move is on its way, nothing else frees the buttons for a second one');
  {
    const sent: string[] = [];

    await first.route('**/api', async (route) => {
      const move = moveOf(route);

      if (move) {
        sent.push(move);
        await sleep(SLOW_ANSWER_MS);
      }

      return route.continue();
    });

    await first.click('.turn [data-action="call"]');
    assert.equal(await first.locator('.turn [data-action="fold"]:disabled').count(), 1);

    await say(first, 'calling');
    assert.equal(await first.locator('.turn [data-action="fold"]:disabled').count(), 1, 'still locked after the chat came back');

    // A tap on a locked button is no tap, and nothing in the page turns one into a move either
    await first.locator('.turn [data-action="fold"]').click({ force: true }).catch(() => undefined);
    await second.waitForSelector('.turn [data-action="check"]:enabled');
    assert.deepEqual(sent, ['call']);

    await first.unroute('**/api');
  }

  console.log('A move whose answer is lost is looked up, not repeated on a guess');
  {
    const sent: string[] = [];
    let lost = false;

    await second.route('**/api', async (route) => {
      const move = moveOf(route);

      if (!move) {
        return route.continue();
      }

      sent.push(move);

      if (lost) {
        return route.continue();
      }

      // The server plays it, and the answer never arrives
      lost = true;
      await route.fetch();

      return route.abort('failed');
    });

    // The big blind checks; that brings the flop, where the big blind is first to act again
    await second.click('.turn [data-action="check"]');
    await second.waitForSelector('.toast:has-text("Checking whether that was played")');
    await second.waitForSelector('.board .card[data-card]');
    await second.waitForSelector('.turn [data-action="check"]:enabled');

    assert.equal(await second.locator('.board .card[data-card]').count(), 3, 'the check was played once: the flop is out and no further');
    assert.deepEqual(sent, ['check']);

    await second.unroute('**/api');
  }

  console.log('The Apps Script-hosted page holds up');
} finally {
  await browser.close();
  await server.close();
}
