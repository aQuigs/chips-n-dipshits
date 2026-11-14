/*
 * Checks, in real browsers, the things that only matter once the page is served by Apps Script: there
 * the address is what remembers a player's seat, and requests are slow enough to get lost or to
 * overlap. A stand-in for Apps Script's host object is put in the page, on top of the local server.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { chromium } from 'playwright';
import type { Browser, Page, Route } from 'playwright';

import { KEYS_SETTLE_MS } from '../src/client/hotkeys.ts';
import { startDevServer } from '../src/dev/server.ts';
import { UNSTAMPED_BUILD } from '../src/server/build.ts';
import { clientPage } from './bundle.ts';
import { complaints, NOTICES, STILL, TITLES } from './pageSpies.ts';
import { STAND_IN_HOST } from './standInHost.ts';

const STEP_TIMEOUT_MS = 20_000;
const SLOW_ANSWER_MS = 3000;
const SLOW_POLL_MS = 1500;
const MOVES = ['fold', 'check', 'call', 'raise'];

// Longer than the page waits before it asks again, whether it was answered at once or not at all
const QUIET_MS = 2500;
const NEWER_BUILD = 'newerbuild00';


// Runs in Apps Script's frame, not in the page around it: the page out of sight, a browser that would allow
// notifications, which Chrome never does in another site's frame, and every ask, notification and title written down
const IN_GOOGLES_FRAME = `
if (window.top !== window) {
  Object.defineProperty(document, 'hidden', { get: () => true });
  Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
  ${NOTICES('granted')};
  ${TITLES};
}
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, reached: () => boolean): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;

  while (!reached()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function open(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(STAND_IN_HOST);
  await context.addInitScript(STILL);

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

  console.log('The lobby asks for the presets as it opens, and asks again when that fails');
  {
    const [id, token] = hostMember.split('.');
    const presets = (request: object) => fetch(`${server.url}api`, { method: 'POST', body: JSON.stringify({ ...request, tableId, auth: { id, token }, build: UNSTAMPED_BUILD }) });
    await presets({ op: 'savePreset', name: 'Friday 25/50', settings: { smallBlind: 25, bigBlind: 50 }, replace: false });

    const page = await open(browser);
    let asked = 0;

    await page.route('**/api', (route) => {
      if (JSON.parse(route.request().postData() ?? '{}').op !== 'presets') {
        return route.continue();
      }

      asked += 1;

      return asked === 1 ? route.abort('failed') : route.continue();
    });

    await page.goto(server.url);
    await page.waitForSelector('#new-table-preset');
    assert.equal(asked, 2, 'the presets were asked for once more after the request that failed, and no more');
    assert.deepEqual(await page.locator('#new-table-preset option').allInnerTexts(), ['The usual settings', 'Friday 25/50']);

    await page.selectOption('#new-table-preset', { label: 'Friday 25/50' });
    assert.equal(await page.inputValue('#new-table-big-blind'), '50');
    await page.context().close();

    await presets({ op: 'deletePreset', name: 'Friday 25/50' });
  }

  console.log('While the table cannot be reached there is a way to the lobby, and the link still works afterwards');
  {
    const page = await open(browser);
    await page.route('**/api', (route) => route.abort('failed'));

    await page.goto(`${server.url}?table=${tableId}&me=${hostMember}`);
    await page.click('[data-action="leave-notice"]');
    await page.waitForSelector('[data-action="create-table"]');
    assert.equal(inAddress(page, 'me'), hostMember);

    // Typing the table's code in the lobby is the link's own question again, not an offer to join as someone new
    await page.fill('#table-code', tableId);
    await page.click('button:has-text("Find table")');
    await page.waitForSelector('.note:has-text("Could not reach the table")');
    assert.equal(inAddress(page, 'me'), hostMember, 'finding the same table keeps the member in the address');

    await page.unroute('**/api');
    await page.waitForSelector('[data-action="confirm-member"]');
    assert.equal(inAddress(page, 'me'), hostMember);
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

  console.log('A link to a place the host has taken away says so, and offers the table again');
  {
    const page = await open(browser);
    await page.goto(`${server.url}?table=${tableId}`);
    await page.fill('#join-name', 'Lurker');
    await page.click('[data-action="join-table"]');
    await page.waitForSelector('.stage .table');

    const lurker = inAddress(page, 'me')!;

    await host.click('[data-action="menu"]');
    await host.click('.menu [data-action="players"]');
    await host.click('li:has-text("Lurker") button:has-text("Remove")');
    await host.click('[data-action="confirm"]');
    await host.waitForSelector('.dialog', { state: 'detached' });

    // The page that was open is told by the server, which is the one thing that may take a seat out of the address
    await page.waitForSelector('#join-name');
    assert.equal(inAddress(page, 'me'), null, 'the address no longer names the member who was removed');
    assert.equal(await remembered(page, tableId), null);

    // The link they were given still leads to the table, and says why it is asking for a name
    const later = await open(browser);
    await later.goto(`${server.url}?table=${tableId}&me=${lurker}`);
    await later.waitForSelector('#join-name');
    await later.waitForSelector('.toast:has-text("personal link no longer works")');
    assert.equal(inAddress(later, 'me'), null);

    await later.context().close();
    await page.context().close();
  }

  console.log('A form whose answer is lost closes, and the table shows what became of it');
  {
    let lost = 0;

    await host.route('**/api', async (route) => {
      if ((JSON.parse(route.request().postData() ?? '{}') as { command?: { type: string } }).command?.type !== 'requestSeat') {
        return route.continue();
      }

      // The server seats the host, and the answer never arrives
      lost += 1;
      await route.fetch();

      return route.abort('failed');
    });

    await sit(host, 0);
    await host.waitForSelector('.toast:has-text("Checking whether that went through")');

    // Left open with its button free, the form would invite a second try at something already done
    await host.waitForSelector('.dialog', { state: 'detached' });
    await host.waitForSelector('.seat.me');
    assert.equal(lost, 1, 'the request was sent once');

    await host.unroute('**/api');
  }

  console.log('Before the first hand the bar under the table agrees with the table');
  {
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

    // Nor does a key, which presses the same buttons, once they have been up long enough to take one
    await first.evaluate('document.activeElement.blur()');
    await sleep(KEYS_SETTLE_MS + 100);
    for (const key of ['f', 'c', 'r', 'Enter']) {
      await first.keyboard.press(key);
    }
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

  console.log("A poll's answer that the answer to a move overtook does not put the old table back");
  {
    let asked = 0;
    let answered = 0;
    let arrived = 0;

    // Every poll is answered by the server as usual, and the answer then takes its time getting to the page
    await second.route('**/api', async (route) => {
      if ((JSON.parse(route.request().postData() ?? '{}') as { op?: string }).op !== 'poll') {
        return route.continue();
      }

      asked += 1;
      const response = await route.fetch();
      answered += 1;
      await sleep(SLOW_POLL_MS);
      arrived += 1;

      return route.fulfill({ response });
    });

    // A chat line ends the poll that was already waiting, so the next one goes by the slow road
    await say(second, 'hmm');
    await until('a poll on the slow road', () => asked === 1);

    // The other player's line is still on its way to this page when this player checks
    await say(first, 'go on then');
    await until("the server's answer about the other player's line", () => answered === 1);
    await second.click('.turn [data-action="check"]');
    await second.waitForSelector('.turn', { state: 'detached' });

    await until('that answer to arrive, after the check was answered', () => arrived === 1);
    await sleep(300);
    assert.equal(await second.locator('.turn').count(), 0, 'the decision already made is not back on screen');
    await first.waitForSelector('.turn [data-action="check"]:enabled');

    // A poll is still on the slow road when this ends
    await second.unrouteAll({ behavior: 'ignoreErrors' });
  }

  // What a page of the newer build would send, for what the pages left behind can no longer do
  const asNewerBuild = async (request: object) => {
    const response = await fetch(`${server.url}api`, { method: 'POST', body: JSON.stringify({ ...request, build: NEWER_BUILD }) });

    return (await response.json()) as { ok: boolean; view?: { hand: { toAct: number }; you: { seat: number } } };
  };
  const authOf = (member: string) => ({ id: member.split('.')[0], token: member.split('.')[1] });
  const noticeText = (page: Page) => page.innerText('.outdated');

  const lobby = await open(browser);
  await lobby.goto(server.url);
  await lobby.waitForSelector('#host-name');

  console.log('The game is updated under a player about to move: the move is refused once, the page says so and goes quiet, and the seat is kept');
  {
    const member = inAddress(first, 'me')!;
    const moves: string[] = [];
    const afterNotice: string[] = [];
    let noticeUp = false;

    await first.route('**/api', (route) => {
      const move = moveOf(route);

      if (move) {
        moves.push(move);
      }

      if (noticeUp) {
        afterNotice.push(route.request().postData() ?? '');
      }

      return route.continue();
    });

    server.deploy(NEWER_BUILD);

    await first.click('.turn [data-action="check"]');
    await first.waitForSelector('.outdated');
    noticeUp = true;

    assert.match(await noticeText(first), /The game was updated\s+Reload to keep playing\. Your place at the table is kept\./);
    assert.equal(await first.locator('.stage .table').count(), 1, 'the table as it last was is still behind the notice');
    assert.equal(await first.locator('.toast:visible').count(), 0, 'the refusal is not also a toast');

    // The table hears from someone on the newer build, which answers the poll this page still had waiting
    assert.equal((await asNewerBuild({ op: 'act', tableId, auth: authOf(hostMember), command: { type: 'chat', text: 'back in a second' } })).ok, true);
    await second.waitForSelector('.outdated');

    // Nor does coming back to the tab, which asks afresh on a page that is current
    await first.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
    await sleep(QUIET_MS);

    assert.deepEqual(afterNotice, [], 'nothing was sent once the notice was up');
    assert.deepEqual(moves, ['check'], 'the move was sent once');

    const table = await asNewerBuild({ op: 'poll', tableId, auth: authOf(member), since: -1 });
    assert.equal(table.view!.hand.toAct, table.view!.you.seat, 'the refused check was not played: it is still this player’s turn');

    assert.equal(inAddress(first, 'table'), tableId, 'the address still names the table');
    assert.equal(inAddress(first, 'me'), member, 'and the seat');
    assert.equal(await remembered(first, tableId), member, 'and so does the browser');

    console.log('In Apps Script’s frame the way back is a link that opens at the top, to the same table and seat');

    const reload = first.locator('.outdated [data-action="reload"]');
    assert.equal(await reload.evaluate((element) => element.tagName), 'A');
    assert.equal(await reload.getAttribute('href'), `${server.url}?table=${tableId}&me=${member}`);
    assert.equal(await reload.getAttribute('target'), '_top');

    await first.unroute('**/api');
    await reload.click();
    await first.waitForSelector('.seat.me');

    assert.equal(await first.evaluate('window.CND_BUILD'), NEWER_BUILD, 'the page that came back is the newer build');
    assert.equal(inAddress(first, 'me'), member);
    assert.equal(await first.locator('.outdated').count(), 0);

    // And it plays: the check that was refused goes through from the page that is current
    await first.click('.turn [data-action="check"]');
    await first.waitForSelector('.turn', { state: 'detached' });
    assert.equal(await first.locator('.outdated').count(), 0);
  }

  console.log('A player who was only watching learns from the table’s next news, without pressing anything');
  {
    const member = inAddress(second, 'me')!;

    assert.match(await noticeText(second), /The game was updated/);
    assert.equal(await second.locator('.outdated [data-action="reload"]').getAttribute('href'), `${server.url}?table=${tableId}&me=${member}`);
    assert.equal(await remembered(second, tableId), member);
  }

  console.log('A lobby left open across the update creates no table, says so, and its link leads back to the lobby');
  {
    await lobby.fill('#host-name', 'Latecomer');
    await lobby.click('[data-action="create-table"]');
    await lobby.waitForSelector('.outdated');

    assert.equal(await lobby.innerText('.outdated p'), 'Reload to keep playing.', 'with no table yet, it promises no place at one');
    assert.equal(await lobby.locator('.stage').count(), 0, 'no table was made');
    assert.equal(await lobby.locator('.toast:visible').count(), 0);
    assert.equal(await lobby.locator('.outdated [data-action="reload"]').getAttribute('href'), server.url);

    await lobby.click('.outdated [data-action="reload"]');
    await lobby.waitForSelector('#host-name');
    assert.equal(await lobby.evaluate('window.CND_BUILD'), NEWER_BUILD);
    assert.equal(await lobby.locator('.outdated').count(), 0);
  }

  console.log("A turn that begins in Apps Script's frame, every preference as a new player has it, flashes the table, asks the browser for nothing, leaves the tab's title alone and says nothing in the console");
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(STAND_IN_HOST);
    await context.addInitScript(IN_GOOGLES_FRAME);

    const outside = await context.newPage();
    const said = complaints(outside);
    outside.setDefaultTimeout(STEP_TIMEOUT_MS);
    outside.on('pageerror', (error) => {
      throw error;
    });

    const dealer = await open(browser);
    const framedTable = await createTable(dealer, server.url, 'Marge');
    await sit(dealer, 0);

    // Google's page on a site of its own, with the game in a sandboxed frame from another, as Apps Script serves it
    const google = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>Google's page</title><iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups" src="${server.url}?table=${framedTable}" style="width: 100%; height: 760px; border: 0"></iframe>`);
    });
    await new Promise<void>((resolve) => google.listen(0, 'localhost', resolve));
    await outside.goto(`http://localhost:${(google.address() as AddressInfo).port}/`);
    const frame = (await (await outside.waitForSelector('iframe')).contentFrame())!;

    await frame.fill('#join-name', 'Homer');
    await frame.click('[data-action="join-table"]');
    await frame.click('[data-sit="1"]');
    await frame.click('[data-action="confirm-sit"]');
    await dealer.click('.banner [data-action="approve"]');
    await frame.waitForSelector('.seat.me');
    await dealer.click('.message [data-action="start"]');

    // Heads-up, whoever has the button acts first; the action reaches the frame either way
    const dealerFirst = await Promise.race([
      dealer.waitForSelector('.turn [data-action="fold"]:enabled').then(() => true),
      frame.waitForSelector('.turn [data-action="fold"]:enabled').then(() => false),
    ]);
    if (dealerFirst) {
      await dealer.click('.turn [data-action="call"]');
    }

    await frame.waitForSelector('.turn button:enabled');
    await frame.waitForSelector('#app[data-attention="turn"]', { state: 'attached' });
    await sleep(500);

    assert.deepEqual(await frame.evaluate('({ asks: window.asks, notices: window.notices.length, titles: window.titles })'), { asks: [], notices: 0, titles: [] });
    assert.equal(await outside.title(), "Google's page");

    // Preferences offers neither, so there is no switch to tap that would ask
    await frame.click('[data-action="menu"]');
    await frame.click('.menu [data-action="preferences"]');
    await frame.waitForSelector('#pref-flash');
    assert.equal(await frame.locator('#pref-notify, #pref-tabTitle').count(), 0);
    assert.deepEqual(said, [], 'the frame complained in the console');

    await context.close();
    await dealer.context().close();
    google.close();
  }

  console.log('The Apps Script-hosted page holds up');
} finally {
  await browser.close();
  await server.close();
}
