import { sameName } from '../engine/index.ts';
import type { Preset } from '../engine/index.ts';
import { placeOf } from './presetStore.ts';
import type { PresetStore, SavedPreset } from './presetStore.ts';

/** Keeps presets in memory, for local play and tests. Held as JSON, like the tables of `MemoryStore`. */
export class MemoryPresetStore implements PresetStore {
  private kept: string[] = [];

  list(): Preset[] {
    return this.kept.map((json) => {
      const { name, settings } = JSON.parse(json) as SavedPreset;

      return { name, settings };
    });
  }

  save(preset: SavedPreset, replace: boolean): Preset[] {
    this.kept[placeOf(this.list().map((kept) => kept.name), preset.name, replace)] = JSON.stringify(preset);

    return this.list();
  }

  delete(name: string): Preset[] {
    const index = this.list().findIndex((kept) => sameName(kept.name, name));

    if (index >= 0) {
      this.kept.splice(index, 1);
    }

    return this.list();
  }
}
