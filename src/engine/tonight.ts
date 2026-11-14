/*
 * The night's numbers: what each player's night comes to, counted as each hand ends, and who leads in
 * what. One table is one night, so the count runs from the table's first hand and carries on when play
 * starts again after a night has ended.
 *
 * Money is not counted here. Who is up and who is down is the ledger's to say, and the standings are
 * handed its rows, so the two can never disagree.
 */
import { badgesIn } from './badges.ts';
import type { EarnedBadge } from './badges.ts';
import type { Card } from './cards.ts';
import { somebodyWon, wonAPot, wonTheHand } from './handFacts.ts';
import type { HandFacts } from './handFacts.ts';
import { madeHandName } from './handNames.ts';
import { highHandsView, newHighHands } from './highHand.ts';
import type { HighHandsView } from './highHand.ts';
import { evaluateHand } from './handRank.ts';
import type { PlayerTonight, TableState, Tonight } from './types.ts';
import type { LedgerRow } from './view.ts';

export function newTonight(): Tonight {
  return { hands: 0, players: {}, highHand: newHighHands() };
}

function newPlayerTonight(): PlayerTonight {
  return { hands: 0, won: 0, biggest: 0, best: null, rebuys: 0, busts: 0, streak: 0, badges: {} };
}

function numbersOf(tonight: Tonight, playerId: string): PlayerTonight {
  return (tonight.players[playerId] ??= newPlayerTonight());
}

/** A player's numbers without their badges, which are earned from the numbers and never read by what earns them. */
export type Counts = Omit<PlayerTonight, 'badges'>;

/** What a hand did to a player's numbers. */
export interface Counted {
  before: Counts;
  after: Counts;
}

function withoutBadges({ badges: _badges, ...counts }: PlayerTonight): Counts {
  return counts;
}

const rankOfBest = (best: Card[] | null): number => (best ? evaluateHand(best).score : -1);

/**
 * Counts a finished hand into the night's numbers:
 * a hand played is one a player was dealt into, however soon they folded;
 * a pot won is a hand they took chips from the pots of (`wonAPot`), counted once however many pots or boards paid them;
 * the biggest pot is the most they took from the pots of one hand, so their share of a split pot, and both boards added up;
 * the best hand is the best one they turned up at a showdown, on either board, won or lost. The first to be shown stays when a later one ties it;
 * a bust is a hand that left them with no chips;
 * the streak is the hands they won in a row (`wonTheHand`), of every hand somebody won: losing one, folding or sitting it out ends it, and a hand nobody won leaves it as it was.
 * Gives back what the hand did to the numbers of each player in it, by member id.
 */
export function countHand(tonight: Tonight, facts: HandFacts): Map<string, Counted> {
  const counted = new Map<string, Counted>();
  const won = somebodyWon(facts);

  tonight.hands += 1;

  if (won) {
    const dealt = new Set(facts.players.map((player) => player.playerId));

    for (const [playerId, numbers] of Object.entries(tonight.players)) {
      numbers.streak = dealt.has(playerId) ? numbers.streak : 0;
    }
  }

  for (const player of facts.players) {
    const numbers = numbersOf(tonight, player.playerId);
    const before = withoutBadges(numbers);

    numbers.hands += 1;
    numbers.busts += player.busted ? 1 : 0;

    if (won) {
      numbers.streak = wonTheHand(player) ? numbers.streak + 1 : 0;
    }

    if (wonAPot(player)) {
      numbers.won += 1;
      numbers.biggest = Math.max(numbers.biggest, player.tookOut);
    }

    for (const hand of player.shown) {
      if (hand.rank > rankOfBest(numbers.best)) {
        numbers.best = hand.cards;
      }
    }

    counted.set(player.playerId, { before, after: withoutBadges(numbers) });
  }

  return counted;
}

/** Counts a badge a player earned, and gives back how many times they have earned it tonight. */
export function countBadge(tonight: Tonight, playerId: string, badge: string): number {
  const { badges } = numbersOf(tonight, playerId);

  return (badges[badge] = (badges[badge] ?? 0) + 1);
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
  badges: EarnedBadge[];
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
  highHand: HighHandsView;
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
  const mostRebuys = Math.max(...down.map((row) => row.rebuys));
  const rebought = down.filter((row) => row.rebuys === mostRebuys);
  const fewestPots = Math.min(...rebought.map((row) => row.won));
  const dipshits = rebought.filter((row) => row.won === fewestPots);

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
  const seated = new Set(state.seats.map((seat) => seat?.playerId));

  // How good each player's best hand is, above zero so that having shown none is leading in nothing
  const bestRank = new Map<string, number>();

  const players = ledger
    .map((row): TonightRow => {
      const { hands, won, biggest, best, rebuys, badges } = tonight.players[row.playerId] ?? newPlayerTonight();
      const value = best && evaluateHand(best);

      bestRank.set(row.playerId, value ? value.score + 1 : 0);

      return {
        playerId: row.playerId,
        name: row.name,
        seated: seated.has(row.playerId),
        net: row.net,
        hands,
        won,
        biggest,
        best: value && { name: madeHandName(value), cards: best! },
        rebuys,
        badges: badgesIn(badges),
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
    bestHand: ids(leaders(players, (row) => bestRank.get(row.playerId)!)),
    ...(over ? crown(players) : { dipshits: [], crownedBy: 'net' }),
    highHand: highHandsView(state),
  };
}
