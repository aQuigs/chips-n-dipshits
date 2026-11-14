import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// These take minutes and need Playwright's browser, so day to day they only run when asked for
const skip = process.env.CI || process.env.E2E ? false : 'set E2E=1 to run the browser tests';

/**
 * Runs one of the browser scripts to its end. Waited for without blocking, since a test's timeout cannot
 * fire while the test blocks; `stop` is the test's signal, so a script still going then is stopped, and
 * closes its browsers as it goes.
 */
async function runScript(script: string, stop: AbortSignal): Promise<void> {
  const child = spawn(process.execPath, [script], { cwd: ROOT, stdio: 'inherit', signal: stop });
  const [code, signal] = (await once(child, 'exit')) as [number | null, string | null];

  assert.equal(code, 0, `${script} ended with ${code ?? signal}`);
}

// One after the other. At once they would end a minute sooner on a laptop, but the workers of the screen
// checks alone keep busy about what CI's four cores have, and the six-player game would wait its turn for them

test('six players get through seating, two hands, a run-it-twice and a rebuy in real browsers', { skip, timeout: 300_000 }, (t) => runScript('scripts/screenshots.ts', t.signal));

test('served the way Apps Script serves it, the page keeps a seat through failed requests and never repeats a move', { skip, timeout: 300_000 }, (t) => runScript('scripts/hostedRun.ts', t.signal));

test('the screens hold up on small phones, with long chat, the largest stacks and under the keyboard', { skip, timeout: 300_000 }, (t) => runScript('scripts/screenChecks.ts', t.signal));
