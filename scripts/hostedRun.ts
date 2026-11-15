/*
 * Checks, in real browsers, the things that only matter once the page is served by Apps Script: there
 * the address is what remembers a player's seat, and requests are slow enough to get lost or to
 * overlap. A stand-in for Apps Script's host object is put in the page, on top of the local server.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

import { KEYS_SETTLE_MS } from '../src/client/hotkeys.ts';
import { startDevServer } from '../src/dev/server.ts';
import type { TableState } from '../src/engine/index.ts';
import { CacheArrivalKeys } from '../src/gas/cacheArrivalKeys.ts';
import { ERRORS_TAB, SheetErrorLog } from '../src/gas/sheetErrorLog.ts';
import { SheetPlayerStore } from '../src/gas/sheetPlayerStore.ts';
import { SheetPresetStore } from '../src/gas/sheetPresetStore.ts';
import { RESULTS_TAB, SheetResultStore } from '../src/gas/sheetResultStore.ts';
import { SheetStore, TABLE_COLUMNS } from '../src/gas/sheetStore.ts';
import { OUTDATED_MESSAGE, UNSTAMPED_BUILD } from '../src/server/build.ts';
import { MemoryErrorLog } from '../src/server/memoryErrorLog.ts';
import { MemoryPlayerStore } from '../src/server/memoryPlayerStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PUT_AWAY_AFTER_MS, PUT_AWAY_AT_ONCE, PUT_AWAY_MESSAGE } from '../src/server/putAway.ts';
import { PokerService } from '../src/server/service.ts';
import { FakeCache, FakeLock, FakeSpreadsheet } from '../tests/fakes.ts';
import { seededRng } from '../tests/helpers.ts';
import { clientPage } from './bundle.ts';
import { playCheck } from './liveCheckSteps.ts';
import { answeredAfter, complaints, moveIn, movesSent, NOTICES, opsSent, ownComplaints, STILL, TITLES, toldOf } from './pageSpies.ts';
import { Gate } from './rig.ts';
import { STAND_IN_HOST } from './standInHost.ts';

const PICTURES = fileURLToPath(new URL('../screenshots/', import.meta.url));

// Tables as older code saved them, written once by scripts/goldenTables.ts
const OLDER_TABLES = new URL('../tests/fixtures/tables/', import.meta.url);
const STEP_TIMEOUT_MS = 20_000;
const SLOW_POLL_MS = 1500;

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

/** A page with Apps Script's stand-in in it. What it throws fails the run, but for what the case throws on purpose, `meant`. */
async function open(browser: Browser, meant?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(STAND_IN_HOST);
  await context.addInitScript(STILL);

  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.on('pageerror', (error) => {
    if (meant === undefined || !error.message.includes(meant)) {
      throw error;
    }
  });

  return page;
}

/** Has a page throw on its own, outside anything the page called, as a bug would, and leave a promise to reject. */
const throwIn = (page: Page, message: string) =>
  page.evaluate((text) => {
    setTimeout(() => {
      throw new Error(text);
    });
    void Promise.reject(new Error(`${text}, rejected`));
  }, message);

const inAddress = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);
const remembered = (page: Page, tableId: string) => page.evaluate(`localStorage.getItem('cnd.seat.${tableId}')`) as Promise<string | null>;
/** A page's own seat, the chips in front of it, the pot and the board, as they are drawn, less the turn's clock, which never stands still. */
const ownPart = (page: Page) =>
  page.evaluate(`['.seat.me', '.seat.me + .bet', '.pot', '.boards'].map((selector) => {
    const part = document.querySelector(selector)?.cloneNode(true);

    part?.querySelectorAll('.timer, .status.clock').forEach((clock) => clock.remove());

    return part?.outerHTML ?? null;
  })`) as Promise<(string | null)[]>;

/** Every key of a turn, pressed long enough after the last redraw that a key would be taken. */
async function pressTurnKeys(page: Page): Promise<void> {
  await page.evaluate('document.activeElement.blur()');
  await sleep(KEYS_SETTLE_MS + 100);

  for (const key of ['f', 'c', 'r', 'Enter']) {
    await page.keyboard.press(key);
  }
}

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

