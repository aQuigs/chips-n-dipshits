/*
 * The standings in words and in order: how the players are sorted, and what is said of a record and of
 * a night. The page that shows them (`render/standings.ts`) draws what these say.
 */
import { formatAmount } from '../engine/amounts.ts';
import type { Unit } from '../engine/types.ts';
import type { PlayerStanding, UnitStandings } from '../server/api.ts';
import type { PlayedNight } from '../server/resultStore.ts';

export type SortId = 'net' | 'nights' | 'rate' | 'biggest';

/** What the players can be put in order of, the first being how the page opens. Always the most first. */
export const SORTS: readonly { id: SortId; label: string }[] = [
  { id: 'net', label: 'Up or down' },
  { id: 'nights', label: 'Nights played' },
  { id: 'rate', label: 'Hands won' },
  { id: 'biggest', label: 'Biggest pot' },
];

/** What a kind of money is called where the viewer picks between them. */
export const MONEY: Record<Unit, string> = { chips: 'Chips', cents: 'Dollars' };

const counted = (count: number, one: string, many = `${one}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** The share of the hands a player was dealt that they took chips from a pot of, from 0 to 1; null before their first hand. */
export function handsWon(of: { won: number; hands: number }): number | null {
  return of.hands > 0 ? of.won / of.hands : null;
}

const percent = (share: number): string => `${Math.round(share * 100)}%`;

const KEYS: Record<SortId, (player: PlayerStanding) => number> = {
  net: (player) => player.net,
  nights: (player) => player.nights,
  // Someone who has not been dealt a hand has won none of them, and stands below everyone who has
  rate: (player) => handsWon(player) ?? -1,
  biggest: (player) => player.biggest,
};

/** The players in order: the most of what they are sorted by first, those level on it by who is up the most, and then by name. */
export function ranked(players: readonly PlayerStanding[], sort: SortId): PlayerStanding[] {
  const key = KEYS[sort];

  return [...players].sort((a, b) => key(b) - key(a) || b.net - a.net || a.name.localeCompare(b.name, 'en') || (a.id < b.id ? -1 : 1));
}

/** The line under a player's name: how many nights, how many of them up, and how many of their hands they won. */
export function summaryOf(player: PlayerStanding): string {
  const share = handsWon(player);

  return [counted(player.nights, 'night'), `up in ${player.nightsUp}`, ...(share === null ? [] : [`won ${percent(share)} of hands`])].join(' · ');
}

/** Pots won, said in full: how many of how many hands, and the share that is. */
export function potsWonText(of: { won: number; hands: number }): string {
  const share = handsWon(of);

  return share === null ? 'No hands yet' : `${of.won.toLocaleString('en-US')} of ${counted(of.hands, 'hand')} (${percent(share)})`;
}

/** The line under a night: what the player did in it. */
export function nightSummary(night: PlayedNight, unit: Unit): string {
  return [counted(night.hands, 'hand'), counted(night.won, 'pot'), ...(night.won > 0 ? [`biggest ${formatAmount(night.biggest, { unit })}`] : [])].join(' · ');
}

/** The day a night was, as the viewer's own device writes dates. */
export function nightDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** When the standings were read, as the viewer's own device writes the time of day. */
export function asOfText(asOf: number): string {
  return `As of ${new Date(asOf).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`;
}

/** Which kind of money the page opens on: the one the viewer has a record in, the one with more players when they have both or neither, chips when level. */
export function firstUnit(units: readonly UnitStandings[], you: string | null): Unit | null {
  const mine = units.filter((of) => of.players.some((player) => player.id === you));
  const [first] = [...(mine.length > 0 ? mine : units)].sort((a, b) => b.players.length - a.players.length);

  return first?.unit ?? null;
}
