import { chanceFigures, chanceSteps } from '../engine/chances.ts';
import type { ChanceFigure, Chances, Spot } from '../engine/chances.ts';
import type { Card } from '../engine/cards.ts';
import type { TableView } from '../engine/view.ts';
import type { BoardCard, TableMotion } from './motion.ts';

/** The hands a table has face up against each other, as a spot on each of its boards. */
export interface TableSpots {
  /** Whose hands they are, in the order every spot has them. */
  seats: number[];
  /** One spot a board, in the order the table has its boards. */
  boards: Spot[];
}

/**
 * The spots a table shows once its betting is over with players all in: the hands still in, all of
 * them face up, on each board as far as it is face up, with every other card face up on the table out
 * of the deck. `turning` are board cards the page still has face down, which count for nothing yet.
 * Null while there are no such hands.
 *
 * Only what the whole table sees goes in, never what this viewer alone does, so every page at a table
 * makes the same spots: a hand counts when it is `shown`, not when its cards happen to be in the view.
 */
export function spotsOf(view: TableView, turning: readonly BoardCard[] = []): TableSpots | null {
  const hand = view.hand;
  if (!hand || (hand.stage !== 'ritVote' && hand.stage !== 'runout')) {
    return null;
  }

  const faceUp = view.seats.flatMap((seat) => (seat?.shown && seat.cards?.every((card) => card !== null) ? [{ seat, cards: seat.cards as Card[] }] : []));
  const stillIn = view.seats.filter((seat) => seat?.inHand && !seat.folded);
  const hands = faceUp.filter(({ seat }) => seat.inHand && !seat.folded);

  // With a hand still in that the table cannot see, no chance among the others would be true
  if (hands.length < 2 || hands.length < stillIn.length) {
    return null;
  }

  const boards = hand.boards.map((board, run) => board.filter((_card, nth) => !turning.some((held) => held.board === run && held.card === nth)));
  const inHands = hands.flatMap(({ cards }) => cards);
  const elsewhere = [...faceUp.filter((shown) => !hands.includes(shown)).flatMap(({ cards }) => cards), ...boards.flat()];

  return {
    seats: hands.map(({ seat }) => seat.seat),
    boards: boards.map((board) => ({
      hands: hands.map(({ cards }) => cards),
      board,
      // Boards run one after the other start from the same cards, which are out of the deck once and on this board
      dead: [...new Set(elsewhere)].filter((card) => !board.includes(card) && !inHands.includes(card)),
    })),
  };
}

/** What the table writes beside the hands of its spots. */
export interface ShownChances {
  seats: number[];
  /** For each board, a figure for each seat in the order of `seats`; null for a board whose figures are still being worked out. */
  boards: (ChanceFigure[] | null)[];
}

/**
 * How the working out is spread, so that it never keeps the page from a tap: `now` is a clock in
 * milliseconds, and `later` runs something once the page has had its turn at whatever else is waiting.
 */
export interface Pace {
  now(): number;
  later(run: () => void): void;
}

/** The longest the working out holds the page at a time: under half a frame, so a tap or a frame is never kept waiting a whole one. */
export const SLICE_MS = 6;

const keyOf = (spot: Spot) => JSON.stringify(spot);

/**
 * The chances shown beside the hands of a table. A spot is worked out once, a slice at a time, from
 * the moment the table shows it. Its figures take the place of the ones before only on a table that
 * has come to rest with it on: until a card has landed face up, the hands read as they did before it.
 */
export class TableChances {
  private readonly motion: TableMotion;
  private readonly pace: Pace;
  private readonly changed: () => void;
  private spots: TableSpots | null = null;
  private keys: string[] = [];
  /** The table has come to rest since it took these spots: what it shows from here on is of them. */
  private landed = false;
  /** The figures of each spot worked out for the hands on the table, by its key; null for one that could not be. */
  private readonly figures = new Map<string, ChanceFigure[] | null>();
  /** What each board shows: the spot it last showed at rest, with its figures, or null for one with none to show. */
  private showing: ({ key: string; figures: ChanceFigure[] | null } | null)[] = [];
  private job: { key: string; steps: Generator<undefined, Chances, undefined> } | null = null;
  private waiting = false;

