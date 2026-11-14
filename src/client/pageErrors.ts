/*
 * What the page throws and nobody catches, told to the server's error log. A request that got no answer
 * and a refusal are no failures (the connection deals with both), so neither is ever reported, and what
 * goes wrong while reporting is never reported either. Nothing about the player goes with a report: its
 * message and trace, and from the browser only its name, version and kind of device.
 */
import type { PageBrowser } from '../server/api.ts';

/** What the page sends of one failure. */
export interface PageFailure {
  message: string;
  trace: string;
}

/** Reports one page load sends at most. */
export const REPORTS_PER_LOAD = 3;

const MESSAGE_LENGTH = 500;
const TRACE_LENGTH = 3000;

// A failure from a script of another site, which the browser hides, says only this: nothing to go on
const HIDDEN = /^(Uncaught )?Script error\.?$/;

// How a browser words a request that got no answer, should one ever reach the page uncaught
const NO_ANSWER = /NetworkError|Failed to fetch|Load failed|network error|connection failure|HTTP 0\b|request timed? ?out|ScriptError/i;

/** The message and the trace of whatever was thrown, as text. */
function partsOf(thrown: unknown): PageFailure {
  if (typeof thrown === 'object' && thrown !== null) {
    const { name, message, stack } = thrown as { name?: unknown; message?: unknown; stack?: unknown };
    const said = typeof message === 'string' ? message : '';
    const named = typeof name === 'string' && name !== '' && name !== 'Error' && !said.startsWith(name) ? `${name}: ${said}` : said;

    return { message: named.slice(0, MESSAGE_LENGTH), trace: typeof stack === 'string' ? stack.slice(0, TRACE_LENGTH) : '' };
  }

  return { message: String(thrown).slice(0, MESSAGE_LENGTH), trace: '' };
}

/** Which failures of one page load are worth a report: each once, a few at most, none that is only a request going unanswered. */
export class PageErrors {
  private sent = 0;
  private readonly seen = new Set<string>();

  /** What to report of a failure the page saw, or null when it is not to be reported. */
  take(thrown: unknown): PageFailure | null {
    if (this.sent >= REPORTS_PER_LOAD) {
      return null;
    }

    const failure = partsOf(thrown);
    const message = failure.message.trim();

    if (message === '' || HIDDEN.test(message) || NO_ANSWER.test(message)) {
      return null;
    }

    const firstFrame = failure.trace.split('\n').find((line) => /^\s*at\s|@/.test(line)) ?? '';
    const key = `${message}\n${firstFrame}`;

    if (this.seen.has(key)) {
      return null;
    }

    this.seen.add(key);
    this.sent += 1;

    return failure;
  }
}

/** A browser's name, major version and kind of device, read from what it calls itself. */
export function browserOf(userAgent: string): PageBrowser {
  const named: [string, RegExp][] = [
    ['Edge', /Edg(?:e|A|iOS)?[/](\d+)/],
    ['Samsung', /SamsungBrowser[/](\d+)/],
    ['Opera', /(?:OPR|OPiOS)[/](\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)[/](\d+)/],
    ['Chrome', /(?:Chrome|CriOS)[/](\d+)/],
    ['Safari', /Version[/](\d+).*Safari[/]/],
  ];
  const [name, major] = named.map(([which, pattern]) => [which, pattern.exec(userAgent)?.[1]] as const).find(([, found]) => found !== undefined) ?? ['Other', '0'];
  const device = /iPad|Tablet/.test(userAgent) || (/Android/.test(userAgent) && !/Mobile/.test(userAgent)) ? 'tablet' : /Mobi|iPhone|Android/.test(userAgent) ? 'phone' : 'desktop';

  return { name, major: Number(major), device };
}

/** Where the page's uncaught failures are heard: the window. */
export interface FailureSource {
  addEventListener(type: 'error' | 'unhandledrejection', listener: (event: { error?: unknown; message?: unknown; reason?: unknown }) => void): void;
}

/**
 * Listens on `target` for what the page throws and leaves uncaught, and hands what is worth reporting
 * to `send`. Whatever happens while doing that, `send` included, is swallowed, so a report can never
 * bring about another.
 */
export function watchForErrors(target: FailureSource, send: (failure: PageFailure) => void): void {
  const errors = new PageErrors();
  let busy = false;

  const report = (thrown: unknown) => {
    if (busy) {
      return;
    }

    busy = true;

    try {
      const failure = errors.take(thrown);

      if (failure) {
        send(failure);
      }
    } catch {
      // Reporting is what failed, which is the one thing never reported
    } finally {
      busy = false;
    }
  };

  target.addEventListener('error', (event) => report(event.error ?? event.message));
  target.addEventListener('unhandledrejection', (event) => report(event.reason));
}
