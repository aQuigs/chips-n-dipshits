import { ERROR_LIMITS, reportOn } from '../server/errorLog.ts';
import type { ErrorLog, ErrorRow, ErrorShelf, Failure } from '../server/errorLog.ts';
import type { Clock } from '../server/service.ts';
import { FIRST_DATA_ROW, openTab, TEXT, TIMESTAMP, WHOLE_NUMBER } from './sheets.ts';
import type { CacheLike, SheetLike, SpreadsheetLike } from './sheets.ts';

export interface SheetErrorLogDeps {
  spreadsheet: () => SpreadsheetLike;
  cache: CacheLike;
  clock: Clock;
  /** The build this script is, for the rows of failures on the server. */
  build: string;
}

export const ERRORS_TAB = 'Errors';
const HEADERS = ['When', 'Where', 'Times', 'Message', 'Table', 'Build', 'Browser', 'Trace'];
const FORMATS = [TIMESTAMP, TEXT, WHOLE_NUMBER, TEXT, TEXT, TEXT, TEXT, TEXT];

const TALLY_KEY = 'errors:tally';

// One request reports this many failures at most, which bounds what reporting adds to it in Sheet calls
export const REPORTS_PER_RUN = 3;

// Past the cap the oldest rows go down to this many below it, so trimming is one call every so many rows
const TRIM_TO = ERROR_LIMITS.rowsKept - 50;

// A row past the ones formatted when the tab was made, or in a tab made by hand, may not be formatted as text: there a
// leading apostrophe keeps a cell from being read as a formula, or a table's code such as 234E56 as a number
const READ_AS_SOMETHING_ELSE = /^[=+\-@\d.]/;
const asText = (value: string) => (READ_AS_SOMETHING_ELSE.test(value) ? `'${value}` : value);

function cellsOf(row: ErrorRow): unknown[] {
  return [new Date(row.at), asText(row.where), row.times, asText(row.message), asText(row.tableId), asText(row.build), asText(row.browser), asText(row.trace)];
}

/**
 * Writes failures to an Errors tab of the Sheet, which the first row makes. Unlike every other tab it
 * is written without the script lock: the commonest failure is not getting the lock, which can't then
 * be waited for again, and nothing here is cached for the lock to keep in step. Rows are appended,
 * which Google keeps apart when two come at once. Two runs making the tab, or trimming it, at the same
 * moment can at worst lose a row to the headers or trim more old rows than needed. The counts behind the
 * limits and the repeats are one value in the script cache, so they are approximate when failures land
 * at the same moment.
 */
export class SheetErrorLog implements ErrorLog, ErrorShelf {
  private readonly deps: SheetErrorLogDeps;
  private readonly seen = new WeakSet<object>();
  private reports = 0;
  private sheet: SheetLike | null = null;

  constructor(deps: SheetErrorLogDeps) {
    this.deps = deps;
  }

  report(failure: Failure): void {
    const again = typeof failure.error === 'object' && failure.error !== null && this.seen.has(failure.error);

    // A script run serves one request, so this is what one request may spend on reporting. An error reported already costs nothing
    if (again || this.reports >= REPORTS_PER_RUN) {
      return;
    }

    this.reports += 1;
    reportOn(this, this.seen, failure, this.deps.clock.now(), this.deps.build);
  }

  recall(): string | null {
    return this.deps.cache.get(TALLY_KEY);
  }

  keep(tally: string): void {
    this.deps.cache.put(TALLY_KEY, tally, ERROR_LIMITS.tallySeconds);
  }

  append(rows: ErrorRow[]): void {
    const sheet = (this.sheet ??= openTab(this.deps.spreadsheet(), ERRORS_TAB, HEADERS, true, FORMATS)!);

    for (const row of rows) {
      sheet.appendRow(cellsOf(row));
    }

    const kept = sheet.getLastRow() - FIRST_DATA_ROW + 1;

    if (kept > ERROR_LIMITS.rowsKept) {
      sheet.deleteRows(FIRST_DATA_ROW, kept - TRIM_TO);
    }
  }
}
