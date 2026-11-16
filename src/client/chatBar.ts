import type { FeedEntry } from '../engine/types.ts';

/** How long a person's line keeps the chat's bar before the dealer's lines have it back: about what it takes to read one. */
export const SPOKEN_HOLDS_MS = 4000;

/** A line of chat from someone else at the table, which is what the bar counts and holds: the viewer knows what they said themselves. */
export const spokenToViewer = (entry: FeedEntry, you: string): boolean => entry.kind === 'chat' && entry.by !== you;

/**
 * The line the chat's bar shows of `lines`, the ones the viewer is shown, oldest first: the newest,
 * unless a person's line still holds the bar (`holding`, its number) and nobody has spoken since.
 * Then it is that line, though the dealer has said more: one move later a friend's question would be
 * gone unread. Null with no line to show.
 */
export function barLine(lines: readonly FeedEntry[], holding: number | null): FeedEntry | null {
  for (let nth = lines.length - 1; nth >= 0 && holding !== null; nth -= 1) {
    const line = lines[nth]!;

    if (line.kind === 'chat') {
      return line.seq === holding ? line : lines.at(-1)!;
    }
  }

  return lines.at(-1) ?? null;
}
