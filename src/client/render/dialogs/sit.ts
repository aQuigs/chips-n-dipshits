import { formatAmount } from '../../../engine/amounts.ts';
import { SUBJECTS } from '../../../engine/subjects.ts';
import type { TableView } from '../../../engine/view.ts';
import { suggestedBuyIn } from '../../buyIns.ts';
import { h, sends } from '../../ui.ts';
import { amountField, amountOf, boxNamed, inputOf } from '../forms.ts';
import { nightOver } from '../night.ts';
import { hostOrCohost } from '../roles.ts';
import { frame, submit } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function sit(view: TableView, seat: number, handlers: DialogHandlers): HTMLElement {
  const { minBuyIn, maxBuyIn, unit } = view.config;

  return frame(
    `Take seat ${seat + 1}`,
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => {
          const form = event.target as HTMLFormElement;

          submit(event, handlers, { type: 'requestSeat', seat, buyIn: amountOf(form, 'buy-in', view.config) }, boxNamed(inputOf(form, 'buy-in'), SUBJECTS.buyIn));
        },
      },
      amountField('buy-in', 'Buy-in', suggestedBuyIn(view.config), view.config, minBuyIn, maxBuyIn, `From ${formatAmount(minBuyIn, view.config)} to ${formatAmount(maxBuyIn, view.config)}${unit === 'chips' ? ' chips' : ''}`),
      hostOrCohost(view) ? null : h('p.note', null, 'The host approves seats, so you sit down once they say yes.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'confirm-sit' }, sends('Sit down', hostOrCohost(view) ? 'Sitting down…' : 'Asking the host…')),
    ),
  );
}

export const sitDialog: DialogKind<'sit', { seat: number }> = {
  kind: 'sit',
  who: (view) => !nightOver(view),
  draw: (view, handlers, { seat }) => sit(view, seat, handlers),
};
