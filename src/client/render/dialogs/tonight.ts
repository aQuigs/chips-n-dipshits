import { formatAmount, signedAmount } from '../../../engine/amounts.ts';
import { prettyCards } from '../../../engine/cards.ts';
import type { Card } from '../../../engine/cards.ts';
import type { TonightRow } from '../../../engine/tonight.ts';
import type { TableView } from '../../../engine/view.ts';
import { countsOf, crownOf, leadersOf, missedOf, standingOf, tonightText } from '../../tonightText.ts';
import { cardText, h } from '../../ui.ts';
import { nightOver } from '../night.ts';
import { copyOnClick, everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

// The players whose line is unfolded. Kept here, not in the dialog, which is drawn again whenever a
// hand ends: a line someone is reading would otherwise fold shut under them
const unfolded = new Set<string>();

const cardsEl = (cards: Card[], handlers: DialogHandlers): HTMLElement => h('span.tonight-cards', null, cardText(prettyCards(cards), handlers.prefs.get('deck')));

function crownEl(view: TableView): HTMLElement | null {
  const crown = crownOf(view);

  return crown && h('div.tonight-crown', null, h('h3', null, crown.title), crown.names ? h('strong', null, crown.names) : null, h('p', null, crown.line));
}

function leadersEl(view: TableView, handlers: DialogHandlers): HTMLElement | null {
  const leaders = leadersOf(view);
  if (leaders.length === 0) {
    return null;
  }

  return h(
    'dl.tonight-leaders',
    null,
    leaders.map((leader) => h('div', null, h('dt', null, leader.label), h('dd', null, h('b', null, leader.who), ` ${leader.what}`, leader.cards ? [' ', cardsEl(leader.cards, handlers)] : null))),
  );
}

function playerEl(row: TonightRow, view: TableView, handlers: DialogHandlers): HTMLElement {
  const details = h(
    'details',
    { open: unfolded.has(row.playerId) },
    h(
      'summary',
      null,
      h('span.who', null, row.name, row.seated ? null : h('small', null, ' left')),
      h('b', { class: `net ${row.net > 0 ? 'up' : row.net < 0 ? 'down' : ''}` }, signedAmount(row.net, view.config)),
      h('span.fold', { 'aria-hidden': 'true' }, '▾'),
      h('small.counts', null, countsOf(row)),
    ),
    h(
      'dl',
      null,
      h('div', null, h('dt', null, 'Biggest pot'), h('dd', null, row.won > 0 ? formatAmount(row.biggest, view.config) : 'None yet')),
      h('div', null, h('dt', null, 'Best hand shown'), h('dd', null, row.best ? [`${row.best.name} `, cardsEl(row.best.cards, handlers)] : 'None yet')),
    ),
  );

  details.addEventListener('toggle', () => (details.open ? unfolded.add(row.playerId) : unfolded.delete(row.playerId)));

  return h('li', { class: [row.playerId === view.you.id ? 'me' : '', view.tonight.dipshits.includes(row.playerId) ? 'dipshit' : ''].join(' ').trim() || null, 'data-player': row.name }, details);
}

function copyEl(view: TableView, handlers: DialogHandlers): HTMLElement {
  const box = h('textarea', { id: 'tonight-text', readonly: true, hidden: true, rows: 8, 'aria-label': 'The night as text' });
  const button = h('button.btn', { type: 'button', 'data-action': 'copy-tonight' }, 'Copy as text');

  copyOnClick(button, box, () => tonightText(view), handlers);

  return h('div.tonight-copy', null, button, h('small.note', null, 'To paste in the group chat.'), box);
}

function tonight(view: TableView, handlers: DialogHandlers): HTMLElement {
  const { players } = view.tonight;
  const missed = missedOf(view);

  if (players.length === 0) {
    return frame('Tonight', handlers, h('p.note', null, 'Nobody has bought in yet.'));
  }

  return frame(
    'Tonight',
    handlers,
    crownEl(view),
    h('p.note.tonight-standing', null, standingOf(view)),
    missed ? h('p.note.tonight-missed', null, missed) : null,
    leadersEl(view, handlers),
    h('ol.tonight-players', null, players.map((row) => playerEl(row, view, handlers))),
    copyEl(view, handlers),
  );
}

export const tonightDialog: DialogKind<'tonight'> = {
  kind: 'tonight',
  menu: { label: 'Tonight', who: everyone, note: () => 'Pots won, the best hand and the dipshit of the night' },
  shows: (view) => [view.tonight, nightOver(view), view.config.unit, view.config.name, view.you.id],
  draw: tonight,
};
