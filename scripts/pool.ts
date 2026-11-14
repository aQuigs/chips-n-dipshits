/*
 * Runs a list of named tasks on a few workers at once. Each worker takes the next task nobody has
 * taken, so none waits while there is work left, and which tasks run beside each other changes from
 * run to run: a task may not lean on the worker it gets or on what ran before it. A task that throws,
 * or that outruns its time limit, is told in its own result and never stops the others.
 */

export interface Task<Worker, Value> {
  name: string;
  /** `signal` aborts when the task has outrun its limit: it then lets go of what it waits on, and what it throws as it ends is kept as where it was. */
  run: (worker: Worker, signal: AbortSignal) => Value | Promise<Value>;
}

export type Result<Value> = { name: string; ms: number } & (
  | { outcome: 'passed'; value: Value }
  | { outcome: 'failed'; error: unknown }
  /** `ended` says whether the task ended once told its time was up, before its worker moved on, and `error` what it threw as it did, if anything. */
  | { outcome: 'timedOut'; ended: boolean; error?: unknown }
);

export interface PoolOptions<Value> {
  /** How long a task may run. */
  limitMs: number;
  /** How long a task that outran its limit gets to say where it was, before its worker moves on without it. */
  graceMs: number;
  /** Told each result in list order, as soon as every task before it has ended. */
  report?: (result: Result<Value>, index: number) => void;
}

type Settled<Value> = { value: Value } | { error: unknown };

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

async function runTask<Worker, Value>(task: Task<Worker, Value>, worker: Worker, { limitMs, graceMs }: PoolOptions<Value>): Promise<Result<Value>> {
  const started = performance.now();
  const ended = () => ({ name: task.name, ms: performance.now() - started });
  const stop = new AbortController();

  // Never rejects, so a task given up on can still throw long after without anyone left to hear it
  const settled: Promise<Settled<Value>> = (async () => task.run(worker, stop.signal))().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  const inTime = await orLate(settled, limitMs);
  if (inTime !== LATE) {
    return 'error' in inTime ? { ...ended(), outcome: 'failed', error: inTime.error } : { ...ended(), outcome: 'passed', value: inTime.value };
  }

  stop.abort(new Error(`${task.name}: stopped after ${limitMs} ms`));
  const afterwards = await orLate(settled, graceMs);

  return { ...ended(), outcome: 'timedOut', ended: afterwards !== LATE, error: afterwards !== LATE && 'error' in afterwards ? afterwards.error : undefined };
}

/** Runs every task, one at a time on each worker, and resolves to their results in the order of the list. */
export async function runPool<Worker, Value>(tasks: readonly Task<Worker, Value>[], workers: readonly Worker[], options: PoolOptions<Value>): Promise<Result<Value>[]> {
  if (tasks.length > 0 && workers.length === 0) {
    throw new Error('There is no worker to run the tasks on');
  }

  const results: Result<Value>[] = [];
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
