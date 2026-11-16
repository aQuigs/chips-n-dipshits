/*
 * Runs browser checks several at a time and tells how each went. Every check gets a rig of its own, so
 * it passes or fails the same alone, in any order and beside any other; what its pages threw is its own
 * failure; and one that hangs is stopped and named, with pictures of its pages, while the rest go on.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { availableParallelism } from 'node:os';
import { format, inspect } from 'node:util';

import { runPool } from './pool.ts';
import type { Result } from './pool.ts';
import { RigBrowser, STALL_MS, STALL_WAYS } from './rig.ts';
import type { Rig, StallWay } from './rig.ts';

export type Check = [name: string, run: (rig: Rig) => Promise<void>];

/** A check and how the pages of its rig are slow, when the run is a stalled one. */
type Stalled = [...Check, way: StallWay | undefined];

export interface CheckRun {
  /** Runs only the checks with one of these in their name, which in a stalled run starts with `[deaf]` or `[behind]`; every check when there are none. */
  only: string[];
  /** The folder, ending in a slash, for pictures of the pages of a check that failed or was stopped. */
  picturesIn: string;
}

/*
 * A check keeps about one core busy between its pages, so a machine runs a few more than half as many
 * at once as it has cores, and the rest are left to whatever else it is doing: a second suite beside
 * this one, the other tests, the desktop. Timed once each on a ten-core laptop with two cores busy
 * elsewhere, all 354 checks with the two other browser tests beside them: 381 s at four at a time, the
 * whole machine a quarter idle, and 343 s at six, a seventh idle, with another checkout's unit tests
 * beside those for a minute. A check took a third longer at six, and none failed either way. More than
 * six were not timed on a quiet machine. CI has four cores, which four checks fill, and keeps its four.
 */
const FEWEST_WORKERS = 4;
const fittingWorkers = () => Math.max(FEWEST_WORKERS, Math.floor(availableParallelism() / 2) + 1);

// A stalled run spends nearly all its time waiting, on about one core between twelve workers
const STALLED_WORKERS = 12;

// For a check that hangs, not one on a busy machine. The slowest take half a minute alone, but with two runs of them all side
// by side on a laptop doing other work besides, one that takes 19 s alone took 90, and was cut off by the limit of then. This is
// twice that. With the grace after it, it is shorter than the silence a run of them all is stopped for (tests/e2e.test.ts).
// A stalled run waits out its stall after every step: the check with the most steps has about 150
const LIMIT_MS = 180_000 + 150 * STALL_MS;

// Enough to look at the pages of a check that was stopped and close them
const GRACE_MS = 20_000;

// What Playwright says of anything still asked of a page when the page is closed
const CLOSED_UNDER_IT = 'Target page, context or browser has been closed';
const SLOWEST_SHOWN = 5;

