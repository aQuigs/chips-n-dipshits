/*
 * Plays a short game at the deployed address, in real browsers with no Google account, the way
 * friends will reach it. It is the check that the page Apps Script serves is the page that was
 * built, and that the script and its Sheet answer. It leaves one small table behind in the Sheet, a
 * Presets tab if there was none, with the presets in it as it found them, and in the Players tab the
 * one player it plays as, whom its first run adds and every later run picks from the list. Both of its
 * browsers being that one player, its table is nobody's night, and it leaves nothing in the standings.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Browser, FrameLocator, Page } from 'playwright';

import { LIMITS } from '../src/engine/index.ts';
import type { KnownPlayer, Preset } from '../src/engine/index.ts';
import { buildOf } from './bundle.ts';
import { readDeployment } from './deployment.ts';

const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const BUILT_PAGE = fileURLToPath(new URL('../dist/gas/index.html', import.meta.url));

// Apps Script answers in seconds, not milliseconds, and the first request wakes the script up
const STEP_TIMEOUT_MS = 60_000;
const APP_SCRIPT = /<script[^>]*>([\s\S]*?)<\/script>/g;

// Both browsers come in as this one known player, so that a run a day does not fill the list with them
const CHECK_PLAYER = 'Live check';

interface Visitor {
  page: Page;
  /** The game itself, which Apps Script puts two frames deep. */
  app: FrameLocator;
}

async function open(browser: Browser, url: string, phone = false): Promise<Visitor> {
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.on('pageerror', (error) => {
    throw new Error(`The page failed: ${error.name}: ${error.message}`);
  });
  await page.goto(url);

  return { page, app: page.frameLocator('#sandboxFrame').frameLocator('#userHtmlFrame') };
}

/** Does one thing a player does and says how long the table took to show it. */
async function timed(what: string, step: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  await step();
  console.log(`  ${what}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

type ScriptAnswer = { ok: boolean; presets?: Preset[]; players?: KnownPlayer[]; units?: { players: { name: string }[] }[]; error?: string };

/** Asks the script directly from inside the game's frame, the way the page itself does, as the page's build. */
async function ask(visitor: Visitor, request: object): Promise<ScriptAnswer> {
  const body = JSON.stringify(request);

  return visitor.app.locator('body').evaluate(`new Promise((resolve, reject) => google.script.run
    .withSuccessHandler((json) => resolve(JSON.parse(json)))
    .withFailureHandler(reject)
    .api(JSON.stringify({ ...${body}, build: window.CND_BUILD })))`) as Promise<ScriptAnswer>;
}

async function checkPlayers(visitor: Visitor): Promise<KnownPlayer[]> {
  const answer = await ask(visitor, { op: 'players' });
  assert.ok(answer.ok && answer.players, `the players could not be listed: ${answer.error}`);

  return answer.players.filter((player) => player.name === CHECK_PLAYER);
}

/** The standings answer from the real Sheet, whatever it has on record, and never have the check's own player in them. */
async function checkStandings(visitor: Visitor): Promise<void> {
  const answer = await ask(visitor, { op: 'standings' });
  assert.ok(answer.ok && answer.units, `the standings could not be read: ${answer.error}`);

  const names = answer.units.flatMap((unit) => unit.players.map((player) => player.name));
  assert.ok(!names.includes(CHECK_PLAYER), `${CHECK_PLAYER} is in the standings, where a table of one player should leave nobody`);
}

/**
 * Answers "who are you?" as the check's one player: picked from the list when the Players tab has
 * them, which is the list read back from the real Sheet, and typed as someone new when it does not,
 * which is the tab being made and written to. `nameBox` is where a new player's name is typed.
 */
async function sayWho(visitor: Visitor, nameBox: string): Promise<void> {
  if ((await checkPlayers(visitor)).length > 0) {
    await visitor.app.locator(`.who-pill:text-is("${CHECK_PLAYER}")`).click();
    await visitor.app.locator(nameBox).waitFor({ state: 'hidden' });
  } else {
    await visitor.app.locator(nameBox).fill(CHECK_PLAYER);
  }
}

async function presetNames(visitor: Visitor): Promise<string[]> {
  const answer = await ask(visitor, { op: 'presets' });
  assert.ok(answer.ok && answer.presets, `the presets could not be listed: ${answer.error}`);

  return answer.presets.map((preset) => preset.name);
}

/**
 * Saves a preset from the host's table settings, finds it in the form for a new table, and deletes it
 * again: the one place the Presets tab, its timestamp cell and a deleted row meet the real Sheet. The
 * preset is deleted whatever happens in between, so the tab is left with the presets it had.
 */
async function checkPresets(browser: Browser, url: string, host: Visitor, tableId: string, me: string): Promise<void> {
  const before = await presetNames(host);
  if (before.length >= LIMITS.presets) {
    console.log(`  (the group has ${before.length} presets, so there is no room to save one and the presets are not checked)`);
    return;
  }

  const name = `Live check ${Date.now()}`;
  const [id, token] = me.split('.');
  const openSettings = async () => {
    await host.app.locator('[data-action="menu"]').click();
    await host.app.locator('.menu [data-action="settings"]').click();
  };

  try {
    await timed('save a preset', async () => {
      await openSettings();
      await host.app.locator('#preset-name').fill(name);
      await host.app.locator('[data-action="save-preset"]').click();
      await host.app.locator(`.preset-list .preset-name:text-is("${name}")`).waitFor();
    });
    await host.app.locator('[data-action="close"]').click();

    const lobby = await open(browser, url);
    await timed('the form for a new table offers it', () => lobby.app.locator(`#new-table-preset option:text-is("${name}")`).waitFor({ state: 'attached' }));
    await lobby.page.context().close();

    await timed('delete the preset', async () => {
      await openSettings();
      await host.app.locator(`[aria-label="Delete ${name}"]`).click();
      await host.app.locator('[data-action="confirm-delete-preset"]').click();
      await host.app.locator('.preset-panel p.note[aria-live]', { hasText: `Deleted ${name}.` }).waitFor();
    });
    await host.app.locator('[data-action="close"]').click();
  } finally {
    // Gone already if the page deleted it; otherwise this is the cleanup after a step that failed
    const left = await ask(host, { op: 'deletePreset', tableId, auth: { id, token }, name });
    assert.ok(left.ok, `the check's preset ${name} could not be deleted: ${left.error}`);
  }

  assert.deepEqual(await presetNames(host), before, 'the presets are not as the check found them');
}

