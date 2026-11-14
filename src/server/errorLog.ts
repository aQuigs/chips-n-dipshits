/*
 * Failures the game carries on through, written down for the Sheet's owner. Every part of the server
 * reports through one interface, `ErrorLog`, whose two versions keep the rules here: what a row holds,
 * how repeats become a count, and the limits that keep a stranger or a broken Sheet from filling it.
 *
 * The owner sits at these tables, so a row is built from a fixed set of fields and never from a table's
 * state or a request's body. What came from an error or a page passes `scrub` on its way in: an address
 * keeps no query or fragment, since a table's can carry a seat's token, and nothing shaped like a token,
 * a card or a dump of JSON is kept.
 */
import type { PageBrowser } from './api.ts';

/** Something that went wrong, as whoever caught it reports it. */
export interface Failure {
  /** Where it happened, in the code's own words: `server act`, `store copy to Ledger`, `page`. */
  where: string;
  /** What was thrown, or a message. Only its message and its trace are read. */
  error: unknown;
  /** The table it happened at, when there is one; an id that isn't one of the game's is left out. */
  tableId?: string | null;
  /** A page's report: who sent it, by which the limits on pages count, the page's build and its browser. */
  page?: { memberId: string; build: string; browser: PageBrowser | null };
}

/** One row of the log, in the order of its columns. */
export interface ErrorRow {
  at: number;
  where: string;
  /** How many times this failure happened: 1 for its first row, and the number of repeats on the row that counts them. */
  times: number;
  message: string;
  tableId: string;
  build: string;
  browser: string;
  trace: string;
}

/** Where failures are written down. `report` never throws, never waits for the lock and writes a few rows at most. */
export interface ErrorLog {
  report(failure: Failure): void;
}

/** Reports to nobody. A store given no log still tells Apps Script's own log, at the place it fails. */
export const NOWHERE: ErrorLog = { report: () => undefined };

/**
 * What the log's two versions differ in: where rows go, and the one short-lived value that holds the
 * counts behind the limits and the repeats. Any of the three may throw.
 */
export interface ErrorShelf {
  recall(): string | null;
  keep(tally: string): void;
  append(rows: ErrorRow[]): void;
}

export const ERROR_LIMITS = {
  /** Repeats of a failure within this long of its first row are counted, not written. */
  repeatWindowMs: 10 * 60_000,
  /** Rows written in one minute, from everywhere. */
  rowsPerMinute: 20,
  /** A page's reports in one minute, from one member, from one table, and from all of them. */
  fromMember: 3,
  fromTable: 10,
  fromPages: 30,
  /** Failures whose repeats are being counted at once; past this the oldest is let go. */
  kinds: 20,
  /** Rows one report may write: its own and one count of repeats whose time is up. */
  rowsPerReport: 2,
  /** Rows the log keeps. Past this the oldest go, so the newest failures are always there. */
  rowsKept: 500,
  /** How long the counts are kept. Repeats still uncounted when a log goes this long without a report are lost. */
  tallySeconds: 6 * 60 * 60,
} as const;

const MESSAGE_LENGTH = 200;
const TRACE_LENGTH = 600;
const TRACE_FRAMES = 6;

// More than any message worth reading, and few enough that scrubbing it is quick
const READ_LENGTH = 20_000;

const TABLE_ID = /^[A-Z0-9]{6}$/;
const BUILD = /^[A-Za-z0-9_-]{1,40}$/;
const BROWSER_NAMES = new Set(['Chrome', 'Safari', 'Firefox', 'Edge', 'Samsung', 'Opera', 'Other']);
const DEVICES = new Set(['phone', 'tablet', 'desktop']);

