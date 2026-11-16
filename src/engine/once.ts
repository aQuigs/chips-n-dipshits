import type { TableState } from './types.ts';

/**
 * A command that must not be done twice is sent under a key its page makes up, and sent again under the
 * same key when no answer came. The table remembers the keys it has acted on, each with who sent it, in
 * its own state: a key and what its command did are saved in one write or not at all, so a command asked
 * twice under one key is done once, whichever asking the table heard first.
 */

/** How many keys a table remembers, the latest ones. A page asks again within moments, a table's worth of commands later at the most. */
export const ASKED_KEPT = 32;

/** How many of them may be one member's, so that nobody's commands push another member's keys out before that member's page has looked. */
export const ASKED_KEPT_EACH = 8;

// One symbol to a byte, six bits of it: 22 make 132 bits, as hard to guess as a member's token
export const KEY_LENGTH = 22;
const SYMBOLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const KEY = new RegExp(`^[A-Za-z0-9_-]{${KEY_LENGTH}}$`);

/** A key from `KEY_LENGTH` bytes nobody could guess, which whoever calls brings: nothing here is random. */
export const keyFrom = (bytes: Uint8Array): string => [...bytes.subarray(0, KEY_LENGTH)].map((byte) => SYMBOLS[byte & 63]).join('');

/** Whether something is a key as a page makes one. */
export const isKey = (value: unknown): value is string => typeof value === 'string' && KEY.test(value);

/** Whether the table has acted on this member's command under this key. Another member's same key is that member's own. */
export const wasAsked = (state: TableState, playerId: string, key: string): boolean => state.asked.some((asked) => asked.key === key && asked.by === playerId);

/** Remembers a key the table has just acted on, and forgets the oldest: the member's own once they have more than `ASKED_KEPT_EACH`, the table's once it has more than `ASKED_KEPT`. */
export function remember(state: TableState, playerId: string, key: string): void {
  state.asked.push({ key, by: playerId });

  if (askedBy(state, playerId).length > ASKED_KEPT_EACH) {
    state.asked.splice(
      state.asked.findIndex((asked) => asked.by === playerId),
      1,
    );
  }

  state.asked.splice(0, state.asked.length - ASKED_KEPT);
}

/** The keys of a member's own that the table remembers: what tells their page that a command it got no answer to was done. */
export const askedBy = (state: TableState, playerId: string): string[] => state.asked.filter((asked) => asked.by === playerId).map((asked) => asked.key);
