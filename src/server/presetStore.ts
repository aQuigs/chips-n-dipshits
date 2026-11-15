import { GameError, LIMITS, sameName } from '../engine/index.ts';
import type { Preset } from '../engine/index.ts';

/** A preset as it is kept, with when and by whom it was last saved. */
export interface SavedPreset extends Preset {
  savedAt: number;
  savedBy: string;
}

/** Where the group's presets live. Implementations decide the database and the locking. */
export interface PresetStore {
  /** Every preset that can be read, in the order they were first saved. */
  list(): Preset[];

  /**
   * Saves a preset while nothing else can change the presets, taking the place of one of the same name
   * if `replace` says to. Refuses as `placeOf` does. Returns the presets as they are then, as `list` would.
   */
  save(preset: SavedPreset, replace: boolean): Preset[];

  /** Deletes the preset of that name, whatever its case, if there is one. Returns the presets as `save` does. */
  delete(name: string): Preset[];
}

/**
 * Where a preset goes among the ones kept: in the place of the one of the same name, or after the
 * last. `kept` names each place, null for one that holds something that can't be read, which keeps its
 * place but matches no name. Refuses a name that is taken unless `replace`, and a new one when every
 * place is taken.
 */
export function placeOf(kept: (string | null)[], name: string, replace: boolean): number {
  const same = kept.findIndex((other) => other !== null && sameName(other, name));

  if (same >= 0) {
    if (!replace) {
      throw new GameError(`There is already a preset called ${kept[same]}`);
    }

    return same;
  }

  if (kept.length >= LIMITS.presets) {
    throw new GameError(`There are ${LIMITS.presets} presets already. Delete one to save another`);
  }

  return kept.length;
}
