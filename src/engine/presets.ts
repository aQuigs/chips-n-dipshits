/* A preset: a table's settings kept under a name, for the group to start the next table from. */
import { CONFIG_KEYS, CONFIG_RULES, CONFIG_SPECS, DEFAULT_CONFIG, fieldsOf, newConfig, settingText, startingConfig, validSetting } from './config.ts';
import type { ConfigKey } from './config.ts';
import type { TableConfig } from './types.ts';
import { LIMITS, text } from './validate.ts';

export interface Preset {
  name: string;
  /** The settings as they were when it was saved, which may not be the settings there are now: read them with `fromPreset`. */
  settings: Record<string, unknown>;
}

/** What picking a preset comes to with the settings there are now. */
export interface PresetUse {
  config: TableConfig;
  /** Each value of the preset's that is no longer allowed, and what took its place. */
  notes: string[];
}

export const PRESET_KEYS = CONFIG_KEYS.filter((key) => CONFIG_SPECS[key].inPresets !== false);

export function presetName(value: unknown): string {
  return text(value, 'The preset name', LIMITS.presetNameLength);
}

export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const NOT_KEPT = CONFIG_KEYS.filter((key) => !PRESET_KEYS.includes(key));

/** Only the settings a preset keeps, of whatever was sent or saved. */
function keptOf(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => PRESET_KEYS.includes(key as ConfigKey)));
}

/**
 * What a preset keeps of the settings sent to be saved, once they pass the checks a new table's do. A
 * setting it doesn't keep is not checked, so a half-typed voice chat link doesn't stop the save.
 */
export function presetSettings(input: unknown): Partial<TableConfig> {
  const config = newConfig(keptOf(fieldsOf(input)));

  return Object.fromEntries(PRESET_KEYS.map((key) => [key, config[key]]));
}

/** A preset as it is handed out: anyone with the game's address may list them, so only what presets keep. */
export function sharedPreset(preset: Preset): Preset {
  return { name: preset.name, settings: keptOf(preset.settings) };
}

function backToUsual(keys: ConfigKey[], config: TableConfig): string {
  if (keys.length === 1) {
    return `${CONFIG_SPECS[keys[0]!].label} is back to ${settingText(keys[0]!, config)}: the preset’s is no longer allowed.`;
  }

  return `${keys.map((key) => CONFIG_SPECS[key].label).join(' and ')} are back to the usual: the preset’s no longer go together.`;
}

/**
 * The settings a preset gives a new table now. A setting added since it was saved starts where a new
 * table's does, one since removed is dropped, and a value that is no longer allowed is replaced by the
 * usual one with a note saying so. `others` holds the settings presets don't keep.
 */
export function fromPreset(settings: unknown, others: TableConfig = DEFAULT_CONFIG): PresetUse {
  const saved = fieldsOf(settings);
  const usual = startingConfig(saved);
  const config: TableConfig = { ...usual, ...Object.fromEntries(NOT_KEPT.map((key) => [key, others[key]])) };
  const set = (key: ConfigKey, value: unknown) => ((config as unknown as Record<string, unknown>)[key] = value);
  const notes: string[] = [];

  // In the registry's order, so what the table plays with is settled before any amount is read for it
  for (const key of PRESET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(saved, key)) {
      continue;
    }

    try {
      set(key, validSetting(CONFIG_SPECS[key], saved[key], config));
    } catch {
      notes.push(backToUsual([key], config));
    }
  }

  for (const { keys, complaint } of CONFIG_RULES) {
    if (complaint(config) !== null) {
      const reset = keys.filter((key) => PRESET_KEYS.includes(key));

      reset.forEach((key) => set(key, usual[key]));
      notes.push(backToUsual(reset, config));
    }
  }

  return { config, notes };
}

/** The preset a table is playing, if its settings are one's to the letter. */
export function matchingPreset(presets: Preset[], config: TableConfig): Preset | null {
  return presets.find((preset) => {
    const used = fromPreset(preset.settings, config).config;

    return PRESET_KEYS.every((key) => used[key] === config[key]);
  }) ?? null;
}
