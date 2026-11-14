import { asNumber, evaluateHand, fromNumber, madeHandName, RANKS, SUITS } from '../engine/index.ts';
import type { Card, TableResults, Unit } from '../engine/index.ts';
import type { ErrorLog } from '../server/errorLog.ts';
import { isPlayerId } from '../server/playerStore.ts';
import { countedOnce, everyNights, nightsIn, nightsOf, recordsOf } from '../server/resultStore.ts';
import type { NightResult, PlayedNight, PlayerRecord, ResultStore, ResultWriter, Standings } from '../server/resultStore.ts';
import { AMOUNT, HeldReports, openTab, TEXT, TIMESTAMP, underLock, WHOLE_NUMBER } from './sheets.ts';
import type { CacheLike, LockLike, SheetLike, SpreadsheetLike } from './sheets.ts';

export interface SheetResultStoreDeps {
  spreadsheet: () => SpreadsheetLike;
  cache: CacheLike;
  lock: LockLike;
  flush: () => void;
  /** Says when the standings were read, which a page tells its reader. */
  clock: { now(): number };
  /** Where what goes wrong and is carried on through is reported. */
  errors?: ErrorLog;
}

export const RESULTS_TAB = 'Results';

// One fact a column, what a person reads first and what the game finds a table's rows by last
const HEADERS = [
  'Night',
  'Table',
  'Player',
  'Played in',
  'Up or down',
  'Hands',
  'Pots won',
  'Biggest pot',
  'Best hand',
  'Best hand cards',
  'Badges',
  'High hand',
  'Player ID',
  'Table ID',
  'Table save (the game goes by this and the two before it, so leave them as they are)',
];

// Where in a row each thing is, counted from 0
const NIGHT = 0;
const TABLE = 1;
const PLAYER = 2;
const PLAYED_IN = 3;
const NET = 4;
const HANDS = 5;
const WON = 6;
const BIGGEST = 7;
const BEST = 9;
const BADGES = 10;
const HIGH_HAND = 11;
const PLAYER_ID = 12;
const TABLE_ID = 13;
const VERSION = 14;

// The three cells a table's rows are found by lie together, so finding them is one small read
const KEY_COLUMN = PLAYER_ID + 1;
const KEY_COLUMNS = VERSION - PLAYER_ID + 1;

/** What the tab calls the money a table played in: amounts are written as that table writes them, so a cents table's are in dollars. */
const MONEY: Record<Unit, string> = { chips: 'chips', cents: 'dollars' };
const UNIT_OF = new Map(Object.entries(MONEY).map(([unit, word]) => [word, unit as Unit]));

/** Text before anything is written to a cell, so that a table called =SUM(A1) is a name and an id like 2E56789 is not a number. */
function formatsOf(unit: Unit): string[] {
  return [TIMESTAMP, TEXT, TEXT, TEXT, AMOUNT[unit], WHOLE_NUMBER, WHOLE_NUMBER, AMOUNT[unit], TEXT, TEXT, TEXT, WHOLE_NUMBER, TEXT, TEXT, WHOLE_NUMBER];
}

const BUSY = 'The standings are busy, try again';

// A night can be looked up again in a moment, so this does not queue for the lock as long as a move does
const LOCK_WAIT_MS = 3000;

// Whoever runs the game changes the tab by hand, which the cache hears nothing of, so this is how long
// the game may go on handing out the standings as they were before such a change
const CACHE_SECONDS = 300;

const UNITS: Unit[] = ['chips', 'cents'];
const standingsKey = (unit: Unit) => `results:${unit}`;
const nightsKey = (unit: Unit, playerId: string) => `nights:${unit}:${playerId}`;

const CARD = new RegExp(`^[${RANKS}][${SUITS}]$`);
const BADGE = /^([A-Za-z][A-Za-z0-9]{0,30}):([1-9]\d{0,8})$/;
const HAND_SIZE = 5;

