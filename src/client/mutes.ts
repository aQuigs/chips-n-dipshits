import type { PrefMemory } from './prefs.ts';

/** Beside a muted player's name on their seat, for the viewer who muted them: an emoji every phone draws. */
export const MUTED_MARK = '🔇';

/**
 * The members one viewer has muted at one table, by member id: their chat, their nudges and their
 * reactions are hidden on this page alone. A list per table rather than a choice for every table, so it
 * is kept beside the preferences, in the same memory, under a name of its own for each table.
 */
export interface MuteList {
  has(memberId: string): boolean;
  /** Everyone muted, in the order they were muted. */
  ids(): string[];
  set(memberId: string, muted: boolean): void;
  /** Calls `watcher` whenever someone is muted or unmuted. Returns the way to stop. */
  watch(watcher: () => void): () => void;
}

// Beside the preferences' cnd.<key> and apart from the seat's cnd.seat.<table>, which muting never touches
const muteKey = (tableId: string) => `cnd.mute.${tableId}`;

/** What the browser kept, read as a list of ids; anything else, as after a hand edit, is nobody muted. */
function decode(text: string | null): string[] | null {
  if (text === null) {
    return null;
  }

  try {
    const ids: unknown = JSON.parse(text);

    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The mutes of one table, kept in the browser. As with the preferences, what the browser has comes first,
 * so a mute made in another tab holds here too, and a browser that keeps nothing costs only that the
 * mutes last for the visit.
 */
export class Mutes implements MuteList {
  private readonly memory: PrefMemory;
  private readonly key: string;
  private chosen: string[] = [];
  private readonly watchers = new Set<() => void>();

  constructor(memory: PrefMemory, tableId: string) {
    this.memory = memory;
    this.key = muteKey(tableId);
  }

  has(memberId: string): boolean {
    return this.ids().includes(memberId);
  }

  ids(): string[] {
    try {
      return decode(this.memory.get(this.key)) ?? this.chosen;
    } catch {
      return this.chosen;
    }
  }

  set(memberId: string, muted: boolean): void {
    const others = this.ids().filter((id) => id !== memberId);

    this.chosen = muted ? [...others, memberId] : others;

    try {
      this.memory.set(this.key, JSON.stringify(this.chosen));
    } catch {
      // Kept for this visit only
    }

    for (const watcher of this.watchers) {
      watcher();
    }
  }

  watch(watcher: () => void): () => void {
    this.watchers.add(watcher);

    return () => this.watchers.delete(watcher);
  }
}
