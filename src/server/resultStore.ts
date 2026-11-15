/*
 * What the game keeps of its players over time: for each table and each known player who had chips
 * there, what the night came to (`resultsOf` in the engine makes these from a table). Here is how they
 * are kept, how they add up into a player's record, and when a table's are written again. Every store
 * follows these, so the record is the same over a Sheet and in memory.
 */
import { addedUp, resultsOf } from '../engine/index.ts';
import type { Card, PlayerResult, TableResults, TableState, Unit } from '../engine/index.ts';
import { SETTLE_AFTER_MS } from './api.ts';

/** One known player's night at one table, as it is kept: a row of the Results tab. */
export interface NightResult extends PlayerResult {
  tableId: string;
  tableName: string;
  unit: Unit;
  /** When the table was made. */
  night: number;
  /** The save of the table this was made from. */
  version: number;
}

/** A table's results as the rows that are kept of them. */
export function nightsIn(results: TableResults): NightResult[] {
  const { tableId, tableName, unit, createdAt, version } = results;

  return results.players.map((player) => ({ ...player, tableId, tableName, unit, night: createdAt, version }));
}

/**
 * The rows that count, of rows as they were read: for each table those of its latest save, and of
 * those one for each player, the lowest. A table's rows are replaced when they are written again, but a
 * write that failed halfway, or a row someone copied by hand, can leave more, and no night is ever
 * counted twice.
 */
export function countedOnce(rows: readonly NightResult[]): NightResult[] {
  const latest = new Map<string, number>();
  for (const row of rows) {
    latest.set(row.tableId, Math.max(latest.get(row.tableId) ?? row.version, row.version));
  }

  const counted = new Map<string, NightResult>();
  for (const row of rows) {
    if (row.version === latest.get(row.tableId)) {
      counted.set(`${row.tableId} ${row.playerId}`, row);
    }
  }

  return [...counted.values()];
}

/**
 * A known player's record over every night kept of them at tables that play one kind of money. A
 * night is a table they had chips at: one table is one night, as its Tonight page has it, however
 * often it was ended and played on.
 */
export interface PlayerRecord {
  /** The known player. */
  id: string;
  nights: number;
  /** Nights they finished up. */
  nightsUp: number;
  /** What they are up or down over all of them, in that money's smallest unit. */
  net: number;
  hands: number;
  /** Hands they took chips from the pots of. */
  won: number;
  /** The most they took from the pots of one hand. */
  biggest: number;
  /** The best hand they showed down on any night, the earliest night's when a later one is as good; null when they have shown none. */
  best: Card[] | null;
  /** Their badges over all the nights, by id, and how many times each. */
  badges: Record<string, number>;
  /** Nights whose high hand was theirs. */
  highHands: number;
}

/**
 * The records by what the tables played in. A chip is not a cent, and nothing says what a chip was
 * worth, so tables that play whole chips and tables that play dollars and cents are never added together.
 */
export type Records = Record<Unit, PlayerRecord[]>;


const inOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The earliest night first, and nights of the same moment by their table and player, so that the same rows add up the same way wherever they lie. */
const byNight = (a: NightResult, b: NightResult): number => a.night - b.night || inOrder(a.tableId, b.tableId) || inOrder(a.playerId, b.playerId);

/** Every player's record, from rows that each count once (`countedOnce`). */
export function recordsOf(rows: readonly NightResult[]): Records {
  const records: Record<Unit, Map<string, PlayerRecord>> = { chips: new Map(), cents: new Map() };

  for (const row of [...rows].sort(byNight)) {
    const ofUnit = records[row.unit];
    const record = ofUnit.get(row.playerId) ?? { id: row.playerId, nights: 0, nightsUp: 0, net: 0, hands: 0, won: 0, biggest: 0, best: null, badges: {}, highHands: 0 };

    ofUnit.set(row.playerId, {
      ...record,
      ...addedUp(record, row),
      nights: record.nights + 1,
      nightsUp: record.nightsUp + (row.net > 0 ? 1 : 0),
      highHands: record.highHands + (row.highHand ? 1 : 0),
    });
  }

  return { chips: [...records.chips.values()], cents: [...records.cents.values()] };
}

/** One of a player's nights, as anyone may see it: the table by its name and date, never by its id. */
export interface PlayedNight {
  /** When the table was made. */
  at: number;
  table: string;
  net: number;
  hands: number;
  won: number;
  biggest: number;
  best: Card[] | null;
  badges: Record<string, number>;
  highHand: boolean;
}

/** How many of a player's nights are handed out, the latest ones. Earlier ones still count in their record. */
export const NIGHTS_SHOWN = 250;

/** Every player's nights, the latest first, by the kind of money and then by the player, from rows that each count once. */
export function everyNights(rows: readonly NightResult[]): Record<Unit, Map<string, PlayedNight[]>> {
  const nights: Record<Unit, Map<string, PlayedNight[]>> = { chips: new Map(), cents: new Map() };

  for (const { unit, playerId, night, tableName, net, hands, won, biggest, best, badges, highHand } of [...rows].sort(byNight).reverse()) {
    const ofPlayer = nights[unit].get(playerId) ?? [];

    if (ofPlayer.length < NIGHTS_SHOWN) {
      ofPlayer.push({ at: night, table: tableName, net, hands, won, biggest, best, badges, highHand });
    }

    nights[unit].set(playerId, ofPlayer);
  }

  return nights;
}

/** A player's nights at tables that play one kind of money, the latest first, from rows that each count once. */
export function nightsOf(rows: readonly NightResult[], playerId: string, unit: Unit): PlayedNight[] {
  return everyNights(rows)[unit].get(playerId) ?? [];
}

