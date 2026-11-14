import type { FeedEntry } from '../../engine/types.ts';
import { cardText, h } from '../ui.ts';

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
  let shown: FeedEntry[] = [];
  let newest: FeedEntry | null = null;

  return {
    element,
    update(entries) {
      const fresh = entries.filter((entry) => entry.seq > lastSeq);
      if (fresh.length === 0) {
        return;
      }

      const following = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK_PX;

      for (const entry of fresh) {
        list.appendChild(entryEl(entry, deck));
      }

      lastSeq = fresh[fresh.length - 1]!.seq;
      shown = [...shown, ...fresh].slice(-MAX_ENTRIES);

      while (list.childElementCount > MAX_ENTRIES) {
        list.firstElementChild!.remove();
      }

      newest = entries[entries.length - 1]!;
      latest.replaceChildren(...latestText(newest, deck));

      if (following) {
        list.scrollTop = list.scrollHeight;
      }
    },
    showDeck(chosen) {
      const following = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK_PX;

      deck = chosen;
      list.replaceChildren(...shown.map((entry) => entryEl(entry, deck)));
      latest.replaceChildren(...(newest ? latestText(newest, deck) : []));

      if (following) {
        list.scrollTop = list.scrollHeight;
      }
    },
  };
}
