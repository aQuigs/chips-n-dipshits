import { CONFIG_KEYS, CONFIG_RULES, CONFIG_SPECS, fixedAtCreation, LIMITS } from '../src/engine/index.ts';
import type { ConfigSpec, Rng, TableConfig } from '../src/engine/index.ts';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// A drawn number stays within reach of the stacks a random game has, so the game still has betting in it
const TYPICAL_SPAN = 20;

const ATTEMPTS = 1000;

function word(rng: Rng, length: number): string {
  return Array.from({ length }, () => LETTERS[rng.int(LETTERS.length)]).join('');
}

/**
 * A value a host might give one setting. Numbers come out at their default or their lowest about as
 * often as anywhere else, since "off" and "untouched" are the cases most worth playing; the rest are
 * spread up to twice the default.
 */
export function randomSetting(spec: ConfigSpec, rng: Rng): string | number | boolean {
  switch (spec.kind) {
    case 'text':
      return word(rng, 1 + rng.int(spec.maxLength));

    case 'link':
      return rng.int(3) === 0 ? '' : `https://${word(rng, 1 + rng.int(12))}.example/${word(rng, rng.int(12))}`;

    case 'chips':
    case 'count':
    case 'seconds': {
      const roll = rng.int(5);
      if (roll === 0) {
        return spec.default;
      }

      if (roll === 1) {
        return spec.min;
      }

      const highest = Math.min(spec.max ?? LIMITS.chips, Math.max(2 * spec.default, spec.min + TYPICAL_SPAN));

      return spec.min + rng.int(highest - spec.min + 1);
    }

    case 'toggle':
      return rng.int(2) === 0;

    case 'choice':
      return spec.options[rng.int(spec.options.length)]!.value;
  }
}

/** The part of a table's settings that has to be given when it is created, since it can't be changed after. */
export function fixedSettings(config: TableConfig): Partial<TableConfig> {
  return Object.fromEntries(CONFIG_KEYS.filter(fixedAtCreation).map((key) => [key, config[key]]));
}

/**
 * A full set of table settings the table would accept, drawn from the registry: a setting added there
 * is drawn here. Given the settings of a `table`, they are a change its host could make: what was
 * chosen for good when it was created stays as it is.
 */
export function randomConfig(rng: Rng, table?: TableConfig): TableConfig {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const config = { ...Object.fromEntries(CONFIG_KEYS.map((key) => [key, randomSetting(CONFIG_SPECS[key], rng)])), ...(table && fixedSettings(table)) } as unknown as TableConfig;

    if (CONFIG_RULES.every((rule) => rule.complaint(config) === null)) {
      return config;
    }
  }

  throw new Error(`No ${ATTEMPTS} random draws gave settings that pass every rule in CONFIG_RULES; a rule that few draws pass needs randomSetting to help`);
}