function cellsOf(row: NightResult): unknown[] {
  // Only what reads back: a badge whose id would not is left out, so that it never costs the row
  const badges = Object.entries(row.badges)
    .map(([id, times]) => `${id}:${times}`)
    .filter((word) => BADGE.test(word));

  return [
    new Date(row.night),
    row.tableName,
    row.name,
    MONEY[row.unit],
    asNumber(row.net, row),
    row.hands,
    row.won,
    asNumber(row.biggest, row),
    row.best ? madeHandName(evaluateHand(row.best)) : '',
    row.best ? row.best.join(' ') : '',
    badges.join(' '),
    row.highHand ? 1 : 0,
    row.playerId,
    row.tableId,
    row.version,
  ];
}

class Unreadable extends Error {}

function whole(cell: unknown): number {
  if (typeof cell !== 'number' || !Number.isSafeInteger(cell) || cell < 0) {
    throw new Unreadable();
  }

  return cell;
}

function amount(cell: unknown, unit: Unit): number {
  const read = typeof cell === 'number' ? fromNumber(cell, { unit }) : null;
  if (read === null) {
    throw new Unreadable();
  }

  return read;
}

function wordsOf(cell: unknown): string[] {
  return String(cell).trim().split(/\s+/).filter((word) => word !== '');
}

function bestFrom(cell: unknown): Card[] | null {
  const cards = wordsOf(cell);
  if (cards.length === 0) {
    return null;
  }

  if (cards.length !== HAND_SIZE || new Set(cards).size !== HAND_SIZE || !cards.every((card) => CARD.test(card))) {
    throw new Unreadable();
  }

  return cards;
}

function badgesFrom(cell: unknown): Record<string, number> {
  return Object.fromEntries(
    wordsOf(cell).map((word) => {
      const [, id, times] = BADGE.exec(word) ?? [];

      // A word typed by hand may be one every object answers to, such as constructor, which would be counted up from what the object has there
      if (id === undefined || id in {}) {
        throw new Unreadable();
      }

      return [id, Number(times)];
    }),
  );
}

/**
 * One row's result, or null when the row can't be read as one, as after a slip while editing the Sheet
 * by hand. Read by where a cell is, never by a header. The name of the best hand is for whoever reads
 * the tab: the game goes by the cards.
 */
function resultFrom(cells: unknown[]): NightResult | null {
  try {
    const night = cells[NIGHT] instanceof Date ? cells[NIGHT].getTime() : NaN;
    const unit = UNIT_OF.get(String(cells[PLAYED_IN]).trim());
    const playerId = String(cells[PLAYER_ID]).trim();
    const tableId = String(cells[TABLE_ID]).trim();
    const highHand = cells[HIGH_HAND] === '' ? 0 : whole(cells[HIGH_HAND]);

    if (Number.isNaN(night) || unit === undefined || !isPlayerId(playerId) || tableId === '' || highHand > 1) {
      return null;
    }

    return {
      tableId,
      tableName: String(cells[TABLE]),
      unit,
      night,
      version: whole(cells[VERSION]),
      playerId,
      name: String(cells[PLAYER]),
      net: amount(cells[NET], unit),
      hands: whole(cells[HANDS]),
      won: whole(cells[WON]),
      biggest: amount(cells[BIGGEST], unit),
      best: bestFrom(cells[BEST]),
      badges: badgesFrom(cells[BADGES]),
      highHand: highHand === 1,
    };
  } catch (error) {
    if (error instanceof Unreadable) {
      return null;
    }

    throw error;
  }
}

/** Where a row is, and what its table's rows are found by. */
interface Key {
  row: number;
  playerId: string;
  tableId: string;
  version: number;
}

const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Keeps what tables came to in a tab of the Sheet, a row for each table and known player, which
 * whoever runs the game can read, sort and chart there. The tab is the truth, and is made by the first
 * row written to it.
 *
 * Written by the store of tables alone (`ResultWriter`), which holds the script lock as it does: a
 * table's rows are replaced, the new ones added below everything before the old ones are taken out, so
 * that a write cut short leaves too many rows and never none, which reading sets right (`countedOnce`).
 *
 * Read for the standings, which are kept in the script cache for a few minutes, refilled only under
 * the lock, and dropped by every write, so the cache is never behind the game's own last write. A
 * change made by hand is heard of when the entry runs out. The reading that fills the standings puts
 * every player's nights beside them, so that whatever is asked for, the tab is read once.
 */
