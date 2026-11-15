import { formatAmount } from '../../../engine/amounts.ts';
import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { amountField, amountOf } from '../forms.ts';
import { nightOver } from '../night.ts';
import { hostOrCohost } from '../roles.ts';
import { frame, submit } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function rebuy(view: TableView, handlers: DialogHandlers): HTMLElement {
  const seat = view.seats[view.you.seat ?? -1];
  const room = seat ? view.config.maxBuyIn - seat.stack - seat.pendingAdd : 0;

  return frame(
    'Add chips',
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => submit(event, handlers, { type: 'requestRebuy', amount: amountOf(event.target as HTMLFormElement, 'rebuy-amount', view.config) }, handlers.close),
      },
      amountField('rebuy-amount', 'Chips to add', room, view.config, 1, room, `Up to ${formatAmount(room, view.config)}, which brings you to the table maximum`),
      h('p.note', null, hostOrCohost(view) ? 'Chips arrive when the current hand is over.' : 'The host approves it, and the chips arrive when the current hand is over.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'confirm-rebuy' }, 'Add chips'),
    ),
  );
}

export const rebuyDialog: DialogKind<'rebuy'> = { kind: 'rebuy', who: (view) => !nightOver(view), draw: rebuy };
