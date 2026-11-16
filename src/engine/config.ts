import { formatAmount, validAmount } from './amounts.ts';
import type { Denominated } from './amounts.ts';
import { bountiesText, handListedTwice, SEVEN_DEUCE, validBounties } from './bounties.ts';
import type { Bounty, BountyLimits } from './bounties.ts';
import { capitalized } from './handNames.ts';
import { STRADDLES } from './straddles.ts';
import type { StraddleKind } from './straddles.ts';
import { GameError } from './types.ts';
import type { TableConfig } from './types.ts';
import { LIMITS, text, webAddress, wholeNumber, yesOrNo } from './validate.ts';

interface SpecBase {
  /** What the form calls it, under the heading of its section (`configSections.ts`), which it never says again. */
  label: string;
  /** How a refusal names it, and anything else that names it away from the form: "The small blind must be a whole number…". */
  subject: string;
  /** A line under the field. */
  hint?: string;
  /** A heading it shares with its neighbors in the form that have the same, over the lot of them. */
  among?: string;
  /** Narrow enough to share a row with the next such field. */
  half?: boolean;
  /** Left out, always. A setting that means nothing as the others stand is kept off the form until it does. */
  applies?(config: TableConfig): boolean;
  /**
   * For what can't change once there is a table: it is chosen when the table is created, told in words
   * in the table settings from then on, and a change to it is refused.
   */
  atCreate?: 'only';
  /** A change leaves the hand in play as it is, which finishes on the value it was dealt under. */
  nextHand?: boolean;
  /** Belongs to one table, so a preset doesn't keep it. Presets can be read by anyone with the game's address. */
  inPresets?: false;
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

export interface ToggleSpec extends SpecBase {
  kind: 'toggle';
  default: boolean;
}

/** One of a few values, which are words or, for a setting that is a count, numbers. */
export interface ChoiceSpec<V extends string | number = string | number> extends SpecBase {
  kind: 'choice';
  default: V;
  options: {
    value: V;
    label: string;
    /** How the table settings say it was picked, for a choice made for good when the table was created. */
    chosen?: string;
    /** Where other settings start on a new table that picks this, in place of their defaults. */
    suggests?: Partial<TableConfig>;
  }[];
}

/** A list of starting hands, each with an amount, as the table's bounties are; empty for none. Its amounts obey what a `chips` setting's do. */
export interface HandAmountsSpec extends SpecBase, BountyLimits {
  kind: 'handAmounts';
  default: Bounty[];
}

export type ConfigSpec = TextSpec | LinkSpec | NumberSpec | ToggleSpec | ChoiceSpec | HandAmountsSpec;

/** What a setting can hold. */
export type SettingValue = TableConfig[keyof TableConfig];

export type ConfigKey = keyof TableConfig;

/** The switch that allows one kind of straddle, worded by the kind's entry in `STRADDLES`. */
function straddleSwitch(setting: StraddleKind['setting']): ToggleSpec {
  const kind = STRADDLES.find((entry) => entry.setting === setting)!;

  return { kind: 'toggle', label: capitalized(kind.short), subject: kind.subject, among: 'Straddles allowed', half: true, default: kind.byDefault, nextHand: true };
}

/** The kind of spec a setting of a given type takes; a string or a number that is one of a few fixed values is a choice. */
type SpecFor<V> = [V] extends [Bounty[]]
  ? HandAmountsSpec
  : [V] extends [boolean]
  ? ToggleSpec
  : [V] extends [number]
    ? number extends V
      ? NumberSpec
      : ChoiceSpec<V>
    : [V] extends [string]
      ? string extends V
        ? TextSpec | LinkSpec
        : ChoiceSpec<V>
      : never;

/**
 * Every table setting. The defaults, the checks on what a host sends, both forms and the random tables
 * of the simulation are all read from here, so a new setting is a field of `TableConfig` and its entry
 * in this list.
 *
 * The order is the order they are checked in, which decides the complaint a host gets when several
 * things are wrong at once. Where each stands in the form is its section's to say (`CONFIG_SECTIONS`).
 */
export const CONFIG_SPECS: { [K in ConfigKey]-?: SpecFor<TableConfig[K]> } = {
  unit: {
    kind: 'choice',
    label: 'Play with',
    subject: 'What the table plays with',
    hint: "Can't be changed once the table is created",
    default: 'chips',
    options: [
      { value: 'chips', label: 'Whole chips', chosen: 'This table plays whole chips' },
      { value: 'cents', label: 'Dollars and cents', chosen: 'This table plays dollars and cents', suggests: { smallBlind: 25, bigBlind: 50, minBuyIn: 2000, maxBuyIn: 10_000, bombPotAmount: 250 } },
    ],
    atCreate: 'only',
  },
  smallBlind: { kind: 'chips', label: 'Small blind', subject: 'The small blind', default: 10, min: 1, half: true, nextHand: true },
  bigBlind: { kind: 'chips', label: 'Big blind', subject: 'The big blind', default: 20, min: 1, half: true, nextHand: true },
  ante: {
    kind: 'chips',
    label: 'Ante',
    subject: 'The ante',
    hint: 'Goes into the pot before any betting. 0 for no ante',
    default: 0,
    min: 0,
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
    applies: (config) => config.ante > 0,
    nextHand: true,
  },
  minBuyIn: { kind: 'chips', label: 'Minimum buy-in', subject: 'The minimum buy-in', default: 400, min: 1, half: true },
  maxBuyIn: { kind: 'chips', label: 'Maximum buy-in', subject: 'The maximum buy-in', default: 2000, min: 1, half: true },
  actionSeconds: {
    kind: 'seconds',
    label: 'Seconds to act',
    subject: 'The action clock',
    hint: '0 turns the clock off',
    default: 30,
    min: 0,
    max: LIMITS.maxActionSeconds,
  },
  name: {
    kind: 'text',
    label: 'Name',
    subject: 'The table name',
    default: "Chips n' Dipshits",
    maxLength: LIMITS.tableNameLength,
  },
  voiceLink: {
    kind: 'link',
    label: 'Voice chat link',
    subject: 'The voice chat link',
    hint: "Your group's Meet, Discord or Zoom call. Everyone at the table gets a button to join it",
    default: '',
    maxLength: LIMITS.linkLength,
    placeholder: 'https://meet.google.com/…',
    inPresets: false,
  },
  allowStraddle: straddleSwitch('allowStraddle'),
  allowDoubleStraddle: straddleSwitch('allowDoubleStraddle'),
  allowButtonStraddle: straddleSwitch('allowButtonStraddle'),
  allowMississippiStraddle: straddleSwitch('allowMississippiStraddle'),
  maxRuns: {
    kind: 'choice',
    label: 'Run it more than once',
    subject: 'Running it more than once',
    hint: 'When everyone is all in, each player still in picks how many times, and the fewest picked wins',
    default: 3,
    options: [
      { value: 1, label: 'Never' },
      { value: 2, label: 'Up to twice' },
      { value: 3, label: 'Up to three times' },
    ],
    nextHand: true,
  },
  allowChop: {
    kind: 'toggle',
    label: 'Chopping the blinds',
    subject: 'Chopping the blinds',
    hint: 'When it folds to the blinds, they can agree to take their blinds back',
    default: false,
  },
  missedBlinds: {
    kind: 'choice',
    label: 'Missed blinds',
    subject: 'Missed blinds',
    hint: 'Owed: a player the blinds pass while sitting out posts them to come back, or waits for the big blind',
    default: 'owed',
    options: [
      { value: 'owed', label: 'Owed' },
      { value: 'forgiven', label: 'Forgiven' },
    ],
    nextHand: true,
  },
  bounties: {
    kind: 'handAmounts',
    label: 'Bounty hands',
    subject: 'The bounties',
    hint: 'Whoever wins with one collects its amount from everyone else dealt in. Write a hand as 72, 72s for suited only, 72o for offsuit only, or AA',
    default: [],
    min: 1,
    most: LIMITS.bounties,
    nextHand: true,
  },
  highHandBonus: {
    kind: 'chips',
    label: 'High-hand bonus',
    subject: 'The high-hand bonus',
    hint: 'Paid by everyone else seated to whoever shows the best hand of the night, when the night ends. 0 for the honor alone',
    default: 0,
    min: 0,
  },
  bombPotAmount: {
    kind: 'chips',
    label: 'Each player puts in',
    subject: 'The bomb pot',
    hint: 'No blinds, and the hand starts on the flop',
    default: 100,
    min: 1,
    nextHand: true,
  },
  bombPotEvery: {
    kind: 'count',
    label: 'Automatically every … hands',
    subject: 'The number of hands per bomb pot',
    hint: '0 for only when the host calls one from the menu',
    default: 0,
    min: 0,
    max: LIMITS.handsPerBombPot,
    nextHand: true,
  },
  bombPotBoards: {
    kind: 'choice',
    label: 'Boards',
    subject: 'The boards of a bomb pot',
    hint: 'With two, each board wins half of every pot',
    default: 'one',
    options: [
      { value: 'one', label: 'One board' },
      { value: 'two', label: 'Two boards' },
    ],
    nextHand: true,
  },
  rabbitHunting: {
    kind: 'toggle',
    label: 'Rabbit hunting',
    subject: 'Rabbit hunting',
    hint: 'After a hand ends early, a player can see the cards that would have come',
    default: false,
  },
};

export const CONFIG_KEYS = Object.keys(CONFIG_SPECS) as ConfigKey[];

export function fixedAtCreation(key: ConfigKey): boolean {
  return CONFIG_SPECS[key].atCreate === 'only';
}

/** A setting as a sentence names it away from the form, where its label would lean on a heading that is not there: "the small blind". */
export function settingName(key: ConfigKey): string {
  const { subject } = CONFIG_SPECS[key];

  return subject[0]!.toLowerCase() + subject.slice(1);
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
  rule(['bounties'], (config) => handListedTwice(config.bounties)),
  rule(['actionSeconds'], (config) =>
    config.actionSeconds !== 0 && config.actionSeconds < LIMITS.minActionSeconds ? `The action clock must be off or at least ${LIMITS.minActionSeconds} seconds` : null,
  ),
];

/**
 * Settings a table or a preset may have been saved with under a name since retired, and the settings
 * each old value comes to now. A saved table is brought forward by its schema step and a saved preset,
 * which has no schema, as it is read; both through `withRetiredSettings`.
 */
const RETIRED_SETTINGS: Record<string, (old: unknown) => Partial<TableConfig>> = {
  // A switch until three runs were allowed, and on meant up to twice
  allowRunItTwice: (on) => ({ maxRuns: on === false ? 1 : 2 }),
  // One amount for seven-deuce until the bounties were a list, and 0 meant none
  sevenDeuceBounty: (amount) => ({ bounties: amount === 0 ? [] : [[SEVEN_DEUCE, amount as number]] }),
};

/** Saved settings with any under a retired name put as the settings that took their place, unless those were saved too. */
export function withRetiredSettings(saved: Record<string, unknown>): Record<string, unknown> {
  const settings = { ...saved };

  for (const [name, now] of Object.entries(RETIRED_SETTINGS)) {
    if (name in settings) {
      Object.assign(settings, { ...now(settings[name]), ...settings });
      delete settings[name];
    }
  }

  return settings;
}

export const DEFAULT_CONFIG = Object.fromEntries(CONFIG_KEYS.map((key) => [key, CONFIG_SPECS[key].default])) as unknown as TableConfig;

/** The fields of whatever was sent as settings, none when it is no object. */
export function fieldsOf(input: unknown): Record<string, unknown> {
  return (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
}

/**
 * Where a new table's settings start, given the choices made for it: the defaults, with what each
 * choice suggests in their place. The create form fills itself in from this and a table created with
 * settings left out takes them from it, so the two agree.
 */
export function startingConfig(chosen?: unknown): TableConfig {
  const given = fieldsOf(chosen);
  // Each list a copy, so no two tables are handed the same one
  const start: Partial<Record<ConfigKey, unknown>> = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));

