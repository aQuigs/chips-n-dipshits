/*
 * Each hand's chance to win once hands are face up with cards to come. It is worked out from what the
 * whole table can see and nothing else, so it is the same wherever it is worked out, and it is never
 * part of a table's state or of a view: whoever wants it asks here.
 */
import { BOARD_SIZE } from './boards.ts';
import { freshDeck, shuffle } from './cards.ts';
import type { Card } from './cards.ts';
import { evaluateHand } from './handRank.ts';
import { seededRng, seedOf } from './seeded.ts';

/** Hands face up against each other on one board that may have cards to come. */
export interface Spot {
  /** Each hand's cards, all of them face up. */
  hands: readonly (readonly Card[])[];
  /** The cards of the board that are out, face up. */
  board: readonly Card[];
  /** Every other card face up on the table, which can no longer come: another board's, or an earlier run's. */
  dead: readonly Card[];
}

export interface Chances {
  /**
   * For each hand in the order given, the chance that it is the best of these hands once the board is
   * complete, a tie counting as an equal share: from 0 to 1, and 1 together. It is no share of the money:
   * side pots and what each player put in do not enter into it.
   */
  shares: number[];
  /** Every way the board can finish was counted. Otherwise the shares are an estimate, from a sample of the ways. */
  exact: boolean;
}

/**
 * How many boards an estimate deals. A share's standard error is then at most 0.5 / √2500, one point in
 * a hundred, and less the further the share is from a half.
 */
export const SAMPLED_BOARDS = 2500;

/**
 * The most ways for a board to finish that are all counted. Up to as many as a sample deals, counting
 * every one is no more work than the sample and gives the exact answer. In hold'em that is every spot
 * from the flop on, 990 ways at most, and none before it, where there are 80,730 at the very least.
 */
export const MOST_COUNTED = SAMPLED_BOARDS;

/**
 * How a spot's chances are made. Nothing that shows chances passes one: it is here for the tests, which
 * hold the two ways against each other on the same spot.
 */
export interface ChanceMethod {
  /** In place of `MOST_COUNTED`. */
  mostCounted?: number;
  /** In place of the spot's own seed. */
  seed?: number;
}

function waysToPick(count: number, from: number): number {
  let ways = 1;

  for (let nth = 0; nth < count; nth++) {
    ways = (ways * (from - nth)) / (nth + 1);
  }

  return ways;
}

/** Every way to pick `count` of `cards`, each once. */
function* everyPick(cards: readonly Card[], count: number, from = 0): Generator<Card[]> {
  if (count === 0) {
    yield [];
    return;
  }

  for (let first = from; first <= cards.length - count; first++) {
    for (const rest of everyPick(cards, count - 1, first + 1)) {
      yield [cards[first]!, ...rest];
    }
  }
}

/** `SAMPLED_BOARDS` picks of `count` of `cards`, each as likely as any other, drawn from `seed`. */
function* sampledPicks(cards: readonly Card[], count: number, seed: number): Generator<Card[]> {
  const rng = seededRng(seed);
  const deck = [...cards];

  for (let pick = 0; pick < SAMPLED_BOARDS; pick++) {
    yield shuffle(deck, rng).slice(0, count);
  }
}

/**
 * What tells one spot from another whatever order its cards are given in. An estimate is seeded with it,
 * so the same hands on the same table get the same estimate on every page and after every reload.
 */
function orderFreeKey({ hands, board, dead }: Spot): string {
  const sorted = (cards: readonly Card[]) => [...cards].sort().join('');

  return [hands.map(sorted).sort().join(' '), sorted(board), sorted(dead)].join('|');
}

/**
 * The work of `chancesOf`, a board at a time: each step counts one way for the board to finish, and
 * the answer comes with the last. For a caller that must not be kept from anything else for long, and
 * so does a few steps at a time. A spot that names a card twice, or something that is no card, is
 * refused at the first step.
 */