const largestScript = (html: string) => [...html.matchAll(APP_SCRIPT)].map((found) => found[1]!).sort((a, b) => b.length - a.length)[0]!;
const inAddress = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

const deployment = await readDeployment();
assert.ok(deployment, 'nothing has been deployed from this checkout; run npm run deploy first');

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

try {
  console.log(`Checking ${deployment.url}`);
  const host = await open(browser, deployment.url);

  await timed('front page', () => host.app.locator('#host-name').waitFor());

  const built = await readFile(BUILT_PAGE, 'utf8');
  const served = await host.app.locator('script').last().evaluate((script) => script.textContent ?? '');
  assert.equal(served, largestScript(built), "the script Apps Script serves is not the one in dist/gas; build and deploy again, or Apps Script has changed it on the way");

  // A page that took itself for another build than the script would stop at its first request and ask to be reloaded
  const servedBuild = await host.app.locator('script').last().evaluate('window.CND_BUILD');
  assert.equal(servedBuild, buildOf(built), 'the page Apps Script serves does not say it is the build in dist/gas');

  await timed('say who the host is', () => sayWho(host, '#host-name'));
  await timed('create a table', async () => {
    await host.app.locator('[data-action="create-table"]').click();
    await host.app.locator('#table-link').waitFor();
  });

  const invite = await host.app.locator('#table-link').inputValue();
  await host.app.locator('[data-action="close"]').click();
  await host.page.waitForURL(/[?&]me=/);
  assert.ok(inAddress(host.page, 'table'), "the address names the table and the host's seat");

  // The guest is the same player from another browser: a second member under a number, with a seat of their own
  const guest = await open(browser, invite, true);
  await guest.app.locator('#join-name').waitFor();
  await timed('say who the guest is', () => sayWho(guest, '#join-name'));
  await timed('join by the invite link', async () => {
    await guest.app.locator('[data-action="join-table"]').click();
    await guest.app.locator('.stage .table').waitFor();
  });

  const listed = await checkPlayers(host);
  assert.equal(listed.length, 1, `the Players tab has ${listed.length} players called ${CHECK_PLAYER}, and the check keeps exactly one`);

  await timed('host sits down', async () => {
    await host.app.locator('[data-sit="0"]').click();
    await host.app.locator('[data-action="confirm-sit"]').click();
    await host.app.locator('.seat.me').waitFor();
  });

  await guest.app.locator('[data-sit="1"]').click();
  await guest.app.locator('[data-action="confirm-sit"]').click();
  await timed("guest's request reaches the host", () => host.app.locator('.banner [data-action="approve"]').waitFor());
  await host.app.locator('.banner [data-action="approve"]').click();
  await timed('approval reaches the guest', () => guest.app.locator('.seat.me').waitFor());

  await host.app.locator('.message [data-action="start"]').click();

  const fold = (visitor: Visitor) => visitor.app.locator('.turn [data-action="fold"]:enabled');
  let first: Visitor | null = null;

  await timed('first hand dealt', async () => {
    first = await Promise.race([host, guest].map((visitor) => fold(visitor).waitFor().then(() => visitor)));
  });

  const actor = first!;
  const other = actor === host ? guest : host;
  await host.page.screenshot({ path: `${OUT}live-host.png` });
  await guest.page.screenshot({ path: `${OUT}live-guest.png` });

  await timed('a fold shows on the other screen', async () => {
    await fold(actor).click();
    await other.app.locator('.message.result').waitFor();
  });

  // A hand is filed once it is cleared away for the next one, so that cards shown late are in it
  await timed('second hand dealt', () => Promise.race([host, guest].map((visitor) => fold(visitor).waitFor())));

  // The hand history is read back from the Sheet's own tab, not from the table in memory
  await timed('hand history from the Sheet', async () => {
    await host.app.locator('[data-action="menu"]').click();
    await host.app.locator('.menu [data-action="history"]').click();
    await host.app.locator('.history summary:has-text("Hand #1")').waitFor();
  });
  await host.app.locator('[data-action="close"]').click();

  await timed('reload at the personal address', async () => {
    await host.page.reload();
    await host.app.locator('.stage .table, [data-action="confirm-member"]').first().waitFor();
  });

  if (await host.app.locator('[data-action="confirm-member"]').count()) {
    console.log('  (this browser had forgotten the seat, so the address was what found it)');
    await host.app.locator('[data-action="confirm-member"]').click();
  }

  await host.app.locator('.seat.me').waitFor();
  await host.page.screenshot({ path: `${OUT}live-host-after.png` });

  await checkPresets(browser, deployment.url, host, inAddress(host.page, 'table')!, inAddress(host.page, 'me')!);
  await timed('standings from the Sheet', () => checkStandings(host));

  console.log('The deployed game works. Pictures are in screenshots/live-*.png');
} finally {
  await browser.close();
}
