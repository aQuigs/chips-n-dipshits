import type { Command, Reaction } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';
import type { TurnLock } from './connection.ts';
import type { BoardCard, TableMotion } from './motion.ts';
import { PendingMove } from './pendingMove.ts';
import { Suspense } from './suspense.ts';
import { spotsOf, TableChances } from './tableChances.ts';
import type { Pace, ShownChances } from './tableChances.ts';
import { newEvents, tableChange, TableNews } from './tableChange.ts';
import type { TableChange } from './tableChange.ts';

/** How the bar under the table is to take the player's own move while it is out: see `ShownTable.waiting`. */
export type Waiting = 'sent' | 'unconfirmed';

/** What the table's screen does with what `ShownTable` works out. */
export interface Showing {
  /** What is shown has changed, and wants drawing from `view()`. */
  draw(): void;
  /** What a view, a held result or the player's own move brought, for the effects: each thing once, after it is drawn. */
  tell(change: TableChange): void;
  /** Something the player should be told in words. */
  say(message: string): void;
}

/** What a move is called in a sentence about it: the label the table gives it. */
const nameOf = (view: TableView): string => view.seats[view.you.seat!]?.lastAction ?? 'move';

/**
 * The table as the page shows it, which is not always the table as the server last told it. Each view
 * from the server passes through the same layers on its way to the screen and to the effects, in this
 * order: `Suspense` holds back the end of a hand while the last cards of a runout turn, and
 * `PendingMove` lays the player's own move over a view that has not caught up with it. Whatever draws
 * the table screen or reacts to it gets the result (`view()`, and the changes handed to `tell`), and
 * nothing goes around it. What the screen shows beyond the view is worked out from that result too:
 * `TableChances` reads the chances of the hands face up off the table as shown, never as it is.
 */
export class ShownTable {
  private readonly news = new TableNews();
  private readonly suspense: Suspense;
  private readonly pending = new PendingMove();
  private readonly tableChances: TableChances;
  private readonly now: () => number;
  private readonly waited: () => number;
  private readonly out: Showing;
  private latest: TableView | null = null;

  /**
   * `now` is the server's time as the page reckons it, which is what the game's own times are told in.
   * `waited` is this device's clock, in ms: how long a move has gone unanswered is a matter of the
   * device alone, and the server's time as reckoned here shifts with every answer that comes.
   * `pace` spreads out the working out of chances.
   */
  constructor(motion: TableMotion, now: () => number, waited: () => number, pace: Pace, out: Showing) {
    this.now = now;
    this.waited = waited;
    this.out = out;
    this.tableChances = new TableChances(motion, pace, () => out.draw());
    this.suspense = new Suspense(motion, (later) => this.show(later));
  }

  /** The table as the server last told it, for what follows the game and draws nothing. */
  get heard(): TableView | null {
    return this.latest;
  }

  /** The table as the screen shows it; null until the first view has come. */
  view(): TableView | null {
    return this.latest && this.pending.shown(this.suspense.shown(this.latest));
  }

  /** The last cards of a runout being turned over, which the table draws but which say nothing yet of the viewer's hand. */
  get turning(): BoardCard[] {
    return this.suspense.turning;
  }

  /** Each face-up hand's chance to win, as far as the table shows it yet; null while no hands are face up against each other. */
  get chances(): ShownChances | null {
    return this.tableChances.shown;
  }

  /** Whether the chances of the cards now on the table are still to come. */
  get chancesPending(): boolean {
    return this.tableChances.pending;
  }

  /**
   * What the bar under the table makes of the player's own move while it is out. `sent`: the page
   * shows nothing of it but that it is out, so the buttons that made it are gone. `unconfirmed`: it
   * shows as played, with no word from the server for long enough that the page should say so. Null
   * when no move is out, or one shows as played and is no news.
   */
  get waiting(): Waiting | null {
    if (this.pending.out === 'sent') {
      return 'sent';
    }

    return this.pending.unconfirmed(this.waited()) ? 'unconfirmed' : null;
  }

