import type { TableView } from '../../../engine/view.ts';
import { askedSays, chipsAsked } from '../../buyIns.ts';
import { h, sendingButton, sends } from '../../ui.ts';
import { frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/**
 * The chips a player has asked the host for, with the way to take the request back. The bar says what
 * was asked and opens this, so withdrawing is a button that says so and never a tap on a status. It
 * closes by itself once the host has answered.
 */
function asked(view: TableView, handlers: DialogHandlers): HTMLElement {
  return frame(
    'Add chips',
    handlers,
    h('p', null, askedSays(chipsAsked(view)!, view.config).full),
    h('p.note', null, 'The chips arrive once the host approves and the current hand is over.'),
    sendingButton('button.btn', { 'data-action': 'cancel-request' }, sends('Cancel request', 'Canceling…'), () => handlers.send({ type: 'cancelRequest' })),
  );
}

export const chipsAskedDialog: DialogKind<'chipsAsked'> = {
  kind: 'chipsAsked',
  who: (view) => chipsAsked(view) !== null,
  shows: chipsAsked,
  draw: asked,
};
