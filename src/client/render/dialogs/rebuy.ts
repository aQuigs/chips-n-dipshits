import { formatAmount } from '../../../engine/amounts.ts';
import { SUBJECTS } from '../../../engine/subjects.ts';
import type { TableView } from '../../../engine/view.ts';
import { offeredToAdd, roomToAdd } from '../../buyIns.ts';
import { h, sends } from '../../ui.ts';
import { amountInput, amountOf, boxNamed, putAmount } from '../forms.ts';
import { nightOver } from '../night.ts';
import { hostOrCohost } from '../roles.ts';
import { frame, submit } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

const AMOUNT = 'rebuy-amount';

/**
 * Asks for more chips. The box starts on the player's own amount (`offeredToAdd`), so what a tap made in
 * haste asks for is what they would have asked for anyway; the most the table allows is a tap away.
 */
function rebuy(view: TableView, handlers: DialogHandlers): HTMLElement {
  const room = roomToAdd(view);
  const offered = offeredToAdd(view);
  const most = formatAmount(room, view.config);
  const box = amountInput(AMOUNT, offered, view.config, 1, room);

  const fillInMost = (): void => {
    putAmount(box, room, view.config);
    // As if typed, so the box is checked again the way it always is
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };

  return frame(
    'Add chips',
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => submit(event, handlers, { type: 'requestRebuy', amount: amountOf(event.target as HTMLFormElement, AMOUNT, view.config) }, boxNamed(box, SUBJECTS.chipsAdded)),
      },
      h(
        'div.field',
        null,
        h('label', { for: AMOUNT }, 'Chips to add'),
        h('div.amount-with-most', null, box, offered < room ? h('button.chip-btn', { type: 'button', 'data-action': 'rebuy-most', 'aria-label': `Max, ${most}`, onclick: fillInMost }, 'Max') : null),
        h('small', null, `Up to ${most}, which brings you to the table maximum`),
      ),
      h('p.note', null, hostOrCohost(view) ? 'Chips arrive when the current hand is over.' : 'The host approves it, and the chips arrive when the current hand is over.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'confirm-rebuy' }, sends('Add chips', hostOrCohost(view) ? 'Adding…' : 'Asking the host…')),
    ),
  );
}

export const rebuyDialog: DialogKind<'rebuy'> = { kind: 'rebuy', who: (view) => !nightOver(view), draw: rebuy };
