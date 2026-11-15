/*
 * Plays a short game at the deployed address, in real browsers with no Google account, the way
 * friends will reach it. It is the check that the page Apps Script serves is the page that was
 * built, and that the script and its Sheet answer. What it plays and what it leaves in the Sheet is
 * in `liveCheckSteps.ts`.
 *
 * With `--staging` it plays at the staging web app instead, which is the same script on the same Sheet.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { buildOf } from './bundle.ts';
import { addressToCheck, DeployRefused, readDeployment, stagingAsked } from './deployment.ts';
import { playCheck } from './liveCheckSteps.ts';
import type { Visitor } from './liveCheckSteps.ts';

const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const BUILT_PAGE = fileURLToPath(new URL('../dist/gas/index.html', import.meta.url));

// Apps Script answers in seconds, not milliseconds, and the first request wakes the script up
const STEP_TIMEOUT_MS = 60_000;
const APP_SCRIPT = /<script[^>]*>([\s\S]*?)<\/script>/g;

const largestScript = (html: string) => [...html.matchAll(APP_SCRIPT)].map((found) => found[1]!).sort((a, b) => b.length - a.length)[0]!;

/** The page Apps Script serves is the one that was built for this address, script for script and by what it says of itself. */
async function servedIsBuilt(host: Visitor): Promise<void> {
  const built = await readFile(BUILT_PAGE, 'utf8');
  const served = await host.app.locator('script').last().evaluate((script) => script.textContent ?? '');
  assert.equal(served, largestScript(built), "the script Apps Script serves is not the one in dist/gas; build and deploy again, or Apps Script has changed it on the way");

  // A page that took itself for another build than the script would stop at its first request and ask to be reloaded
  const servedBuild = await host.app.locator('script').last().evaluate('window.CND_BUILD');
  assert.equal(servedBuild, buildOf(built), 'the page Apps Script serves does not say it is the build in dist/gas');
}

async function check(): Promise<void> {
  const staging = stagingAsked(process.argv.slice(2), process.env);
  const address = addressToCheck(await readDeployment(), staging);

  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();

  try {
    console.log(`Checking ${staging ? 'the staging web app at ' : ''}${address}`);

    await playCheck({
      address,
      open: async (url, phone = false) => {
        const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();

        page.setDefaultTimeout(STEP_TIMEOUT_MS);
        page.on('pageerror', (error) => {
          throw new Error(`The page failed: ${error.name}: ${error.message}`);
        });
        await page.goto(url);

        // Apps Script puts the game two frames deep
        return { page, app: page.frameLocator('#sandboxFrame').frameLocator('#userHtmlFrame') };
      },
      frontPage: servedIsBuilt,
      picture: (name) => `${OUT}live-${name}.png`,
      say: (line) => console.log(line),
    });

    console.log(`${staging ? `The build works at the staging web app, ${address}.` : `The deployed game works at ${address}.`} Pictures are in screenshots/live-*.png`);
  } finally {
    await browser.close();
  }
}

try {
  await check();
} catch (error) {
  if (!(error instanceof DeployRefused)) {
    throw error;
  }

  console.error(`\n${error.message}`);
  process.exitCode = 1;
}