export class SheetResultStore implements ResultStore, ResultWriter {
  private readonly deps: SheetResultStoreDeps;
  private readonly reports: HeldReports;
  private found: SheetLike | null = null;

  constructor(deps: SheetResultStoreDeps) {
    this.deps = deps;
    this.reports = new HeldReports(deps.errors);
  }

  standings(): Standings {
    return this.reports.after(() => this.cached() ?? this.locked(() => this.cached() ?? this.remember(this.rows())));
  }

  nights(playerId: string, unit: Unit): PlayedNight[] {
    const read = (): PlayedNight[] => {
      const rows = this.rows();
      this.remember(rows);

      return nightsOf(rows, playerId, unit);
    };

    return this.reports.after(() => this.cachedNights(playerId, unit) ?? this.locked(() => this.cachedNights(playerId, unit) ?? read()));
  }

  written(): Map<string, number> {
    const sheet = this.tab(false);
    const versions = new Map<string, number>();

    // Rows of more than one save are a write cut short, which no save of the table matches
    for (const { tableId, version } of sheet ? this.keys(sheet).keys : []) {
      const above = versions.get(tableId);

      if (tableId !== '') {
        versions.set(tableId, above === undefined || above === version ? version : NaN);
      }
    }

    return versions;
  }

  write(results: readonly TableResults[]): void {
    const sheet = this.tab(results.some((table) => table.players.length > 0));
    if (!sheet) {
      return;
    }

    const { last, keys } = this.keys(sheet);
    const keysOf = (table: TableResults) => keys.filter((key) => key.tableId === table.tableId);

    // A table whose rows are these already, each of this save and one for each player, is left as it is
    const stale = results.filter((table) => {
      const kept = keysOf(table);

      return !(kept.every((key) => key.version === table.version) && sameIds(kept.map((key) => key.playerId), table.players.map((player) => player.playerId)));
    });

    const rows = stale.flatMap(nightsIn);
    const old = stale.flatMap(keysOf);

    if (stale.length === 0) {
      return;
    }

    try {
      if (rows.length > 0) {
        this.append(sheet, last, rows);
        this.deps.flush();
      }

      if (old.length > 0) {
        this.remove(sheet, old.map((key) => key.row));
        this.deps.flush();
      }
    } catch (error) {
      // Whatever of it did or didn't land, the cache must not go on answering from before it
      this.forget();
      throw error;
    }

    // Standings that could not be dropped are minutes behind until they run out, which whoever asked for the write is told
    const stuck = this.forget();
    if (stuck) {
      throw stuck;
    }
  }

  private locked<T>(work: () => T): T {
    return underLock(this.deps.lock, BUSY, work, LOCK_WAIT_MS);
  }

  private tab(create: boolean): SheetLike | null {
    this.found ??= openTab(this.deps.spreadsheet(), RESULTS_TAB, HEADERS, create);

    return this.found;
  }

  /** The last row with anything in it, and what each row above it is found by, read from the three cells that say. */
  private keys(sheet: SheetLike): { last: number; keys: Key[] } {
    const last = sheet.getLastRow();
    const cells = last < 1 ? [] : sheet.getRange(1, KEY_COLUMN, last, KEY_COLUMNS).getValues();

    return {
      last,
      keys: cells.map(([playerId, tableId, version], index) => ({
        row: index + 1,
        playerId: String(playerId).trim(),
        tableId: String(tableId).trim(),
        version: typeof version === 'number' ? version : NaN,
      })),
    };
  }

  private append(sheet: SheetLike, last: number, rows: NightResult[]): void {
    // A tab left with nothing in it, as when making it failed halfway, gets its headers
    if (last === 0) {
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    }

    const range = sheet.getRange(Math.max(last, 1) + 1, 1, rows.length, HEADERS.length);

    range.setNumberFormats(rows.map((row) => formatsOf(row.unit)));
    range.setValues(rows.map(cellsOf));
  }

  /** Deletes rows, from the bottom up so that those still to go stay where they were, and those that lie together in one call. */
  private remove(sheet: SheetLike, rows: number[]): void {
    const down = [...rows].sort((a, b) => b - a);

    for (let at = 0; at < down.length; ) {
      let run = 1;
      while (down[at + run] === down[at]! - run) {
        run += 1;
      }

      sheet.deleteRows(down[at]! - run + 1, run);
      at += run;
    }
  }

