import { ByteRng } from '../server/byteRng.ts';
import { PokerService } from '../server/service.ts';
import type { ApiError } from '../server/api.ts';
import { SheetStore } from './sheetStore.ts';

// Set by the build when the deployed address is known; otherwise the script asks Apps Script for it
declare const WEB_APP_URL: string;

const APP_TITLE = "Chips n' Dipshits";

// A held poll stays well inside the six minutes a script may run, and frees its slot regularly
const MAX_HOLD_MS = 25_000;
const HOLD_CHECK_MS = 250;

const BOOT_PLACEHOLDER = '"__BOOT__"';
const TABLE_PARAMETER = /^[A-Za-z0-9]{1,12}$/;
const MEMBER_PARAMETER = /^[A-Za-z0-9]{1,16}\.[A-Za-z0-9]{1,64}$/;

/**
 * Random bytes from the platform's UUID generator, which is the only strong random source a script has.
 * A version-4 UUID is 32 hex digits, all random except the version digit and the variant digit.
 */
function uuidBytes(): number[] {
  const hex = Utilities.getUuid().replace(/-/g, '');
  const random = hex.slice(0, 12) + hex.slice(13, 16) + hex.slice(17);
  const bytes: number[] = [];

  for (let i = 0; i + 2 <= random.length; i += 2) {
    bytes.push(parseInt(random.slice(i, i + 2), 16));
  }

  return bytes;
}

let serviceForThisRun: PokerService | null = null;

function service(): PokerService {
  serviceForThisRun ??= new PokerService({
    store: new SheetStore({
      spreadsheet: () => SpreadsheetApp.getActiveSpreadsheet(),
      cache: CacheService.getScriptCache(),
      lock: LockService.getScriptLock(),
      flush: () => SpreadsheetApp.flush(),
    }),
    clock: { now: () => Date.now() },
    rng: new ByteRng(uuidBytes),
  });

  return serviceForThisRun;
}

function webAppUrl(): string {
  if (typeof WEB_APP_URL === 'string' && WEB_APP_URL.length > 0) {
    return WEB_APP_URL;
  }

  try {
    return ScriptApp.getService().getUrl();
  } catch {
    return '';
  }
}

function parameter(event: GoogleAppsScript.Events.DoGet, name: string, pattern: RegExp): string | null {
  const value = event?.parameter?.[name];

  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/** Serves the game page, telling it which table the link points at. */
export function doGet(event: GoogleAppsScript.Events.DoGet): GoogleAppsScript.HTML.HtmlOutput {
  const boot = {
    baseUrl: webAppUrl(),
    table: parameter(event, 'table', TABLE_PARAMETER),
    me: parameter(event, 'me', MEMBER_PARAMETER),
  };

  // Escaping < keeps anything in the link from closing the script tag the settings sit in
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  const page = HtmlService.createHtmlOutputFromFile('index').getContent().replace(BOOT_PLACEHOLDER, () => bootJson);

  return HtmlService.createHtmlOutput(page).setTitle(APP_TITLE).addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** The same API for a page hosted somewhere else, which can only reach the script over HTTP. */
export function doPost(event: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(api(event.postData.contents)).setMimeType(ContentService.MimeType.JSON);
}

/** Keeps a poll open until there is something to send back, so players see changes without hammering the script. */
function holdUntilNews(request: unknown): void {
  const poll = request as { op?: unknown; tableId?: unknown; since?: unknown; holdMs?: unknown };
  if (poll.op !== 'poll' || typeof poll.tableId !== 'string' || typeof poll.since !== 'number' || typeof poll.holdMs !== 'number') {
    return;
  }

  const until = Date.now() + Math.min(poll.holdMs, MAX_HOLD_MS);

  while (Date.now() < until && !service().hasNews(poll.tableId, poll.since)) {
    Utilities.sleep(HOLD_CHECK_MS);
  }
}

/** Every call the game page makes, as JSON in and JSON out. */
export function api(body: string): string {
  try {
    const request: unknown = JSON.parse(body);

    if (typeof request === 'object' && request !== null) {
      holdUntilNews(request);
    }

    return JSON.stringify(service().handle(request));
  } catch (error) {
    console.error(error);

    const failure: ApiError = { ok: false, code: 'internal', error: 'Something went wrong on the server, try again' };

    return JSON.stringify(failure);
  }
}
