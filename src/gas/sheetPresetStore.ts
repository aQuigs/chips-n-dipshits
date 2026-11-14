import { presetName, sameName } from '../engine/index.ts';
import type { Preset } from '../engine/index.ts';
import { placeOf } from '../server/presetStore.ts';
import type { PresetStore, SavedPreset } from '../server/presetStore.ts';
import { FIRST_DATA_ROW, openTab, TEXT, TIMESTAMP, underLock } from './sheets.ts';
import type { LockLike, SheetLike, SpreadsheetLike } from './sheets.ts';

export interface SheetPresetStoreDeps {
  spreadsheet: () => SpreadsheetLike;
  lock: LockLike;
  flush: () => void;
}

const TAB = 'Presets';
const HEADERS = ['Name', 'Settings (the game reads these, so edit with care)', 'Saved', 'Saved by'];
const FORMATS = [TEXT, TEXT, TIMESTAMP, TEXT];
const BUSY = 'The presets are busy, try again';

/** One row's preset, or null when what is in the row can't be read as one, as after a slip while editing the Sheet by hand. */
function presetOf(row: unknown[]): Preset | null {
  try {
    const name = presetName(String(row[0]));
    const settings: unknown = JSON.parse(String(row[1]));

    return typeof settings === 'object' && settings !== null && !Array.isArray(settings) ? { name, settings: settings as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

interface Row {
  row: number;
  preset: Preset | null;
}

function readable(rows: Row[]): Preset[] {
  return rows.flatMap(({ preset }) => (preset ? [{ name: preset.name, settings: preset.settings }] : []));
}

/**
 * Keeps the group's presets in a tab of the Sheet, a row each. Nothing is cached: they are read only
 * when a table is being created or its settings opened. Every write is under the script lock, so two
 * saves at once can't both take the last place or both add the same name.
 */
export class SheetPresetStore implements PresetStore {
  private readonly deps: SheetPresetStoreDeps;

  constructor(deps: SheetPresetStoreDeps) {
    this.deps = deps;
  }

  list(): Preset[] {
    const sheet = this.tab(false);

    return sheet ? readable(this.rows(sheet)) : [];
  }

  save(preset: SavedPreset, replace: boolean): Preset[] {
    return underLock(this.deps.lock, BUSY, () => {
      const sheet = this.tab(true)!;
      const rows = this.rows(sheet);
      const place = placeOf(rows.map((kept) => kept.preset?.name ?? null), preset.name, replace);
      const at = place < rows.length ? rows[place]!.row : this.freeRow(rows);
      const range = sheet.getRange(at, 1, 1, HEADERS.length);

      // Plain text, so a name that starts with = is not taken for a formula
      range.setNumberFormats([FORMATS]);
      range.setValues([[preset.name, JSON.stringify(preset.settings), new Date(preset.savedAt), preset.savedBy]]);
      this.deps.flush();

      return readable([...rows.filter(({ row }) => row !== at), { row: at, preset }].sort((a, b) => a.row - b.row));
    });
  }

  delete(name: string): Preset[] {
    return underLock(this.deps.lock, BUSY, () => {
      const sheet = this.tab(false);
      const rows = sheet ? this.rows(sheet) : [];
      const found = rows.find(({ preset }) => preset !== null && sameName(preset.name, name));

      if (sheet && found) {
        sheet.deleteRow(found.row);
        this.deps.flush();
      }

      return readable(rows.filter((kept) => kept !== found));
    });
  }

  private tab(create: boolean): SheetLike | null {
    return openTab(this.deps.spreadsheet(), TAB, HEADERS, create);
  }

  /**
   * Every row below the headers with a name or settings in it, as a preset or null. One that can't be
   * read still takes a place, so the presets never take more rows than the limit. A row with neither,
   * cleared by hand or holding only a note to the side, is free.
   */
  private rows(sheet: SheetLike): Row[] {
    const last = sheet.getLastRow();
    const values = last < FIRST_DATA_ROW ? [] : sheet.getRange(FIRST_DATA_ROW, 1, last - FIRST_DATA_ROW + 1, 2).getValues();

    return values.flatMap((cells, index) => (cells.every((cell) => String(cell).trim() === '') ? [] : [{ row: FIRST_DATA_ROW + index, preset: presetOf(cells) }]));
  }

  /** The first row below the headers that no preset takes, which is never past the limit while there is room for one more. */
  private freeRow(rows: Row[]): number {
    const taken = new Set(rows.map(({ row }) => row));
    let row = FIRST_DATA_ROW;

    while (taken.has(row)) {
      row += 1;
    }

    return row;
  }
}
