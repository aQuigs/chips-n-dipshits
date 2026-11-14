/*
 * Runs browser checks several at a time and tells how each went. Every check gets a rig of its own, so
 * it passes or fails the same alone, in any order and beside any other; what its pages threw is its own
 * failure; and one that hangs is stopped and named, with pictures of its pages, while the rest go on.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { format, inspect } from 'node:util';

import { runPool } from './pool.ts';
import type { Result } from './pool.ts';
import { RigBrowser } from './rig.ts';
import type { Rig } from './rig.ts';

export type Check = [name: string, run: (rig: Rig) => Promise<void>];

export interface CheckRun {
  /** Runs only the checks with this in their name. */
  only?: string | undefined;
  /** The folder, ending in a slash, for pictures of the pages of a check that was stopped. */
  picturesIn: string;
}

/*
 * Chosen by timing 65 checks on a ten-core laptop: 193 s on one worker, 101 on two, 71 on three, 54 on
 * four, 46 on five, 41 on six, 37 on eight. Four use two and a half cores between them, which is what
 * leaves room for the suites of two other people on that machine, and for CI, which has four cores:
 * beside two other runs of the checks, eight workers were no faster than four and slowed the six-player
 * game twice as much.
 */
const DEFAULT_WORKERS = 4;

// Six times what the slowest check takes, and short enough that one stuck check is told well inside the timeout of the test that runs them all
const LIMIT_MS = 90_000;

// Enough to take the pictures and close the pages of a check that was stopped
const GRACE_MS = 20_000;
const PICTURE_TIMEOUT_MS = 5_000;
const SLOWEST_SHOWN = 5;

/** How many checks run at once: CHECK_WORKERS when it is set. */
function workerCount(): number {
  const asked = process.env.CHECK_WORKERS;
  const count = asked === undefined ? DEFAULT_WORKERS : Number(asked);
  assert.ok(Number.isInteger(count) && count >= 1, `CHECK_WORKERS is how many checks run at once, a whole number from 1 up, not "${asked}"`);

  return count;
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error'] as const;

/**
 * Keeps what is printed while a check runs with that check, since several run at once and their lines
 * would come out shuffled. Returns how to run something as a check whose lines go to `lines`.
 */
function keepPrintsApart(): <T>(lines: string[], run: () => T) => T {
  const printedBy = new AsyncLocalStorage<string[]>();

  for (const method of CONSOLE_METHODS) {
    const print = console[method];

    console[method] = (...said: unknown[]) => {
      const lines = printedBy.getStore();

      if (lines) {
        lines.push(format(...said));
      } else {
        print(...said);
      }
    };
  }

  return (lines, run) => printedBy.run(lines, run);
}

/** Saves a picture of each page a rig has open, and says where, or why there is none. */
function picturesOf(rig: Rig, pathStart: string): Promise<string[]> {
  return Promise.all(
    rig.pages().map((page, index) => {
      const path = `${pathStart}-${index + 1}.png`;

      return page.screenshot({ path, timeout: PICTURE_TIMEOUT_MS }).then(
        () => path,
        (error: Error) => `no picture of page ${index + 1}: ${error.message.split('\n')[0]}`,
      );
    }),
  );
}

const fileName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// The frames of a stack that are the runner's own, which say nothing of the check
const OWN_FRAME = /^\s+at .*\/scripts\/(pool|checkRunner)\.ts:/;

/** What was thrown, with its stack and what it carries, such as what an assertion found and what it expected. */
const telling = (thrown: unknown) =>
  inspect(thrown)
    .split('\n')
    .filter((line) => !OWN_FRAME.test(line))
    .join('\n');

/** Runs the checks and prints how each went, then the failures again and how long it all took. Resolves to whether every check passed. */
export async function runChecks(checks: readonly Check[], { only, picturesIn }: CheckRun): Promise<boolean> {
  const chosen = checks.filter(([name]) => !only || name.includes(only));
  const notes = chosen.map((): string[] => []);
  const browsers = Array.from({ length: Math.min(workerCount(), chosen.length) }, () => new RigBrowser());
  const printingTo = keepPrintsApart();
  const started = performance.now();

  /** One check on a rig of its own. `said` takes what there is to tell of it besides how it ended. */
  const runCheck = async ([name, run]: Check, browser: RigBrowser, stop: AbortSignal, said: string[]): Promise<void> => {
    const rig = await browser.rig();

    // A check out of time is waiting on something: closing its pages under it makes that wait throw, which says where it was
    stop.addEventListener('abort', () => {
      void picturesOf(rig, `${picturesIn}stuck-${fileName(name)}`)
        .then((pictures) => said.push('Its pages when it was stopped:', ...pictures))
        .finally(() => rig.close())
        // A close that fails is told by the close below, which is this same one
        .catch(() => undefined);
    });

    try {
      await run(rig);
      assert.equal(rig.pageErrors.length, 0, 'A page of this check threw an error');
    } finally {
      // Told of a check that failed some other way too, since it may be why
      said.push(...rig.pageErrors.map((thrown) => `A page threw: ${thrown}`));
      await rig.close();
    }
  };

  /** A check's line, and under it what it printed and why it failed. */
  const account = (result: Result<void>, index: number): string => {
    const told = [...notes[index]!];

    if (result.outcome === 'failed') {
      told.push(telling(result.error));
    } else if (result.outcome === 'timedOut') {
      told.unshift(`Stopped: it was still running after ${LIMIT_MS / 1000} seconds.`);
      told.push(result.error === undefined ? 'It went on after its pages were closed.' : `Where it was, by what it threw when its pages were closed: ${telling(result.error)}`);
    }

    const lines = told.map((line) => `        ${line.replaceAll('\n', '\n        ')}\n`);

    return `  ${result.outcome === 'passed' ? 'ok  ' : 'FAIL'}  ${result.name} (${seconds(result.ms)})\n${lines.join('')}`;
  };

  const results = await runPool(
    chosen.map((check, index) => ({ name: check[0], run: (browser: RigBrowser, stop: AbortSignal) => printingTo(notes[index]!, () => runCheck(check, browser, stop, notes[index]!)) })),
    browsers,
    { limitMs: LIMIT_MS, graceMs: GRACE_MS, report: (result, index) => process.stdout.write(account(result, index)) },
  );

  await Promise.all(browsers.map((browser) => browser.close()));

  const failures = results.flatMap((result, index) => (result.outcome === 'passed' ? [] : [account(result, index)]));
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_SHOWN);

  // Again, where they are found without scrolling back through the checks that passed
  if (failures.length > 0 && failures.length < results.length) {
    process.stdout.write(`\n${failures.length} of ${results.length} failed:\n\n${failures.join('\n')}`);
  }

  if (results.length === 0) {
    process.stdout.write(`No check has "${only ?? ''}" in its name.\n`);
  } else {
    process.stdout.write(`\n${results.length} checked and ${failures.length} failed in ${seconds(performance.now() - started)}, ${browsers.length} at a time (CHECK_WORKERS sets how many).\n`);
  }

  if (results.length > SLOWEST_SHOWN) {
    process.stdout.write(`The slowest:\n${slowest.map((result) => `  ${seconds(result.ms).padStart(6)}  ${result.name}\n`).join('')}`);
  }

  return failures.length === 0;
}
