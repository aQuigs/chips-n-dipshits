/*
 * Plays a short game at the deployed address, in real browsers with no Google account, the way
 * friends will reach it. It is the check that the page Apps Script serves is the page that was
 * built, and that the script and its Sheet answer. It leaves one small table behind in the Sheet.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Browser, FrameLocator, Page } from 'playwright';

import { readDeployment } from './deployment.ts';

const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const BUILT_PAGE = fileURLToPath(new URL('../dist/gas/index.html', import.meta.url));

// Apps Script answers in seconds, not milliseconds, and the first request wakes the script up
const STEP_TIMEOUT_MS = 60_000;
const APP_SCRIPT = /<script[^>]*>([\s\S]*?)<\/script>/g;

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

  const served = await host.app.locator('script').last().evaluate((script) => script.textContent ?? '');
  assert.equal(served, largestScript(await readFile(BUILT_PAGE, 'utf8')), "the script Apps Script serves is not the one in dist/gas; build and deploy again, or Apps Script has changed it on the way");

  await host.app.locator('#host-name').fill('Host check');
  await timed('create a table', async () => {
    await host.app.locator('[data-action="create-table"]').click();
    await host.app.locator('#table-link').waitFor();
  });

  const invite = await host.app.locator('#table-link').inputValue();
  await host.app.locator('[data-action="close"]').click();
  await host.page.waitForURL(/[?&]me=/);
  assert.ok(inAddress(host.page, 'table'), "the address names the table and the host's seat");

  const guest = await open(browser, invite, true);
  await guest.app.locator('#join-name').fill('Guest check');
  await timed('join by the invite link', async () => {
    await guest.app.locator('[data-action="join-table"]').click();
    await guest.app.locator('.stage .table').waitFor();
  });

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

  console.log('The deployed game works. Pictures are in screenshots/live-*.png');
} finally {
  await browser.close();
}
