import type { Card } from '../engine/cards.ts';
import { readHand } from '../engine/handNames.ts';
import type { HandView, Holding, TableView } from '../engine/view.ts';
import { sweatOf } from './celebrations.ts';
import type { BoardCard, TableMotion } from './motion.ts';
import type { TableChange } from './tableChange.ts';

/**
 * What a view says of how everyone is doing, all of which a hand's result changes. A part of the view
 * that a result changes and that is not the hand, a stack or the feed goes here, or it gives the result
 * away while it is held.
 */
type Standing = Pick<TableView, 'ledger' | 'tonight'>;

const standingOf = ({ ledger, tonight }: TableView): Standing => ({ ledger, tonight });

/** What the page holds back while the last cards of a runout are turned over. */
interface Held {
  /** The cards being turned. */
  cards: BoardCard[];
  /** What the viewer's hand makes without those cards, for the hint under their own. */
  holding: Holding | null;
  /** Where everyone stood before the hand was settled, as the view before showed it. */
  standing: Standing;
  /** The first line of the play-by-play and chat held back, by its number, and every line after it; null when none is. */
  line: number | null;
}

interface Hold {
  hand: number;
  /** How many events the hand had when the hold began: the held ones are its last. */
  events: number;
  held: Held;
  /** What the view brought that is told once the cards are up. */
  later: Pick<TableChange, 'events' | 'feed' | 'earned'>;
  waiting: boolean;
}

/**
 * The end of a hand held back while the last cards of an all-in runout are turned over. The server
 * sends the last card and the result in one view; this splits what the view brought in two: what is
 * told at once, up to the cards, and the result, told once they are face up as though a later view
 * had brought it. Until then the page is drawn from `shown`, the table as it stood before the hand was
 * settled, and so says nothing the cards have not.
 *
 * Nobody has a decision to make while it lasts and it is no longer than `sweatOf` allows. A view that
 * brings more of the same hand ends it and tells what was held with what is new; a view of another hand,
 * or one that comes late, ends it untold. With motion off nothing is held: there would be no turn of a
 * card to wait for.
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
    const { before, view, events, feed, earned } = change;
    const hold = this.hold;

    this.view = view;

    if (hold && (events.length > 0 || !change.current || view.hand?.number !== hold.hand)) {
      this.hold = null;

      // More of the same hand: what was held is what came between, so it goes before what is new
      if (change.current && view.hand?.number === hold.hand) {
        return { ...change, events: [...hold.later.events, ...events], feed: [...hold.later.feed, ...feed], earned: [...hold.later.earned, ...earned] };
      }
    }

    const sweat = this.motion.seen() ? sweatOf(change) : null;
    if (!sweat) {
      return change;
    }

    const hand = view.hand!;
    // The play-by-play names the cards and the winner from the first line the dealer says of them
    const line = feed.find((entry) => entry.kind === 'dealer')?.seq ?? null;
    const told = (entry: { seq: number }) => line === null || entry.seq < line;
    const cards = sweat.turns.map(({ board, card }) => ({ board, card }));

    this.hold = {
      hand: hand.number,
      events: hand.events.length,
      held: { cards, holding: withoutCards(view, hand, cards), standing: standingOf(before ?? view), line },
      later: { events: events.slice(sweat.upTo), feed: feed.filter((entry) => !told(entry)), earned },
      waiting: false,
    };

    // Whatever follows a hand's events takes the new ones for the last of the hand's, so the view told with them ends there too
    const upTo = { ...hand, events: hand.events.slice(0, hand.events.length - events.length + sweat.upTo) };

    return { ...change, view: { ...view, hand: upTo }, events: events.slice(0, sweat.upTo), feed: feed.filter(told), earned: [] };
  }

  /** The last cards of a runout being turned over, which the table draws but which say nothing yet of the viewer's hand. */
  get turning(): BoardCard[] {
    return this.hold?.held.cards ?? [];
  }

  /** The table as the page shows it: as it stood before its hand was settled while the result is held back, else as it is. */
  shown(view: TableView): TableView {
    const held = this.hold?.held;

    return held && view.hand ? unsettled(view, view.hand, held) : view;
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
      // A hand whose events were emptied meanwhile, as one that outgrew its record, has none left to tell
      const events = view.hand?.events.length === hold.events ? hold.later.events : [];

      this.hold = null;
      this.release({ before: view, view, feed: hold.later.feed, events, current: true, wentBack: false, nightEnded: false, earned: hold.later.earned, now: view.now });
    });
  }

  /** Lets go of whatever is held, untold, when the table is left. */
  end(): void {
    this.hold = null;
  }
}

/** What the viewer's hand makes on each board without the cards being turned. */
function withoutCards(view: TableView, hand: HandView, cards: readonly BoardCard[]): Holding | null {
  const hole = view.you.seat === null ? null : view.seats[view.you.seat]?.cards;
  if (!hand.holding || !hole || hole.includes(null)) {
    return null;
  }

  const reads = hand.boards.map((board, run) => readHand(hole as Card[], board.filter((_card, nth) => !cards.some((held) => held.board === run && held.card === nth))));

  return { ...hand.holding, reads };
}

/**
 * The view as it stood before its hand was settled, which is how the page is drawn while the last cards
 * of a runout are turned over: no result, the pot in the middle, every stack, the ledger and the night's
 * numbers as they were, nobody offered to show their cards, the hint without the cards being turned, and
 * nothing in the feed from the first line that tells of them.
 */
function unsettled(view: TableView, hand: HandView, held: Held): TableView {
  const gained = new Map<number, number>();
  const gain = (seat: number, amount: number) => gained.set(seat, (gained.get(seat) ?? 0) + amount);
  const bounty = hand.result?.bounty;

  for (const win of hand.result?.winnings ?? []) {
    gain(win.seat, win.amount);
  }

  for (const payment of bounty?.payments ?? []) {
    gain(bounty!.seat, payment.amount);
    gain(payment.seat, -payment.amount);
  }

  return {
    ...view,
    hand: { ...hand, stage: 'runout', result: null, canShow: false, holding: held.holding },
    seats: view.seats.map((seat) => seat && { ...seat, stack: seat.stack - (gained.get(seat.seat) ?? 0) }),
    ...held.standing,
    feed: held.line === null ? view.feed : view.feed.filter((entry) => entry.seq < held.line!),
  };
}
