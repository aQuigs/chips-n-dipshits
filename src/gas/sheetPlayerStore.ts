import { listedLike, playerName } from '../engine/index.ts';
import type { KnownPlayer, Rng } from '../engine/index.ts';
import { dueToBeSeen, inListOrder, isPlayerId, mayAdd, newPlayerId } from '../server/playerStore.ts';
import type { KeptPlayer, PlayerStore } from '../server/playerStore.ts';
import { FIRST_DATA_ROW, openTab, TEXT, TIMESTAMP, underLock } from './sheets.ts';
import type { CacheLike, LockLike, SheetLike, SpreadsheetLike } from './sheets.ts';

export interface SheetPlayerStoreDeps {
  spreadsheet: () => SpreadsheetLike;
  cache: CacheLike;
  lock: LockLike;
  flush: () => void;
  /** Where a new player's id comes from. */
  rng: Rng;
}

const TAB = 'Players';
const HEADERS = ['ID (the game knows a player by this, so leave it as it is)', 'Name', 'First seen', 'Last seen'];
const FORMATS = [TEXT, TEXT, TIMESTAMP, TIMESTAMP];
const SEEN_COLUMN = 4;
const BUSY = 'The list of players is busy, try again';

const CACHE_KEY = 'players';

// Whoever runs the game changes the tab by hand, which the cache hears nothing of, so this is how long
// the game may go on handing out the list as it was before such a change
const CACHE_SECONDS = 300;

// Who a player is can be said again later, so this does not queue for the lock as long as a move does
const LOCK_WAIT_MS = 3000;

interface Row {
  row: number;
  /** Null when what is in the row can't be read as a player, as after a slip while editing the Sheet by hand. */
  player: KeptPlayer | null;
}

/**
 * One row's player, or null: an id the game did not give, a name that is no name, or an id or a name
 * that a row above already has, which is then the one that counts.
 */
function keptOf(cells: unknown[], above: KeptPlayer[]): KeptPlayer | null {
  try {
    const id = String(cells[0]).trim();
    const name = playerName(String(cells[1]));
    const seen = cells[SEEN_COLUMN - 1] instanceof Date ? (cells[SEEN_COLUMN - 1] as Date).getTime() : NaN;

    return isPlayerId(id) && !above.some((player) => player.id === id) && !listedLike(above, name) ? { id, name, seenAt: Number.isNaN(seen) ? 0 : seen } : null;
  } catch {
    return null;
  }
}

function readable(rows: Row[]): KeptPlayer[] {
  return rows.flatMap(({ player }) => (player ? [player] : []));
}

/**
 * Keeps the known players in a tab of the Sheet, a row each, with the whole list in the script cache
 * in front, since every join asks for it. The tab is the truth. Every write to it, and every refill of
 * the cache, happens under the script lock, and a write that fails takes the cache entry with it, so
 * the cache never holds a list older than the game's own last write. A change made by hand is another
 * matter: the game hears of it when the cache entry runs out.
 */
export class SheetPlayerStore implements PlayerStore {
  private readonly deps: SheetPlayerStoreDeps;

  constructor(deps: SheetPlayerStoreDeps) {
    this.deps = deps;
  }

  list(): KnownPlayer[] {
    return inListOrder(this.known());
  }

  seen(id: string, at: number): KnownPlayer | null {
    const found = this.known().find((player) => player.id === id);
    if (!found) {
      return null;
    }

    if (dueToBeSeen(found, at)) {
      this.noteSeen(id, at);
    }

    return { id: found.id, name: found.name };
  }

  add(name: string, at: number): KnownPlayer {
    const clean = playerName(name);

    return this.locked(() => {
      const sheet = this.tab(true)!;
      const { headed, rows } = this.read(sheet);
      const players = readable(rows);

      mayAdd(players, rows.length, clean);

      const added: KeptPlayer = { id: newPlayerId(this.deps.rng, players), name: clean, seenAt: at };

      this.write(() => {
        // A tab that lost its headers, as when making it failed halfway, gets them back
        if (!headed) {
          sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
        }

        const range = sheet.getRange(this.freeRow(rows), 1, 1, HEADERS.length);

        // Plain text before anything is written: an id like 2E56789234 is not turned into a number, and
        // nothing a player typed is ever taken for a formula, whatever the rule for names comes to allow
        range.setNumberFormats([FORMATS]);
        range.setValues([[added.id, added.name, new Date(at), new Date(at)]]);
      });
      this.remember([...players, added]);

      return { id: added.id, name: added.name };
    });
  }

