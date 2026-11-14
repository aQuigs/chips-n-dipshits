import { formatAmount, signedAmount } from '../../../engine/amounts.ts';
import type { TableView } from '../../../engine/view.ts';
import { settleUp } from '../../settle.ts';
import { h } from '../../ui.ts';
import { everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function ledger(view: TableView, handlers: DialogHandlers): HTMLElement {
  const rows = [...view.ledger].sort((a, b) => b.net - a.net);
  const payments = settleUp(rows);

  // Only a table where chips were moved has the column, so the others keep the room on a phone
  const transfers = rows.some((row) => row.transferred !== 0);

  const table = h(
    'table.ledger',
    null,
    h('thead', null, h('tr', null, h('th', null, 'Player'), h('th', null, 'Bought'), h('th', null, 'Cashed out'), transfers ? h('th', null, 'Transferred') : null, h('th', null, 'On table'), h('th', null, 'Net'))),
    h(
      'tbody',
      null,
      rows.map((row) =>
        h(
          'tr',
          null,
          h('td', null, row.name),
          h('td', null, formatAmount(row.buyIn, view.config)),
          h('td', null, formatAmount(row.cashOut, view.config)),
          transfers ? h('td', null, signedAmount(row.transferred, view.config)) : null,
          h('td', null, formatAmount(row.stack, view.config)),
          h('td', { class: row.net > 0 ? 'up' : row.net < 0 ? 'down' : '' }, signedAmount(row.net, view.config)),
        ),
      ),
    ),
  );

  return frame(
    'Ledger',
    handlers,
    rows.length === 0 ? h('p.note', null, 'Nobody has bought in yet.') : h('div.scroll-x', null, table),
    transfers ? h('p.note', null, 'Transferred is chips the host or a co-host moved from one player to another. They are already in On table, so they count toward Net like chips won or lost.') : null,
    payments.length > 0
      ? h(
          'div.settle',
          null,
          h('h3', null, 'To settle up right now'),
          h('ul', null, payments.map((p) => h('li', null, h('b', null, p.from), ' pays ', h('b', null, p.to), ` ${formatAmount(p.amount, view.config)}`))),
          h('p.note', null, 'Counts chips still on the table as if everyone cashed out now.'),
        )
      : null,
  );
}

export const ledgerDialog: DialogKind<'ledger'> = {
  kind: 'ledger',
  menu: { label: 'Ledger', who: everyone, note: () => 'Who is up and who owes whom' },
  shows: (view) => view.ledger,
  draw: ledger,
};