  /** A view the connection has taken up. */
  take(view: TableView, wentBack: boolean): void {
    const before = this.latest;

    this.latest = view;

    // Worked out before the table is drawn: what is held back, or laid over the view, decides what is drawn
    const change = this.pending.see(this.suspense.see(this.news.change(before, view, this.now(), wentBack)));

    this.show(change);
  }

  /**
   * Follows the move last sent, as the connection says how it stands: going out, unanswered and being
   * looked up, or accounted for. This is the one way a move comes to be shown early, whatever made it.
   *
   * A move of the turn shows as played from the moment it goes out; of any other move, all that
   * shows is that it is out. The connection frees the move buttons only after taking up whatever view
   * the answer or the lookup brought, so a move still showing as played then was not played: it comes
   * off the table, which is as it was before the move. A refusal is explained by the server's own
   * words; a move the lookup found no sign of by a sentence from here, which claims no more than
   * that: the request may still be on its way, and the server then plays it or refuses it by its number.
   */
  moveIs(lock: TurnLock, sent?: Command): void {
    if (lock === 'sent' && sent) {
      this.play(sent);
    }

    if (lock === 'unanswered' && this.pending.unanswered()) {
      this.out.draw();
    }

    if (lock === 'open') {
      const undone = this.putBack();

      if (undone?.unanswered) {
        this.out.say(`The table has no sign of your ${undone.name}, so it is still your turn.`);
      }
    }
  }

  /**
   * The player's own reaction or throw, told the moment they make it, as the effects are told anything
   * else that happens: nothing else on the table changes. The view the server sends back with it has
   * it too, and tells it to nobody, since a page never takes its viewer's own reactions from a view.
   */
  react(reaction: Reaction): void {
    const view = this.view();

    if (view) {
      this.out.tell({ before: view, view, feed: [], events: [], current: true, wentBack: false, nightEnded: false, earned: [], tookHighHand: false, reactions: [reaction], now: this.now() });
    }
  }

  /** Takes the player's move off the table without a word, as when the page learns it can no longer follow the game. */
  forget(): void {
    this.putBack();
  }

  /** Lets go of whatever is held or pending, untold, when the table is left. */
  end(): void {
    this.suspense.end();
    this.pending.drop();
    this.tableChances.end();
  }

  /**
   * A move of the turn shows as played, and the effects hear of it as of anything else that happens
   * in the hand. Any other move, and one the view on screen does not offer, changes nothing on the
   * table and is told to nobody: the bar is drawn again without the buttons that made it.
   */
  private play(move: Command): void {
    const before = this.view();

    if (!before) {
      return;
    }

    if (!this.pending.begin(move, before, this.waited())) {
      this.out.draw();
      return;
    }

    const view = this.view()!;

    this.show({ before, view, feed: [], events: newEvents(before, view), current: true, wentBack: false, nightEnded: false, earned: [], tookHighHand: false, reactions: [], now: this.now() });
  }

  private putBack(): { name: string; unanswered: boolean } | null {
    const before = this.view();
    const dropped = this.pending.drop();

    if (!before || !dropped) {
      return null;
    }

    // Nothing of it was on the table: its buttons are simply back, where the table still offers them
    if (!dropped.played) {
      this.out.draw();
      return null;
    }

    // The table as shown has gone back, and is told like one that did: nothing in it is news, and the turn that returns is not announced again
    this.show(tableChange(before, this.view()!, this.now(), true));

    return { name: nameOf(before), unanswered: dropped.unanswered };
  }

  private show(change: TableChange): void {
    this.tableChances.follow(spotsOf(this.view()!, this.turning));
    this.out.draw();
    this.out.tell(change);

    // The effects have set the table moving, and both wait for it to be still. `Suspense` first: a result
    // it lets go then is on the table before the chances of the cards before it would be shown
    this.suspense.played();
    this.tableChances.played();
  }
}