  private locked<T>(work: () => T): T {
    return underLock(this.deps.lock, BUSY, work, LOCK_WAIT_MS);
  }

  private tab(create: boolean): SheetLike | null {
    return openTab(this.deps.spreadsheet(), TAB, HEADERS, create);
  }

  /** The players that can be read, in the order of their rows: from the cache, or from the tab into the cache. */
  private known(): KeptPlayer[] {
    const cached = this.cached();
    if (cached) {
      return cached;
    }

    return this.locked(() => {
      // When the entry runs out, everyone opening the game at that moment arrives here; the first of them refills it
      const refilled = this.cached();
      if (refilled) {
        return refilled;
      }

      const sheet = this.tab(false);
      const players = sheet ? readable(this.read(sheet).rows) : [];

      this.remember(players);

      return players;
    });
  }

  /** What the cache has of the list. A cache that can't be asked, or holds something else, has nothing. */
  private cached(): KeptPlayer[] | null {
    try {
      const kept: unknown = JSON.parse(this.deps.cache.get(CACHE_KEY) ?? 'null');

      return Array.isArray(kept) ? (kept as KeptPlayer[]) : null;
    } catch {
      return null;
    }
  }

  /** The list as just read under the lock goes into the cache. One that can't be put there must not leave an older one behind. */
  private remember(players: KeptPlayer[]): void {
    try {
      this.deps.cache.put(CACHE_KEY, JSON.stringify(players), CACHE_SECONDS);
    } catch {
      this.forget();
    }
  }

  private forget(): void {
    try {
      this.deps.cache.remove(CACHE_KEY);
    } catch {
      // Nothing more can be done; the entry runs out by itself
    }
  }

  /** Makes a change to the tab and pushes it through. Whatever of it did or didn't land when that fails, the cache must not go on answering from before it. */
  private write(change: () => void): void {
    try {
      change();
      this.deps.flush();
    } catch (error) {
      this.forget();
      throw error;
    }
  }

  /**
   * Whether the tab has its headers, and every row below them with anything in its four cells, as a
   * player or null. One that can't be read still takes a place, so the list never takes more rows than
   * it may. A row with nothing in them, cleared by hand or holding only a note to the side, is free.
   */
  private read(sheet: SheetLike): { headed: boolean; rows: Row[] } {
    const last = sheet.getLastRow();
    const values = last < 1 ? [] : sheet.getRange(1, 1, last, HEADERS.length).getValues();
    const blank = (cells: unknown[]) => cells.every((cell) => String(cell).trim() === '');
    const rows: Row[] = [];

    // The first row is the headers whatever it says, except a player: deleting the header row by hand
    // moves one up into its place, and they are on the list still
    const first = values.length > 0 && keptOf(values[0]!, []) ? 1 : FIRST_DATA_ROW;

    values.slice(first - 1).forEach((cells, index) => {
      if (!blank(cells)) {
        rows.push({ row: first + index, player: keptOf(cells, readable(rows)) });
      }
    });

    return { headed: values.length > 0 && !blank(values[0]!), rows };
  }

  /** The first row below the headers that holds nothing, which is never past the limit while there is room for one more player. */
  private freeRow(rows: Row[]): number {
    const taken = new Set(rows.map(({ row }) => row));
    let row = FIRST_DATA_ROW;

    while (taken.has(row)) {
      row += 1;
    }

    return row;
  }

  /**
   * Writes when a player was last seen. It rides on a request made for something else, so it never
   * throws: whatever it could not do is done the next time they are seen.
   */
  private noteSeen(id: string, at: number): void {
    try {
      this.locked(() => {
        const sheet = this.tab(false);
        const rows = sheet ? this.read(sheet).rows : [];
        const found = rows.find(({ player }) => player?.id === id);

        // Someone else's request may have noted them while this one waited for the lock
        if (sheet && found?.player && dueToBeSeen(found.player, at)) {
          const cell = sheet.getRange(found.row, SEEN_COLUMN, 1, 1);

          this.write(() => {
            cell.setNumberFormats([[TIMESTAMP]]);
            cell.setValues([[new Date(at)]]);
          });
          found.player.seenAt = at;
        }

        this.remember(readable(rows));
      });
    } catch (error) {
      console.error(error);
    }
  }
}