/** How many checks run at once: CHECK_WORKERS when it is set, and otherwise what the machine has cores for. */
function workerCount(): number {
  const asked = process.env.CHECK_WORKERS;
  const count = asked === undefined ? (STALL_MS > 0 ? STALLED_WORKERS : fittingWorkers()) : Number(asked);
  assert.ok(Number.isInteger(count) && count >= 1, `CHECK_WORKERS is how many checks run at once, a whole number from 1 up, not "${asked}"`);

  return count;
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error'] as const;

/** One browser's checks, one after the other. */
interface Worker {
  browser: RigBrowser;
  /** Where what is printed on this worker goes: to the check it is running. */
  lines: string[];
}

/**
 * Keeps what is printed while a check runs with that check, since several run at once and their lines
 * would come out shuffled. What a page's events print comes in the context its browser was launched in,
 * whichever check that was, so the context is the worker, the same for all its checks.
 */
function keepPrintsApart(): AsyncLocalStorage<Worker> {
  const printedOn = new AsyncLocalStorage<Worker>();

  for (const method of CONSOLE_METHODS) {
    const print = console[method];

    console[method] = (...said: unknown[]) => {
      const worker = printedOn.getStore();

      if (worker) {
        worker.lines.push(format(...said));
      } else {
        print(...said);
      }
    };
  }

  return printedOn;
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
  // A stalled run puts every check through each way a page can be slow
  const ways: readonly (StallWay | undefined)[] = STALL_MS > 0 ? STALL_WAYS : [undefined];
  const all = ways.flatMap((way) => checks.map(([name, run]): Stalled => [way ? `[${way}] ${name}` : name, run, way]));
  const chosen = all.filter(([name]) => only.length === 0 || only.some((part) => name.includes(part)));
  const notes = chosen.map((): string[] => []);
  const workers = Array.from({ length: Math.min(workerCount(), chosen.length) }, (): Worker => ({ browser: new RigBrowser(), lines: [] }));
  const printedOn = keepPrintsApart();
  const started = performance.now();

  /** One check on a rig of its own. `said` takes what there is to tell of it besides how it ended. */
  const runCheck = async ([name, run, way]: Stalled, browser: RigBrowser, stop: AbortSignal, said: string[]): Promise<void> => {
    const rig = await browser.rig(way);

    // A check out of time is waiting on something: closing its pages under it makes that wait throw, which says where it was
    stop.addEventListener('abort', () => {
      void rig
        .lastLook(`${picturesIn}stuck-${fileName(name)}`)
        .then((pages) => said.push('Its pages when it was stopped:', ...pages))
        .finally(() => rig.close())
        // A close that fails is told by the close below, which is this same one
        .catch(() => undefined);
    });

    try {
      // Out of time before there was a rig, with nobody yet to hear so
      stop.throwIfAborted();
      await run(rig);
    } catch (error) {
      // What the pages showed in place of what the check wanted, while they are still there to ask
      if (!stop.aborted) {
        said.push('Its pages when it failed:', ...(await rig.lastLook(`${picturesIn}failed-${fileName(name)}`)));
      }

      throw error;
    } finally {
      await rig.close();

      // Told of a check that failed some other way too, since it may be why
      said.push(...rig.pageErrors.map((thrown) => `A page threw: ${thrown}`));
    }

    // Looked at once the pages are closed: what one threw as the check ended has arrived by then
    assert.equal(rig.pageErrors.length, 0, 'A page of this check threw an error');
  };

  /** A check's line, and under it what it printed and why it failed. */
  const account = (result: Result, index: number): string => {
    const told = [...notes[index]!];

    if (result.outcome === 'failed') {
      told.push(telling(result.error));
    } else if (result.outcome === 'timedOut') {
      told.unshift(`Stopped: it was still running after ${LIMIT_MS / 1000} seconds.`);

      if (!result.ended) {
        told.push('It went on after its pages were closed.');
      } else if (result.error !== undefined) {
        told.push(`Where it was, by what it threw when its pages were closed: ${telling(result.error)}`);
      }
    }

    const lines = told.map((line) => `        ${line.replaceAll('\n', '\n        ')}\n`);

    return `  ${result.outcome === 'passed' ? 'ok  ' : 'FAIL'}  ${result.name} (${seconds(result.ms)})\n${lines.join('')}`;
  };

  const tasks = chosen.map((check, index) => ({
    name: check[0],
    run: (worker: Worker, stop: AbortSignal) => {
      worker.lines = notes[index]!;

      return printedOn.run(worker, () => runCheck(check, worker.browser, stop, notes[index]!));
    },
  }));

  // A check that fails between starting a wait and getting to it leaves the wait behind. Closing its pages
  // then fails that wait with nobody to hear it, which Node would end the whole run for, every other check's report with it
  const leftBehind = (reason: unknown) => {
    if (!String((reason as Error | undefined)?.message).includes(CLOSED_UNDER_IT)) {
      throw reason;
    }
  };

  process.on('unhandledRejection', leftBehind);
  const results = await runPool(tasks, workers, { limitMs: LIMIT_MS, graceMs: GRACE_MS, report: (result, index) => process.stdout.write(account(result, index)) });

  await Promise.all(workers.map(({ browser }) => browser.close()));
  process.off('unhandledRejection', leftBehind);

  const failures = results.flatMap((result, index) => (result.outcome === 'passed' ? [] : [account(result, index)]));
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_SHOWN);

  // Again, where they are found without scrolling back through the checks that passed
  if (failures.length > 0 && failures.length < results.length) {
    process.stdout.write(`\n${failures.length} of ${results.length} failed:\n\n${failures.join('\n')}`);
  }

  if (results.length === 0) {
    process.stdout.write(`No check has ${only.map((part) => `"${part}"`).join(' or ')} in its name.\n`);
  } else {
    process.stdout.write(`\n${results.length} checked and ${failures.length} failed in ${seconds(performance.now() - started)}, ${workers.length} at a time (CHECK_WORKERS sets how many).\n`);
  }

  if (results.length > SLOWEST_SHOWN) {
    process.stdout.write(`The slowest:\n${slowest.map((result) => `  ${seconds(result.ms).padStart(6)}  ${result.name}\n`).join('')}`);
  }

  return failures.length === 0;
}
