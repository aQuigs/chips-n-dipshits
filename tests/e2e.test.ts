import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// These take minutes and need Playwright's browser, so day to day they only run when asked for
const skip = process.env.CI || process.env.E2E ? false : 'set E2E=1 to run the browser tests';

// A script that says nothing for this long hangs. Each says a line for every part it gets through and stops
// a step of its own that takes too long, a screen check within three and a half minutes (scripts/checkRunner.ts).
// How long the whole of one takes has no limit: the list of checks grows with every feature, and a machine busy
// with something else makes a run slow, not wrong
const SILENCE_MS = 240_000;

// How long a script told to stop has to close its browsers. Playwright takes the signal for itself, so a
// script waiting on something that closing them does not end would go on for good: it is ended outright
const STOP_GRACE_MS = 10_000;

/** What a script said, ending at the end of a line even when the script did not get that far. */
const inLines = (said: string) => (said === '' || said.endsWith('\n') ? said : `${said}\n`);

interface Telling {
  /** Says the script's lines as they come. Otherwise they are said in one piece when it ends, since the scripts run side by side and their lines would come out shuffled. */
  live: boolean;
}

/**
 * Runs one of the browser scripts to its end. Waited for without blocking, so the others run meanwhile.
 * `stop` is the test's signal: a script still going then, or one that hangs, is stopped, and closes its
 * browsers as it goes.
 */
async function runScript(script: string, stop: AbortSignal, { live }: Telling): Promise<void> {
  const child = spawn(process.execPath, [script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  let told = 0;
  let outright: NodeJS.Timeout | undefined;
  /** The last line it had said when it was taken to hang. What it says as it is stopped comes after. */
  let hungAfter: string | null = null;

  const end = () => {
    child.kill();
    outright ??= setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
  };

  const silence = setTimeout(() => {
    hungAfter = said.trimEnd().split('\n').at(-1)!;
    end();
  }, SILENCE_MS);

  const hear = (chunk: string) => {
    said += chunk;
    silence.refresh();

    // Whole lines only: a line cut in two by what another script says is no line of either
    if (live) {
      const whole = said.lastIndexOf('\n') + 1;

      process.stdout.write(said.slice(told, whole));
      told = whole;
    }
  };

  stop.addEventListener('abort', end);

  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8').on('data', hear);
  }

  // Once it has ended and everything it said has been heard
  const [code, signal] = (await once(child, 'close')) as [number | null, string | null];

  clearTimeout(silence);
  clearTimeout(outright);
  stop.removeEventListener('abort', end);
  process.stdout.write(live ? inLines(said.slice(told)) : `\n${script}:\n${inLines(said)}`);

  assert.ok(hungAfter === null, `${script} said nothing for ${SILENCE_MS / 1000} seconds and was stopped, after: ${hungAfter}`);
  assert.equal(code, 0, `${script} ended with ${code ?? signal}`);
}

// Side by side: the first two wait on the game's own pace far more than they work, and keep one core busy
// between them, so they are over while the screen checks, which take the longest, are still running
describe('in real browsers', { concurrency: true }, () => {
  test('six players get through seating, two hands, a run-it-twice and a rebuy', { skip }, (t) => runScript('scripts/screenshots.ts', t.signal, { live: false }));

  test('served the way Apps Script serves it, the page keeps a seat through failed requests and never repeats a move', { skip }, (t) => runScript('scripts/hostedRun.ts', t.signal, { live: false }));

  test('the screens hold up on small phones, with long chat, the largest stacks and under the keyboard', { skip }, (t) => runScript('scripts/screenChecks.ts', t.signal, { live: true }));
});
