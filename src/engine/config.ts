import { validAmount } from './amounts.ts';
import type { Denominated } from './amounts.ts';
import { GameError } from './types.ts';
import type { TableConfig } from './types.ts';
import { LIMITS, text, webAddress, wholeNumber, yesOrNo } from './validate.ts';

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
  /**
   * Asked for when a table is created as well; the rest are only in the table settings. `'only'` is
   * for what can't change once there is a table: it is chosen then, shown closed in the table settings
   * from then on, and a change to it is refused.
   */
  atCreate?: boolean | 'only';
  /** A change leaves the hand in play as it is, which finishes on the value it was dealt under. */
  nextHand?: boolean;
}

export interface TextSpec extends SpecBase {
  kind: 'text';
  default: string;
  maxLength: number;
}

/** A secure web address, or '' for none. */
export interface LinkSpec extends SpecBase {
  kind: 'link';
  default: string;
  maxLength: number;
  /** An example address for the empty field. */
  placeholder: string;
}

/**
 * A whole number: of anything that is counted, of seconds, or for `chips` an amount, which counts the
 * table's smallest unit. Its limits count the same, so at a table that plays dollars and cents a
 * lowest of 1 is 0.01.
 */
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
  options: {
    value: V;
    label: string;
    /** Where other settings start on a new table that picks this, in place of their defaults. */
    suggests?: Partial<TableConfig>;
  }[];
}

export type ConfigSpec = TextSpec | LinkSpec | NumberSpec | ToggleSpec | ChoiceSpec;

export type ConfigKey = keyof TableConfig;

/** The kind of spec a setting of a given type takes; a string that is one of a few fixed values is a choice. */
type SpecFor<V> = [V] extends [boolean] ? ToggleSpec : [V] extends [number] ? NumberSpec : [V] extends [string] ? (string extends V ? TextSpec | LinkSpec : ChoiceSpec<V>) : never;

/**
 * Every table setting. The defaults, the checks on what a host sends, both forms and the random tables
 * of the simulation are all read from here, so a new setting is a field of `TableConfig` and its entry
 * in this list.
 *
 * The order is the order they are checked in, which decides the complaint a host gets when several
 * things are wrong at once. The form goes by `group` first, and by this order within a group.
 */
export const CONFIG_SPECS: { [K in ConfigKey]-?: SpecFor<TableConfig[K]> } = {
  unit: {
    kind: 'choice',
    label: 'Play with',
    subject: 'What the table plays with',
    hint: "Can't be changed once the table is created",
    default: 'chips',
    options: [
      { value: 'chips', label: 'Whole chips' },
      { value: 'cents', label: 'Dollars and cents', suggests: { smallBlind: 25, bigBlind: 50, minBuyIn: 2000, maxBuyIn: 10_000 } },
    ],
    group: 'stakes',
    atCreate: 'only',
  },
  smallBlind: { kind: 'chips', label: 'Small blind', subject: 'The small blind', default: 10, min: 1, group: 'stakes', half: true, atCreate: true, nextHand: true },
  bigBlind: { kind: 'chips', label: 'Big blind', subject: 'The big blind', default: 20, min: 1, group: 'stakes', half: true, atCreate: true, nextHand: true },
  ante: {
    kind: 'chips',
    label: 'Ante',
    subject: 'The ante',
    hint: 'Goes into the pot before any betting. 0 for no ante',
    default: 0,
    min: 0,
    group: 'stakes',
    atCreate: true,
    nextHand: true,
  },
  anteFrom: {
    kind: 'choice',
    label: 'Who antes',
    subject: 'Who antes',
    default: 'everyone',
    options: [
      { value: 'everyone', label: 'Everyone dealt in' },
      { value: 'bigBlind', label: 'The big blind, once for the table' },
    ],
    group: 'stakes',
    atCreate: true,
    nextHand: true,
  },
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
  voiceLink: {
    kind: 'link',
    label: 'Voice chat link',
    subject: 'The voice chat link',
    hint: "Your group's Meet, Discord or Zoom call. Everyone at the table gets a button to join it",
    default: '',
    maxLength: LIMITS.linkLength,
    placeholder: 'https://meet.google.com/…',
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

export function fixedAtCreation(key: ConfigKey): boolean {
  return CONFIG_SPECS[key].atCreate === 'only';
}

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

function fieldsOf(input: unknown): Record<string, unknown> {
  return (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
}

/**
 * Where a new table's settings start, given the choices made for it: the defaults, with what each
 * choice suggests in their place. The create form fills itself in from this and a table created with
 * settings left out takes them from it, so the two agree.
 */
export function startingConfig(chosen?: unknown): TableConfig {
  const given = fieldsOf(chosen);
  const start: Partial<Record<ConfigKey, unknown>> = { ...DEFAULT_CONFIG };

  for (const key of CONFIG_KEYS) {
    const spec = CONFIG_SPECS[key];
    const option = spec.kind === 'choice' ? spec.options.find((o) => o.value === given[key]) : undefined;

    if (option) {
      Object.assign(start, { [key]: option.value }, option.suggests);
    }
  }

  return start as TableConfig;
}

/** One setting as its spec allows it, or a refusal that names it and writes amounts the way `table` does. */
export function validSetting(spec: ConfigSpec, value: unknown, table: Denominated): string | number | boolean {
  switch (spec.kind) {
    case 'text':
      return text(value, spec.subject, spec.maxLength);
    case 'link':
      return webAddress(value, spec.subject, spec.maxLength);
    case 'chips':
      return validAmount(value, spec.subject, table, spec.min, spec.max);
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

/**
 * Checks a change to a table's settings, filling anything left out from the current ones. What was
 * chosen for good when the table was created may only be sent as it is.
 */
export function validatedConfig(input: unknown, current: TableConfig): TableConfig {
  const given = fieldsOf(input);
  const config: Partial<Record<ConfigKey, string | number | boolean>> = {};

  for (const key of CONFIG_KEYS) {
    const spec = CONFIG_SPECS[key];

    config[key] = validSetting(spec, given[key] === undefined ? current[key] : given[key], current);

    if (fixedAtCreation(key) && config[key] !== current[key]) {
      throw new GameError(`${spec.subject} was chosen when the table was created and can't be changed`);
    }

    for (const { keys, complaint } of CONFIG_RULES) {
      const wrong = keys.includes(key) && keys.every((read) => read in config) ? complaint(config as unknown as TableConfig) : null;
      if (wrong !== null) {
        throw new GameError(wrong);
      }
    }
  }

  return config as unknown as TableConfig;
}

/**
 * Checks the settings a table is created with, filling anything left out from where its choices say
 * to start. That start already holds each choice sent, so none of them counts as a change to what was
 * chosen for good; a setting fixed at creation that is not a choice would need the same.
 */
export function newConfig(input: unknown): TableConfig {
  return validatedConfig(input, startingConfig(input));
}
