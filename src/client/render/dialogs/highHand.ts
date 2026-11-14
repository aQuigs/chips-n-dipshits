import { formatAmount } from '../../../engine/amounts.ts';
import { midSentence } from '../../../engine/handNames.ts';
import type { TableView } from '../../../engine/view.ts';
import { namesOf } from '../../tonightText.ts';
import { h, holdWhile } from '../../ui.ts';
import { hostOrCohost } from '../roles.ts';
import { frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/**
 * Paying the high-hand bonus before the night ends. It moves everyone's chips, so it says who pays
 * what and to whom and waits for a yes, or why it can't be paid now.
 */
function payHighHand(view: TableView, handlers: DialogHandlers): HTMLElement {
  const { next, due } = view.tonight.highHand;
  const { config } = view;
  const holders = next ? h('p', null, h('b', null, namesOf(view, next.playerIds)), ` ${next.playerIds.length > 1 ? 'share' : 'holds'} the high hand with ${midSentence(next.name)}.`) : null;

  if ('refused' in due) {
    return frame('Pay the high hand?', handlers, holders, h('p', null, `${due.refused}.`), h('div.buttons', null, h('button.btn', { type: 'button', onclick: handlers.close }, 'Close')));
  }

  const total = formatAmount(due.total, config);
  const holderGone = next !== null && !next.playerIds.some((id) => due.playerIds.includes(id));
  const pay = (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;

    holdWhile(button, async () => {
      // The hand and the collectors shown here go with it, so a payout that has changed since is refused, and the dialog stays to show what is due now
      if ((await handlers.send({ type: 'payHighHand', hand: due.hand, to: due.playerIds })) !== 'refused' && button.isConnected) {
        handlers.close();
      }
    });
  };

  return frame(
    'Pay the high hand?',
    handlers,
    holders,
    holderGone
      ? h('p', null, `${namesOf(view, next.playerIds)} ${next.playerIds.length > 1 ? 'have' : 'has'} left, so ${namesOf(view, due.playerIds)} ${due.playerIds.length > 1 ? 'collect' : 'collects'} it, with the best hand of anyone seated.`)
      : null,
    h('p', null, `Everyone else seated pays ${formatAmount(config.highHandBonus, config)}, or what they have if that is less: ${total} in all${due.playerIds.length > 1 ? ', shared' : ''}.`),
    h('p.note', null, 'Once it is paid, the next high hand starts from nothing. The high hand of the night stays in Tonight.'),
    h('div.buttons', null, h('button.btn', { type: 'button', onclick: handlers.close }, 'Cancel'), h('button.btn.primary', { type: 'button', 'data-action': 'pay-high-hand', onclick: pay }, `Pay ${total}`)),
  );
}

export const highHandDialog: DialogKind<'highHand'> = {
  kind: 'highHand',
  menu: {
    label: 'Pay the high hand',
    who: (view) => hostOrCohost(view) && view.config.highHandBonus > 0 && view.tonight.highHand.next !== null,
    note: (view) => {
      const { due } = view.tonight.highHand;

      if (view.hand) {
        return 'Between hands only';
      }

      return 'refused' in due ? 'Nothing to pay now' : `${namesOf(view, due.playerIds)}: ${formatAmount(view.config.highHandBonus, view.config)} from everyone else`;
    },
  },
  shows: (view) => [view.tonight.highHand.next, view.tonight.highHand.due, view.config.highHandBonus, view.config.unit],
  draw: payHighHand,
};
