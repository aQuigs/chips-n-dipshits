import { KEY_LENGTH, keyFrom } from '../engine/once.ts';
import type { Command } from '../engine/types.ts';

/** The commands a table must do once however often they are asked: those that move chips, and the answers to a request for them. */
export const ONCE = new Set<Command['type']>(['transferChips', 'requestRebuy', 'approve', 'deny']);

/**
 * The keys this page sends such commands under. A command asked again in the same words, by the page
 * itself or by whoever fills its form in a second time, goes under the key of the first, and the table
 * does it once. The key is given up (`settled`) once whoever asked has been told what became of the
 * command: taken or refused by the table, or shown by the table to have been done. The same command
 * made on purpose after that is a second command.
 *
 * Keys are held in the page's memory alone. A reload forgets them, and the try after that is a new command.
 */
export class Once {
  private readonly random: (bytes: number) => Uint8Array;

  /** The key of each command whose fate is not known, by the table and the words it was asked in. */
  private readonly held = new Map<string, string>();

  /** `random` gives that many bytes nobody could guess: the browser's own, never `Math.random`. */
  constructor(random: (bytes: number) => Uint8Array) {
    this.random = random;
  }

  /** The key to send a command to a table under, or undefined for a command that goes without one. */
  keyFor(tableId: string, command: Command): string | undefined {
    if (!ONCE.has(command.type)) {
      return undefined;
    }

    const words = JSON.stringify([tableId, command]);
    const key = this.held.get(words) ?? keyFrom(this.random(KEY_LENGTH));

    this.held.set(words, key);

    return key;
  }

  /** Whoever asked has been told what became of the command under this key. */
  settled(key: string): void {
    for (const [words, held] of this.held) {
      if (held === key) {
        this.held.delete(words);
      }
    }
  }
}