// Every case before the one that throws on purpose is told nothing: no request that failed, went unanswered or was
// refused is a failure of the page, and the server fails nowhere
const errors = new MemoryErrorLog({ now: () => Date.now() });
const server = await startDevServer({ port: 0, page: async () => html, errors });
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
    await page.waitForSelector('[data-action="join-table"]');
    assert.equal(inAddress(page, 'me'), null, 'the address no longer names the member who was removed');
    assert.equal(await remembered(page, tableId), null);

    // The seat is gone and who they are is not: the two are remembered apart, and only the seat was the server's to take
    assert.equal(await page.innerText('.who-remembered b'), 'Lurker');

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

  console.log('Muting the other player hides their chat and leaves the seat where the page keeps it, in the address and the browser; an @ offers their name');
  {
    const other = second === friend ? 'Danny' : 'Quigs';
    const row = `.dialog li:has(b:text-is("${other}"))`;
    const member = inAddress(first, 'me');
    const kept = await remembered(first, tableId);

    await first.click('[data-action="menu"]');
    await first.click('.menu [data-action="mute"]');
    await first.click(`${row} [data-action="mute"]`);
    await first.waitForSelector(`${row} [data-action="unmute"]`);
    await first.click('.dialog [data-action="close"]');

    // The other player's line reaches this page with this player's own, which says it has come
    await say(second, 'not for your ears');
    await say(first, 'did you say something');
    assert.equal(await first.locator('.feed li:has-text("not for your ears")').count(), 0, 'the muted player’s line shows');
    assert.equal(inAddress(first, 'me'), member, 'muting took the seat out of the address');
    assert.equal(await remembered(first, tableId), kept, 'muting changed what the browser remembers of the seat');
    assert.equal(await first.evaluate(`localStorage.getItem('cnd.mute.${tableId}')`), JSON.stringify([inAddress(second, 'me')!.split('.')[0]]));

    await first.click('[data-action="menu"]');
    await first.click('.menu [data-action="mute"]');
    await first.click(`${row} [data-action="unmute"]`);
    await first.click('.dialog [data-action="close"]');
    await first.waitForSelector('.feed li:has-text("not for your ears")', { state: 'attached' });

    await first.click('#chat-input');
    await first.keyboard.type('@');
    assert.ok((await first.locator('#mention-list li').allInnerTexts()).includes(other), 'the other player is offered');
    await first.keyboard.press('Escape');
    await first.fill('#chat-input', '');
    assert.equal(await first.inputValue('#raise-amount'), '137', 'the bet being sized is as it was');
  }

  console.log('A move shows the moment it is made, and no key or line of chat makes a second one while its answer is on its way');
  {
    const sent = movesSent(first);
    const moves = await Gate.on(first, 'moves');

    // The server plays the call, and its answer takes its time
    await moves.close('answers');
    await first.click('.turn [data-action="call"]');
    await first.waitForSelector('.turn', { state: 'detached' });
    assert.equal(await first.innerText('.seat.me .status'), 'CALL', 'the call is on the table before the server has answered');
    await moves.holding();

    await say(first, 'calling');
    assert.equal(await first.locator('.turn').count(), 0, 'no buttons came back with the chat');

    // A key presses a button, and there is none
    await pressTurnKeys(first);

    await moves.open();
    await second.waitForSelector('.turn [data-action="check"]:enabled');
    assert.deepEqual(sent, ['call']);

    await first.unroute('**/api');
  }

  console.log('A move whose answer is lost stays shown, marked, while it is looked up, and is not repeated on a guess');
  {
    const sent = movesSent(second);
    const moves = await Gate.on(second, 'moves');
    const polls = await Gate.on(second, 'polls');

    // The server plays it and the answer never arrives; no poll gets through either, until the check lets one
    await polls.close('requests');
    await moves.close('answers');

    // The big blind checks; that brings the flop, where the big blind is first to act again
    await second.click('.turn [data-action="check"]');
    await second.waitForSelector('.turn', { state: 'detached' });
    await moves.holding();
    await moves.lose();

    await second.waitForSelector('.toast:has-text("Checking whether that was played")');
    await second.waitForSelector('.stage[data-unconfirmed]');
    assert.equal(await second.innerText('.controls .waiting'), 'Waiting for the table to confirm your check…');
    assert.equal(await second.locator('.board .card[data-card]').count(), 0, 'no card is shown that the server has not sent');

    await polls.open();
    await second.waitForSelector('.board .card[data-card]');
    await second.waitForSelector('.turn [data-action="check"]:enabled');

    assert.equal(await second.locator('.board .card[data-card]').count(), 3, 'the check was played once: the flop is out and no further');
    assert.equal(await second.locator('.stage[data-unconfirmed]').count(), 0);
    assert.deepEqual(sent, ['check']);

    await second.unrouteAll({ behavior: 'ignoreErrors' });
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

  // The flop, with the big blind's check in and the button to act. From here each page's moves and polls go by a gate
  {
    const nameOf = (page: Page) => (page === host ? 'Quigs' : 'Danny');
    const said = [complaints(first), complaints(second)];
    const sent = [movesSent(first), movesSent(second)];
    const gates = { first: { moves: await Gate.on(first, 'moves'), polls: await Gate.on(first, 'polls') }, second: { moves: await Gate.on(second, 'moves'), polls: await Gate.on(second, 'polls') } };

    console.log('A bet the server refuses comes off the table, and the buttons are back with the amount as it was typed');
    {
      await first.fill('#raise-amount', '137');
      const before = await ownPart(first);

      await gates.first.moves.close('requests');
      await first.click('.turn [data-action="raise"]');
      await first.waitForSelector('.turn', { state: 'detached' });
      assert.equal(await first.innerText('.seat.me + .bet'), '137', 'the bet is on the table before the server has answered');

      await gates.first.moves.holding();
      await gates.first.moves.refuse();
      await first.waitForSelector('.toast:has-text("The table is busy, try again")');
      await first.waitForSelector('.turn [data-action="raise"]:enabled');

      assert.equal(await first.inputValue('#raise-amount'), '137');
      assert.match(await first.innerText('.turn .btn.raise'), /137/);
      assert.deepEqual(await ownPart(first), before, 'the table is as it was before the bet');
      await gates.first.moves.open();
    }

    console.log('A move that never reaches the server is looked up, put back with a sentence, and not sent again');
    {
      const before = await ownPart(first);

      await gates.first.polls.close('requests');
      await gates.first.moves.close('requests');
      await first.click('.turn [data-action="check"]');
      await first.waitForSelector('.turn', { state: 'detached' });
      await gates.first.moves.holding();
      await gates.first.moves.lose();
      await first.waitForSelector('.stage[data-unconfirmed]');

      await gates.first.polls.open();
      await first.waitForSelector('.toast:has-text("The table has no sign of your check, so it is still your turn.")');
      await first.waitForSelector('.turn [data-action="check"]:enabled');

      assert.deepEqual(await ownPart(first), before, 'the table is as it was before the check');
      assert.equal(await first.inputValue('#raise-amount'), '137', 'the bet being sized is still there');
      assert.equal(await second.locator('.turn').count(), 0, 'the other player was never given the turn');
      await gates.first.moves.open();
    }

    console.log('A move the server confirms is drawn once: its answer changes nothing of what was shown at the tap');
    {
      await gates.first.moves.close('requests');
      await first.click('.turn [data-action="raise"]');
      await first.waitForSelector('.turn', { state: 'detached' });
      await gates.first.moves.holding();

      const made = await ownPart(first);
      assert.equal(await first.innerText('.seat.me + .bet'), '137');
      assert.equal(await second.locator('.bet').count(), 0, 'the other player sees no bet the server has not heard of');

      await gates.first.moves.open();
      await toldOf(first, nameOf(first));
      await second.waitForSelector('.turn [data-action="call"]:enabled');
      assert.deepEqual(await ownPart(first), made);
    }

    console.log('A view from before a move, arriving after the tap, does not put the turn back');
    {
      // The poll is answered with a line of chat, and the answer is still on its way when this player calls
      await gates.second.polls.close('answers');
      await say(first, 'well?');
      await gates.second.polls.holding();

      await gates.second.moves.close('requests');
      await second.click('.turn [data-action="call"]');
      await second.waitForSelector('.turn', { state: 'detached' });
      await gates.second.moves.holding();
      const made = await ownPart(second);

      await gates.second.polls.open();
      await second.waitForSelector('.feed li:has-text("well?")', { state: 'attached' });
      assert.equal(await second.locator('.turn').count(), 0, 'the decision already made is not back on screen');
      assert.deepEqual(await ownPart(second), made, 'and the call is still on the table');

      // The call ends the flop, and the turn card comes with the answer, not before
      assert.equal(await second.locator('.board .card[data-card]').count(), 3);
      await gates.second.moves.open();
      await second.waitForSelector('.turn [data-action="check"]:enabled');
      assert.equal(await second.locator('.board .card[data-card]').count(), 4);
    }

    console.log('An answer that arrives after a poll already showed the move played, and the hand moved on, changes nothing and frees the buttons');
    {
      // The server plays the check, and its answer is held while the page's poll brings the news
      await gates.second.moves.close('answers');
      await second.click('.turn [data-action="check"]');
      await second.waitForSelector('.turn', { state: 'detached' });
      await toldOf(second, nameOf(second));

      // The other player checks behind, and the river puts the action back on this one, whose first check is still unanswered
      await first.click('.turn [data-action="check"]');
      await second.waitForSelector('.turn [data-action="check"]:disabled');
      assert.equal(await second.locator('.board .card[data-card]').count(), 5);

      // A tap on a locked button is no tap, and a key presses nothing either
      await second.locator('.turn [data-action="check"]').click({ force: true }).catch(() => undefined);
      await pressTurnKeys(second);

      const river = await ownPart(second);
      await gates.second.moves.holding();
      await gates.second.moves.open();
      await second.waitForSelector('.turn [data-action="check"]:enabled');
      assert.deepEqual(await ownPart(second), river, 'the old answer put nothing back');

      // And the turn it freed is played as any other
      await second.click('.turn [data-action="check"]');
      await first.waitForSelector('.turn [data-action="check"]:enabled');
    }

    console.log('A reaction whose request or its answer is lost is dropped: shown at the tap, never sent again or looked up, nothing said, and the seat kept');
    {
      const askedOf = (page: Page) => {
        const asked = { reactions: 0, lookups: 0 };

        page.on('request', (request) => {
          const body = JSON.parse(request.postData() ?? '{}') as { op?: string; since?: number; command?: { type: string } };

          asked.reactions += body.op === 'act' && body.command?.type === 'react' ? 1 : 0;
          asked.lookups += body.op === 'poll' && body.since === -1 ? 1 : 0;
        });

        return asked;
      };
      const asked = [askedOf(first), askedOf(second)];
      const lost = { first: await Gate.on(first, 'reactions'), second: await Gate.on(second, 'reactions') };
      const seatsOf = async (page: Page) => [inAddress(page, 'me'), await remembered(page, tableId)];
      const seats = [await seatsOf(first), await seatsOf(second)];

      // What the moves before had the pages say is gone first
      await first.waitForSelector('.toast', { state: 'hidden' });
      await second.waitForSelector('.toast', { state: 'hidden' });

      // Lost on its way: the server never hears it, and only the page that sent it showed it
      await lost.first.close('requests');
      await first.click('[data-action="reactions"]');
      await first.click('[data-react="laugh"]');
      await first.waitForSelector('.seat-reaction[data-reaction="laugh"]');
      await lost.first.holding();
      await lost.first.lose();

      // Lost on its way back: the server heard it, so the other player sees it land
      await lost.second.close('answers');
      await second.click('[data-action="reactions"]');
      await second.click('[data-react="tomato"]');
      await second.click(`[data-throw-at="${inAddress(first, 'me')!.split('.')[0]}"]`);
      await second.waitForSelector('.seat-reaction[data-reaction="tomato"]');
      await lost.second.holding();
      await lost.second.lose();
      await first.waitForSelector('.seat-reaction[data-reaction="tomato"]');

      // Long enough for a page that went looking to have asked
      await sleep(QUIET_MS);
      assert.deepEqual(asked, [{ reactions: 1, lookups: 0 }, { reactions: 1, lookups: 0 }], 'a lost reaction was sent again or looked up');
      assert.deepEqual([await seatsOf(first), await seatsOf(second)], seats, 'a lost reaction touched a seat');

      for (const page of [first, second]) {
        assert.deepEqual(await page.locator('.toast:visible').allInnerTexts(), [], 'a lost reaction was spoken of');
      }

      await lost.first.open();
      await lost.second.open();
    }

    console.log('A move chosen ahead shows at the tap, is looked up and not sent again when its answer is lost, and the table makes it when the action arrives, with nothing for the player to tap');
    {
      const chosen: unknown[] = [];
      first.on('request', (request) => {
        const body = JSON.parse(request.postData() ?? '{}') as { op?: string; command?: { type: string; what?: unknown } };

        if (body.op === 'act' && body.command?.type === 'preAct') {
          chosen.push(body.command.what);
        }
      });

      // The river is checked through. In the next hand the other player has the button and acts first, with this one in the big blind behind
      await first.click('.turn [data-action="check"]');
      await second.waitForSelector('.turn [data-action="call"]:enabled');
      await first.waitForSelector('.ahead [data-action="ahead-check"]:enabled');
      assert.deepEqual(await first.locator('.ahead button:enabled').allInnerTexts(), ['Fold', 'Check/Fold', 'Check', 'Check/Call any']);

      // The table hears the choice, and its answer never comes back
      const choices = await Gate.on(first, 'choices');
      await choices.close('answers');
      await first.click('.ahead [data-action="ahead-check"]');
      await first.waitForSelector('.ahead [data-action="ahead-check"][aria-pressed="true"]');
      await choices.holding();
      await choices.lose();
      await first.waitForSelector('.toast:has-text("No answer from the table")');
      await choices.open();

      // Long enough for a page that sent it again to have done so; what it asked the table agrees with what it shows
      await sleep(QUIET_MS);
      assert.deepEqual(chosen, ['check'], 'a choice whose answer was lost was sent again');
      assert.equal(await first.locator('.ahead [data-action="ahead-check"][aria-pressed="true"]').count(), 1, 'the choice the table has is no longer shown');

      // The call brings the action, the table checks, and the flop puts this player first to act: a new turn, not the one the choice answered
      await second.click('.turn [data-action="call"]');
      await first.waitForSelector('.turn [data-action="check"]:enabled');
      assert.equal(await first.locator('.board .card[data-card]').count(), 3);
      assert.deepEqual((await first.locator('.feed li').allInnerTexts()).slice(-3, -1), [`${nameOf(second)} calls 10`, `${nameOf(first)} checks`]);
      assert.equal(await first.locator('.ahead, [aria-pressed="true"]').count(), 0, 'a choice is still shown on the turn');
    }

    assert.deepEqual(sent, [['raise', 'check', 'raise', 'check', 'check'], ['call', 'check', 'check', 'call']], 'each move was sent once: the refused bet and the lost check were tapped again by the player, and the check chosen ahead was no move of the page');
    assert.deepEqual(said.map(ownComplaints), [[], []], 'a page complained in the console');

    await first.unrouteAll({ behavior: 'ignoreErrors' });
    await second.unrouteAll({ behavior: 'ignoreErrors' });

    // What these cases had the page say is gone before the next looks at what a page says
    await first.waitForSelector('.toast', { state: 'hidden' });
  }

  console.log('A rabbit hunt whose answer is lost after the table played it is sent once more, and the cards come out once');
  {
    const dealer = await open(browser);
    const rabbitTable = await createTable(dealer, server.url, 'Bart');
    const [id, token] = inAddress(dealer, 'me')!.split('.');
    const act = (command: object) => fetch(`${server.url}api`, { method: 'POST', body: JSON.stringify({ op: 'act', tableId: rabbitTable, auth: { id, token }, command, build: UNSTAMPED_BUILD }) });

    assert.equal(((await (await act({ type: 'updateConfig', config: { rabbitHunting: true } })).json()) as { ok: boolean }).ok, true);
    await sit(dealer, 0);

    const other = await open(browser);
    await other.goto(`${server.url}?table=${rabbitTable}`);
    await other.fill('#join-name', 'Lisa');
    await other.click('[data-action="join-table"]');
    await sit(other, 1);
    await dealer.click('.banner [data-action="approve"]');
    await other.waitForSelector('.seat.me');
    await dealer.click('.message [data-action="start"]');

    // Whoever acts first folds, which ends the hand before the flop
    const folder = await Promise.race([dealer, other].map((page) => page.waitForSelector('.turn [data-action="fold"]:enabled').then(() => page)));
    await folder.click('.turn [data-action="fold"]');

    const hunter = folder === dealer ? other : dealer;
    let hunts = 0;
    await hunter.route('**/api', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { op?: string; command?: { type?: string } };

      // The first is played by the table, and its answer never reaches the page
      if (body.op === 'act' && body.command?.type === 'huntRabbit' && ++hunts === 1) {
        await route.fetch();
        return route.abort('failed');
      }

      return route.fallback();
    });

    await hunter.click('.message [data-action="hunt"]');
    await hunter.waitForSelector('.board .card.hunted:nth-child(5)');
    await folder.waitForSelector('.board .card.hunted:nth-child(5)');

    assert.equal(hunts, 2, 'the hunt with no answer was sent once more');
    assert.equal(await hunter.locator('.feed li:has-text("hunts the rabbit")').count(), 1, 'and the cards came out once');

    await dealer.context().close();
    await other.context().close();
  }

  console.log('A card shown after the hand whose answer is lost after the table played it is sent once more, and comes out once');
  {
    const dealer = await open(browser);
    const showTable = await createTable(dealer, server.url, 'Nelson');
    await sit(dealer, 0);

    const other = await open(browser);
    await other.goto(`${server.url}?table=${showTable}`);
    await other.fill('#join-name', 'Milhouse');
    await other.click('[data-action="join-table"]');
    await sit(other, 1);
    await dealer.click('.banner [data-action="approve"]');
    await other.waitForSelector('.seat.me');
    await dealer.click('.message [data-action="start"]');

    // Whoever acts first folds, and then shows the card on their left
    const folder = await Promise.race([dealer, other].map((page) => page.waitForSelector('.turn [data-action="fold"]:enabled').then(() => page)));
    await folder.click('.turn [data-action="fold"]');
    const watcher = folder === dealer ? other : dealer;

    // The first is played by the table, and its answer never reaches the page; the one sent again is let through
    const shows = await Gate.on(folder, 'shows');
    await shows.close('answers');
    await folder.click('.controls [data-action="show-card"][data-place="0"]');
    await shows.holding();
    await shows.lose();
    await shows.holding();
    await shows.open();

    await folder.waitForSelector('.seat.me .hole .card.seen');
    await watcher.waitForSelector('.seat:not(.me) .hole .card[data-card] + .card.back');

    assert.equal(await folder.locator('.feed li:has-text("shows one card")').count(), 1, 'and the card came out once');
    assert.equal(await folder.locator('.feed li:has-text("shows the other card")').count(), 0);

    await dealer.context().close();
    await other.context().close();
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
      const move = moveIn(route.request());

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
    assert.equal(await first.locator('.seat.me.acting').count(), 1, 'with the check that may never be played taken off it');
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
    // The page shows its check at the tap, so what says it went through is the answer, and no notice after it
    const answer = await answeredAfter(first, () => first.click('.turn [data-action="check"]'));
    assert.equal((await answer.json()).ok, true, 'the check was refused');
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

    console.log("In Apps Script's frame, which is refused the clipboard, the night as text is put in a box, selected, to be copied from there");
    await frame.click('.dialog [data-action="close"]');
    await frame.click('[data-action="menu"]');
    await frame.click('.menu [data-action="tonight"]');
    await frame.click('[data-action="copy-tonight"]');
    await frame.waitForSelector('#tonight-text:visible');

    const box = (await frame.evaluate(`(() => {
      const box = document.querySelector('#tonight-text');

      return { text: box.value, selected: box.value.slice(box.selectionStart, box.selectionEnd), focused: document.activeElement === box, says: document.querySelector('[data-action="copy-tonight"]').textContent };
    })()`)) as { text: string; selected: string; focused: boolean; says: string };

    assert.equal(box.text, 'Chips n’ Dipshits: the night so far, 0 hands\n\nHomer 0 · 0 hands · 0 pots won\nMarge 0 · 0 hands · 0 pots won');
    assert.deepEqual([box.selected, box.focused], [box.text, true], 'the text is not ready to be copied by hand');
    // Copying a selection is still allowed in such a frame by the browsers that allow it at all, and where it is not, the button sends the player to the box
    assert.ok(['Copied', 'Copy it from the box'].includes(box.says), box.says);

    await context.close();
    await dealer.context().close();
    google.close();
  }

  console.log('A table that was put away says so once, stops asking, and is in neither the address nor the browser afterwards, its mutes and the cards kept for its replays included, while who the browser is stays');
  {
    // A game of its own, whose clock can be moved on two weeks
    let ahead = 0;
    const game = new PokerService({ store: new MemoryStore(), presets: new MemoryPresetStore(), players: new MemoryPlayerStore(seededRng(15)), clock: { now: () => Date.now() + ahead }, rng: seededRng(14) });
    const later = await startDevServer({ port: 0, page: async () => html, service: game });

    try {
      const page = await open(browser);
      const old = await createTable(page, later.url, 'Marge');
      const member = inAddress(page, 'me')!;
      assert.equal(await remembered(page, old), member);
      await page.evaluate(`localStorage.setItem('cnd.mute.${old}', '["someone"]')`);
      await page.evaluate(`localStorage.setItem('cnd.dealt.${old}', '{"player":"someone","hands":[[1,["As","Ah"]]]}')`);

      const whoItIs = `localStorage.getItem('cnd.player')`;
      const marge = await page.evaluate(whoItIs);
      assert.match(String(marge), /"name":"Marge"/);

      const polls: unknown[] = [];
      page.on('request', (request) => {
        const sent = JSON.parse(request.postData() ?? '{}') as { op?: string; tableId?: string };

        if (sent.op === 'poll' && sent.tableId === old) {
          polls.push(sent);
        }
      });

      // Nobody plays for two weeks, the page open all the while, and then someone else starts a table
      ahead = PUT_AWAY_AFTER_MS;
      const other = await open(browser);
      await createTable(other, later.url, 'Homer');

      await page.waitForSelector('[data-screen="put-away"]');
      assert.equal(await page.innerText('[data-screen="put-away"] p >> nth=0'), PUT_AWAY_MESSAGE);
      assert.deepEqual([inAddress(page, 'table'), inAddress(page, 'me')], [null, null], 'the address still names the table that is gone');
      assert.equal(await remembered(page, old), null, 'the browser still remembers a seat at it');
      assert.equal(await page.evaluate(`localStorage.getItem('cnd.mute.${old}')`), null, 'the browser still keeps who was muted at it');
      assert.equal(await page.evaluate(`localStorage.getItem('cnd.dealt.${old}')`), null, 'the browser still keeps the cards dealt at it');
      assert.equal(await page.evaluate(whoItIs), marge, 'who the browser is went with a table, though it is not about any one table');

      // The answer was a plain one, not a failure to be tried again
      const asked = polls.length;
      await sleep(QUIET_MS);
      assert.equal(polls.length, asked, 'the page went on asking for a table that was put away');

      // Loaded again there is no table to go back to, and the personal link someone kept is answered the same way
      await page.reload();
      await page.waitForSelector('[data-action="create-table"]');
      assert.equal(await page.innerText('.who-remembered b'), 'Marge');

      const kept = await open(browser);
      await kept.goto(`${later.url}?table=${old}&me=${member}`);
      await kept.waitForSelector('[data-screen="put-away"]');
      assert.deepEqual([inAddress(kept, 'table'), inAddress(kept, 'me')], [null, null]);

      await kept.click('[data-action="start-new-table"]');
      await kept.waitForSelector('[data-action="create-table"]');

      // The table made since is none the worse
      await other.waitForSelector('.stage .table');
      await say(other, 'still here');

      for (const each of [page, other, kept]) {
        await each.context().close();
      }
    } finally {
      await later.close();
    }
  }

  console.log("A failure in the page reaches Apps Script's stand-in once, as a report from the member, and the seat is kept; before joining there is nobody to send it as");
  {
    assert.equal(errors.rows.length, 0, 'the cases above wrote to the error log');

    const meant = 'A failure on purpose';
    const lobby = await open(browser, meant);
    const fromLobby = opsSent(lobby);
    await lobby.goto(server.url);
    await lobby.waitForSelector('[data-action="create-table"]');
    await throwIn(lobby, meant);
    await sleep(QUIET_MS);
    assert.deepEqual(fromLobby.filter((op) => op === 'report'), [], 'a page that is at no table reported');

    const page = await open(browser, meant);
    const id = await createTable(page, server.url, 'Ned');
    const member = inAddress(page, 'me')!;
    const sent = opsSent(page);

    await throwIn(page, meant);
    await throwIn(page, meant);
    await until('the reports', () => errors.rows.length === 2);
    await sleep(QUIET_MS);

    assert.deepEqual(sent.filter((op) => op === 'report'), ['report', 'report'], 'the thrown failure and the rejected one, each once');
    assert.deepEqual(
      errors.rows.map((row) => [row.where, row.tableId, row.message]),
      [
        ['page', id, meant],
        ['page', id, `${meant}, rejected`],
      ],
    );
    assert.match(errors.rows[0]!.browser, /^Chrome \d+ on a desktop$/);
    assert.deepEqual([inAddress(page, 'table'), inAddress(page, 'me'), await remembered(page, id)], [id, member, member], 'the seat was lost');
    await say(page, 'still here');

    await lobby.context().close();
    await page.context().close();
  }

  console.log('A join whose answer is lost is the same join when it is tried again, and the key the two go under is in neither the address, what the browser remembers, nor what the page reports of a failure');
  {
    // A game of its own, whose tables can be looked into
    const tables = new MemoryStore();
    const told = new MemoryErrorLog({ now: () => Date.now() });
    const game = new PokerService({ store: tables, presets: new MemoryPresetStore(), players: new MemoryPlayerStore(seededRng(27)), clock: { now: () => Date.now() }, rng: seededRng(26), errors: told });
    const own = await startDevServer({ port: 0, page: async () => html, service: game });

    try {
      const meant = 'A failure around a join';
      const owner = await open(browser);
      const id = await createTable(owner, own.url, 'Ivy');

      const guest = await open(browser, meant);
      const bodies: string[] = [];
      const lost: { auth: { id: string; token: string } }[] = [];

      await guest.route('**/api', async (route) => {
        const body = route.request().postData() ?? '';
        bodies.push(body);

        if ((JSON.parse(body) as { op?: string }).op !== 'join' || lost.length > 0) {
          return route.continue();
        }

        // The table lets the guest in, and the answer never arrives
        lost.push((await (await route.fetch()).json()) as (typeof lost)[number]);

        return route.abort('failed');
      });

      await guest.goto(`${own.url}?table=${id}`);
      await guest.waitForSelector('[data-action="join-table"]:not([disabled])');
      await guest.fill('#join-name', 'Jo');
      await guest.click('[data-action="join-table"]');
      await guest.waitForSelector('.toast:has-text("Could not join the table")');
      assert.deepEqual(tables.read(id)!.members.map((member) => member.name), ['Ivy', 'Jo'], 'the table did not let the guest in the first time, so the case shows nothing');

      const joins = () => bodies.filter((body) => body.includes('"op":"join"')).map((body) => (JSON.parse(body) as { key?: string }).key);
      const key = joins()[0]!;
      assert.match(String(key), /^[A-Za-z0-9_-]{22,64}$/, 'the join went without a key, or with one too short to be a secret');

      const keptBy = (page: Page) => page.evaluate('JSON.stringify([location.href, { ...localStorage }, { ...sessionStorage }, document.cookie, document.documentElement.outerHTML])') as Promise<string>;
      assert.ok(!(await keptBy(guest)).includes(key), 'the key of a join that has no answer is in the address, in what the browser remembers, or on the page');

      // A failure while the join has no answer has nobody to be reported as
      await throwIn(guest, meant);
      await sleep(QUIET_MS);
      assert.ok(!bodies.some((body) => body.includes('"op":"report"')), 'a page that is at no table reported');

      await guest.waitForSelector('[data-action="join-table"]:not([disabled])');
      await guest.click('[data-action="join-table"]');
      await guest.waitForSelector('.stage .table');
      assert.deepEqual(joins(), [key, key], 'the second asking went under another key than the first');
      assert.deepEqual(tables.read(id)!.members.map((member) => member.name), ['Ivy', 'Jo'], 'trying again made the guest a second member');
      assert.equal(inAddress(guest, 'me'), `${lost[0]!.auth.id}.${lost[0]!.auth.token}`, 'the guest is not the member the first asking made');

      // A failure once the guest is in is reported as theirs, and says nothing of how they got in
      await throwIn(guest, `${meant}, at the table`);
      await until('the reports', () => told.rows.length === 2);
      assert.deepEqual(told.rows.map((row) => [row.where, row.tableId]), [['page', id], ['page', id]]);
      assert.ok(!JSON.stringify(told.rows).includes(key), 'the error log has the key of a join');
      assert.deepEqual(bodies.filter((body) => body.includes(key) && !body.includes('"op":"join"')), [], 'a request that is not the join carries its key');
      assert.ok(!(await keptBy(guest)).includes(key), 'the key outlived the join in the address, in what the browser remembers, or on the page');

      await owner.context().close();
      await guest.context().close();
    } finally {
      await own.close();
    }
  }

  console.log('Who are you: the first to arrive is asked only for a name, the page then says who it takes them for, "not me" asks again, a list that will not load stops nobody, and a seat is never touched by any of it');
  {
    // A game of its own, which starts out knowing nobody
    const known = new MemoryPlayerStore(seededRng(17));
    const game = new PokerService({ store: new MemoryStore(), presets: new MemoryPresetStore(), players: known, clock: { now: () => Date.now() }, rng: seededRng(16) });
    const fresh = await startDevServer({ port: 0, page: async () => html, service: game });

    const asks = (page: Page) => page.getAttribute('.who-ask', 'data-who');
    const player = async (page: Page) => JSON.parse(((await page.evaluate(`localStorage.getItem('cnd.player')`)) as string | null) ?? 'null') as { id: string; name: string } | null;
    const idOf = (name: string) => known.list().find((listed) => listed.name === name)!.id;
    const pills = (page: Page) => page.locator('.who-list .who-pill').allInnerTexts();

    /** A gate that keeps the list of players from the page until it is opened. */
    const listKept = async (page: Page) => {
      const gate = await Gate.on(page, 'players');
      await gate.close('requests');

      return gate;
    };

    /** The page's request for the list fails, as on a bad line, and the page asks again. */
    const listFails = async (gate: Gate) => {
      await gate.holding();
      await gate.lose();
      await gate.holding();
    };

    try {
      // The first visit: nobody is known, so the question is the one it always was
      const host = await open(browser);
      await host.goto(fresh.url);
      await host.waitForSelector('#host-name');
      assert.equal(await asks(host), 'name');
      assert.deepEqual([await host.isVisible('.who-pick'), await host.isVisible('.who-remembered')], [false, false]);

      const first = await createTable(host, fresh.url, 'Quigs');
      const seat = await remembered(host, first);
      assert.deepEqual(await player(host), { id: idOf('Quigs'), name: 'Quigs' });
      assert.equal(inAddress(host, 'me'), seat);

      // A guest's join form before the list is in asks for a name; what is half typed, and the cursor, are still there when it arrives
      const guest = await open(browser);
      const list = await listKept(guest);
      await guest.goto(`${fresh.url}?table=${first}`);
      await guest.waitForSelector('[data-action="join-table"]:not([disabled])');
      await list.holding();
      assert.equal(await asks(guest), 'name');

      await guest.click('#join-name');
      await guest.keyboard.type('Bo');
      await list.open();
      await guest.waitForSelector('.who-pick');
      assert.deepEqual(await pills(guest), ['Quigs']);
      assert.equal(await guest.getAttribute('[data-action="someone-new"]', 'aria-pressed'), 'true');
      assert.equal(await guest.evaluate('document.activeElement.id'), 'join-name', 'the list arriving took the cursor out of the name');

      await guest.keyboard.type('b');
      assert.equal(await guest.inputValue('#join-name'), 'Bob');
      await guest.click('[data-action="join-table"]');
      await guest.waitForSelector('.stage .table');
      assert.deepEqual(await player(guest), { id: idOf('Bob'), name: 'Bob' });

      const guestSeat = await remembered(guest, first);
      assert.ok(guestSeat);

      // The next visit says who it takes them for before the list is even in, and making a table needs no name typed
      const again = await listKept(host);
      await host.goto(fresh.url);
      await host.waitForSelector('.who-remembered');
      await again.holding();
      assert.equal(await host.innerText('.who-remembered b'), 'Quigs');
      assert.equal(await host.isVisible('#host-name'), false);
      await again.open();

      await host.click('[data-action="create-table"]');
      await host.waitForSelector('#table-link');
      await host.click('[data-action="close"]');
      const second = inAddress(host, 'table')!;
      assert.notEqual(second, first);
      assert.deepEqual(known.list().map((listed) => listed.name).sort(), ['Bob', 'Quigs'], 'a remembered player was put on the list again');
      assert.equal(await remembered(host, first), seat, 'the seat at the first table was touched');

      // Not me: the list, with the name last typed in its box and the player it reads like pointed out
      await guest.goto(`${fresh.url}?table=${second}`);
      await guest.waitForSelector('.who-remembered');
      await guest.click('[data-action="not-me"]');
      await guest.waitForSelector('.who-pick');
      assert.deepEqual((await pills(guest)).sort(), ['Bob', 'Quigs']);
      assert.equal(await guest.inputValue('#join-name'), 'Bob');
      assert.equal(await guest.innerText('[data-action="pick-alike"]'), 'I’m Bob');

      // Someone new under a name the list has is told whose it is, stays on the form with everything as typed, and nothing is lost
      await guest.click('[data-action="join-table"]');
      await guest.waitForSelector('.toast:has-text("Bob is already on the list of players")');
      assert.equal(await guest.inputValue('#join-name'), 'Bob');
      assert.deepEqual([await player(guest), await remembered(guest, first)], [{ id: idOf('Bob'), name: 'Bob' }, guestSeat]);

      // Saying they are the host instead joins them as a member of their own: it is a name tag, and the host keeps the table
      await guest.click('.who-pill:has-text("Quigs")');
      assert.equal(await guest.isVisible('#join-name'), false);
      await guest.click('[data-action="join-table"]');
      await guest.waitForSelector('.stage .table');
      assert.deepEqual(await player(guest), { id: idOf('Quigs'), name: 'Quigs' });
      await guest.click('[data-action="menu"]');
      await guest.waitForSelector('.menu [data-action="who"]');
      assert.equal(await guest.locator('.menu [data-action="players"], .menu [data-action="settings"]').count(), 0, 'picking the host gave the guest the host’s menu');
      assert.equal(await guest.innerText('.menu [data-action="who"] small'), 'On the list of players as Quigs');
      await guest.click('[data-action="close"]');
      assert.notEqual(inAddress(guest, 'me'), inAddress(host, 'me'));
      assert.equal(await remembered(guest, first), guestSeat, 'saying otherwise took the seat at the first table out of the browser');
      assert.equal(known.list().length, 2);

      // A browser that knows nobody picks a name in the lobby and makes a table as that player, which is how the check of the deployed game comes in
      const picker = await open(browser);
      await picker.goto(fresh.url);
      await picker.click('.who-pill:text-is("Bob")');
      await picker.waitForSelector('#host-name', { state: 'hidden' });
      await picker.click('[data-action="create-table"]');
      await picker.waitForSelector('#table-link');
      assert.deepEqual(await player(picker), { id: idOf('Bob'), name: 'Bob' });
      assert.equal(known.list().length, 2);
      await picker.context().close();

      // A list that will not load: someone new is asked for a name and gets in, hearing nothing of it
      const stranger = await open(browser);
      const failing = await listKept(stranger);
      await stranger.goto(`${fresh.url}?table=${second}`);
      await stranger.waitForSelector('[data-action="join-table"]:not([disabled])');
      await listFails(failing);
      assert.equal(await asks(stranger), 'name');
      assert.equal(await stranger.isVisible('.toast'), false, 'the page said something about a list it can do without');

      await stranger.fill('#join-name', 'Dee');
      await stranger.click('[data-action="join-table"]');
      await stranger.waitForSelector('.stage .table');
      assert.deepEqual(await player(stranger), { id: idOf('Dee'), name: 'Dee' });

      // And someone remembered is still taken for who they were: only a list that did load says a player is gone
      await failing.lose();
      await stranger.goto(fresh.url);
      await stranger.waitForSelector('.who-remembered');
      await listFails(failing);
      assert.equal(await stranger.innerText('.who-remembered b'), 'Dee');
      assert.deepEqual(await player(stranger), { id: idOf('Dee'), name: 'Dee' });
      await failing.open();

      // A remembered player the list no longer has is forgotten without a word, and the seats stay
      const strangerSeat = await remembered(stranger, second);
      await stranger.evaluate(`localStorage.setItem('cnd.player', JSON.stringify({ id: 'GONE234', name: 'Ghost' }))`);
      await stranger.goto(fresh.url);
      await stranger.waitForSelector('.who-pick');
      assert.equal(await stranger.isVisible('.who-remembered'), false);
      assert.equal(await stranger.isVisible('.toast'), false);
      assert.equal(await player(stranger), null);
      assert.equal(await remembered(stranger, second), strangerSeat);
      assert.equal(await stranger.inputValue('#host-name'), 'Dee');

      for (const each of [host, guest, stranger]) {
        await each.context().close();
      }
    } finally {
      await fresh.close();
    }
  }

  console.log('The page says what language it is in, even where whoever serves it writes the outer page themselves');
  {
    const page = await open(browser);

    // As Apps Script may serve it: the page's own markup inside a document that names no language
    await page.route(server.url, async (route) => {
      const served = await route.fetch();

      await route.fulfill({ response: served, body: (await served.text()).replace('<html lang="en">', '<html>') });
    });

    await page.goto(server.url);
    await page.waitForSelector('[data-action="create-table"]');
    assert.equal(await page.evaluate('document.documentElement.lang'), 'en', 'a screen reader is left to guess the language');
    await page.context().close();
  }

  console.log('The theme and the size of text are set before anything is drawn: what the player chose, else what the device asks for');
  {
    // Written down the moment the page first has anything in it, which is before the browser can have painted it
    const AT_FIRST_DRAW = `new MutationObserver((_changes, observer) => {
      const app = document.getElementById('app');

      if (app && app.childElementCount > 0) {
        window.atFirstDraw = { theme: document.documentElement.dataset.theme, textSize: app.dataset.textSize };
        observer.disconnect();
      }
    }).observe(document, { subtree: true, childList: true });`;
    const page = await open(browser);
    const drawnAs = async () => {
      await page.waitForSelector('[data-action="create-table"]');

      return page.evaluate('window.atFirstDraw');
    };

    await page.addInitScript(AT_FIRST_DRAW);
    await page.goto(server.url);
    assert.deepEqual(await drawnAs(), { theme: 'cardroom', textSize: 'standard' }, 'a device that asks for nothing');

    // A device set to more contrast, and a browser set to larger text than it shipped with
    await page.emulateMedia({ contrast: 'more' });
    await page.addInitScript(`new MutationObserver((_changes, observer) => {
      if (document.documentElement) {
        document.documentElement.style.fontSize = '20px';
        observer.disconnect();
      }
    }).observe(document, { childList: true });`);
    await page.reload();
    assert.deepEqual(await drawnAs(), { theme: 'contrast', textSize: 'large' }, 'what the device asks for');

    await page.evaluate(`localStorage.setItem('cnd.theme', 'divebar'); localStorage.setItem('cnd.textSize', 'largest')`);
    await page.reload();
    assert.deepEqual(await drawnAs(), { theme: 'divebar', textSize: 'largest' }, 'what the player chose stands over what the device asks for');
    await page.context().close();
  }

  console.log("The live check's own game plays through, and on a Sheet of tables older code saved it changes no row of theirs but those of the tables it puts away");
  {
    // The store as it is deployed, on a Sheet the way a staging check finds it: every table saved by the code friends are still
    // playing on, which cannot open one this code has saved. Some were left two weeks ago, some this afternoon, some are in play
    const lock = new FakeLock();
    const sheet = new FakeSpreadsheet(lock, {}, null, [ERRORS_TAB]);
    const cache = new FakeCache();
    const clock = { now: () => Date.now() };
    const sheetErrors = new SheetErrorLog({ spreadsheet: () => sheet, cache, clock, build: UNSTAMPED_BUILD });
    const deps = { spreadsheet: () => sheet, cache, lock, flush: () => {}, errors: sheetErrors };
    const results = new SheetResultStore({ ...deps, clock });
    const store = new SheetStore({ ...deps, results });
    const rng = seededRng(17);
    const game = new PokerService({ store, presets: new SheetPresetStore(deps), players: new SheetPlayerStore({ ...deps, rng }), arrivals: new CacheArrivalKeys({ cache }), results, clock, rng, errors: sheetErrors });

    const HOUR_MS = 3_600_000;
    const leftFor = (index: number) => (index < PUT_AWAY_AT_ONCE + 1 ? PUT_AWAY_AFTER_MS + (index + 1) * HOUR_MS : index < 9 ? 4 * HOUR_MS : 60_000);
    const older = readdirSync(OLDER_TABLES).filter((file) => file.endsWith('.json'));

    older.forEach((file, index) => {
      // As its file has it, with no step taken toward this code's shape, under an id of its own
      const state = { ...(JSON.parse(readFileSync(new URL(file, OLDER_TABLES), 'utf8')) as TableState), id: `OLD2${'ABCDEFGHJKLMNPQRSTUVWXYZ'[index]}2` };

      store.transact(state.id, () => ({ save: state, at: Date.now() - leftFor(index), effects: [], result: null }));
    });
    cache.entries.clear();

    const rowsOf = (tab: string) => {
      const found = sheet.getSheetByName(tab);
      const rows = found && found.getLastRow() > 1 ? found.getRange(2, 1, found.getLastRow() - 1, TABLE_COLUMNS).getValues() : [];

      return new Map(rows.filter((row) => row[0] !== '').map((row) => [String(row[0]), JSON.stringify(row)]));
    };
    const before = rowsOf('Tables');
    assert.equal(before.size, older.length);
    assert.ok([...before.values()].every((row) => /\\"schema\\":[2-6],/.test(row)), 'every table is as older code saved it');

    // What that code keeps of its tables in the script's cache, which the two share: it reads these before it reads the Sheet
    const theirsOf = () => Object.fromEntries([...cache.entries].filter(([key]) => /^(state|peek|row):[^:]+$/.test(key)));
    [...before.keys()].forEach((id, index) => {
      cache.put(`state:${id}`, `{"schema":2,"id":"${id}"}`, 21_600);
      cache.put(`peek:${id}`, '{"version":1,"wakeAt":null}', 21_600);
      cache.put(`row:${id}`, String(index + 2), 21_600);
    });
    const theirs = theirsOf();

    const checked = await startDevServer({ port: 0, page: async () => html, service: game });

    try {
      await playCheck({
        address: checked.url,
        open: async (url, phone = false) => {
          const page = await open(browser);

          if (phone) {
            await page.setViewportSize({ width: 390, height: 844 });
          }

          await page.goto(url);

          return { page, app: page };
        },
        picture: (name) => `${PICTURES}hosted-check-${name}.png`,
        say: () => {},
      });
    } finally {
      await checked.close();
    }

    const after = rowsOf('Tables');
    const putAway = rowsOf('Archive');
    const made = [...after.keys()].filter((id) => !before.has(id));

    assert.equal(made.length, 1, 'the check made one table');
    assert.equal(putAway.size, PUT_AWAY_AT_ONCE, 'and making it put away as many old tables as making any table does');

    // The code friends are on can still open every table it could: a row is cell for cell what that code saved, in Tables or in the Archive
    for (const [id, row] of before) {
      assert.equal(putAway.get(id) ?? after.get(id), row, `the row of ${id} was changed`);
      assert.equal(putAway.has(id), !after.has(id), `${id} is in one of the two tabs`);
    }

    // Nor does it find anything in the cache but what it left there: not a table of this code's, and no entry of its own gone
    assert.deepEqual(theirsOf(), theirs);

    // Nobody at those tables is a player the game knows, so the nights that went on record put nobody in the standings
    const standings = sheet.getSheetByName(RESULTS_TAB);
    assert.ok(!standings || standings.getLastRow() <= 1, 'a row went into Results');

    const failures = sheet.getSheetByName(ERRORS_TAB);
    assert.ok(!failures || failures.getLastRow() <= 1, `something failed on the way: ${failures?.shown(2, 2)}, ${failures?.shown(2, 4)}`);
  }

  console.log('A check that fails on a page told the game was updated says another build answered, and one that fails any other way says only what failed');
  {
    const SOON_MS = 3000;

    /** Plays the check at a server whose answers `instead` may replace, and gives what the check failed with. `stepMs` is how long a step may take. */
    const failedCheck = async (instead: (op: unknown, answer: () => object) => object, stepMs = SOON_MS): Promise<Error> => {
      const pages: Page[] = [];
      const checked = await startDevServer({
        port: 0,
        page: async () => html,
        answer: async (body, _request, answering) => {
          await answering.untilNews(body);

          return instead((body as { op?: unknown }).op, () => answering.handle(body) as object);
        },
      });

      try {
        await playCheck({
          address: checked.url,
          open: async (url) => {
            const page = await open(browser);

            page.setDefaultTimeout(stepMs);
            pages.push(page);
            await page.goto(url);

            return { page, app: page };
          },
          picture: (name) => `${PICTURES}hosted-check-failed-${name}.png`,
          say: () => {},
        });
      } catch (error) {
        return error as Error;
      } finally {
        for (const page of pages) {
          await page.context().close();
        }

        await checked.close();
      }

      return assert.fail('the check passed');
    };

    // For about a minute after a web app is given a version, the one it had answers some of the calls: here, the host's first move
    const mixed = await failedCheck((op, answer) => (op === 'act' ? { ...answer(), build: 'theoneithad0' } : answer()));
    assert.match(mixed.message, new RegExp(`Timeout ${SOON_MS}ms exceeded`), 'what failed is still said');
    assert.match(mixed.message, /A page of the check's is showing "The game was updated".*both may still be answering: wait a minute and run the check again/s);
    assert.ok(mixed.cause instanceof Error, 'and the failure itself is kept');

    // Or one of the check's own requests, which no page hears the answer to: the version it had turns away what a page of another build
    // may not ask. It is the check's last step, so the game before it is given the time a game takes
    const refused = await failedCheck((op, answer) => (op === 'standings' ? { ok: false, code: 'stale', error: OUTDATED_MESSAGE, build: 'theoneithad0' } : answer()), STEP_TIMEOUT_MS);
    assert.match(refused.message, /the standings could not be read: The game was updated\. Reload to keep playing\./);
    assert.match(refused.message, /A request of the check's own was turned away as one from a page of another build\..*both may still be answering: wait a minute and run the check again/s);

    const broken = await failedCheck((op, answer) => (op === 'act' ? { ok: false, code: 'internal', error: 'Something went wrong on the server, try again', build: UNSTAMPED_BUILD } : answer()));
    assert.match(broken.message, new RegExp(`Timeout ${SOON_MS}ms exceeded`));
    assert.doesNotMatch(broken.message, /The game was updated|another build/);
  }

  console.log('The Apps Script-hosted page holds up');
} finally {
  await browser.close();
  await server.close();
}
