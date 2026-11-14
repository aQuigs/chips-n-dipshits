/*
 * Runs a list of named tasks on a few workers at once. Each worker takes the next task nobody has
 * taken, so none waits while there is work left, and which tasks run beside each other changes from
 * run to run: a task may not lean on the worker it gets or on what ran before it. A task that throws,
 * or that outruns its time limit, is told in its own result and never stops the others.
 */

export interface Task<Worker> {
  name: string;
  /** `signal` aborts when the task has outrun its limit: it then lets go of what it waits on, and what it throws as it ends is kept as where it was. */
  run: (worker: Worker, signal: AbortSignal) => unknown;
}

export type Result = { name: string; ms: number } & (
  | { outcome: 'passed' }
  | { outcome: 'failed'; error: unknown }
  /** `ended` says whether the task ended once told its time was up, before its worker moved on, and `error` what it threw as it did, if anything. */
  | { outcome: 'timedOut'; ended: boolean; error?: unknown }
);

export interface PoolOptions {
  limitMs: number;
  /** How long a task that outran its limit gets to say where it was, before its worker moves on without it. */
  graceMs: number;
  /** Told each result in list order, as soon as every task before it has ended. */
  report?: (result: Result, index: number) => void;
}

const LATE = Symbol('late');

/** Resolves to `LATE` after `ms`, unless `first` settles before; either way no timer is left behind. */
async function orLate<T>(first: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([first, new Promise<typeof LATE>((resolve) => (timer = setTimeout(() => resolve(LATE), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTask<Worker>(task: Task<Worker>, worker: Worker, { limitMs, graceMs }: PoolOptions): Promise<Result> {
  const started = performance.now();
  const took = () => ({ name: task.name, ms: performance.now() - started });
  const stop = new AbortController();

  // Never rejects, so a task given up on can still throw long after without anyone left to hear it
  const settled: Promise<{ error?: unknown }> = (async () => task.run(worker, stop.signal))().then(
    () => ({}),
    (error: unknown) => ({ error }),
  );

  const inTime = await orLate(settled, limitMs);
  if (inTime !== LATE) {
    return 'error' in inTime ? { ...took(), outcome: 'failed', error: inTime.error } : { ...took(), outcome: 'passed' };
  }

  stop.abort(new Error(`${task.name}: stopped after ${limitMs} ms`));
  const afterwards = await orLate(settled, graceMs);

  return afterwards === LATE ? { ...took(), outcome: 'timedOut', ended: false } : { ...took(), outcome: 'timedOut', ended: true, ...afterwards };
}

/** Runs every task, one at a time on each worker, and resolves to their results in the order of the list. */
export async function runPool<Worker>(tasks: readonly Task<Worker>[], workers: readonly Worker[], options: PoolOptions): Promise<Result[]> {
  if (tasks.length > 0 && workers.length === 0) {
    throw new Error('There is no worker to run the tasks on');
  }

  const results: Result[] = [];
  let next = 0;
  let reported = 0;

  const work = async (worker: Worker): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await runTask(tasks[index]!, worker, options);

      while (results[reported]) {
        options.report?.(results[reported]!, reported);
        reported += 1;
      }
    }
  };

  await Promise.all(workers.map(work));

  return results;
}
