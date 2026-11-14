import type { Ability, AppPreferences } from './prefs.ts';

/** Somewhere on the table a thing moves from or to. Where each is on the page is the table renderer's to say (`drawnTable`). */
export type Place =
  /** The middle of the felt, where cards are dealt from and folded ones go. */
  | { at: 'deck' }
  | { at: 'pot' }
  /** A player's plate, with their name and stack. */
  | { at: 'seat'; seat: number }
  /** A player's two cards. */
  | { at: 'cards'; seat: number }
  /** Where a seat's bet sits, whether or not one is there now. */
  | { at: 'bet'; seat: number }
  /** One card's place on a board. */
  | { at: 'board'; board: number; card: number };

/**
 * Every move there is, by name. How each looks is the page's business (`LOOKS` in pageMotion.ts):
 *
 * - `deal`, `board`, `show` and `bet` move what the table has standing at `to` once the view is drawn:
 *   a seat's cards, one card of a board, a seat's bet. Where the table draws nothing there, nothing moves.
 * - `chips` and `muck` move a stand-in for what the table no longer draws: a pile of chips, or a
 *   seat's cards face down. It is drawn at `from`, travels to `to` and is gone when it lands.
 */
export type MoveName = 'deal' | 'board' | 'show' | 'bet' | 'chips' | 'muck';

export interface Move {
  name: MoveName;
  /** Where it leaves from. Left out of a move that happens where it lies: cards turned face up, a card dropped onto the board. */
  from?: Place;
  to: Place;
  /** What a pile of chips says it is worth, in the table's smallest unit. Left out, the pile is a bare chip. */
  amount?: number;
  /**
   * Milliseconds from now until it starts. Until then what moves waits where it starts from: cards
   * still to be dealt are not yet seen, and a pile of chips sits where it will leave from.
   */
  after: number;
}

/** How long each move takes, from leaving to landing. */
export const MOVE_MS: Record<MoveName, number> = { deal: 260, board: 240, show: 200, bet: 200, chips: 280, muck: 220 };

/**
 * What moves things across the table. Motion is decoration over a table that is already drawn as it
 * truly is: nothing here changes what is on the table, where it rests or what can be tapped, and when
 * a move ends or is cancelled the page is exactly as if it had never played.
 *
 * An effect reaches it as `context.motion`. The hand's own moves come from `handMoves`, held to its
 * budgets; anything else may play its own:
 *
 * - A bet drawn before the hand's events bring it, as when a player's own move is shown before the
 *   server has answered, gets the slide a confirmed one gets by playing `betSlide(seat)`
 *   (handMoves.ts) once it is drawn. The view that confirms it finds the bet lying there and does
 *   not slide it again.
 * - A longer, staged piece is one list of moves with later and later `after`s. To hold a card back
 *   while it plays, give that card a move that starts late: it stays unseen until then. A move for
 *   something already moving takes the place of the one it had.
 * - What must wait for the table to be still awaits `idle()`, which is not told of a pause that
 *   only makes way for the next thing to move.
 *
 * Whatever is played ends early when the table under it is drawn again, as every new view of the
 * hand does, so no move can outlast what it shows.
 */
export interface TableMotion {
  /** Starts every move in the list, each `after` its own wait. Nothing plays for a viewer who has motion off. */
  play(moves: readonly Move[]): void;
  /** Ends everything in flight at once, where it was going. */
  cancel(): void;
  /** Resolves once nothing is moving: at once when nothing is. */
  idle(): Promise<void>;
}

/** What does the moving: the page's own animations in a browser, or nothing where there are none. */
export interface MotionPlayer extends TableMotion {
  /** Stops everything and lets go of the page, when the table is left. */
  dispose(): void;
}

export const stillMotion: MotionPlayer = { play: () => undefined, cancel: () => undefined, idle: () => Promise.resolve(), dispose: () => undefined };

/** What the page knows that decides whether anything moves. */
export interface Watching {
  /** The device asks for less motion. */
  reduced(): boolean;
  /** False while the page is out of sight: another tab, a phone asleep. */
  inView(): boolean;
}

/**
 * The motion one viewer sees on a table. Whatever moves something plays it through here, which is
 * what holds it to their switch and to a device that asks for less motion, and keeps a page nobody
 * is looking at from saving motion up for when they come back.
 */
export class Motion implements MotionPlayer {
  private readonly player: MotionPlayer;
  private readonly prefs: AppPreferences;
  private readonly watching: Watching;

  constructor(player: MotionPlayer, prefs: AppPreferences, watching: Watching) {
    this.player = player;
    this.prefs = prefs;
    this.watching = watching;
  }

  play(moves: readonly Move[]): void {
    if (moves.length > 0 && this.prefs.get('motion') && !this.watching.reduced() && this.watching.inView()) {
      this.player.play(moves);
    }
  }

  cancel(): void {
    this.player.cancel();
  }

  idle(): Promise<void> {
    return this.player.idle();
  }

  dispose(): void {
    this.player.dispose();
  }
}

/** Whether the switch in Preferences can turn motion on: not while the device itself asks for less. */
export const motionAbility = (watching: Watching): Ability => (watching.reduced() ? 'blocked' : 'yes');
