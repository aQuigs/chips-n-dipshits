import type { FeedEntry } from '../../engine/types.ts';
import type { TableView } from '../../engine/view.ts';
import { barLine, SPOKEN_HOLDS_MS, spokenToViewer } from '../chatBar.ts';
import { chatLineShown } from '../senders.ts';
import { LABELS } from '../spoken.ts';
import { cardText, h, marksCards, readableText } from '../ui.ts';
import { createChatBox } from './chatBox.ts';
import { chatLineEl, gifOf, namesViewer, showPicture } from './chatLine.ts';

// How close to the bottom still counts as following the conversation
const FOLLOW_SLACK_PX = 40;

// The page stays open for hours, so the list keeps only its tail
const MAX_ENTRIES = 300;

/** What the lines are drawn with, as the viewer has it now: read again whenever the list is drawn. */
export interface FeedLook {
  /** Decides how the cards in the play-by-play are written. */
  deck: string;
  /** GIF links show as their pictures. */
  pictures: boolean;
  /** Whose chat lines show: everyone's but those the viewer has muted (`sendersShown`). */
  shown(sender: string): boolean;
}

export interface Feed {
  element: HTMLElement;
  update(view: TableView): void;
  /** Draws every line again when what the look has changed, the deck, who is muted or whether GIFs show, changes how any line shows. */
  redraw(): void;
}

/** More unseen lines than this are counted as this many and more. */
const MOST_COUNTED = 99;

/** A line as the bar under the table says it: in words alone, a GIF the viewer sees as one named for what it is. */
function latestText(entry: FeedEntry, current: FeedLook): (string | HTMLElement)[] {
  if (entry.kind !== 'chat') {
    return cardText(entry.text, current.deck);
  }

  return [`${entry.from}: ${gifOf(entry, current.pictures) === null ? entry.text : 'GIF'}`];
}

/**
 * The dealer's play-by-play and the table chat in one list. Built once and updated in place, so what
 * someone is typing and where they have scrolled to both survive new entries arriving. `beside` stands at
 * the end of its bar, which is there in every shape of the page, and `over` lies over the bar while it
 * has something to show (toast.css). The bar shows the newest line in words alone, and a person's line
 * for a few seconds though the dealer has said more since (`barLine`); a GIF shows only in the opened
 * list, and only once its line is in sight there, so nothing is fetched for a closed chat or a line
 * scrolled past.
 */
