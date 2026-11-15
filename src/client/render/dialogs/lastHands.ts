import type { Command } from '../../../engine/types.ts';
import { LIMITS } from '../../../engine/validate.ts';
import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { lastHandsText, nightOver } from '../night.ts';
import { hostOrCohost } from '../roles.ts';
import { frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/**
 * How many hands are left tonight, picked with one tap, or called off; and ending the night outright,
 * which can only be done between hands. During a hand the count is of hands after it, and the hand on
 * the table can itself be made the last.
 */
function lastHands(view: TableView, handlers: DialogHandlers): HTMLElement {
  const send = (command: Command) => {
    void handlers.send(command);
    handlers.close();
  };
  const choice = (hands: number, label: string) =>
    h('button.chip-btn', { type: 'button', 'data-hands': hands, 'aria-pressed': String(view.handsLeft === hands), onclick: () => send({ type: 'setLastHands', hands, from: view.handCount }) }, label);
  const counts = Array.from({ length: LIMITS.lastHands }, (_, index) => choice(index + 1, String(index + 1)));

  return frame(
    'Last hands',
    handlers,
    h('p', null, view.hand ? 'How many more hands after this one? The night is over once they are played.' : 'How many more hands? The night is over once they are played.'),
    view.hand ? h('div.this-hand', null, choice(0, 'This hand is the last')) : null,
    h('div.hand-counts', { role: 'group', 'aria-label': 'Hands left' }, counts),
    h(
      'div.buttons',
      null,
      view.handsLeft === null ? null : h('button.btn', { type: 'button', 'data-action': 'call-off-last-hands', onclick: () => send({ type: 'setLastHands', hands: null }) }, 'Call it off'),
      view.hand
        ? null
        : h(
            'button.btn.danger',
            {
              type: 'button',
              'data-action': 'end-night',
              onclick: () =>
                handlers.open({
                  kind: 'confirm',
                  title: 'End the night?',
                  body: 'No more hands are dealt. Chips, the ledger and cashing out still work, and play can start again from the menu.',
                  action: 'End the night',
                  command: { type: 'endNight' },
                }),
            },
            'End the night now',
          ),
    ),
  );
}

export const lastHandsDialog: DialogKind<'lastHands'> = {
  kind: 'lastHands',
  menu: {
    label: 'Last hands',
    who: (view) => hostOrCohost(view) && !nightOver(view),
    note: (view) => lastHandsText(view) ?? 'Call how many hands are left, or end the night',
  },
  // The hand on the table is what the count is from, so a new one is a new dialog
  shows: (view) => [view.hand !== null, view.handCount, view.handsLeft],
  draw: lastHands,
};
