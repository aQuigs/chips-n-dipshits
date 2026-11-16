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

const RUNS: Record<TableConfig['maxRuns'], string> = { 1: 'run it once', 2: 'run it up to twice', 3: 'run it up to 3 times' };
const BOARDS: Record<TableConfig['bombPotBoards'], string> = { one: 'one board', two: 'two boards' };
const MISSED_BLINDS: Record<TableConfig['missedBlinds'], string> = { owed: 'missed blinds owed', forgiven: 'missed blinds forgiven' };

/** Past this many, the folded line counts the bounty hands instead of listing them. */
const BOUNTIES_LISTED = 2;

function straddlesHeld(config: TableConfig): string {
  const allowed = straddlesAllowed(config);

  if (allowed.length === 1) {
    return allowed[0]!.label;
  }

  return allowed.length === 0 ? 'No straddles' : `Straddles: ${allowed.map((kind) => kind.short).join(', ')}`;
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
    settings: ['allowStraddle', 'allowDoubleStraddle', 'allowButtonStraddle', 'allowMississippiStraddle', 'maxRuns', 'allowChop', 'missedBlinds', 'rabbitHunting'],
    holds: (config) =>
      [straddlesHeld(config), RUNS[config.maxRuns], config.allowChop && 'blinds can chop', MISSED_BLINDS[config.missedBlinds], config.rabbitHunting && 'rabbit hunting'].filter(Boolean).join(' · '),
  },
  table: {
    label: 'Table',
    settings: ['name', 'voiceLink', 'actionSeconds'],
    holds: (config) => [config.name, config.actionSeconds === 0 ? 'no clock' : `${config.actionSeconds} s clock`, config.voiceLink === '' ? 'no voice link' : 'voice link set'].join(' · '),
  },
} satisfies Record<string, SectionSpec>;

export type ConfigSection = keyof typeof CONFIG_SECTIONS;

export const CONFIG_SECTION_KEYS = Object.keys(CONFIG_SECTIONS) as ConfigSection[];

/** The section a setting stands in. */
export function sectionOf(key: keyof TableConfig): ConfigSection {
  return CONFIG_SECTION_KEYS.find((section) => (CONFIG_SECTIONS[section].settings as readonly string[]).includes(key))!;
}
