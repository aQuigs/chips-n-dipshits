import type { TableView } from '../../../engine/view.ts';
import { chips, h } from '../../ui.ts';
import { frame, theHost } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function players(view: TableView, handlers: DialogHandlers): HTMLElement {
  const requests = view.requests.map((request) =>
    h(
      'li',
      null,
      h('span', null, h('b', null, request.name), request.kind === 'seat' ? ` wants seat ${request.seat + 1} with ${chips(request.amount)}` : ` wants to add ${chips(request.amount)}`),
      h(
        'span.row-actions',
        null,
        h('button.btn.small.primary', { type: 'button', 'data-action': 'approve', onclick: () => void handlers.send({ type: 'approve', playerId: request.playerId }) }, 'Approve'),
        h('button.btn.small', { type: 'button', 'data-action': 'deny', onclick: () => void handlers.send({ type: 'deny', playerId: request.playerId }) }, 'Deny'),
      ),
    ),
  );

  const seatedIds = new Set(view.seats.flatMap((seat) => (seat ? [seat.playerId] : [])));
  const makeHost = (playerId: string, name: string) =>
    h(
      'button.btn.small',
      {
        type: 'button',
        onclick: () =>
          handlers.open({
            kind: 'confirm',
            title: `Make ${name} the host?`,
            body: 'They take over approving players and changing settings, and you become a regular player.',
            action: 'Hand over',
            command: { type: 'transferHost', playerId },
          }),
      },
      'Make host',
    );

  const seated = view.seats.flatMap((seat) =>
    seat
      ? [
          h(
            'li',
            null,
            h('span', null, h('b', null, seat.name), ` · seat ${seat.seat + 1} · ${chips(seat.stack)}`),
            h(
              'span.row-actions',
              null,
              h('button.btn.small', { type: 'button', onclick: () => handlers.open({ kind: 'setStack', playerId: seat.playerId }) }, 'Set stack'),
              seat.playerId === view.you.id ? null : makeHost(seat.playerId, seat.name),
              h(
                'button.btn.small',
                {
                  type: 'button',
                  onclick: () =>
                    handlers.open({
                      kind: 'confirm',
                      title: `Remove ${seat.name}?`,
                      body: 'They lose their seat and their chips are cashed out in the ledger. They can ask for a seat again.',
                      action: 'Remove',
                      command: { type: 'kick', playerId: seat.playerId },
                    }),
                },
                'Remove',
              ),
            ),
          ),
        ]
      : [],
  );

  const watching = view.members.filter((member) => !seatedIds.has(member.id) && member.id !== view.you.id);

  // Only someone with no line in the ledger can be taken off the table altogether
  const played = new Set(view.ledger.map((row) => row.playerId));
  const removeWatcher = (playerId: string, name: string) =>
    h(
      'button.btn.small',
      {
        type: 'button',
        onclick: () =>
          handlers.open({
            kind: 'confirm',
            title: `Remove ${name}?`,
            body: 'They have not played here, so they are taken off the table and their name is free again. They can join again from the link.',
            action: 'Remove',
            command: { type: 'kick', playerId },
          }),
      },
      'Remove',
    );

  return frame(
    'Players',
    handlers,
    requests.length > 0 ? h('section', null, h('h3', null, 'Waiting for you'), h('ul.rows', null, requests)) : null,
    h('section', null, h('h3', null, 'Seated'), seated.length > 0 ? h('ul.rows', null, seated) : h('p.note', null, 'Nobody is seated yet.')),
    watching.length > 0
      ? h('section', null, h('h3', null, 'Watching'), h('ul.rows', null, watching.map((member) => h('li', null, h('span', null, h('b', null, member.name)), h('span.row-actions', null, makeHost(member.id, member.name), played.has(member.id) ? null : removeWatcher(member.id, member.name))))))
      : null,
  );
}

export const playersDialog: DialogKind<'players'> = {
  kind: 'players',
  menu: {
    label: 'Players',
    who: theHost,
    note: (view) => (view.requests.length > 0 ? `${view.requests.length} waiting for you` : 'Approve, adjust stacks, remove'),
  },
  // Stacks move with every bet. Redrawn that often, a button here would be gone before a tap on it landed,
  // so during a hand the list keeps the stacks it was drawn with
  shows: (view) => [view.requests, view.members, view.hostId, view.hand?.number, view.seats.map((seat) => seat && [seat.playerId, seat.name, seat.seat, view.hand ? null : seat.stack])],
  draw: players,
};
