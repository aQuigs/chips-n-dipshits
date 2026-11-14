import { formatAmount } from '../../../engine/amounts.ts';
import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { amountField, amountOf } from '../forms.ts';
import { nightOver } from '../night.ts';
import { hostOrCohost } from '../roles.ts';
import { frame, submit } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function sit(view: TableView, seat: number, handlers: DialogHandlers): HTMLElement {
  const { minBuyIn, maxBuyIn, bigBlind, unit } = view.config;
  const suggested = Math.min(maxBuyIn, Math.max(minBuyIn, bigBlind * 100));

  return frame(
    `Take seat ${seat + 1}`,
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => submit(event, handlers, { type: 'requestSeat', seat, buyIn: amountOf(event.target as HTMLFormElement, 'buy-in', view.config) }, handlers.close),
      },
      amountField('buy-in', 'Buy-in', suggested, view.config, minBuyIn, maxBuyIn, `From ${formatAmount(minBuyIn, view.config)} to ${formatAmount(maxBuyIn, view.config)}${unit === 'chips' ? ' chips' : ''}`),
      hostOrCohost(view) ? null : h('p.note', null, 'The host approves seats, so you sit down once they say yes.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'confirm-sit' }, 'Sit down'),
    ),
  );
}

export const sitDialog: DialogKind<'sit', { seat: number }> = {
  kind: 'sit',
  who: (view) => !nightOver(view),
  draw: (view, handlers, { seat }) => sit(view, seat, handlers),
};
