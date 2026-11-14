import type { Holding, TableView } from '../engine/view.ts';
import { sweatOf } from './celebrations.ts';
import type { BoardCard, TableMotion } from './motion.ts';
import type { TableChange } from './tableChange.ts';

/** What the page holds back while the last cards of a runout are turned over: on the felt, and in the feed. */
export interface Held {
  /** The cards being turned. */
  cards: BoardCard[];
  /** What the viewer held before those cards came, for the hint under their own. */
  holding: Holding | null;
  /** The first line of the play-by-play and chat held back, by its number, and every line after it; null when none is. */
  line: number | null;
}

interface Hold {
  hand: number;
  held: Held;
  /** What the view brought that is told once the cards are up. */
  later: Pick<TableChange, 'events' | 'feed'>;
  waiting: boolean;
}

/**
 * The end of a hand held back while the last cards of an all-in runout are turned over. The server
 * sends the last card and the result in one view; this splits what the view brought in two: what is
 * told at once, up to the cards, and the result, told once they are face up as though a later view
 * had brought it. Until then the felt and the feed are drawn from `held`, and so say nothing the
 * cards have not.
 *
 * Nobody has a decision to make while it lasts, it is no longer than `sweatOf` allows, and a view
 * that brings anything new of the hand, or comes late, ends it at once. With motion off nothing is
 * held: there would be no turn of a card to wait for.
 */
export class Suspense {
  private readonly motion: TableMotion;
  private readonly release: (later: TableChange) => void;
  private hold: Hold | null = null;
  private view: TableView | null = null;

  /** `release` draws the table as it is and tells what was held back, as the effects of a view are told. */
  constructor(motion: TableMotion, release: (later: TableChange) => void) {
    this.motion = motion;
    this.release = release;
  }

  /** What of `change` is told now. Call for every view put on screen, before it is drawn. */
  see(change: TableChange): TableChange {
    const { before, view, events, feed } = change;

    this.view = view;

    if (this.hold && (events.length > 0 || !change.current || view.hand?.number !== this.hold.hand)) {
      this.hold = null;
    }

    const sweat = this.motion.seen() ? sweatOf(change) : null;
    if (!sweat) {
      return change;
    }

    // The play-by-play names the cards and the winner from the first line the dealer says of them
    const line = feed.find((entry) => entry.kind === 'dealer')?.seq ?? null;
    const told = (entry: { seq: number }) => line === null || entry.seq < line;
    const number = view.hand!.number;

    this.hold = {
      hand: number,
      held: {
        cards: sweat.turns.map(({ board, card }) => ({ board, card })),
        holding: before?.hand?.number === number ? before.hand.holding : null,
        line,
      },
      later: { events: events.slice(sweat.upTo), feed: feed.filter((entry) => !told(entry)) },
      waiting: false,
    };

    // Whatever follows a hand's events takes the new ones for the last of the hand's, so the view told with them ends there too
    const hand = view.hand!;
    const shown = { ...hand, events: hand.events.slice(0, hand.events.length - events.length + sweat.upTo) };

    return { ...change, view: { ...view, hand: shown }, events: events.slice(0, sweat.upTo), feed: feed.filter(told) };
  }

  /** What is held back now, for drawing the felt and the feed; null while nothing is. */
  get held(): Held | null {
    return this.hold?.held ?? null;
  }

  /**
   * Call once the effects of a view have set the table moving. What is held back is told when the table
   * is still: the cards are up, or whatever was moving was ended, by a resize, a hidden page or a redraw.
   */
  played(): void {
    const hold = this.hold;
    if (!hold || hold.waiting) {
      return;
    }

    hold.waiting = true;

    void this.motion.idle().then(() => {
      if (this.hold !== hold) {
        return;
      }

      const view = this.view!;

      this.hold = null;
      this.release({ before: view, view, ...hold.later, current: true, wentBack: false, nightEnded: false });
    });
  }

  /** Lets go of whatever is held, untold, when the table is left. */
  end(): void {
    this.hold = null;
  }
}
