import { AUTO_SHOWS } from '../../../engine/autoShow.ts';
import type { AutoShow } from '../../../engine/types.ts';
import type { TableView } from '../../../engine/view.ts';
import { h, holdWhile } from '../../ui.ts';
import { frame, seated } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

const WORDS: Record<AutoShow, { label: string; says: string; short: [on: string, off: string] }> = {
  lost: {
    label: 'Show my losing hands',
    says: 'At a showdown, a hand that can’t win anything is turned up in its turn instead of mucked.',
    short: ['Show losers', 'Muck losers'],
  },
  foldedTo: {
    label: 'Show when everyone folds to me',
    says: 'Both cards are turned up as the hand ends, as if you pressed Show.',
    short: ['show when folded to', 'muck when folded to'],
  },
};

/** A switch for each choice, sent at each tap as the switches under the table are. */
function autoShow(view: TableView, handlers: DialogHandlers): HTMLElement {
  const switches = AUTO_SHOWS.map((when) => {
    const on = view.autoShow.includes(when);
    const words = WORDS[when];
    const button = h('button.toggle.pref', { type: 'button', role: 'switch', 'aria-checked': String(on), 'data-auto-show': when }, h('i'), h('span', null, words.label, h('small', null, words.says)));

    button.addEventListener('click', () => holdWhile(button, () => handlers.send({ type: 'setAutoShow', when, on: !on })));

    return button;
  });

  return frame('Show or muck', handlers, h('p.note', null, 'Kept with your seat until you change it, and done for you when you’re away. Only you see what you chose.'), h('section', null, switches));
}

export const autoShowDialog: DialogKind<'autoShow'> = {
  kind: 'autoShow',
  menu: {
    label: 'Show or muck',
    who: seated,
    note: (view) => AUTO_SHOWS.map((when) => WORDS[when].short[view.autoShow.includes(when) ? 0 : 1]).join(' · '),
  },
  shows: (view) => view.autoShow,
  draw: autoShow,
};