export function createFeed(onChat: (text: string) => void, look: () => FeedLook, beside: HTMLElement | null = null, over: HTMLElement | null = null): Feed {
  // Not a live region: new lines are said by the page's announcer, once, whether or not this list is open.
  // It takes the keyboard so that it can be scrolled without a pointer
  const list = h('ol.entries', { role: 'list', 'aria-label': LABELS.lines, tabindex: 0 });
  // The line on the bar is for the eye: said as it came, and not again as the name of the button it stands on
  const latest = h('span.latest', { 'aria-hidden': 'true' });
  // How many lines people have said with the list out of sight, until the viewer has the list in sight again: the bar shows one line, and the dealer's soon take it
  const counted = h('span.count');
  const unread = h('span.unread', { hidden: true }, counted, h('span.unseen', null, ' unread. '));
  // Up from when a line names the viewer with the list out of sight, shut or down for their turn, until they have the list in sight again
  const named = h('span.named-you', { hidden: true }, h('span.unseen', null, 'A line names you. '), '@');
  const toggle = h('button.feed-toggle', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'feed-body' }, h('span.label', null, 'Chat'), unread, named, latest);
  let members: TableView['members'] = [];
  const box = createChatBox(onChat, () =>
    members
      .filter((member) => member.id !== you)
      .map((member) => member.name)
      .sort((a, b) => a.localeCompare(b)),
  );

  const element = h('aside.feed', { 'aria-label': LABELS.feed }, h('div.feed-bar', null, toggle, beside, over), h('div.feed-body', { id: 'feed-body' }, list, box.element));

  toggle.addEventListener('click', () => {
    const open = element.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
    list.scrollTop = list.scrollHeight;
  });

  let lastSeq = 0;
  let opened = false;
  let you = '';
  let unseen = 0;
  // The line a person said that keeps the bar for now, by its number, and the timer that gives the bar back
  let holding: number | null = null;
  let released: ReturnType<typeof setTimeout> | undefined;
  // Every line had, shown or not, so it can be drawn again for another look
  const had: FeedEntry[] = [];
  const gifs = new Map<Element, { address: string; from: string | null }>();
  // How each line had is drawn, by its number, so a change of look that changes no line draws nothing again
  const drawnAs = new Map<number, string>();

  /** Changes the list, and keeps it at the bottom if that is where the reader was. */
  function keepFollowing(change: () => void): void {
    const following = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK_PX;

    change();

    if (following) {
      list.scrollTop = list.scrollHeight;
    }
  }

  // A line drawn in a closed chat has no box, so it is in sight only once the chat is open and the line scrolled to
  const sight = new IntersectionObserver(
    (seen) => {
      for (const { target, isIntersecting } of seen) {
        const gif = gifs.get(target);
        if (isIntersecting && gif) {
          gifs.delete(target);
          sight.unobserve(target);
          keepFollowing(() => showPicture(target as HTMLElement, gif.address, gif.from));
        }
      }
    },
    { root: list },
  );

  const isShown = (entry: FeedEntry, current: FeedLook) => chatLineShown(entry, current.shown);
  const howDrawn = (entry: FeedEntry, current: FeedLook) => {
    if (!isShown(entry, current)) {
      return 'hidden';
    }

    if (entry.kind !== 'chat') {
      return marksCards(current.deck) ? 'cards marked' : 'cards plain';
    }

    return gifOf(entry, current.pictures) !== null ? 'gif' : 'words';
  };

  const lineEl = (entry: FeedEntry, current: FeedLook): HTMLElement => {
    if (entry.kind !== 'chat') {
      return h('li', { 'data-kind': entry.kind }, readableText(entry.text, current.deck));
    }

    const line = chatLineEl(entry, { you, pictures: current.pictures });
    if (line.gif !== null) {
      gifs.set(line.element, { address: line.gif, from: entry.from });
      sight.observe(line.element);
    }

    return line.element;
  };

  const showLatest = (current: FeedLook) => {
    const line = barLine(
      had.filter((entry) => isShown(entry, current)),
      holding,
    );

    latest.replaceChildren(...(line ? latestText(line, current) : []));
  };

  const showUnseen = () => {
    counted.textContent = unseen > MOST_COUNTED ? `${MOST_COUNTED}+` : String(unseen);
    unread.hidden = unseen === 0;
  };

  /** Gives `line` the bar for a while. The time is the page's own, and its end draws the bar's line and nothing else. */
  const hold = (line: FeedEntry) => {
    holding = line.seq;
    clearTimeout(released);
    released = setTimeout(() => {
      holding = null;
      showLatest(look());
    }, SPOKEN_HOLDS_MS);
  };

  // The list comes into sight when the chat is opened, and when it comes back up after a turn that took its room: at its newest line, as it opens, since out of sight it followed nothing
  new IntersectionObserver((seen) => {
    if (seen.some((one) => one.isIntersecting)) {
      named.hidden = true;
      unseen = 0;
      showUnseen();
      list.scrollTop = list.scrollHeight;
    }
  }).observe(list);

  /** Notes how `entries` are drawn now, and gives back those that show. */
  const drawing = (entries: readonly FeedEntry[], current: FeedLook): FeedEntry[] => {
    entries.forEach((entry) => drawnAs.set(entry.seq, howDrawn(entry, current)));

    return entries.filter((entry) => isShown(entry, current));
  };

  const drawAll = () => {
    const current = look();

    gifs.clear();
    sight.disconnect();
    keepFollowing(() => list.replaceChildren(...drawing(had, current).map((entry) => lineEl(entry, current))));
    showLatest(current);
  };

  return {
    element,
    update(view) {
      you = view.you.id;
      members = view.members;

      // The lines a page opens with are not news
      const arrived = opened;
      opened = true;

      const fresh = view.feed.filter((entry) => entry.seq > lastSeq);
      if (fresh.length === 0) {
        return;
      }

      lastSeq = fresh[fresh.length - 1]!.seq;
      had.push(...fresh);
      had.splice(0, Math.max(0, had.length - MAX_ENTRIES)).forEach((gone) => drawnAs.delete(gone.seq));

      const current = look();

      // What people said just now, to the viewer and where they are shown it
      const spoken = arrived ? fresh.filter((entry) => spokenToViewer(entry, you) && isShown(entry, current)) : [];

      if (list.clientHeight === 0) {
        if (spoken.some((entry) => namesViewer(entry, you))) {
          named.hidden = false;
        }

        unseen += spoken.length;
        showUnseen();
      }

      if (spoken.length > 0) {
        hold(spoken.at(-1)!);
      }

      keepFollowing(() => {
        list.append(...drawing(fresh, current).map((entry) => lineEl(entry, current)));

        while (list.childElementCount > MAX_ENTRIES) {
          const oldest = list.firstElementChild!;

          gifs.delete(oldest);
          sight.unobserve(oldest);
          oldest.remove();
        }
      });
      showLatest(current);
    },
    redraw() {
      // Rewriting the list has a screen reader read it all again, so only when a line shows otherwise
      const current = look();

      if (had.some((entry) => drawnAs.get(entry.seq) !== howDrawn(entry, current))) {
        drawAll();
      } else {
        showLatest(current);
      }
    },
  };
}
