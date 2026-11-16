import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { frame, linkToCopy } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/**
 * The table's link and nothing that is one member's: the dialog is used in a hurry, with people waiting
 * to get in, and whatever it holds gets sent to them. A member's own link has a dialog to itself
 * (`otherDevice.ts`).
 */
function invite(view: TableView, handlers: DialogHandlers): HTMLElement {
  return frame(
    'Invite players',
    handlers,
    linkToCopy({ id: 'table-link', label: 'Send this link to your friends', link: handlers.tableLink(), copies: 'Copy invite link', main: true }, handlers),
    h('p.note', null, `Or tell them the table code: `, h('b.code', null, view.id)),
  );
}

/** Opened from the top bar, which has its button on every screen and in every state of the table, so the menu has no line for it. */
export const inviteDialog: DialogKind<'invite'> = {
  kind: 'invite',
  draw: invite,
};
