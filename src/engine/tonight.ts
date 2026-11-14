/*
 * The night's numbers: what each player's night comes to, counted as each hand ends, and who leads in
 * what. One table is one night, so the count runs from the table's first hand and carries on when play
 * starts again after a night has ended.
 *
 * Money is not counted here. Who is up and who is down is the ledger's to say, and the standings are
 * handed its rows, so the two can never disagree.
 */
import type { Card } from './cards.ts';
import { wonAPot } from './handFacts.ts';
import type { HandFacts } from './handFacts.ts';
import { madeHandName } from './handNames.ts';
import { evaluateHand } from './handRank.ts';
import type { PlayerTonight, TableState, Tonight } from './types.ts';
import type { LedgerRow } from './view.ts';

export function newTonight(): Tonight {
  return { hands: 0, players: {} };
}

function numbersOf(tonight: Tonight, playerId: string): PlayerTonight {
  return (tonight.players[playerId] ??= { hands: 0, won: 0, biggest: 0, best: null, rebuys: 0 });
}

const rankOfBest = (best: Card[] | null): number => (best ? evaluateHand(best).score : -1);

/**
 * Counts a finished hand into the night's numbers:
 * a hand played is one a player was dealt into, however soon they folded;
 * a pot won is a hand they took chips from the pots of (`wonAPot`), counted once however many pots or boards paid them;
 * the biggest pot is the most they took from the pots of one hand, so their share of a split pot, and both boards added up;
 * the best hand is the best one they turned up at a showdown, on either board, won or lost. The first to be shown stays when a later one ties it.
 */
export function countHand(tonight: Tonight, facts: HandFacts): void {
  tonight.hands += 1;

  for (const player of facts.players) {
    const numbers = numbersOf(tonight, player.playerId);

    numbers.hands += 1;

    if (wonAPot(player)) {
      numbers.won += 1;
      numbers.biggest = Math.max(numbers.biggest, player.tookOut);
    }

    for (const hand of player.shown) {
      if (hand.rank > rankOfBest(numbers.best)) {
        numbers.best = hand.cards;
      }
    }
  }
}

/** Counts chips bought by a member who had bought before: a rebuy, whether they were broke, topping up or sitting down again. */
export function countRebuy(tonight: Tonight, playerId: string): void {
  numbersOf(tonight, playerId).rebuys += 1;
}

/** One player's night, as everyone at the table may see it. */
export interface TonightRow {
  playerId: string;
  name: string;
  /** Has a seat now. False for someone who played and left. */
  seated: boolean;
  /** Chips won or lost, as the ledger has it. */
  net: number;
  hands: number;
  won: number;
  biggest: number;
  best: { name: string; cards: Card[] } | null;
  rebuys: number;
}

/** What settled who the dipshit is: the worst net by itself, or a tie on it broken by rebuys, or one on both broken by pots won. */
export type CrownedBy = 'net' | 'rebuys' | 'pots';

export interface TonightView {
  /** Finished hands the numbers count. */
  hands: number;
  /** Finished hands they leave out, dealt before the table kept count: 0 unless the table is older than the count. */
  missed: number;
  /** Everyone who has had chips at the table, the best night first and the worst last. */
  players: TonightRow[];
  /** Who leads in each thing, as member ids: several when they are level, none when nobody has any of it. */
  upMost: string[];
  mostPots: string[];
  biggestPot: string[];
  bestHand: string[];
  /**
   * The dipshit of the night, crowned only once the night is over: whoever is down the most, of those
   * level on that whoever rebought the most, and of those still level whoever won the fewest pots.
   * Players level on all three share it. Nobody when nobody is down.
   */
  dipshits: string[];
  crownedBy: CrownedBy;
}

/** The rows that have the most of something, among those that have any of it. */
function leaders(rows: readonly TonightRow[], amount: (row: TonightRow) => number): TonightRow[] {
  const most = Math.max(0, ...rows.map(amount));

  return most > 0 ? rows.filter((row) => amount(row) === most) : [];
}

const ids = (rows: readonly TonightRow[]): string[] => rows.map((row) => row.playerId);

/** Worse nights sort later: less won, then more rebuys, then fewer pots. The name only keeps the order of those level on all three from changing between views. */
function byStanding(a: TonightRow, b: TonightRow): number {
  return b.net - a.net || a.rebuys - b.rebuys || b.won - a.won || (a.name < b.name ? -1 : 1);
}

function crown(rows: readonly TonightRow[]): Pick<TonightView, 'dipshits' | 'crownedBy'> {
  const down = leaders(rows, (row) => -row.net);
  const rebought = down.filter((row) => row.rebuys === Math.max(...down.map((other) => other.rebuys)));
  const dipshits = rebought.filter((row) => row.won === Math.min(...rebought.map((other) => other.won)));

  let crownedBy: CrownedBy = 'net';
  if (dipshits.length < rebought.length) {
    crownedBy = 'pots';
  } else if (rebought.length < down.length) {
    crownedBy = 'rebuys';
  }

  return { dipshits: ids(dipshits), crownedBy };
}

/**
 * The night as it stands, for everyone to see: every number in it is something the whole table
 * watched happen. `ledger` is the table's ledger rows, which say who has had chips here and what
 * each is up or down. `over` says the night has ended, which is when the dipshit is crowned.
 */
export function tonightView(state: TableState, ledger: readonly LedgerRow[], over: boolean): TonightView {
  const { tonight } = state;
  const finished = state.handCount - (state.hand ? 1 : 0);

  const players = ledger
    .map((row): TonightRow => {
      const { hands = 0, won = 0, biggest = 0, best = null, rebuys = 0 } = tonight.players[row.playerId] ?? {};

      return {
        playerId: row.playerId,
        name: row.name,
        seated: state.seats.some((seat) => seat?.playerId === row.playerId),
        net: row.net,
        hands,
        won,
        biggest,
        best: best && { name: madeHandName(evaluateHand(best)), cards: best },
        rebuys,
      };
    })
    .sort(byStanding);

  return {
    hands: tonight.hands,
    missed: finished - tonight.hands,
    players,
    upMost: ids(leaders(players, (row) => row.net)),
    mostPots: ids(leaders(players, (row) => row.won)),
    biggestPot: ids(leaders(players, (row) => row.biggest)),
    bestHand: ids(leaders(players, (row) => rankOfBest(row.best?.cards ?? null) + 1)),
    ...(over ? crown(players) : { dipshits: [], crownedBy: 'net' }),
  };
}
