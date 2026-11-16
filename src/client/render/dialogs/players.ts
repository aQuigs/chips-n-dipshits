import { formatAmount } from '../../../engine/amounts.ts';
import type { SeatView, TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import type { Child } from '../../ui.ts';
import { roleOf } from '../../../engine/hosts.ts';
import { requestText } from '../../spoken.ts';
import { badgeMarks } from '../badges.ts';
import { hostAlone, hostOrCohost, roleMark } from '../roles.ts';
import { frame, rowActions } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

interface Player {
  id: string;
  name: string;
}

/**
 * The rows that are unfolded, for each opening of the dialog. Drawn again with the table's news, or
 * come back to from a question, it is the same list with the same rows open; opened anew, every row
 * is folded again, and what removes a player or gives the table away is put away with it.
 */
const UNFOLDED = new WeakMap<object, Set<string>>();

function unfoldedIn(opening: object): Set<string> {
  const unfolded = UNFOLDED.get(opening) ?? new Set<string>();

  UNFOLDED.set(opening, unfolded);

  return unfolded;
}

function players(view: TableView, handlers: DialogHandlers, unfolded: Set<string>): HTMLElement {
  const requests = view.requests.map((request) =>
    h(
      'li',
      null,
      h('span.who', null, h('b', null, request.name), ` ${requestText(request, view.config)}`),
      rowActions(
        { id: request.playerId, name: request.name },
        h('button.btn.small.primary', { type: 'button', 'data-action': 'approve', onclick: () => void handlers.send({ type: 'approve', playerId: request.playerId }) }, 'Approve'),
        h('button.btn.small', { type: 'button', 'data-action': 'deny', onclick: () => void handlers.send({ type: 'deny', playerId: request.playerId }) }, 'Deny'),
      ),
    ),
  );

  // Who runs the table is the host's choice alone, and nobody is offered a say over their own role
  const roleButtons = ({ id: playerId, name }: Player) => {
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
                body: 'They can approve players, start and pause the game, change settings, adjust stacks, transfer chips between players and remove players, just as you can. You can end it at any time.',
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
            danger: true,
          }),
      },
      'Make host',
    );

    return [cohost, makeHost];
  };

  // A co-host may not remove the host, nor take another co-host off the table, which would end their role. And nobody
  // is offered to remove themselves: standing up is theirs, in the menu
  const remove = ({ id: playerId, name }: Player, body: string, altogether: boolean) =>
    playerId === view.you.id || (!hostAlone(view) && (roleOf(view, playerId) === 'host' || (altogether && roleOf(view, playerId) === 'cohost')))
      ? null
      : h(
          'button.btn.small.danger',
          {
            type: 'button',
            'data-action': 'remove',
            onclick: () => handlers.open({ kind: 'confirm', title: `Remove ${name}?`, body, action: 'Remove', command: { type: 'kick', playerId }, danger: true }),
          },
          'Remove',
        );

  const rowsDrawn = new Set<string>();

  /** Makes `behind` the part of `row` that one "More" unfolds in place, and hands back that "More". */
  const unfolds = (row: string, behind: HTMLElement): HTMLElement => {
    behind.id = `more-${row}`;
    behind.classList.add('row-more');
    behind.hidden = !unfolded.has(row);
    rowsDrawn.add(row);

    const toggle = h('button.btn.small', { type: 'button', 'data-action': 'more', 'aria-expanded': String(!behind.hidden), 'aria-controls': behind.id }, 'More');

    toggle.addEventListener('click', () =>
      // Unfolding makes a sheet taller or scrolls its list, and either brings these buttons up where "More" was tapped
      handlers.byThePlayer(() => {
        behind.hidden = !behind.hidden;
        toggle.setAttribute('aria-expanded', String(!behind.hidden));

        if (behind.hidden) {
          unfolded.delete(row);
        } else {
          unfolded.add(row);
          // At the foot of what scrolls they would unfold out of sight, and "More" would seem to do nothing: the whole row, with the room under it
          behind.parentElement?.scrollIntoView({ block: 'nearest' });
        }
      }),
    );

    return toggle;
  };

  /**
   * A player's row: who they are, what is done to them every night, and what is done once a night at most, or once ever,
   * behind "More", with no "More" when there is nothing to put behind it. A player's row in one list is not theirs in the
   * other, which starts folded.
   */
  const playerRow = (list: 'seated' | 'watching', player: Player, who: Child[], everyNight: Child[], rare: Child[]): HTMLElement => {
    const behind = rowActions(player, ...rare);
    const toggle = behind.childElementCount > 0 ? unfolds(`${list}-${player.id}`, behind) : null;

    return h(`li.player-row.${list}`, null, h('span.who', null, who), rowActions(player, ...everyNight, toggle), toggle && behind);
  };

  const badges = new Map(view.tonight.players.map((row) => [row.playerId, row.badges]));

  const nameOf = ({ id, name }: Player) => [h('b', null, name, roleMark(view, id)), badgeMarks(badges.get(id) ?? [])];

  // Only to an open seat, not for a player already on their way out, and not while a shuffle is coming. A move that waits can be taken back
  const move = (seat: SeatView) => {
    if (seat.moveTo !== null) {
      return h('button.btn.small', { type: 'button', 'data-action': 'keep-seat', onclick: () => void handlers.send({ type: 'moveSeat', playerId: seat.playerId, seat: seat.seat }) }, 'Stay put');
    }

    return view.seats.includes(null) && !seat.leaving && !view.shuffleAfterHand
      ? h('button.btn.small', { type: 'button', 'data-action': 'move', onclick: () => handlers.pickSeat(seat.playerId) }, 'Move')
      : null;
  };

  const owes = (seat: SeatView) => [seat.owesBigBlind ? 'the big blind' : '', seat.owesSmallBlind ? 'the small blind' : ''].filter(Boolean).join(' and ');

  const seats = view.seats.filter((seat) => seat !== null);
  const seated = seats.map((seat) => {
    const player = { id: seat.playerId, name: seat.name };
    const owing = owes(seat);

    return playerRow(
      'seated',
      player,
      [
        nameOf(player),
        ` · seat ${seat.seat + 1} · ${formatAmount(seat.stack, view.config)}`,
        seat.moveTo !== null ? h('small.move-note', null, `Moves to seat ${seat.moveTo + 1} after this hand`) : null,
        owing ? h('small.owes-note', null, `Owes ${owing}`) : null,
      ],
      [
        h('button.btn.small', { type: 'button', 'data-action': 'set-stack', onclick: () => handlers.open({ kind: 'setStack', playerId: player.id }) }, 'Set stack'),
        move(seat),
        owing ? h('button.btn.small', { type: 'button', 'data-action': 'forgive-blinds', onclick: () => void handlers.send({ type: 'forgiveBlinds', playerId: player.id }) }, 'Forgive blinds') : null,
      ],
      [roleButtons(player), remove(player, 'They lose their seat and their chips are cashed out in the ledger. They can ask for a seat again.', false)],
    );
  });

  const seatedIds = new Set(seats.map((seat) => seat.playerId));
  // Only someone with no line in the ledger can be taken off the table altogether
  const played = new Set(view.ledger.map((row) => row.playerId));
  const watchers = view.members
    .filter((member) => !seatedIds.has(member.id) && member.id !== view.you.id)
    .map((member) =>
      playerRow('watching', member, [nameOf(member)], [], [
        roleButtons(member),
        played.has(member.id) ? null : remove(member, 'They have not played here, so they are taken off the table and their name is free again. They can join again from the link.', true),
      ]),
    );

  // A row is folded again once its player has left it: back in the same list later, they are not found open
  for (const row of unfolded) {
    if (!rowsDrawn.has(row)) {
      unfolded.delete(row);
    }
  }

  // What is done to the whole table stands over the list it is done to, in reach before any scrolling
  const tools = [
    seats.filter((seat) => !seat.leaving).length > 1 ? h('button.btn.small', { type: 'button', 'data-action': 'transfer', onclick: () => handlers.open({ kind: 'transfer' }) }, 'Transfer chips') : null,
    seated.length > 1
      ? h(
          'button.btn.small',
          {
            type: 'button',
            'data-action': 'shuffle',
            onclick: () =>
              handlers.open({
                kind: 'confirm',
                title: 'Shuffle the seats?',
                body: 'Everyone seated gets a random seat among those taken, with their chips. The open seats stay open, and the dealer button is drawn again for the next hand. During a hand, this happens when it ends.',
                action: 'Shuffle',
                command: { type: 'shuffleSeats' },
              }),
          },
          'Shuffle seats',
        )
      : null,
    view.shuffleAfterHand ? h('small.note.shuffle-note', null, 'The seats are shuffled after this hand') : null,
  ].filter((tool) => tool !== null);

  // Whoever runs the table is the one who can ask a player to say who they are, so that their night counts for them.
  // Said once and last, where it moves nothing the host reaches for
  const unknown = view.members.filter((member) => member.identity === null).map((member) => member.name);
  const unknownNote = unknown.length > 0 ? h('p.note.unknown-players', null, `Not on the list of players: ${unknown.join(', ')}. Each can say who they are under “Who you are” in the menu.`) : null;

  return frame(
    'Players',
    handlers,
    requests.length > 0 ? h('section', null, h('h3', null, 'Waiting for you'), h('ul.rows', null, requests)) : null,
    h(
      'section',
      null,
      h('h3', null, 'Seated'),
      tools.length > 0 ? h('div.list-tools', null, tools) : null,
      seated.length > 0 ? h('ul.rows', null, seated) : h('p.note', null, 'Nobody is seated yet.'),
    ),
    watchers.length > 0 ? h('section', null, h('h3', null, 'Watching'), h('ul.rows', null, watchers)) : null,
    unknownNote,
  );
}

export const playersDialog: DialogKind<'players'> = {
  kind: 'players',
  menu: {
    group: 'run',
    label: 'Players',
    who: hostOrCohost,
    state: (view) => (view.requests.length > 0 ? `${view.requests.length} waiting for you` : null),
  },
  // A host works down the list: a co-host named, then a player removed, with the list still there between the two
  comesBack: true,
  // Stacks move with every bet. Redrawn that often, a button here would be gone before a tap on it landed,
  // so during a hand the list keeps the stacks it was drawn with
  shows: (view) => [
    view.requests,
    view.members,
    view.hostId,
    view.cohostIds,
    view.hand?.number,
    view.shuffleAfterHand,
    view.tonight.players.map((row) => [row.playerId, row.badges]),
    view.seats.map((seat) => seat && [seat.playerId, seat.name, seat.seat, seat.moveTo, seat.leaving, seat.owesBigBlind, seat.owesSmallBlind, view.hand ? null : seat.stack]),
  ],
  draw: (view, handlers, opening) => players(view, handlers, unfoldedIn(opening as object)),
};
