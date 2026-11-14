import { LIMITS } from '../../engine/validate.ts';
import { completed, completionAt } from '../mentionCompletion.ts';
import type { Completion } from '../mentionCompletion.ts';
import { h } from '../ui.ts';

export interface ChatBox {
  element: HTMLFormElement;
}

const LIST_ID = 'mention-list';

// Keys that move the caret along the line, which may take it to another name or away from any
const ALONG_THE_LINE = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);
const optionId = (index: number) => `mention-option-${index}`;

/**
 * Where a line of chat is typed and sent. Typing an @ offers the names of the people at the table that
 * fit what follows it, picked by tap or with the arrow keys and Enter or Tab. Built once and never drawn
 * again, so what is typed, the list and the caret all stay as they are whatever the table does meanwhile.
 */
/** `people` gives the names the box offers after an @, asked as the player types: everyone at the table but the viewer. */
export function createChatBox(onChat: (text: string) => void, people: () => readonly string[]): ChatBox {
  const input = h('input', {
    type: 'text',
    id: 'chat-input',
    maxlength: LIMITS.chatLength,
    placeholder: 'Say something',
    autocomplete: 'off',
    'aria-label': 'Chat message',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-controls': LIST_ID,
    'aria-expanded': 'false',
  });
  const list = h('ul.mention-list', { id: LIST_ID, role: 'listbox', 'aria-label': 'People to name', hidden: true });

  let open: Completion | null = null;
  let active = 0;

  const show = (completion: Completion | null) => {
    open = completion;
    active = 0;
    input.setAttribute('aria-expanded', String(open !== null));
    list.hidden = open === null;
    list.replaceChildren(
      ...(open?.names ?? []).map((name, index) =>
        h(
          'li',
          {
            id: optionId(index),
            role: 'option',
            // Kept from taking the keyboard from the box, so a tap leaves it up, the caret where it was and the list there to be picked from
            onpointerdown: (event: Event) => event.preventDefault(),
            onmousedown: (event: Event) => event.preventDefault(),
            onclick: () => pick(name),
          },
          name,
        ),
      ),
    );
    mark();
  };

  const mark = () => {
    list.querySelectorAll('li').forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));

    if (open) {
      input.setAttribute('aria-activedescendant', optionId(active));
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const look = () => show(input.selectionStart === input.selectionEnd ? completionAt(input.value, input.selectionStart ?? input.value.length, people()) : null);

  /** Writes the name out, or, where the line has no room for it, closes the list and leaves the line as typed. Says which. */
  const pick = (name: string): boolean => {
    const result = open && completed(input.value, input.selectionStart ?? input.value.length, open, name);

    if (result) {
      input.value = result.text;
      input.setSelectionRange(result.caret, result.caret);
      input.focus();
    }

    show(null);
    return result !== null;
  };

  input.addEventListener('input', look);
  // A caret moved by a tap or the arrow keys along the line may now be somewhere else entirely
  input.addEventListener('click', look);
  input.addEventListener('keyup', (event) => ALONG_THE_LINE.has(event.key) && look());
  input.addEventListener('blur', () => show(null));

  input.addEventListener('keydown', (event) => {
    // A key that is picking a word in an input method, as for Japanese or Chinese, is the method's
    if (!open || event.isComposing) {
      return;
    }

    const count = open.names.length;
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: count - 1 };

    if (event.key in steps) {
      active = (active + steps[event.key]!) % count;
      mark();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      // With no room for the name, the key does what it would have with no list
      if (!pick(open.names[active]!)) {
        return;
      }
    } else if (event.key === 'Escape') {
      show(null);
    } else {
      return;
    }

    event.preventDefault();
  });

  const element = h(
    'form.say',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();

        const text = input.value.trim();
        if (text) {
          onChat(text);
          input.value = '';
          show(null);
        }
      },
    },
    list,
    input,
    h('button.btn.small', { type: 'submit' }, 'Send'),
  );

  return { element };
}
