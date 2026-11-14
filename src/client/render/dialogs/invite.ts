import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { copyOnClick, everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function copyRow(id: string, label: string, value: string, handlers: DialogHandlers, warning?: string): HTMLElement {
  const input = h('input', { type: 'text', id, readonly: true, value, onfocus: (event: Event) => (event.target as HTMLInputElement).select() });
  const button = h('button.btn.small.primary', { type: 'button' }, 'Copy');

  copyOnClick(button, input, () => value, handlers);

  return h('div.field', null, h('label', { for: id }, label), h('div.copy', null, input, button), warning ? h('small', null, warning) : null);
}

function invite(view: TableView, handlers: DialogHandlers): HTMLElement {
  return frame(
    'Invite players',
    handlers,
    copyRow('table-link', 'Send this link to your friends', handlers.tableLink(), handlers),
    h('p.note', null, `Or tell them the table code: `, h('b.code', null, view.id)),
    copyRow('member-link', 'Your own link, to carry on from another phone or computer', handlers.memberLink(), handlers, 'Keep this one to yourself: whoever opens it plays as you.'),
  );
}

export const inviteDialog: DialogKind<'invite'> = {
  kind: 'invite',
  menu: { label: 'Invite players', who: everyone },
  draw: invite,
};
