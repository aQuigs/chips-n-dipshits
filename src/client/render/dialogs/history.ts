import { formatAmount } from '../../../engine/amounts.ts';
import type { Denominated } from '../../../engine/amounts.ts';
import { bombPotName } from '../../../engine/bombPots.ts';
import { cardText, h } from '../../ui.ts';
import { everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function history(table: Denominated, handlers: DialogHandlers): HTMLElement {
  const body = h('div.history', null, h('p.note', null, 'Loading…'));

  handlers.loadHistory().then(
    (hands) => {
      body.replaceChildren(
        ...(hands.length === 0
          ? [h('p.note', null, 'No finished hands yet.')]
          : [...hands].reverse().map((hand) => {
              const bounty = hand.result.bounty;
              const collected = bounty ? bounty.payments.reduce((sum, payment) => sum + payment.amount, 0) : 0;
              const winners = hand.result.winnings.map((win) => {
                const withBounty = win.amount + (bounty?.seat === win.seat ? collected : 0);

                return `${hand.players.find((p) => p.seat === win.seat)?.name ?? '?'} +${formatAmount(withBounty, table)}`;
              });

              const title = `Hand #${hand.number}${hand.bombPot ? ` · ${bombPotName(hand.bombPot)}` : ''}`;

              return h('details', null, h('summary', null, title, h('small', null, winners.join(', '))), h('pre', null, cardText(hand.summary, handlers.prefs.get('deck'))));
            })),
      );
    },
    () => body.replaceChildren(h('p.note', null, 'Could not load the hand history. Close this and try again.')),
  );

  return frame('Hand history', handlers, body);
}

export const historyDialog: DialogKind<'history'> = {
  kind: 'history',
  menu: { label: 'Hand history', who: everyone },
  draw: (view, handlers) => history(view.config, handlers),
};