  /**
   * Every row that counts, as the tab has them now. A missing tab is no results. The first row is the
   * headers whatever it says; any other that can't be read is left out, and said to be.
   */
  private rows(): NightResult[] {
    const sheet = this.tab(false);
    const last = sheet ? sheet.getLastRow() : 0;
    const values = last < 1 ? [] : sheet!.getRange(1, 1, last, HEADERS.length).getValues();
    const read: NightResult[] = [];
    const unreadable: number[] = [];

    values.forEach((cells, index) => {
      const result = cells.every((cell) => String(cell).trim() === '') ? null : resultFrom(cells);

      if (result) {
        read.push(result);
      } else if (index > 0 && cells.some((cell) => String(cell).trim() !== '')) {
        unreadable.push(index + 1);
      }
    });

    if (unreadable.length > 0) {
      this.reports.failed('store read results', `Left out ${unreadable.length} rows of the Results tab that could not be read, the first of them row ${unreadable[0]}`);
    }

    return countedOnce(read);
  }

  /** The standings the cache has, when it has both halves of one reading. A cache that can't be asked, or holds something else, has nothing. */
  private cached(): Standings | null {
    try {
      const [chips, cents] = UNITS.map((unit) => JSON.parse(this.deps.cache.get(standingsKey(unit)) ?? 'null') as { asOf: number; players: PlayerRecord[] } | null);

      return chips && cents && chips.asOf === cents.asOf ? { asOf: chips.asOf, records: { chips: chips.players, cents: cents.players } } : null;
    } catch (error) {
      this.reports.failed('store read cached results', error);

      return null;
    }
  }

  /**
   * A player's nights as the cache has them, which it only can beside the standings they were read
   * with. Someone those standings have no record of has no nights, which takes no reading to know.
   */
  private cachedNights(playerId: string, unit: Unit): PlayedNight[] | null {
    const standings = this.cached();

    if (!standings?.records[unit].some((record) => record.id === playerId)) {
      return standings && [];
    }

    try {
      const kept = JSON.parse(this.deps.cache.get(nightsKey(unit, playerId)) ?? 'null') as { asOf: number; nights: PlayedNight[] } | null;

      return kept?.asOf === standings.asOf ? kept.nights : null;
    } catch (error) {
      this.reports.failed('store read cached results', error);

      return null;
    }
  }

  /**
   * The standings these rows come to, read now, put in the cache: a half for each kind of money, since
   * both at their fullest are more than one entry holds, and then every player's nights, each saying
   * which reading it is of. Standings that can't be put there must not leave older ones behind; nights
   * that can't are read again when asked for.
   */
  private remember(rows: NightResult[]): Standings {
    const standings: Standings = { asOf: this.deps.clock.now(), records: recordsOf(rows) };
    const nights = everyNights(rows);
    const ofPlayers = UNITS.flatMap((unit) => [...nights[unit]].map(([playerId, played]) => [nightsKey(unit, playerId), JSON.stringify({ asOf: standings.asOf, nights: played })]));

    if (!this.put(Object.fromEntries(UNITS.map((unit) => [standingsKey(unit), JSON.stringify({ asOf: standings.asOf, players: standings.records[unit] })])))) {
      this.forget();
    } else if (ofPlayers.length > 0) {
      this.put(Object.fromEntries(ofPlayers));
    }

    return standings;
  }

  /** Puts what was just read under the lock into the cache, and says whether it could. */
  private put(entries: Record<string, string>): boolean {
    try {
      this.deps.cache.putAll(entries, CACHE_SECONDS);

      return true;
    } catch (error) {
      this.reports.failed('store cache results', error);

      return false;
    }
  }

  /**
   * Drops the standings, and with them every player's nights, which are only found beside the standings
   * they were read with. Gives back what went wrong, if anything did: nothing more can be done then,
   * and the entry runs out by itself.
   */
  private forget(): unknown {
    let stuck: unknown = null;

    for (const unit of UNITS) {
      try {
        this.deps.cache.remove(standingsKey(unit));
      } catch (error) {
        stuck ??= error;
      }
    }

    return stuck;
  }
}
