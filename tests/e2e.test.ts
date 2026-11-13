import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// These take over a minute and need Playwright's browser, so day to day they only run when asked for
const skip = process.env.CI || process.env.E2E ? false : 'set E2E=1 to run the browser tests';

test('six players get through seating, two hands, a run-it-twice and a rebuy in real browsers', { skip, timeout: 300_000 }, () => {
  execFileSync(process.execPath, ['scripts/screenshots.ts'], { cwd: ROOT, stdio: 'inherit' });
});

test('served the way Apps Script serves it, the page keeps a seat through failed requests and never repeats a move', { skip, timeout: 300_000 }, () => {
  execFileSync(process.execPath, ['scripts/hostedRun.ts'], { cwd: ROOT, stdio: 'inherit' });
});
