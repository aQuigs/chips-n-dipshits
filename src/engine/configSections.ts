/*
 * The sections of a table's settings: the headings both forms put them under, which settings stand
 * under each and in what order, and the one line a section is folded under.
 */
import { formatAmount } from './amounts.ts';
import { capitalized } from './handNames.ts';
import { stakesText } from './stakes.ts';
import { straddlesAllowed } from './straddles.ts';
import type { TableConfig } from './types.ts';

interface SectionSpec {
  /** Its heading. No label under it says the heading again. */
  label: string;
  /** Its settings, in the order the form shows them. */
  settings: readonly (keyof TableConfig)[];
  /** What its settings come to, in a host's words, for the line it is folded under. */
  holds(config: TableConfig): string;
}

const BOARDS: Record<TableConfig['bombPotBoards'], string> = { one: 'one board', two: 'two boards' };

/** Past this many, the folded line counts the bounty hands instead of listing them. */
const BOUNTIES_LISTED = 2;

/** Past this many, the folded line counts the kinds of straddle instead of naming them. */
const STRADDLES_NAMED = 2;

/**
 * How long the line of the house rules may get with each rule in its full words. Past it each is said in
 * fewer, so a table with everything on still folds under a line to glance at: three lines of the
 * narrowest phone hold every line this long, and the shortest that takes a fourth is a few characters longer.
 */
const HOUSE_LINE_ROOM = 100;

type Runs = Record<TableConfig['maxRuns'], string>;

const RUNS: { full: Runs; brief: Runs } = {
  full: { 1: 'run it once', 2: 'run it up to twice', 3: 'run it up to 3 times' },
  brief: { 1: 'run it once', 2: 'run it twice', 3: 'run it 3 times' },
};

function straddlesHeld(config: TableConfig, brief: boolean): string {
  const allowed = straddlesAllowed(config);

  if (allowed.length <= 1) {
    return allowed[0]?.label ?? 'No straddles';
  }

  return brief || allowed.length > STRADDLES_NAMED ? `${allowed.length} straddles` : `Straddles: ${allowed.map((kind) => kind.short).join(', ')}`;
}

function houseHeld(config: TableConfig): string {
  const said = (brief: boolean): string =>
    [
      config.actionSeconds === 0 ? 'No clock' : `${config.actionSeconds} s clock`,
      straddlesHeld(config, brief),
      RUNS[brief ? 'brief' : 'full'][config.maxRuns],
      config.allowChop && (brief ? 'chop' : 'blinds can chop'),
      `${brief ? '' : 'missed '}blinds ${config.missedBlinds}`,
      config.rabbitHunting && 'rabbit hunting',
    ]
      .filter(Boolean)
      .join(' · ');
  const full = said(false);

  return full.length <= HOUSE_LINE_ROOM ? full : said(true);
}

function sideMoneyHeld(config: TableConfig): string {
  const { bounties, highHandBonus } = config;
  const paid = bounties.length > BOUNTIES_LISTED ? [`${bounties.length} bounty hands`] : bounties.map(([hand, amount]) => `${hand} pays ${formatAmount(amount, config)}`);
  const bonus = highHandBonus > 0 ? [`high hand ${formatAmount(highHandBonus, config)}`] : [];
  const line = [...paid, ...bonus].join(' · ');

  return line === '' ? 'None' : capitalized(line);
}

/**
 * Every section, in the order the table settings show them. Every setting stands in exactly one, and
 * a new setting is added to the one it belongs under. The order within a section is the form's alone:
 * the order settings are checked in is `CONFIG_SPECS`'s.
 */
export const CONFIG_SECTIONS = {
  stakes: {
    label: 'Stakes',
    settings: ['unit', 'smallBlind', 'bigBlind', 'ante', 'anteFrom', 'minBuyIn', 'maxBuyIn'],
    holds: (config) => `${stakesText(config)} · buy-in ${formatAmount(config.minBuyIn, config)} to ${formatAmount(config.maxBuyIn, config)}`,
  },
  bombPots: {
    label: 'Bomb pots',
    settings: ['bombPotAmount', 'bombPotEvery', 'bombPotBoards'],
    holds: (config) =>
      [
        `${formatAmount(config.bombPotAmount, config)} each`,
        config.bombPotEvery === 0 ? 'only when called' : config.bombPotEvery === 1 ? 'every hand' : `every ${config.bombPotEvery} hands`,
        BOARDS[config.bombPotBoards],
      ].join(' · '),
  },
  sideMoney: {
    label: 'Bounties and high hand',
    settings: ['bounties', 'highHandBonus'],
    holds: sideMoneyHeld,
  },
  house: {
    label: 'House rules',
    // The clock leads, here and on the line: it is the one of these a host comes back to change mid-game, when someone is slow
    settings: ['actionSeconds', 'allowStraddle', 'allowDoubleStraddle', 'allowButtonStraddle', 'allowMississippiStraddle', 'maxRuns', 'allowChop', 'missedBlinds', 'rabbitHunting'],
    holds: houseHeld,
  },
  // Only what a host is asked about every table, since this is the section the form for a new table opens on
  table: {
    label: 'Table',
    settings: ['name', 'voiceLink'],
    holds: (config) => [config.name, config.voiceLink === '' ? 'no voice link' : 'voice link set'].join(' · '),
  },
} satisfies Record<string, SectionSpec>;

export type ConfigSection = keyof typeof CONFIG_SECTIONS;

export const CONFIG_SECTION_KEYS = Object.keys(CONFIG_SECTIONS) as ConfigSection[];

/** The section a setting stands in. */
export function sectionOf(key: keyof TableConfig): ConfigSection {
  return CONFIG_SECTION_KEYS.find((section) => (CONFIG_SECTIONS[section].settings as readonly string[]).includes(key))!;
}
