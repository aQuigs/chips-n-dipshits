import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runPool } from '../scripts/pool.ts';
import type { Result, Task } from '../scripts/pool.ts';

// Long enough that no task of these tests meets it unless the test is about meeting it
const AMPLE = { limitMs: 10_000, graceMs: 10_000 };
const SHORT = { limitMs: 40, graceMs: 40 };

/** A promise the test settles when it chooses, so tasks wait on each other and never on the clock. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));

  return { opened, open };
}

const outcomes = (results: Result<unknown>[]) => results.map((result) => result.outcome);

/** What each task that did not pass threw, by its message. */
const thrown = (results: Result<unknown>[]) => results.map((result) => (result.outcome === 'passed' ? null : (result.error as Error | undefined)?.message));
const named = (name: string, run: Task<string, unknown>['run']): Task<string, unknown> => ({ name, run });

test('as many tasks run at once as there are workers, one on each, and never more', async () => {
  const allBusy = gate();
  const busy = new Set<string>();
  let most = 0;

  const task = (name: string) =>
    named(name, async (worker) => {
      assert.ok(!busy.has(worker), `${worker} was given two tasks at once`);
      busy.add(worker);
      most = Math.max(most, busy.size);

      // Opens only once three tasks are under way together: workers that took turns would never get here
      if (busy.size === 3) {
        allBusy.open();
      }
      await allBusy.opened;

      busy.delete(worker);
    });

  const results = await runPool(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(task), ['one', 'two', 'three'], AMPLE);

  assert.deepEqual(outcomes(results), Array(7).fill('passed'));
  assert.equal(most, 3);
});

test('results come back in the order of the list, whatever order the tasks end in', async () => {
  const ends = [gate(), gate(), gate()];
  const ended: number[] = [];
  const reported: [string, number][] = [];

  // Each task but the last waits for the one after it to end
  const tasks = [0, 1, 2].map((index) =>
    named(`task ${index}`, async () => {
      await ends[index + 1]?.opened;
      ended.push(index);
      ends[index]!.open();

      return index * 10;
    }),
  );

  const results = await runPool(tasks, ['one', 'two', 'three'], { ...AMPLE, report: (result, index) => reported.push([result.name, index]) });

  assert.deepEqual(ended, [2, 1, 0]);
  assert.deepEqual(reported, [['task 0', 0], ['task 1', 1], ['task 2', 2]]);
  assert.deepEqual(
    results.map((result) => [result.name, result.outcome === 'passed' && result.value]),
    [['task 0', 0], ['task 1', 10], ['task 2', 20]],
  );
});

test('a result is reported as soon as every task before it has ended, not when the run does', async () => {
  const firstReported = gate();
  const tasks = [named('quick', () => 'done'), named('waits to hear of the first', () => firstReported.opened)];

  const results = await runPool(tasks, ['one', 'two'], { ...AMPLE, report: (result) => result.name === 'quick' && firstReported.open() });

  assert.deepEqual(outcomes(results), ['passed', 'passed']);
});

test('a task that fails and tasks that outrun the limit are told in their own results, and every other task still runs', async () => {
  const ran: string[] = [];
  const stopped: string[] = [];
  const pass = (name: string) => named(name, () => void ran.push(name));

  const tasks = [
    pass('first'),
    named('fails', async () => {
      throw new Error('broken');
    }),
    pass('second'),
    // Told its time is up, says where it was
    named('hangs, then answers', (_worker, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('was waiting for the flop'))))),
    pass('third'),
    // Told its time is up, goes on hanging
    named('hangs for good', (_worker, signal) => new Promise(() => signal.addEventListener('abort', () => stopped.push('hangs for good')))),
    pass('fourth'),
  ];

  const results = await runPool(tasks, ['one', 'two'], SHORT);

  assert.deepEqual(outcomes(results), ['passed', 'failed', 'passed', 'timedOut', 'passed', 'timedOut', 'passed']);
  assert.deepEqual(ran, ['first', 'second', 'third', 'fourth']);
  assert.deepEqual(stopped, ['hangs for good']);
  assert.deepEqual(thrown(results), [null, 'broken', null, 'was waiting for the flop', null, undefined, null]);
});

test('a single worker goes on to the next task after one that never stops', async () => {
  const results = await runPool([named('hangs for good', () => new Promise(() => {})), named('after it', () => 'ran')], ['only'], SHORT);

  assert.deepEqual(outcomes(results), ['timedOut', 'passed']);
});

test('a task that ends in time is never told to stop', async () => {
  let told = false;
  const task = named('quick', (_worker, signal) => signal.addEventListener('abort', () => (told = true)));

  await runPool([task, named('hangs for good', () => new Promise(() => {}))], ['only'], SHORT);

  assert.equal(told, false);
});

test('a task that throws before it returns a promise fails like any other', async () => {
  const tasks = [
    named('throws at once', () => {
      throw new Error('at once');
    }),
    named('after it', () => 'ran'),
  ];

  const results = await runPool(tasks, ['only'], AMPLE);

  assert.deepEqual(outcomes(results), ['failed', 'passed']);
  assert.deepEqual(thrown(results), ['at once', null]);
});

test('no tasks is no results, with nothing reported', async () => {
  let reports = 0;

  assert.deepEqual(await runPool([], ['one', 'two'], { ...AMPLE, report: () => (reports += 1) }), []);
  assert.deepEqual(await runPool([], [], AMPLE), []);
  assert.equal(reports, 0);
});

test('with more workers than tasks every task runs once, and at once', async () => {
  const bothBusy = gate();
  const workersOf: Record<string, string[]> = { a: [], b: [] };

  const task = (name: string) =>
    named(name, async (worker) => {
      workersOf[name]!.push(worker);

      if (Object.values(workersOf).every((workers) => workers.length > 0)) {
        bothBusy.open();
      }
      await bothBusy.opened;
    });

  const results = await runPool([task('a'), task('b')], ['one', 'two', 'three', 'four', 'five'], AMPLE);

  assert.deepEqual(outcomes(results), ['passed', 'passed']);
  assert.equal(workersOf.a!.length, 1);
  assert.equal(workersOf.b!.length, 1);
  assert.notEqual(workersOf.a![0], workersOf.b![0]);
});

test('tasks with no worker to run them are refused, not passed over', async () => {
  await assert.rejects(runPool([named('never run', () => 'ran')], [], AMPLE), /no worker/);
});
