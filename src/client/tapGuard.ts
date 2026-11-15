/**
 * Keeps a tap on what it was aimed at. A part of the page is drawn anew by the game, not by the player,
 * so a finger on its way down to one control can land on another that has come up in its place: "Sit out
 * next hand" beside a table lying down is where "Raise" comes up when the turn arrives, a second tap on
 * "Call" all in finds the choice of how many times to run it, and a row of a list moves under a finger
 * when another row is added above it. For as long as it takes to see such a change, a control that came
 * up where a different one lay takes no tap. Everything else is live at once: a turn that is already on
 * screen, and a button that came up over words, so a player who is ready is never slowed.
 *
 * This is the rule; `pageTapGuard.ts` applies it to the page.
 */

/**
 * How long a control that came up in another's place takes no tap, counted from when the page is free
 * to show it (`shownAt`): about the time it takes to see that the page has changed. It is also how long
 * a finger may still be on its way to what lay there before. Shorter than the keys' wait
 * (`KEYS_SETTLE_MS`): a key is held back whatever it presses, a tap only where something else lay.
 */
export const TAPS_SETTLE_MS = 350;

// Boxes that share less than this, each way, are beside each other: a finger aimed at one is not on the other
const SHARED_PX = 2;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A control where it lies. */
export interface Spot<C> {
  control: C;
  /**
   * What tells it from every other control once it is drawn anew and is a new element: its id and its
   * data marks, never what it says or where it lies. "Call" for the next decision is not the "Call"
   * that lay there for the last. Null for a control with no mark, which is the same only as itself.
   */
  is: string | null;
  box: Box;
  /** A tap on it cannot be taken back, so it takes none in the moment it first comes up, whatever lay there: nobody is ready for it before they have read it. */
  forGood: boolean;
}

/** Every control as it lay when a drawing left the screen, at `left`. */
export interface Drawing<C> {
  left: number;
  spots: Spot<C>[];
}

/**
 * A control that takes no tap until `until`. Null while the page is still busy with the drawing the
 * control came up in: nobody can see or tap it yet, so its time has not begun (`shownAt`).
 */
export interface Hold<C> {
  spot: Spot<C>;
  until: number | null;
}

const same = <C>(a: Spot<C>, b: Spot<C>): boolean => a.control === b.control || (a.is !== null && a.is === b.is);

const share = (a: Box, b: Box): boolean => Math.min(a.right, b.right) - Math.max(a.left, b.left) > SHARED_PX && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > SHARED_PX;

const inPlace = (a: Box, b: Box): boolean => [a.left - b.left, a.top - b.top, a.right - b.right, a.bottom - b.bottom].every((apart) => Math.abs(apart) <= SHARED_PX);

/** The drawings a finger may still be on its way to at `at`. */
export const stillAimedAt = <C>(drawings: readonly Drawing<C>[], at: number): Drawing<C>[] => drawings.filter((drawing) => at - drawing.left < TAPS_SETTLE_MS);

/** The holds among `held` that are not over at `at`. */
export const stillHeld = <C>(held: readonly Hold<C>[], at: number): Hold<C>[] => held.filter((hold) => hold.until === null || hold.until > at);

/**
 * The holds once the page is free again, at `at`, to show what it drew and to take a tap: the settle
 * time of those that came up in that drawing begins now. Laying a drawing out takes a slow phone a good
 * part of that time, and counted from before it a hold would be over as its control came into sight.
 */
export const shownAt = <C>(held: readonly Hold<C>[], at: number): Hold<C>[] => held.map((hold) => (hold.until === null ? { spot: hold.spot, until: at + TAPS_SETTLE_MS } : hold));

/**
 * The controls among `now`, as the page stands at `at` with the last of `drawings` just gone, that take
 * no tap yet, each with when it does:
 *
 * - One that has come up, or moved, to where a different control lay in a drawing a finger may still
 *   be on its way to: for the settle time from when the page shows it. Every such drawing counts, not
 *   only the last: a part drawn twice in a moment still has a finger on its way to what the first one
 *   showed.
 * - One that commits for good and was not in the drawing just gone: for the settle time from when the
 *   page shows it.
 * - One that lies where it lay in the drawing just gone has not come up at all: it is live, or among
 *   `held`, the holds of that drawing, has the rest of the time it had.
 */
export function holds<C>(drawings: readonly Drawing<C>[], now: readonly Spot<C>[], at: number, held: readonly Hold<C>[] = []): Hold<C>[] {
  const aimedAt = stillAimedAt(drawings, at);
  const justGone = drawings.at(-1)?.spots ?? [];

  return now.flatMap((spot): Hold<C>[] => {
    const before = justGone.filter((was) => same(was, spot));

    if (before.some((was) => inPlace(was.box, spot.box))) {
      const kept = stillHeld(held, at).find((hold) => same(hold.spot, spot));

      return kept ? [{ spot, until: kept.until }] : [];
    }

    const tookAnothersPlace = aimedAt.some((drawing) => drawing.spots.some((was) => !same(was, spot) && share(was.box, spot.box)));
    const cameUpForGood = spot.forGood && before.length === 0;

    return tookAnothersPlace || cameUpForGood ? [{ spot, until: null }] : [];
  });
}