/** The records as they were read at `asOf`. */
export interface Standings {
  asOf: number;
  records: Records;
}

/** Where the game reads its players' records from. Implementations decide the database, the locking and any caching. */
export interface ResultStore {
  /** Every player's record. May be served from a cache, and says when it was read. */
  standings(): Standings;

  /** One player's nights as `nightsOf` gives them, read no earlier than the standings last handed out. */
  nights(playerId: string, unit: Unit): PlayedNight[];
}

/** For a game that keeps nobody's record: everything asks and nothing is there. */
export const NO_RESULTS: ResultStore = {
  standings: () => ({ asOf: 0, records: { chips: [], cents: [] } }),
  nights: () => [],
};

/**
 * Where a store of tables writes what its tables came to. Only such a store writes here, while nothing
 * else can change the table or what is kept of it: over a Sheet, holding the script lock.
 */
export interface ResultWriter {
  /** The save each table's kept results were made from, by table id: only tables of which something is kept. */
  written(): Map<string, number>;

  /**
   * Keeps each of these in place of whatever is kept of its table: none is left of a table that has
   * no players. Nothing is written of a table when what is kept was made from the same save, so
   * asking again costs a look.
   */
  write(results: readonly TableResults[]): void;
}

/** How many tables one look loads to write their results, in one write, so that it stays a small part of the request that carries it. */
export const SETTLED_AT_ONCE = 3;

/** How long after a look before a request for the standings sets off another. */
export const SETTLE_EVERY_MS = 5 * 60 * 1000;

/** A table as a store knows it without loading it. */
export interface SavedTable {
  id: string;
  changedAt: number;
  version: number;
}

/**
 * What a store remembers of its looks, to spare itself the next: when the last one worth noting was,
 * the save of each table found to need nothing more, and the save of each whose results could not be
 * written. Only a memory: lost, the tables are looked at again.
 */
export interface Settled {
  at: number;
  seen: Record<string, number>;
  failed: Record<string, number>;
}

export const NEVER_SETTLED: Settled = { at: 0, seen: {}, failed: {} };

const sameSaves = (a: Record<string, number>, b: Record<string, number>): boolean => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, version]) => b[id] === version);

export function idleLongEnough(table: SavedTable, now: number): boolean {
  return now - table.changedAt >= SETTLE_AFTER_MS;
}

/**
 * One look at the tables nobody has changed for `SETTLE_AFTER_MS`: those whose kept results are not of
 * their last save have them written, the latest played first, `SETTLED_AT_ONCE` at most, and the rest
 * wait for the next look. A table mid-hand is written like any other, chips in the pot counting as
 * their owner's, as its ledger has them. `load` reads a table, or gives null for one that can't be
 * read as a table any more, which is then left alone for good. A table that fails is `failed` and
 * tried again by a later look, behind every table that has not failed: one that can never be written
 * holds up nobody.
 *
 * Gives back what to remember, which is `memory` itself when there is nothing new to: a look that was
 * `asked` for by itself is always noted, so that the next asking is held off for `SETTLE_EVERY_MS`,
 * and one that rode on something else only when it saw to a table.
 */
export function settleIdle<T extends SavedTable>(
  tables: readonly T[],
  now: number,
  memory: Settled,
  results: ResultWriter,
  load: (table: T) => TableState | null,
  failed: (error: unknown, table: T | null) => void,
  asked: boolean,
): Settled {
  const idle = tables.filter((table) => idleLongEnough(table, now));
  // Only what is still true of a table as it stands is carried over: a save since then starts it afresh
  const still = (saves: Record<string, number>) => Object.fromEntries(idle.filter((table) => saves[table.id] === table.version).map((table) => [table.id, table.version]));
  const seen = still(memory.seen);
  const troubled = still(memory.failed);
  const unseen = idle.filter((table) => !(table.id in seen)).sort((a, b) => Number(a.id in troubled) - Number(b.id in troubled) || b.changedAt - a.changedAt || inOrder(a.id, b.id));

  const settled = (table: T): void => {
    seen[table.id] = table.version;
    delete troubled[table.id];
  };

  const trouble = (error: unknown, table: T): void => {
    troubled[table.id] = table.version;
    failed(error, table);
  };

  if (unseen.length > 0) {
    const written = results.written();
    const toWrite: { table: T; found: TableResults }[] = [];
    let loaded = 0;

    for (const table of unseen) {
      if (written.get(table.id) === table.version) {
        settled(table);
        continue;
      }

      if (loaded === SETTLED_AT_ONCE) {
        break;
      }

      loaded += 1;

      try {
        const state = load(table);
        const found = state && resultsOf(state);

        // A table that comes to nothing, with nothing kept of it, is not worth a write
        if (found && (found.players.length > 0 || written.has(table.id))) {
          toWrite.push({ table, found });
        } else {
          settled(table);
        }
      } catch (error) {
        trouble(error, table);
      }
    }

    const write = (batch: typeof toWrite): boolean => {
      try {
        results.write(batch.map(({ found }) => found));
        batch.forEach(({ table }) => settled(table));

        return true;
      } catch (error) {
        batch.length === 1 ? trouble(error, batch[0]!.table) : failed(error, null);

        return false;
      }
    };

    // One write for all of them. When that fails, each by itself, so that one table's trouble is not the others'
    if (toWrite.length > 0 && !write(toWrite) && toWrite.length > 1) {
      toWrite.forEach((one) => write([one]));
    }
  }

  const same = sameSaves(seen, memory.seen) && sameSaves(troubled, memory.failed);

  return asked || !same ? { at: now, seen, failed: troubled } : memory;
}
