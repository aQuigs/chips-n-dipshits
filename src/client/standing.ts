/*
 * A seated player's standing choices: what the table does for them every time it comes up, until they
 * say otherwise. A straddle of each kind the table allows, and chopping the blinds where it allows that.
 * They are set in one dialog, and the button that opens it says what is on.
 */
import { straddlesAllowed } from '../engine/straddles.ts';
import type { StraddleKind } from '../engine/straddles.ts';
import type { TableView } from '../engine/view.ts';
import type { Words } from './words.ts';

export interface Standing {
  /** The kinds of straddle the table allows, in the order they are listed. */
  straddles: StraddleKind[];
  /** Those of them the player has on. */
  straddling: StraddleKind[];
  /** Whether the table lets the blinds chop. */
  chops: boolean;
  alwaysChop: boolean;
}

/** The viewer's standing choices, or null for a watcher and at a table that allows none. */
export function standingOf(view: TableView): Standing | null {
  const seat = view.you.seat === null ? null : view.seats[view.you.seat];
  const straddles = straddlesAllowed(view.config);
  const chops = view.config.allowChop;

  if (!seat || (straddles.length === 0 && !chops)) {
    return null;
  }

  return { straddles, straddling: straddles.filter((kind) => seat.straddles.includes(kind.what)), chops, alwaysChop: seat.alwaysChop };
}

const always = (words: string): Words => ({ full: words, brief: words });

// The kind every table starts with is the one players know as the straddle; any other has to say which it is, where there is room
const named = (kind: StraddleKind): Words => (kind.byDefault ? always('Straddle') : { full: kind.label, brief: 'Straddle' });

/**
 * Some straddles and the chop as one name: "Straddle", "Always chop", "2 straddles and chop". One kind
 * goes by its own name, more by `several`. Null when there is neither.
 */
function together(kinds: StraddleKind[], several: string, chop: boolean): Words | null {
  const [only] = kinds;
  const straddles = !only ? null : kinds.length === 1 ? named(only) : always(several);

  if (!straddles) {
    return chop ? always('Always chop') : null;
  }

  return chop ? { full: `${straddles.full} and chop`, brief: `${straddles.brief}, chop` } : straddles;
}

/** What the dialog holds, which is its name. */
export function standingName({ straddles, chops }: Standing): Words {
  return together(straddles, 'Straddles', chops)!;
}

/**
 * What the button that opens the dialog says: what is on, or with nothing on, what is inside. A straddle
 * that is on costs chips every round, so it is never out of sight.
 */
export function standingSays(standing: Standing): Words {
  const { straddling, alwaysChop } = standing;
  const on = together(straddling, `${straddling.length} straddles`, alwaysChop);
  const { full, brief } = on ?? standingName(standing);
  const state = on ? 'on' : 'off';

  return { full: `${full}: ${state}`, brief: `${brief}: ${state}` };
}
