import type { TableView } from '../../../engine/view.ts';
import { chips, h } from '../../ui.ts';
import { numberField, numberOf } from '../forms.ts';
import { frame, hostOrCohost, submit } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function sit(view: TableView, seat: number, handlers: DialogHandlers): HTMLElement {
  const { minBuyIn, maxBuyIn, bigBlind } = view.config;
  const suggested = Math.min(maxBuyIn, Math.max(minBuyIn, bigBlind * 100));

  return frame(
    `Take seat ${seat + 1}`,
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => submit(event, handlers, { type: 'requestSeat', seat, buyIn: numberOf(event.target as HTMLFormElement, 'buy-in') }, handlers.close),
      },
      numberField('buy-in', 'Buy-in', suggested, minBuyIn, maxBuyIn, `From ${chips(minBuyIn)} to ${chips(maxBuyIn)} chips`),
      hostOrCohost(view) ? null : h('p.note', null, 'The host approves seats, so you sit down once they say yes.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'confirm-sit' }, 'Sit down'),
    ),
  );
}

export const sitDialog: DialogKind<'sit', { seat: number }> = {
  kind: 'sit',
  draw: (view, handlers, { seat }) => sit(view, seat, handlers),
};