  for (const key of CONFIG_KEYS) {
    const spec = CONFIG_SPECS[key];
    const option = spec.kind === 'choice' ? spec.options.find((o) => o.value === given[key]) : undefined;

    if (option) {
      Object.assign(start, { [key]: option.value }, option.suggests);
    }
  }

  return start as TableConfig;
}

/** Whether two values of a setting are the same, a list being the same when everything on it is. */
export function sameSetting(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  return a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b));
}

/** Whether a setting holds amounts, which mean something else once what the table plays with changes. */
export function holdsAmounts(key: ConfigKey): boolean {
  const kind = CONFIG_SPECS[key].kind;

  return kind === 'chips' || kind === 'handAmounts';
}

/** A setting's value as a player reads it: "0.25", "on", "Dollars and cents". */
export function settingText(key: ConfigKey, config: TableConfig): string {
  const spec = CONFIG_SPECS[key];
  const value = config[key];

  switch (spec.kind) {
    case 'chips':
      return formatAmount(value as number, config);
    case 'toggle':
      return value ? 'on' : 'off';
    case 'choice':
      return spec.options.find((option) => option.value === value)?.label ?? String(value);
    case 'handAmounts':
      return bountiesText(value as Bounty[], config);
    default:
      return String(value);
  }
}

/** One setting as its spec allows it, or a refusal that names it and writes amounts the way `table` does. */
export function validSetting(spec: ConfigSpec, value: unknown, table: Denominated): SettingValue {
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
    case 'handAmounts':
      return validBounties(value, table, spec);
  }
}

/**
 * Checks a change to a table's settings, filling anything left out from the current ones. What was
 * chosen for good when the table was created may only be sent as it is.
 */
export function validatedConfig(input: unknown, current: TableConfig): TableConfig {
  const given = fieldsOf(input);
  const config: Partial<Record<ConfigKey, SettingValue>> = {};

  for (const key of CONFIG_KEYS) {
    const spec = CONFIG_SPECS[key];

    config[key] = validSetting(spec, given[key] === undefined ? current[key] : given[key], current);

    if (fixedAtCreation(key) && !sameSetting(config[key], current[key])) {
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
