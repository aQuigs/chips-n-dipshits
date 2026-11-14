import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { amountField, amountOf, inputOf, pickField } from '../forms.ts';
import { hostOrCohost } from '../roles.ts';
import { frame, submit } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function transfer(view: TableView, handlers: DialogHandlers): HTMLElement {
  const players = view.seats.flatMap((seat) => (seat && !seat.leaving ? [{ value: seat.playerId, label: seat.name }] : []));

  const send = (event: Event) => {
    const form = event.target as HTMLFormElement;
    const command = { type: 'transferChips', from: inputOf(form, 'transfer-from').value, to: inputOf(form, 'transfer-to').value, amount: amountOf(form, 'transfer-amount', view.config) } as const;

    submit(event, handlers, command, () => handlers.open({ kind: 'players' }));
  };

  return frame(
    'Transfer chips',
    handlers,
    h(
      'form',
      { onsubmit: send },
      pickField('transfer-from', 'From', 'Who gives the chips', players),
      pickField('transfer-to', 'To', 'Who gets them', players),
      amountField('transfer-amount', 'Chips', null, view.config, 1),
      h('p.note', null, 'Neither player can be in the hand being played. Everyone sees it in the chat, and in the ledger the chips count as lost by one player and won by the other.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'confirm-transfer' }, 'Transfer chips'),
    ),
  );
}

export const transferDialog: DialogKind<'transfer'> = { kind: 'transfer', who: hostOrCohost, draw: transfer };
