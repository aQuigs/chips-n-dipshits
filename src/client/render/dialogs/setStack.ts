import { SUBJECTS } from '../../../engine/subjects.ts';
import type { TableView } from '../../../engine/view.ts';
import { h, sends } from '../../ui.ts';
import { amountField, amountOf, boxNamed, inputOf } from '../forms.ts';
import { hostOrCohost } from '../roles.ts';
import { frame, submit } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function setStack(view: TableView, playerId: string, handlers: DialogHandlers): HTMLElement {
  const seat = view.seats.find((s) => s?.playerId === playerId);

  return frame(
    `Set ${seat?.name ?? 'player'}'s stack`,
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => {
          const form = event.target as HTMLFormElement;

          submit(event, handlers, { type: 'setStack', playerId, stack: amountOf(form, 'new-stack', view.config) }, boxNamed(inputOf(form, 'new-stack'), SUBJECTS.stack));
        },
      },
      amountField('new-stack', 'Chips', seat?.stack ?? 0, view.config, 0, undefined, 'The difference counts as chips bought or cashed out, so the ledger still adds up. Only works between hands.'),
      h('button.btn.primary', { type: 'submit' }, sends('Set stack', 'Setting…')),
    ),
  );
}

export const setStackDialog: DialogKind<'setStack', { playerId: string }> = {
  kind: 'setStack',
  who: hostOrCohost,
  draw: (view, handlers, { playerId }) => setStack(view, playerId, handlers),
};