export function* chanceSteps(spot: Spot, method: ChanceMethod = {}): Generator<undefined, Chances, undefined> {
  const { hands, board } = spot;
  const unseen = new Set(freshDeck());

  for (const card of [...hands.flat(), ...board, ...spot.dead]) {
    if (!unseen.delete(card)) {
      throw new Error(`A spot is made of cards face up, each once: ${String(card)} is not one, or is there twice`);
    }
  }

  const toCome = BOARD_SIZE - board.length;
  if (toCome < 0 || toCome > unseen.size) {
    throw new Error(`A board of ${board.length} cards cannot be finished from ${unseen.size}`);
  }

  // A hand with nothing to beat is the best there is, however the board comes
  if (hands.length < 2) {
    return { shares: hands.map(() => 1), exact: true };
  }

  // The deck in the one order every page lists it in, so that a sample deals the same boards from it everywhere
  const deck = [...unseen];
  const exact = waysToPick(toCome, deck.length) <= (method.mostCounted ?? MOST_COUNTED);
  const finishes = exact ? everyPick(deck, toCome) : sampledPicks(deck, toCome, method.seed ?? seedOf(orderFreeKey(spot)));
  const won = hands.map(() => 0);
  let counted = 0;

  for (const rest of finishes) {
    const scores = hands.map((hand) => evaluateHand([...board, ...rest, ...hand]).score);
    const best = Math.max(...scores);
    const winners = scores.filter((score) => score === best).length;

    scores.forEach((score, hand) => {
      if (score === best) {
        won[hand]! += 1 / winners;
      }
    });

    counted += 1;
    yield;
  }

  return { shares: won.map((share) => share / counted), exact };
}

/**
 * Each hand's chance to be the best hand of a spot when its board is complete. Callers ask this and
 * never know how it was made: every way the board can finish is counted when there are at most
 * `MOST_COUNTED`, and otherwise `SAMPLED_BOARDS` of them are dealt from a seed that is the spot's own.
 */
export function chancesOf(spot: Spot, method?: ChanceMethod): Chances {
  const steps = chanceSteps(spot, method);

  for (;;) {
    const step = steps.next();

    if (step.done) {
      return step.value;
    }
  }
}

/** A hand's chance as it is written beside its cards. */
export interface ChanceFigure {
  /**
   * Whole percent, without the sign. `<1` and `>99` are for a hand that would otherwise read 0 while it
   * can still win, or 100 while it can still lose. An estimate has `~` in front.
   */
  text: string;
  /** Ahead of every other hand, in its share and in the figure shown for it, and in an estimate by more than the sample could have made up. */
  favorite: boolean;
}

// Shares are told apart no finer than this when they are rounded, so two that are equal but for the last bit of a sum count as equal
const ROUNDING_STEPS = 1e9;

/**
 * The shares as whole percent that add up to 100: each is rounded down, and the points left over go one
 * each to the hands that lost most by it. Where two lost the same, the bigger share is first, so the same
 * shares read the same whichever hand is listed first; only between equal shares is it the earlier hand.
 */
function wholePercent(shares: readonly number[]): number[] {
  const percent = shares.map((share) => Math.round(share * 100 * ROUNDING_STEPS) / ROUNDING_STEPS);
  const whole = percent.map(Math.floor);
  const left = 100 - whole.reduce((sum, points) => sum + points, 0);
  const byLoss = percent.map((points, hand) => ({ hand, points, lost: points - whole[hand]! })).sort((a, b) => b.lost - a.lost || b.points - a.points || a.hand - b.hand);

  byLoss.slice(0, left).forEach(({ hand }) => (whole[hand]! += 1));

  return whole;
}

/**
 * The lead an estimate needs to have a favorite. A sampled share is off by a standard error of up to
 * 0.5 / √SAMPLED_BOARDS, and the difference of two by up to twice that, when one hand's loss is the
 * other's gain. A lead under two such errors, four points, is one the sample cannot tell from none.
 */
const SAMPLED_LEAD = 2 / Math.sqrt(SAMPLED_BOARDS);

/**
 * How each hand's chance is written. The figures of one spot add up to 100, and none lies at the ends:
 * 0 is only for a hand that cannot win or tie, and 100 only for one that cannot lose or tie. An
 * estimate cannot know either, so it never reads 0 or 100.
 */
export function chanceFigures({ shares, exact }: Chances): ChanceFigure[] {
  const whole = wholePercent(shares);
  const lead = exact ? 0 : SAMPLED_LEAD;

  return shares.map((share, hand) => {
    const points = whole[hand]!;
    const ahead = shares.every((other, nth) => nth === hand || (share - other > lead && points > whole[nth]!));

    if (points === 0 && (share > 0 || !exact)) {
      return { text: '<1', favorite: false };
    }

    if (points === 100 && (share < 1 || !exact)) {
      return { text: '>99', favorite: ahead };
    }

    return { text: exact ? String(points) : `~${points}`, favorite: ahead };
  });
}
