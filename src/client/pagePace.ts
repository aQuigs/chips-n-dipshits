import type { Pace } from './tableChances.ts';

/**
 * The browser's clock, and its queue of tasks by way of a message to itself. A timer would do for
 * `later`, but one set from inside another is made to wait some milliseconds, which is most of a slice
 * of work idled away each time; a message waits only for what was already queued, a tap and a frame
 * among them.
 */
export function pagePace(): Pace {
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];

  channel.port1.onmessage = () => waiting.shift()?.();

  return {
    now: () => performance.now(),
    later: (run) => {
      waiting.push(run);
      channel.port2.postMessage(null);
    },
  };
}