const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()]*/gi;
const QUERY = /\?[^\s"'`<>()]*=[^\s"'`<>()]*/g;
const JSON_START = /[{[]\s*["{[][\s\S]*/;
const LONG_QUOTE = /(["'`])(?:(?!\1)[^\n]){21,}(?:\1|$)/g;
// A seat's token is 24 capitals and digits, so even a piece of one cut off by a cap is longer than this
const TOKEN = /[A-Z0-9]{10,}/g;
const BLOB = /[A-Za-z0-9+/_=-]{24,}/g;
// A card, or cards run together as a deck is when joined, but not the start of a word: "As" goes, "The" stays
const CARDS = /(?<![A-Za-z0-9])(?:[2-9TJQKA][cdhs])+(?![a-z0-9])/g;
const FRAME = /^\s*at\s|@/;

/**
 * Text from an error or a page, made fit for a row: an address without its query or fragment, no JSON,
 * no long quoted span, nothing shaped like a token or a card, on one line and at most `length` long.
 */
export function scrub(text: string, length: number): string {
  let kept = text.length > READ_LENGTH ? text.slice(0, READ_LENGTH).replace(/[A-Za-z0-9]+$/, '') : text;

  kept = kept
    .replace(ADDRESS, (address) => address.replace(/[?#][\s\S]*$/, ''))
    .replace(QUERY, '?…')
    .replace(JSON_START, '…')
    .replace(LONG_QUOTE, (_quoted, mark: string) => `${mark}…${mark}`)
    .replace(TOKEN, '…')
    .replace(BLOB, (blob) => (/\d/.test(blob) ? '…' : blob))
    .replace(CARDS, '··')
    .replace(/\s+/g, ' ')
    .trim();

  return kept.length > length ? `${kept.slice(0, length - 1)}…` : kept;
}

/** A frame of a trace with its address cut to the file's name and place in it, so `https://host/a/page.js?x=1:3:9` reads `page.js:3:9`. */
function frameOf(line: string): string {
  return line.trim().replace(ADDRESS, (address) => {
    const cut = address.search(/[?#]/);
    const place = cut < 0 ? '' : (/(?::\d+)+$/.exec(address)?.[0] ?? '');

    return (cut < 0 ? address : address.slice(0, cut)).replace(/^.*\//, '') + place;
  });
}

/** The message and the first frames of what was thrown, scrubbed. Never throws, whatever it was handed. */
export function described(error: unknown): { message: string; trace: string } {
  try {
    const { name, message, stack } = (typeof error === 'object' && error !== null ? error : { message: error }) as { name?: unknown; message?: unknown; stack?: unknown };
    const said = typeof message === 'string' ? message : String(message);
    const named = typeof name === 'string' && name !== '' && name !== 'Error' && !said.startsWith(name) ? `${name}: ${said}` : said;
    const frames = typeof stack === 'string' ? stack.split('\n').filter((line) => FRAME.test(line)).slice(0, TRACE_FRAMES).map(frameOf) : [];

    return { message: scrub(named, MESSAGE_LENGTH), trace: scrub(frames.join(' | '), TRACE_LENGTH) };
  } catch {
    return { message: 'A failure that could not be read', trace: '' };
  }
}

export function browserText(browser: PageBrowser | null): string {
  if (!browser || !BROWSER_NAMES.has(browser.name) || !DEVICES.has(browser.device)) {
    return '';
  }

  const major = Number.isInteger(browser.major) && browser.major > 0 && browser.major < 1000 ? ` ${browser.major}` : '';

  return `${browser.name}${major} on a ${browser.device}`;
}

/** The row a failure comes to, from its fields alone. `build` is the server's, which a page of another build is told apart from. */
export function rowOf(failure: Failure, at: number, build: string): ErrorRow {
  const { message, trace } = described(failure.error);
  const tableId = typeof failure.tableId === 'string' && TABLE_ID.test(failure.tableId) ? failure.tableId : '';
  const page = failure.page;
  const pageBuild = page ? (BUILD.test(page.build) ? page.build : '?') : build;

  return {
    at,
    where: scrub(failure.where, 40),
    times: 1,
    message,
    tableId,
    build: pageBuild === build ? build : `${pageBuild} (server ${build})`,
    browser: page ? browserText(page.browser) : '',
    trace,
  };
}

/** A failure whose repeats are being counted, with what its row of repeats will say. */
interface Kind {
  signature: string;
  until: number;
  first: number;
  last: number;
  more: number;
  row: Omit<ErrorRow, 'at' | 'times' | 'trace'>;
}

interface Tally {
  minute: number;
  rows: number;
  pages: number;
  members: Record<string, number>;
  tables: Record<string, number>;
  kinds: Kind[];
}

const freshTally = (minute: number): Tally => ({ minute, rows: 0, pages: 0, members: {}, tables: {}, kinds: [] });

function tallyOf(kept: string | null, minute: number): Tally {
  let tally: Tally | null = null;

  try {
    const parsed = kept ? (JSON.parse(kept) as Tally) : null;
    tally = parsed && Array.isArray(parsed.kinds) ? parsed : null;
  } catch {
    // Counts that can't be read are started again
  }

  if (!tally) {
    return freshTally(minute);
  }

  return tally.minute === minute ? tally : { ...freshTally(minute), kinds: tally.kinds };
}

/** What makes two failures the same one: where, and the message with its numbers left out. */
export const signatureOf = (row: Pick<ErrorRow, 'where' | 'message'>) => `${row.where}\n${row.message.replace(/\d+/g, '#')}`;

/** The row that says how many more times a failure happened after its first row. */
function repeatsRow(kind: Kind): ErrorRow {
  return { ...kind.row, at: kind.last, times: kind.more, trace: `Repeats after a first row at ${new Date(kind.first).toISOString()}` };
}

/** Whether a page's report is within the limits, counting it. */
function pageAllowed(tally: Tally, tableId: string, memberId: string): boolean {
  const member = `${tableId}.${memberId}`;
  const allowed = tally.pages < ERROR_LIMITS.fromPages && (tally.tables[tableId] ?? 0) < ERROR_LIMITS.fromTable && (tally.members[member] ?? 0) < ERROR_LIMITS.fromMember;

  if (allowed) {
    tally.pages += 1;
    tally.tables[tableId] = (tally.tables[tableId] ?? 0) + 1;
    tally.members[member] = (tally.members[member] ?? 0) + 1;
  }

  return allowed;
}

/**
 * The rows a failure comes to, given the counts kept so far, and the counts to keep. The first of a
 * failure is written and opens a window in which its repeats are only counted; once the window is over,
 * the count is written as a row of its own by the next report of anything. A page's report over its
 * limits, and any row past the rows a minute allows, is dropped.
 */
export function folded(row: ErrorRow, pageMember: string | null, kept: string | null): { rows: ErrorRow[]; kept: string } {
  const tally = tallyOf(kept, Math.floor(row.at / 60_000));
  const rows: ErrorRow[] = [];
  const write = (written: ErrorRow, room: number = ERROR_LIMITS.rowsPerReport): boolean => {
    if (rows.length >= room || tally.rows >= ERROR_LIMITS.rowsPerMinute) {
      return false;
    }

    rows.push(written);
    tally.rows += 1;

    return true;
  };
  const letGo = (kind: Kind, room?: number): boolean => {
    if (kind.more > 0 && !write(repeatsRow(kind), room)) {
      return false;
    }

    tally.kinds = tally.kinds.filter((other) => other !== kind);

    return true;
  };

  if (pageMember !== null && !pageAllowed(tally, row.tableId, pageMember)) {
    return { rows, kept: JSON.stringify(tally) };
  }

  // The counts whose window is over are written first, leaving room for this failure's own row; one that can't be yet waits
  for (const kind of tally.kinds.filter((kind) => row.at >= kind.until)) {
    letGo(kind, ERROR_LIMITS.rowsPerReport - 1);
  }

  const signature = signatureOf(row);
  const same = tally.kinds.find((kind) => kind.signature === signature);

  // A count whose window is over but could not be written yet goes on counting
  if (same) {
    same.more += 1;
    same.last = row.at;

    if (same.row.tableId !== row.tableId) {
      same.row.tableId = '';
    }
  } else if (write(row)) {
    const { where, message, tableId, build, browser } = row;
    tally.kinds.push({ signature, until: row.at + ERROR_LIMITS.repeatWindowMs, first: row.at, last: row.at, more: 0, row: { where, message, tableId, build, browser } });
  }

  // Too many being counted at once: the oldest goes, its count written if there is room and lost if not
  while (tally.kinds.length > ERROR_LIMITS.kinds) {
    const oldest = tally.kinds[0]!;

    if (!letGo(oldest)) {
      tally.kinds = tally.kinds.slice(1);
    }
  }

  return { rows, kept: JSON.stringify(tally) };
}

/**
 * Reports a failure on a shelf: the one body both versions of the log share. An error object already
 * in `seen` was reported by whoever caught it first and is left alone. Whatever goes wrong while
 * reporting is told to Apps Script's own log and nothing else, so reporting can never fail a request or
 * report itself.
 */
export function reportOn(shelf: ErrorShelf, seen: WeakSet<object>, failure: Failure, at: number, build: string): void {
  try {
    if (typeof failure.error === 'object' && failure.error !== null) {
      if (seen.has(failure.error)) {
        return;
      }

      seen.add(failure.error);
    }

    const row = rowOf(failure, at, build);
    const { rows, kept } = folded(row, failure.page ? failure.page.memberId : null, shelf.recall());

    shelf.keep(kept);

    if (rows.length > 0) {
      shelf.append(rows);
    }
  } catch (error) {
    console.error('A failure could not be written to the error log', error);
  }
}
