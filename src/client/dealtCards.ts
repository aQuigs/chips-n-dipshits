import { HOLE_CARDS } from '../engine/cards.ts';
import type { Card } from '../engine/cards.ts';
import type { TableView } from '../engine/view.ts';
import { HISTORY_LIMIT } from '../server/api.ts';
import type { PrefMemory } from './prefs.ts';

/**
 * The viewer's own two cards in the hands this browser saw dealt at one table, so that a hand played
 * back shows them face up as the viewer had them. A hand's record holds only what the whole table saw,
 * and nothing asks the server for more: these never leave the browser.
 *
 * Kept beside the preferences, in the same memory, under a name of its own for each table and apart
 * from the seat's `cnd.seat.<table>`, with the member they were dealt to: another member at the table
 * from the same browser is shown none of them.
 */
export interface DealtMemory {
  /** Keeps the viewer's cards in the hand a view shows, when it shows them. Call with every view. */
  see(view: TableView): void;
  /** The cards kept for this member in hand number `hand`, or null for a hand this browser did not see them dealt in. */
  of(playerId: string, hand: number): Card[] | null;
}

interface Kept {
  /** The member the cards were dealt to. */
  player: string;
  /** Each hand's number and cards, oldest first. */
  hands: [hand: number, cards: Card[]][];
}

const dealtKey = (tableId: string) => `cnd.dealt.${tableId}`;

/** Forgets the cards of a table that is gone for good, with its seat: none of its hands will be opened again. */
export function forgetDealt(memory: { remove(key: string): void }, tableId: string): void {
  memory.remove(dealtKey(tableId));
}

const isHand = (entry: unknown): entry is Kept['hands'][number] =>
  Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'number' && Array.isArray(entry[1]) && entry[1].length === HOLE_CARDS && entry[1].every((card) => typeof card === 'string');

/** What the browser kept, when it is this member's; anything else, as after a hand edit or for another member, is nothing kept. */
function decode(text: string | null, player: string): Kept | null {
  if (text === null) {
    return null;
  }

  try {
    const kept = JSON.parse(text) as Partial<Kept> | null;

    return kept?.player === player && Array.isArray(kept.hands) ? { player, hands: kept.hands.filter(isHand) } : { player, hands: [] };
  } catch {
    return { player, hands: [] };
  }
}

/**
 * The dealt cards of one table, kept in the browser. As with the preferences, what the browser has
 * comes first, so a hand another tab saw dealt is known here too, and a browser that keeps nothing
 * costs only that the cards last for the visit.
 */
export class DealtCards implements DealtMemory {
  private readonly memory: PrefMemory;
  private readonly key: string;
  private kept: Kept | null = null;
  /** The last hand kept, so that the views that follow it cost nothing. */
  private last = '';

  constructor(memory: PrefMemory, tableId: string) {
    this.memory = memory;
    this.key = dealtKey(tableId);
  }

  see(view: TableView): void {
    const cards = view.you.seat === null ? null : view.seats[view.you.seat]?.cards;
    if (!view.hand || !cards || cards.length !== HOLE_CARDS || cards.some((card) => card === null)) {
      return;
    }

    const seen = JSON.stringify([view.you.id, view.hand.number, cards]);
    if (seen === this.last) {
      return;
    }

    // A table put back to an earlier state deals its next hands under numbers it has used: what was kept from this one on is gone
    const earlier = this.read(view.you.id).hands.filter(([hand]) => hand < view.hand!.number);

    this.last = seen;
    // As many hands as the history offers: one older than that can no longer be opened
    this.kept = { player: view.you.id, hands: [...earlier, [view.hand.number, cards as Card[]] as Kept['hands'][number]].slice(-HISTORY_LIMIT) };

    try {
      this.memory.set(this.key, JSON.stringify(this.kept));
    } catch {
      // Kept for this visit only
    }
  }

  of(playerId: string, hand: number): Card[] | null {
    return this.read(playerId).hands.find(([number]) => number === hand)?.[1] ?? null;
  }

  private read(player: string): Kept {
    const here = this.kept?.player === player ? this.kept : null;

    try {
      return decode(this.memory.get(this.key), player) ?? here ?? { player, hands: [] };
    } catch {
      return here ?? { player, hands: [] };
    }
  }
}
