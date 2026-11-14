/*
 * The night's numbers in words: who gets the crown and why, who leads in what, and the whole night as
 * text to paste somewhere. The Tonight dialog and the pasted text say the same things, so they are
 * worded once, here.
 */
import { formatAmount, signedAmount } from '../engine/amounts.ts';
import { badgeOf } from '../engine/badges.ts';
import type { EarnedBadge } from '../engine/badges.ts';
import { prettyCards } from '../engine/cards.ts';
import { listed } from '../engine/handNames.ts';
import type { Card } from '../engine/cards.ts';
import type { TonightRow } from '../engine/tonight.ts';
import type { TableView } from '../engine/view.ts';
import { nightOver } from './render/night.ts';

// More names than this in one line tell nobody anything, and ten of the longest would fill a phone
const MOST_NAMES = 3;

const counted = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const rowsOf = (view: TableView, ids: string[]): TonightRow[] => view.tonight.players.filter((row) => ids.includes(row.playerId));

/** The crowning, said: who, and what settled it. */
export interface Crown {
  title: string;
  /** Empty on a night with no dipshit. */
  names: string;
  line: string;
}

/** Who the dipshit of the night is, or null while the night is still going: nobody is crowned before it ends. */
export function crownOf(view: TableView): Crown | null {
  if (!nightOver(view)) {
    return null;
  }

  const crowned = rowsOf(view, view.tonight.dipshits);
  if (crowned.length === 0) {
    return { title: 'No dipshit tonight', names: '', line: 'Nobody finished down.' };
  }

  const down = formatAmount(-crowned[0]!.net, view.config);
  const names = listed(crowned.map((row) => row.name));

  if (crowned.length > 1) {
    return { title: 'Dipshits of the night', names, line: `Each down ${down}, with the same rebuys and the same pots won.` };
  }

  const lines = {
    net: `Down ${down}, more than anyone.`,
    rebuys: `Down ${down}, tied for the worst night, and bought back in the most.`,
    pots: `Down ${down}, tied for the worst night and on rebuys, and won the fewest pots.`,
  };

  return { title: 'Dipshit of the night', names, line: lines[view.tonight.crownedBy] };
}

/** Who leads in one thing. */
export interface Leader {
  label: string;
  who: string;
  what: string;
  /** The cards of the best hand, when one player alone has it. */
  cards: Card[] | null;
}

/** Who leads in what, leaving out whatever nobody has any of yet. */
export function leadersOf(view: TableView): Leader[] {
  const { tonight, config } = view;

  const leader = (label: string, ids: string[], what: (row: TonightRow) => string, cards: (row: TonightRow) => Card[] | null = () => null): Leader[] => {
    const rows = rowsOf(view, ids);
    if (rows.length === 0) {
      return [];
    }

    const alone = rows.length === 1;
    const who = rows.length > MOST_NAMES ? `${rows.length} players` : listed(rows.map((row) => row.name));

    return [{ label, who, what: alone ? what(rows[0]!) : `${what(rows[0]!)} each`, cards: alone ? cards(rows[0]!) : null }];
  };

  return [
    ...leader('Up the most', tonight.upMost, (row) => signedAmount(row.net, config)),
    ...leader('Most pots won', tonight.mostPots, (row) => String(row.won)),
    ...leader('Biggest pot', tonight.biggestPot, (row) => formatAmount(row.biggest, config)),
    ...leader('Best hand', tonight.bestHand, (row) => row.best!.name, (row) => row.best!.cards),
  ];
}

/** How many times a badge was earned, after its name: nothing for once. */
export const timesText = (times: number): string => (times > 1 ? ` ×${times}` : '');

/** A badge in words, as "💀 Felted ×2". */
export function badgeText(earned: EarnedBadge): string {
  const badge = badgeOf(earned.id)!;

  return `${badge.mark} ${badge.name}${timesText(earned.times)}`;
}

/** What a player did tonight besides win or lose money, in a line. */
export function countsOf(row: TonightRow): string {
  return [counted(row.hands, 'hand'), `${counted(row.won, 'pot')} won`, row.rebuys > 0 ? counted(row.rebuys, 'rebuy') : null].filter(Boolean).join(' · ');
}

/** Where the night stands, for the top of the dialog. */
export function standingOf(view: TableView): string {
  const hands = counted(view.tonight.hands, 'hand');

  return nightOver(view) ? `The night is over, after ${hands}.` : `So far tonight, after ${hands}. The dipshit of the night is crowned when the night ends.`;
}

/** Said on a table that was going before these numbers were kept, or null on one that has counted from its first hand. */
export function missedOf(view: TableView): string | null {
  const { missed } = view.tonight;

  return missed > 0 ? `These numbers start partway through the night: ${counted(missed, 'hand')} ${missed === 1 ? 'was' : 'were'} played before the count began. The money is all there.` : null;
}

/** The night as plain text, to paste in the group chat. */
export function tonightText(view: TableView): string {
  const crown = crownOf(view);
  const hands = counted(view.tonight.hands, 'hand');

  const top = [
    `${view.config.name}: ${crown ? 'the night is over' : 'the night so far'}, ${hands}`,
    crown ? `${crown.title}${crown.names ? `: ${crown.names}` : ''}. ${crown.line}` : null,
    ...leadersOf(view).map((leader) => `${leader.label}: ${leader.who}, ${leader.what}${leader.cards ? ` (${prettyCards(leader.cards)})` : ''}`),
  ];

  const players = view.tonight.players.map((row) => [`${row.name}${row.seated ? '' : ' (left)'} ${signedAmount(row.net, view.config)} · ${countsOf(row)}`, ...row.badges.map(badgeText)].join(' · '));

  return [top.filter(Boolean).join('\n'), players.join('\n'), missedOf(view)].filter(Boolean).join('\n\n');
}
