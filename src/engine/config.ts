import { GameError } from './types.ts';
import type { TableConfig } from './types.ts';
import { LIMITS, text, wholeNumber, yesOrNo } from './validate.ts';

/** The sections of the settings form, in the order they show. `house` is what the house allows at the table. */
export const CONFIG_GROUPS = ['table', 'stakes', 'clock', 'extras', 'house'] as const;

export type ConfigGroup = (typeof CONFIG_GROUPS)[number];

interface SpecBase {
  /** What the form calls it. */
  label: string;
  /** How a refusal names it: "The small blind must be a whole number…". */
  subject: string;
  /** A line under the field. */
  hint?: string;
  group: ConfigGroup;
  /** Narrow enough to share a row with the next such field of its group. */
  half?: boolean;
  /** Asked for when a table is created as well; the rest are only in the table settings. */
  atCreate?: boolean;
  /** A change leaves the hand in play as it is, which finishes on the value it was dealt under. */
  nextHand?: boolean;
}

export interface TextSpec extends SpecBase {
  kind: 'text';
  default: string;
  maxLength: number;
}

/** A whole number: of chips, of anything else that is counted, or of seconds. */
export interface NumberSpec extends SpecBase {
  kind: 'chips' | 'count' | 'seconds';
  default: number;
  min: number;
  /** Left out, the most chips a table can hold. */
  max?: number;
}

/** A switch has only its label to say what it does; the form gives it no line underneath. */
export interface ToggleSpec extends Omit<SpecBase, 'hint'> {
  kind: 'toggle';
  default: boolean;
}

export interface ChoiceSpec<V extends string = string> extends SpecBase {
  kind: 'choice';
  default: V;
  options: { value: V; label: string }[];
}

export type ConfigSpec = TextSpec | NumberSpec | ToggleSpec | ChoiceSpec;

export type ConfigKey = keyof TableConfig;

/** The kind of spec a setting of a given type takes; a string that is one of a few fixed values is a choice. */
type SpecFor<V> = [V] extends [boolean] ? ToggleSpec : [V] extends [number] ? NumberSpec : [V] extends [string] ? (string extends V ? TextSpec : ChoiceSpec<V>) : never;

/**
 * Every table setting. The defaults, the checks on what a host sends, both forms and the random tables
 * of the simulation are all read from here, so a new setting is a field of `TableConfig` and its entry
 * in this list.
 *
 * The order is the order they are checked in, which decides the complaint a host gets when several
 * things are wrong at once. The form goes by `group` first, and by this order within a group.
 */
export const CONFIG_SPECS: { [K in ConfigKey]-?: SpecFor<TableConfig[K]> } = {
  smallBlind: { kind: 'chips', label: 'Small blind', subject: 'The small blind', default: 10, min: 1, group: 'stakes', half: true, atCreate: true, nextHand: true },
  bigBlind: { kind: 'chips', label: 'Big blind', subject: 'The big blind', default: 20, min: 1, group: 'stakes', half: true, atCreate: true, nextHand: true },
  minBuyIn: { kind: 'chips', label: 'Minimum buy-in', subject: 'The minimum buy-in', default: 400, min: 1, group: 'stakes', half: true, atCreate: true },
  maxBuyIn: { kind: 'chips', label: 'Maximum buy-in', subject: 'The maximum buy-in', default: 2000, min: 1, group: 'stakes', half: true, atCreate: true },
  actionSeconds: {
    kind: 'seconds',
    label: 'Seconds to act',
    subject: 'The action clock',
    hint: '0 turns the clock off',
    default: 30,
    min: 0,
    max: LIMITS.maxActionSeconds,
    group: 'clock',
  },
  name: {
    kind: 'text',
    label: 'Table name',
    subject: 'The table name',
    default: "Chips n' Dipshits",
    maxLength: LIMITS.tableNameLength,
    group: 'table',
    atCreate: true,
  },
  allowStraddle: { kind: 'toggle', label: 'Allow straddles', subject: 'Straddles', default: true, group: 'house' },
  allowRunItTwice: { kind: 'toggle', label: 'Offer run it twice when everyone is all in', subject: 'Run it twice', default: true, group: 'house' },
  sevenDeuceBounty: {
    kind: 'chips',
    label: 'Seven-deuce bounty',
    subject: 'The seven-deuce bounty',
    hint: 'Paid by everyone dealt in to whoever wins with 7-2. 0 turns it off',
    default: 0,
    min: 0,
    group: 'extras',
    nextHand: true,
  },
};

export const CONFIG_KEYS = Object.keys(CONFIG_SPECS) as ConfigKey[];

export interface ConfigRule {
  /** The settings the rule reads. It is checked as soon as each of them is fine by itself. */
  keys: ConfigKey[];
  /** What is wrong between them, or null. */
  complaint(config: TableConfig): string | null;
}

function rule<K extends ConfigKey>(keys: K[], complaint: (config: Pick<TableConfig, K>) => string | null): ConfigRule {
  return { keys, complaint };
}

/** What must hold between settings, or of one setting beyond what its spec can say. */
export const CONFIG_RULES: ConfigRule[] = [
  rule(['smallBlind', 'bigBlind'], (config) => (config.bigBlind < config.smallBlind ? "The big blind can't be smaller than the small blind" : null)),
  rule(['minBuyIn', 'maxBuyIn'], (config) => (config.maxBuyIn < config.minBuyIn ? "The maximum buy-in can't be smaller than the minimum" : null)),
  rule(['actionSeconds'], (config) =>
    config.actionSeconds !== 0 && config.actionSeconds < LIMITS.minActionSeconds ? `The action clock must be off or at least ${LIMITS.minActionSeconds} seconds` : null,
  ),
];

export const DEFAULT_CONFIG = Object.fromEntries(CONFIG_KEYS.map((key) => [key, CONFIG_SPECS[key].default])) as unknown as TableConfig;

/** One setting as its spec allows it, or a refusal that names it. */
export function validSetting(spec: ConfigSpec, value: unknown): string | number | boolean {
  switch (spec.kind) {
    case 'text':
      return text(value, spec.subject, spec.maxLength);
    case 'chips':
    case 'count':
    case 'seconds':
      return wholeNumber(value, spec.subject, spec.min, spec.max);
    case 'toggle':
      return yesOrNo(value, spec.subject);
    case 'choice': {
      const option = spec.options.find((o) => o.value === value);
      if (!option) {
        throw new GameError(`${spec.subject} must be one of: ${spec.options.map((o) => o.label).join(', ')}`);
      }

      return option.value;
    }
  }
}

/** Checks a full set of table settings, filling anything missing from the current ones. */
export function validatedConfig(input: unknown, current: TableConfig): TableConfig {
  const given = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const config: Partial<Record<ConfigKey, string | number | boolean>> = {};

  for (const key of CONFIG_KEYS) {
    config[key] = validSetting(CONFIG_SPECS[key], given[key] === undefined ? current[key] : given[key]);

    for (const { keys, complaint } of CONFIG_RULES) {
      const wrong = keys.includes(key) && keys.every((read) => read in config) ? complaint(config as unknown as TableConfig) : null;
      if (wrong !== null) {
        throw new GameError(wrong);
      }
    }
  }

  return config as unknown as TableConfig;
}