  /** `changed` is called when what `shown` and `pending` say has changed, other than by `follow`. */
  constructor(motion: TableMotion, pace: Pace, changed: () => void) {
    this.motion = motion;
    this.pace = pace;
    this.changed = changed;
  }

  /** Takes the spots the table is about to show. Call before every draw of it: spots it already had cost nothing. */
  follow(spots: TableSpots | null): void {
    const keys = spots?.boards.map(keyOf) ?? [];
    if (JSON.stringify(keys) === JSON.stringify(this.keys)) {
      return;
    }

    // Other hands, or none: nothing worked out or shown for the last ones says anything of these
    if (JSON.stringify([spots?.seats, spots?.boards[0]?.hands]) !== JSON.stringify([this.spots?.seats, this.spots?.boards[0]?.hands])) {
      this.figures.clear();
      this.showing = [];
    }

    this.spots = spots;
    this.keys = keys;
    this.landed = false;
    this.showing = keys.map((_key, board) => this.showing[board] ?? null);

    // Begun at once, while the cards are on their way: a spot that takes no longer than a slice is ready as they land
    this.work();
  }

  /** Call once the effects of what is shown have set the table moving: the spots on it count as seen when it is at rest again. */
  played(): void {
    if (this.spots && !this.landed) {
      this.showAtRest(() => (this.landed = true));
    }
  }

  /** What to write beside the hands now; null when the table shows no spots. */
  get shown(): ShownChances | null {
    return this.spots && { seats: this.spots.seats, boards: this.showing.map((board) => board?.figures ?? null) };
  }

  /** Whether what is written is not yet of the cards now on the table: those are on their way, or their figures still being worked out. */
  get pending(): boolean {
    return this.keys.some((key, board) => this.showing[board]?.key !== key);
  }

  /** Stops the working out, when the table is left. */
  end(): void {
    this.follow(null);
  }

  /** Writes what is worked out of the spots on the table the next time it is at rest, unless it has moved on to others by then. */
  private showAtRest(first?: () => void): void {
    const spots = this.spots;

    void this.motion.idle().then(() => {
      if (this.spots !== spots) {
        return;
      }

      first?.();

      // A board that is not worked out yet shows no figure: the one it had is of cards that have been added to
      this.showing = this.keys.map((key) => (this.figures.has(key) ? { key, figures: this.figures.get(key)! } : null));
      this.changed();
    });
  }

  /** Works on the spots the table shows, in the order of its boards, for one slice, and comes back for the rest. */
  private work(): void {
    const until = this.pace.now() + SLICE_MS;

    do {
      // A spot the table has stopped showing is left where it is
      if (this.job && !this.keys.includes(this.job.key)) {
        this.job = null;
      }

      const board = this.keys.findIndex((key) => !this.figures.has(key));
      if (board < 0) {
        return;
      }

      const key = this.job?.key ?? this.keys[board]!;

      try {
        this.job ??= { key, steps: chanceSteps(this.spots!.boards[this.keys.indexOf(key)]!) };

        const step = this.job.steps.next();
        if (step.done) {
          this.finish(key, chanceFigures(step.value));
        }
      } catch (error) {
        // A spot that cannot be worked out must not be what stops the table: its hands show no figure
        console.error(error);
        this.finish(key, null);
      }
    } while (this.pace.now() < until);

    if (!this.waiting) {
      this.waiting = true;
      this.pace.later(() => {
        this.waiting = false;
        this.work();
      });
    }
  }

  private finish(key: string, figures: ChanceFigure[] | null): void {
    this.figures.set(key, figures);
    this.job = null;

    if (this.landed) {
      this.showAtRest();
    }
  }
}
