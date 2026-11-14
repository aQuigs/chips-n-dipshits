import type { FeedEntry } from '../../engine/types.ts';
import { cardText, h, marksCards } from '../ui.ts';

const CHAT_LENGTH = 200;

// How close to the bottom still counts as following the conversation
const FOLLOW_SLACK_PX = 40;

// The page stays open for hours, so the list keeps only its tail
const MAX_ENTRIES = 300;

export interface Feed {
  element: HTMLElement;
  update(entries: readonly FeedEntry[]): void;
  /** Redraws what is shown for the deck now chosen, which decides how the cards in it are written. */
  showDeck(deck: string): void;
}

function entryEl(entry: FeedEntry, deck: string): HTMLElement {
  if (entry.kind === 'chat') {
    return h('li', { 'data-kind': entry.kind }, h('b', null, `${entry.from}: `), entry.text);
  }

  return h('li', { 'data-kind': entry.kind }, cardText(entry.text, deck));
}

function latestText(entry: FeedEntry, deck: string): (string | HTMLElement)[] {
  return entry.kind === 'chat' ? [`${entry.from}: ${entry.text}`] : cardText(entry.text, deck);
}

/**
 * The dealer's play-by-play and the table chat in one list. Built once and updated in place, so what
 * someone is typing and where they have scrolled to both survive new entries arriving.
 */
export function createFeed(onChat: (text: string) => void, deck: string): Feed {
  const list = h('ol.entries', { 'aria-live': 'polite' });
  const input = h('input', { type: 'text', id: 'chat-input', maxlength: CHAT_LENGTH, placeholder: 'Say something', autocomplete: 'off', 'aria-label': 'Chat message' });
  const latest = h('span.latest');
  const toggle = h('button.feed-toggle', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'feed-body' }, h('span.label', null, 'Chat'), latest);

  const form = h(
    'form.say',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();

        const text = input.value.trim();
        if (text) {
          onChat(text);
          input.value = '';
        }
      },
    },
    input,
    h('button.btn.small', { type: 'submit' }, 'Send'),
  );

  const element = h('aside.feed', null, toggle, h('div.feed-body', { id: 'feed-body' }, list, form));

  toggle.addEventListener('click', () => {
    const open = element.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
    list.scrollTop = list.scrollHeight;
  });

  let lastSeq = 0;
  // What the list shows, so it can be written out again for another deck
  const shown: FeedEntry[] = [];

  /** Changes the list, and keeps it at the bottom if that is where the reader was. */
  function keepFollowing(change: () => void): void {
    const following = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK_PX;

    change();

    if (following) {
      list.scrollTop = list.scrollHeight;
    }
  }

  const showLatest = () => {
    const newest = shown.at(-1);
    latest.replaceChildren(...(newest ? latestText(newest, deck) : []));
  };

  return {
    element,
    update(entries) {
      const fresh = entries.filter((entry) => entry.seq > lastSeq);
      if (fresh.length === 0) {
        return;
      }

      lastSeq = fresh[fresh.length - 1]!.seq;
      shown.push(...fresh);
      shown.splice(0, Math.max(0, shown.length - MAX_ENTRIES));

      keepFollowing(() => {
        list.append(...fresh.map((entry) => entryEl(entry, deck)));

        while (list.childElementCount > MAX_ENTRIES) {
          list.firstElementChild!.remove();
        }
      });
      showLatest();
    },
    showDeck(chosen) {
      const marksChange = marksCards(chosen) !== marksCards(deck);

      deck = chosen;
      // Rewriting the list has a screen reader read it all again, so only when the cards are written differently
      if (!marksChange) {
        return;
      }

      keepFollowing(() => list.replaceChildren(...shown.map((entry) => entryEl(entry, deck))));
      showLatest();
    },
  };
}
