import { reactionKind, reactionText } from '../engine/reactions.ts';
import type { ReactionKind } from '../engine/reactions.ts';
import type { TableView } from '../engine/view.ts';
import type { Move, TableMotion } from './motion.ts';
import { MOVE_MS } from './motion.ts';
import type { Sounds } from './sound.ts';
import type { TableChange } from './tableChange.ts';

/** What the button that opens the picker shows: an emoji every phone draws, as the reactions' own marks are. */
export const PICKER_MARK = '😃';

/** How long a reaction stays up over its sender's seat. */
export const POPPED_MS = 3000;

/** How long a thrown thing stays on the seat it landed on. */
export const LANDED_MS = 2500;

/** A reaction to be shown over a seat: popped up over its sender's, or landed on the one it was thrown at. */
export interface SeatMark {
  seat: number;
  kind: ReactionKind;
  /** What it says in words, for a screen reader: "Sam threw a tomato at Dana". */
  label: string;
  /** It arrives with a little bounce, where the table is moving; otherwise it is simply there. */
  moving: boolean;
}

/** Where a reaction is shown: over the table, on a layer the table is never drawn into, so a new view of the hand does not take it away. */
export interface SeatMarks {
  /** Shows `mark` over its seat `after` milliseconds from now, for as long as its kind stays up. */
  show(mark: SeatMark, after: number): void;
  /** Puts what is showing back over its seats, which may have moved since: a new view, a turned phone. */
  follow(): void;
}

/** A reaction as this page shows it: over which seat, and for a throw, from which. */
export interface ReactionShown {
  kind: ReactionKind;
  label: string;
  /** The seat it shows over: its sender's, or the one a throw lands on. */
  seat: number;
  /** The seat a throw flies from, or null for a reaction, or a thrower no longer seated, whose throw simply lands. */
  from: number | null;
}

const seatOf = (view: TableView, member: string | undefined): number | null => view.seats.find((seat) => seat?.playerId === member)?.seat ?? null;

/**
 * The reactions a change brings that this page shows: from a sender `shown` lets through, of a kind
 * this page knows, over a seat that is still there. A throw at a player who has left since lands nowhere.
 */
export function reactionsShown({ view, reactions }: TableChange, shown: (sender: string) => boolean): ReactionShown[] {
  return reactions.flatMap((reaction): ReactionShown[] => {
    const kind = reactionKind(reaction.kind);
    const seat = seatOf(view, kind?.thrown ? reaction.to : reaction.from);

    if (!kind || seat === null || !shown(reaction.from)) {
      return [];
    }

    return [{ kind, label: reactionText(reaction, view.members), seat, from: kind.thrown ? seatOf(view, reaction.from) : null }];
  });
}

/** What shows them: the seats' marks, the table's motion and its sounds. */
export interface ReactionStage {
  marks: SeatMarks;
  motion: TableMotion;
  sounds: Sounds;
}

/**
 * Shows each reaction over its seat. A throw flies from the thrower's seat and shows where it lands as
 * it lands; with motion off, or from a thrower no longer seated, it is simply there. Each throw makes
 * its sound as it is thrown; a reaction over a seat is silent.
 */
export function showReactions(shown: readonly ReactionShown[], { marks, motion, sounds }: ReactionStage): void {
  const moving = motion.seen();

  for (const { kind, label, seat, from } of shown) {
    const flies = moving && from !== null && from !== seat;

    if (flies) {
      const flight: Move = { name: 'throw', from: { at: 'seat', seat: from }, to: { at: 'seat', seat }, mark: kind.mark, after: 0 };

      motion.play([flight]);
    }

    if (kind.thrown) {
      sounds.play('whoosh');
    }

    marks.show({ seat, kind, label, moving }, flies ? MOVE_MS.throw : 0);
  }
}
