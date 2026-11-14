import { formatAmount } from '../../../engine/amounts.ts';
import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { roleOf } from '../../../engine/hosts.ts';
import { hostAlone, hostOrCohost, roleMark } from '../roles.ts';
import { frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function players(view: TableView, handlers: DialogHandlers): HTMLElement {
  const requests = view.requests.map((request) =>
    h(
      'li',
      null,
      h('span', null, h('b', null, request.name), request.kind === 'seat' ? ` wants seat ${request.seat + 1} with ${formatAmount(request.amount, view.config)}` : ` wants to add ${formatAmount(request.amount, view.config)}`),
      h(
        'span.row-actions',
        null,
        h('button.btn.small.primary', { type: 'button', 'data-action': 'approve', onclick: () => void handlers.send({ type: 'approve', playerId: request.playerId }) }, 'Approve'),
        h('button.btn.small', { type: 'button', 'data-action': 'deny', onclick: () => void handlers.send({ type: 'deny', playerId: request.playerId }) }, 'Deny'),
      ),
    ),
  );

  // Who runs the table is the host's choice alone, and nobody is offered a say over their own role
  const roleButtons = (playerId: string, name: string) => {
    if (!hostAlone(view) || playerId === view.you.id) {
      return [];
    }

    const cohost = roleOf(view, playerId) === 'cohost'
      ? h('button.btn.small', { type: 'button', 'data-action': 'end-cohost', onclick: () => void handlers.send({ type: 'setCohost', playerId, on: false }) }, 'End co-host')
      : h(
          'button.btn.small',
          {
            type: 'button',
            'data-action': 'make-cohost',
            onclick: () =>
              handlers.open({
                kind: 'confirm',
                title: `Make ${name} a co-host?`,
                body: 'They can approve players, start and pause the game, change settings, adjust stacks and remove players, just as you can. You can end it at any time.',
                action: 'Make co-host',
                command: { type: 'setCohost', playerId, on: true },
              }),
          },
          'Make co-host',
        );

    const makeHost = h(
      'button.btn.small',
      {
        type: 'button',
        'data-action': 'make-host',
        onclick: () =>
          handlers.open({
            kind: 'confirm',
            title: `Make ${name} the host?`,
            body: 'They take over the table, and you stay on as a co-host until they say otherwise.',
            action: 'Hand over',
            command: { type: 'transferHost', playerId },
          }),
      },
      'Make host',
    );

    return [cohost, makeHost];
  };

  // A co-host may not remove the host, nor take another co-host off the table, which would end their role
  const remove = (playerId: string, name: string, body: string, altogether: boolean) =>
    !hostAlone(view) && (roleOf(view, playerId) === 'host' || (altogether && roleOf(view, playerId) === 'cohost'))
      ? null
      : h(
          'button.btn.small',
          {
            type: 'button',
            'data-action': 'remove',
            onclick: () => handlers.open({ kind: 'confirm', title: `Remove ${name}?`, body, action: 'Remove', command: { type: 'kick', playerId } }),
          },
          'Remove',
        );

  const nameOf = (playerId: string, name: string) => h('b', null, name, roleMark(view, playerId));

  const seatedIds = new Set(view.seats.flatMap((seat) => (seat ? [seat.playerId] : [])));
  const seated = view.seats.flatMap((seat) =>
    seat
      ? [
          h(
            'li',
            null,
            h('span', null, nameOf(seat.playerId, seat.name), ` · seat ${seat.seat + 1} · ${formatAmount(seat.stack, view.config)}`),
            h(
              'span.row-actions',
              null,
              h('button.btn.small', { type: 'button', 'data-action': 'set-stack', onclick: () => handlers.open({ kind: 'setStack', playerId: seat.playerId }) }, 'Set stack'),
              roleButtons(seat.playerId, seat.name),
              remove(seat.playerId, seat.name, 'They lose their seat and their chips are cashed out in the ledger. They can ask for a seat again.', false),
            ),
          ),
        ]
      : [],
  );

  const watching = view.members.filter((member) => !seatedIds.has(member.id) && member.id !== view.you.id);

  // Only someone with no line in the ledger can be taken off the table altogether
  const played = new Set(view.ledger.map((row) => row.playerId));
  const watcherRow = (playerId: string, name: string) =>
    h(
      'li',
      null,
      h('span', null, nameOf(playerId, name)),
      h(
        'span.row-actions',
        null,
        roleButtons(playerId, name),
        played.has(playerId) ? null : remove(playerId, name, 'They have not played here, so they are taken off the table and their name is free again. They can join again from the link.', true),
      ),
    );

  return frame(
    'Players',
    handlers,
    requests.length > 0 ? h('section', null, h('h3', null, 'Waiting for you'), h('ul.rows', null, requests)) : null,
    h('section', null, h('h3', null, 'Seated'), seated.length > 0 ? h('ul.rows', null, seated) : h('p.note', null, 'Nobody is seated yet.')),
    watching.length > 0 ? h('section', null, h('h3', null, 'Watching'), h('ul.rows', null, watching.map((member) => watcherRow(member.id, member.name)))) : null,
  );
}

export const playersDialog: DialogKind<'players'> = {
  kind: 'players',
  menu: {
    label: 'Players',
    who: hostOrCohost,
    note: (view) => (view.requests.length > 0 ? `${view.requests.length} waiting for you` : 'Approve, adjust stacks, remove'),
  },
  // Stacks move with every bet. Redrawn that often, a button here would be gone before a tap on it landed,
  // so during a hand the list keeps the stacks it was drawn with
  shows: (view) => [
    view.requests,
    view.members,
    view.hostId,
    view.cohostIds,
    view.hand?.number,
    view.seats.map((seat) => seat && [seat.playerId, seat.name, seat.seat, view.hand ? null : seat.stack]),
  ],
  draw: players,
};
