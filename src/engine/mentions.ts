/*
 * Who a chat line names with an @. The table settles it once, when it takes the line, and keeps it with
 * the line as members' ids: names repeat across a night, and contain spaces, so a page reading names out
 * of the words could name the wrong person. Being named nudges a player, which one sender can do to one
 * player only so often.
 */
import type { FeedEntry, Mention } from './types.ts';

/** Whether a mention nudges whom it names, rather than only marking them. */
export const nudges = (mention: Mention): boolean => mention[3] !== true;

/** How soon after nudging someone the same sender may nudge them again: named sooner, they are marked in the line but not nudged. */
export const NUDGE_GAP_MS = 60_000;

/** The most people one line names; an @ past them is just text. Each one named is kept with the line, which is saved with the table. */
export const MENTIONS_PER_LINE = 3;

const WORDY = /[\p{L}\p{N}\p{M}_]/u;

/** Whether `char` carries a word on: an @ right after one, as in an email address, opens no mention, nor does a name end right before one. */
export const carriesOn = (char: string | undefined): boolean => char !== undefined && WORDY.test(char);

/** Whether the character at `at` is an @ that can name someone: one at the start of a word. */
export const opensMention = (text: string, at: number): boolean => text[at] === '@' && !carriesOn(text[at - 1]);

/** Whether `name`, compared without case, is written at `at` in `text` as a whole: not the start of a longer word. */
function namedAt(text: string, at: number, name: string): boolean {
  const written = text.slice(at, at + name.length);

  return written.length === name.length && written.toLowerCase() === name.toLowerCase() && !carriesOn(text[at + name.length]);
}

/**
 * Whom `text`, said by `from`, names. An `@` at the start of a word followed by a member's name, in any
 * case, names that member; where two names fit, as "Al" and "Al Smith", the longer is meant. An @ that
 * fits nobody, that fits two people with one name, or that fits the sender is just text.
 */
export function mentionsIn(text: string, members: readonly { id: string; name: string }[], from: string): Mention[] {
  const found: Mention[] = [];

  for (let at = text.indexOf('@'); at !== -1 && found.length < MENTIONS_PER_LINE; at = text.indexOf('@', at + 1)) {
    if (!opensMention(text, at)) {
      continue;
    }

    const fits = members.filter((member) => namedAt(text, at + 1, member.name));
    const longest = Math.max(0, ...fits.map((member) => member.name.length));
    const meant = fits.filter((member) => member.name.length === longest);

    if (meant.length === 1 && meant[0]!.id !== from) {
      found.push([meant[0]!.id, at, longest + 1]);
      at += longest;
    }
  }

  return found;
}

/**
 * `mentions` as a line said at `now` by `from` keeps them: one naming someone `from` has nudged within
 * `NUDGE_GAP_MS`, by an earlier line in `feed` or earlier in this one, is quiet. The feed keeps its last
 * lines only, so a sender who floods it can nudge again sooner, once for every screenful.
 */
export function withNudgeLimit(mentions: readonly Mention[], feed: readonly FeedEntry[], from: string, now: number): Mention[] {
  const nudged = new Set(feed.filter((line) => line.by === from && now - line.at < NUDGE_GAP_MS).flatMap((line) => (line.mentions ?? []).filter(nudges).map(([id]) => id)));

  return mentions.map((mention) => {
    const [id, at, length] = mention;
    if (nudged.has(id)) {
      return [id, at, length, true];
    }

    nudged.add(id);
    return mention;
  });
}
