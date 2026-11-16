import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { everyone, frame, rowActions } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/** Everyone at the table but the viewer, seated or watching, in the order of their names. */
const others = (view: TableView) => view.members.filter((member) => member.id !== view.you.id).sort((a, b) => a.name.localeCompare(b.name));

function mute(view: TableView, handlers: DialogHandlers): HTMLElement {
  const { mutes } = handlers;
  const rows = others(view).map((member) => {
    const muted = mutes.has(member.id);

    return h(
      'li',
      { 'data-muted': muted },
      h('span', null, h('b', null, member.name), muted ? h('small.mute-note', null, 'Muted') : null),
      rowActions(
        member,
        h(
          'button.btn.small',
          // One id whichever way it stands, so the keyboard stays on the switch it has just thrown
          { type: 'button', id: `mute-${member.id}`, 'data-action': muted ? 'unmute' : 'mute', 'aria-pressed': String(muted), 'aria-label': `${muted ? 'Unmute' : 'Mute'} ${member.name}`, onclick: () => mutes.set(member.id, !muted) },
          muted ? 'Unmute' : 'Mute',
        ),
      ),
    );
  });

  return frame(
    'Mute players',
    handlers,
    h('p.note', null, 'Hides their chat, their nudges and their reactions on this screen only. Nobody is told, and what they do in the game still shows.'),
    rows.length > 0 ? h('ul.rows', null, rows) : h('p.note', null, 'Nobody else is at the table yet.'),
  );
}

export const muteDialog: DialogKind<'mute'> = {
  kind: 'mute',
  menu: {
    group: 'you',
    label: 'Mute players',
    who: everyone,
    state: (view, { mutes }) => {
      const muted = others(view).filter((member) => mutes.has(member.id)).length;

      return muted > 0 ? `${muted} muted` : null;
    },
  },
  shows: (view, { mutes }) => [others(view), mutes.ids()],
  draw: mute,
};
