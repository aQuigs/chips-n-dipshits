import { UNSTAMPED_BUILD } from './build.ts';
import { ERROR_LIMITS, reportOn } from './errorLog.ts';
import type { ErrorLog, ErrorRow, ErrorShelf, Failure } from './errorLog.ts';
import type { Clock } from './service.ts';

/** Keeps failures in memory, for local play and tests, by the same rules as the Sheet's Errors tab. */
export class MemoryErrorLog implements ErrorLog, ErrorShelf {
  readonly rows: ErrorRow[] = [];
  private readonly seen = new WeakSet<object>();
  private tally: string | null = null;
  private tallyUntil = 0;
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  report(failure: Failure): void {
    reportOn(this, this.seen, failure, this.clock.now(), UNSTAMPED_BUILD);
  }

  recall(): string | null {
    return this.clock.now() < this.tallyUntil ? this.tally : null;
  }

  keep(tally: string): void {
    this.tally = tally;
    this.tallyUntil = this.clock.now() + ERROR_LIMITS.tallySeconds * 1000;
  }

  append(rows: ErrorRow[]): void {
    this.rows.push(...rows);
    this.rows.splice(0, Math.max(0, this.rows.length - ERROR_LIMITS.rowsKept));
  }
}
