import type { FeedEntry } from '../../engine/types.ts';
import { gifAddress } from '../gifs.ts';
import { h } from '../ui.ts';

/** A chat line as drawn, and the address of the GIF it is when it shows as one. */
export interface ChatLine {
  element: HTMLElement;
  gif: string | null;
}

/** What a chat line is drawn with, beside the line itself. */
export interface ChatLook {
  /** The viewer, whose own name in a line is marked more strongly. */
  you: string;
  /** GIF links show as their pictures; off, a GIF line stays its link. */
  pictures: boolean;
}

/** The address of the GIF a chat line shows as, or null when it shows its words. */
export function gifOf(entry: FeedEntry, pictures: boolean): string | null {
  // A line that names someone shows its words, the name marked, even when the rest of it, as an address's #@name, made it a GIF's
  return pictures && !entry.mentions?.length ? gifAddress(entry.text) : null;
}

/** The words of a line, with each name it mentions marked, the viewer's own more strongly. */
function wordsOf(entry: FeedEntry, you: string): (string | HTMLElement)[] {
  const parts: (string | HTMLElement)[] = [];
  let from = 0;

  for (const [id, at, length] of entry.mentions ?? []) {
    parts.push(entry.text.slice(from, at), h('span.mention', { 'data-you': id === you }, entry.text.slice(at, at + length)));
    from = at + length;
  }

  parts.push(entry.text.slice(from));

  return parts.filter((part) => part !== '');
}

/** Whether a line names the viewer, said by someone else. */
export const namesViewer = (entry: FeedEntry, you: string): boolean => (entry.mentions ?? []).some(([id]) => id === you) && entry.by !== you;

/**
 * A line of the chat. One that names the viewer says so in words too, ahead of it, for a reader who
 * can't see the mark. A line that is a GIF's address is drawn as its link until the picture is put in
 * (`showPicture`), which the feed does only once the line is in sight.
 */
export function chatLineEl(entry: FeedEntry, look: ChatLook): ChatLine {
  const namesYou = namesViewer(entry, look.you);
  const gif = gifOf(entry, look.pictures);

  const element = h(
    'li',
    { 'data-kind': entry.kind, 'data-names-you': namesYou, 'data-gif': gif !== null && 'waiting' },
    namesYou ? h('span.unseen', null, 'Names you. ') : null,
    h('b', null, `${entry.from}: `),
    gif === null ? wordsOf(entry, look.you) : h('span.gif-link', null, entry.text),
  );

  return { element, gif };
}

/**
 * Puts the GIF at `address` in its line, in place of the link. Built from the parts of an address that
 * passed `gifAddress`, never from the line's words. The picture's host is not told which page asked
 * (the table's address can carry a seat), and a picture that fails to load leaves the plain link.
 */
export function showPicture(line: HTMLElement, address: string, from: string | null): void {
  const link = line.querySelector('.gif-link');
  if (!link) {
    return;
  }

  const picture = document.createElement('img');
  picture.setAttribute('referrerpolicy', 'no-referrer');
  picture.setAttribute('loading', 'lazy');
  picture.setAttribute('decoding', 'async');
  picture.setAttribute('alt', from ? `A GIF from ${from}` : 'A GIF');
  picture.className = 'gif';

  picture.addEventListener('load', () => {
    line.dataset.gif = 'shown';
  });
  picture.addEventListener('error', () => {
    picture.replaceWith(link);
    line.dataset.gif = 'failed';
  });

  // Last, once nothing about the request can change
  picture.setAttribute('src', address);
  link.replaceWith(picture);
}
