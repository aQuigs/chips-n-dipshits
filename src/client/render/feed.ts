import type { FeedEntry } from '../../engine/types.ts';
import { h } from '../ui.ts';

const CHAT_LENGTH = 200;

// How close to the bottom still counts as following the conversation
const FOLLOW_SLACK_PX = 40;

// The page stays open for hours, so the list keeps only its tail
const MAX_ENTRIES = 300;

export interface Feed {
  element: HTMLElement;
  update(entries: readonly FeedEntry[]): void;
}

function entryEl(entry: FeedEntry): HTMLElement {
  if (entry.kind === 'chat') {
    return h('li', { 'data-kind': entry.kind }, h('b', null, `${entry.from}: `), entry.text);
  }

  return h('li', { 'data-kind': entry.kind }, entry.text);
}

/**
 * The dealer's play-by-play and the table chat in one list. Built once and updated in place, so what
 * someone is typing and where they have scrolled to both survive new entries arriving.
 */
export function createFeed(onChat: (text: string) => void): Feed {
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

  return {
    element,
    update(entries) {
      const fresh = entries.filter((entry) => entry.seq > lastSeq);
      if (fresh.length === 0) {
        return;
      }

      const following = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK_PX;

      for (const entry of fresh) {
        list.appendChild(entryEl(entry));
      }

      lastSeq = fresh[fresh.length - 1]!.seq;

      while (list.childElementCount > MAX_ENTRIES) {
        list.firstElementChild!.remove();
      }

      const newest = entries[entries.length - 1]!;
      latest.textContent = newest.kind === 'chat' ? `${newest.from}: ${newest.text}` : newest.text;

      if (following) {
        list.scrollTop = list.scrollHeight;
      }
    },
  };
}
