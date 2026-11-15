/*
 * What a table came to for the players the game knows from one night to the next: a line for each of
 * them, made from the night's numbers as the Tonight page shows them and from nothing else, so that
 * what is kept over time can never disagree with what the table saw. Nothing here counts a hand or a chip.
 */
import type { Card } from './cards.ts';
import { evaluateHand } from './handRank.ts';
import { nightIsOver } from './night.ts';
import { tonightView } from './tonight.ts';
import type { TonightRow } from './tonight.ts';
import type { TableState, Unit } from './types.ts';
import { ledgerOf } from './view.ts';

/** One known player's night at one table. The amounts are in the table's smallest unit. */
export interface PlayerResult {
  /** The known player (`Member.identity`), never a member's id. */
  playerId: string;
  /** What they were called at the table: the name of the first of their members to join. */
  name: string;
  /** What they are up or down, as the ledger has it: chips still in front of them count as theirs. */
  net: number;
  hands: number;
  /** Hands they took chips from the pots of. */
  won: number;
  /** The most they took from the pots of one hand. */
  biggest: number;
  /** The five cards of the best hand they turned up at a showdown, or null when they showed none. */
  best: Card[] | null;
  /** The badges they earned, by id, and how many times each. */
  badges: Record<string, number>;
  /** The best hand shown down at the table was theirs, alone or shared. */
  highHand: boolean;
}

/** A table's results as one save of it has them. With no players, nothing of the table is to be kept. */
export interface TableResults {
  tableId: string;
  tableName: string;
  unit: Unit;
  /** When the table was made, which is the night's date. */
  createdAt: number;
  /** The save of the table these were made from, which tells a later set from an earlier one. */
  version: number;
  players: PlayerResult[];
}

const rankOf = (cards: readonly Card[] | null): number => (cards ? evaluateHand(cards).score : -1);

function resultOf(playerId: string, row: TonightRow, highHand: boolean): PlayerResult {
  return {
    playerId,
    name: row.name,
    net: row.net,
    hands: row.hands,
    won: row.won,
    biggest: row.biggest,
    best: row.best?.cards ?? null,
    badges: Object.fromEntries(row.badges.map((badge) => [badge.id, badge.times])),
    highHand,
  };
}

/** What of a night adds up: over two members of one table who are one player, and over a player's nights. */
export type Summed = Pick<PlayerResult, 'net' | 'hands' | 'won' | 'biggest' | 'best' | 'badges'>;

/**
 * Two of them as one: money, hands and pots add up, as do the badges; the biggest pot is the bigger
 * of the two, and the best hand the better, the first one's when they are as good.
 */
export function addedUp(first: Summed, more: Summed): Summed {
  const badges = { ...first.badges };

  for (const [id, times] of Object.entries(more.badges)) {
    badges[id] = (badges[id] ?? 0) + times;
  }

  return {
    net: first.net + more.net,
    hands: first.hands + more.hands,
    won: first.won + more.won,
    biggest: Math.max(first.biggest, more.biggest),
    best: rankOf(more.best) > rankOf(first.best) ? more.best : first.best,
    badges,
  };
}

/** Adds another member's night to a known player's, for one who sat at the table as two ("Bob" and "Bob 2"), under the first one's name. */
function combined(result: PlayerResult, more: PlayerResult): PlayerResult {
  return { ...result, ...addedUp(result, more), highHand: result.highHand || more.highHand };
}

/**
 * The results of a table as it stands, one for each known player who has had chips at it. A member
 * nobody knows gets none, and counts in nobody's. A table at which only one person ever had chips is
 * nobody's night, however many times they sat down: it takes two to play, and it keeps a table made
 * to try the game out of everyone's record.
 */
export function resultsOf(state: TableState): TableResults {
  const tonight = tonightView(state, ledgerOf(state), nightIsOver(state));
  const rowOf = new Map(tonight.players.map((row) => [row.playerId, row]));
  const holders = new Set(tonight.highHand.best?.playerIds);
  const byPlayer = new Map<string, PlayerResult>();
  let unknown = 0;

  // In the order they joined, so that a player who sat down twice goes by the first name they had
  for (const member of state.members) {
    const row = rowOf.get(member.id);
    if (!row) {
      continue;
    }

    if (member.identity === null) {
      unknown += 1;
      continue;
    }

    const result = resultOf(member.identity, row, holders.has(member.id));
    const had = byPlayer.get(member.identity);

    byPlayer.set(member.identity, had ? combined(had, result) : result);
  }

  return {
    tableId: state.id,
    tableName: state.config.name,
    unit: state.config.unit,
    createdAt: state.createdAt,
    version: state.version,
    players: byPlayer.size + unknown >= 2 ? [...byPlayer.values()] : [],
  };
}
