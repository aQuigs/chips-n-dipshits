/**
 * What an arrival came to: the table, the member it made there, and the words it was asked in. The
 * member's token is not here. It is read from the table when the arrival is answered again.
 */
export interface KeptArrival {
  tableId: string;
  memberId: string;
  /** The request as it was put, so that a key sent with another request finds nobody. */
  asked: string;
}

/**
 * The arrivals the server has answered, by the key each request carried. A page that got no answer
 * to a join or a new table asks again under the same key, and is given the member the first asking
 * made, not a second one.
 *
 * It is only a memory, kept for `ARRIVAL_KEY_SECONDS`: one that has forgotten, or cannot be asked,
 * costs what asking twice always cost. Either call may throw, and `Asking` carries on without it.
 */
export interface ArrivalKeys {
  find(key: string): KeptArrival | null;
  keep(key: string, arrival: KeptArrival): void;
}

// Long enough for a page to give up on an answer and ask again, several times over
export const ARRIVAL_KEY_SECONDS = 600;

// What a page makes for a key: letters, digits, - and _, too many to guess. Checked before a key is
// part of the name anything is kept under, which has limits of its own on what a name may be
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// A page asks in a few hundred characters. Anything near what one kept value may hold is not kept at all
const ASKED_LIMIT = 20_000;

/** Whether something kept under a key is an arrival, as only this version's entries are sure to be. */
export function isKeptArrival(value: unknown): value is KeptArrival {
  const { tableId, memberId, asked } = (value ?? {}) as Partial<KeptArrival>;

  return typeof tableId === 'string' && typeof memberId === 'string' && typeof asked === 'string';
}

/** A failure of the keys that an asking carried on through. */
export interface KeysFailure {
  where: string;
  error: unknown;
}

/**
 * One request's dealings with the keys: what was kept for it, and keeping what it came to. Neither
 * throws. A failure is held instead, and handed over by `failures`: the caller has a table in hand
 * when it asks, and with it the lock that an error log may want, so it tells of them once it has let go.
 */
export class Asking {
  private readonly keys: ArrivalKeys;
  private readonly key: string;
  private readonly asked: string;
  private held: KeysFailure[] = [];

  constructor(keys: ArrivalKeys, key: string, asked: string) {
    this.keys = keys;
    this.key = key;
    this.asked = asked;
  }

  /** What an earlier asking of this very request came to, or null: nothing kept, or kept for other words. */
  kept(): KeptArrival | null {
    const found = this.quietly('server find arrival', () => this.keys.find(this.key));

    return found && found.asked === this.asked ? found : null;
  }

  keep(tableId: string, memberId: string): void {
    this.quietly('server keep arrival', () => this.keys.keep(this.key, { tableId, memberId, asked: this.asked }));
  }

  /** The failures held since this was last asked for them. */
  failures(): KeysFailure[] {
    const held = this.held;
    this.held = [];

    return held;
  }

  private quietly<T>(where: string, step: () => T): T | null {
    try {
      return step();
    } catch (error) {
      this.held.push({ where, error });

      return null;
    }
  }
}

/**
 * The asking a request is, from the key it carries and the words it was put in. Null when it carries
 * no key, or words too long to keep: an arrival as every one was before there were keys. Undefined
 * when what it carries is not a key.
 */
export function askingOf(keys: ArrivalKeys, key: unknown, asked: string): Asking | null | undefined {
  if (key === undefined || key === null) {
    return null;
  }

  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    return undefined;
  }

  return asked.length > ASKED_LIMIT ? null : new Asking(keys, key, asked);
}

/** Keeps the keys in memory, which is right wherever one process answers every request: local play and tests. */
export class MemoryArrivalKeys implements ArrivalKeys {
  private readonly kept = new Map<string, { arrival: KeptArrival; until: number }>();
  private readonly clock: { now(): number };

  constructor(clock: { now(): number }) {
    this.clock = clock;
  }

  find(key: string): KeptArrival | null {
    const found = this.kept.get(key);

    return found && found.until > this.clock.now() ? found.arrival : null;
  }

  keep(key: string, arrival: KeptArrival): void {
    const now = this.clock.now();

    for (const [old, { until }] of this.kept) {
      if (until <= now) {
        this.kept.delete(old);
      }
    }

    this.kept.set(key, { arrival, until: now + ARRIVAL_KEY_SECONDS * 1000 });
  }
}
