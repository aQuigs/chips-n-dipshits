import { formatAmount } from '../../../engine/amounts.ts';
import { listed, midSentence } from '../../../engine/handNames.ts';
import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { hostOrCohost } from '../roles.ts';
import { frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

const namesOf = (view: TableView, ids: readonly string[]): string => listed(ids.map((id) => view.tonight.players.find((row) => row.playerId === id)?.name ?? 'Someone'));

/** What everyone else seated would pay now: the bonus each, or what they have when that is less. */
function totalOf(view: TableView, collectors: readonly string[]): number {
  return view.seats.reduce((sum, seat) => sum + (seat && !collectors.includes(seat.playerId) ? Math.min(view.config.highHandBonus, seat.stack) : 0), 0);
}

/** Why the bonus can't be paid now, or null when it can. */
function whyNot(view: TableView): string | null {
  const { due } = view.tonight.highHand;

  if (view.hand) {
    return "It moves everyone's chips, so it is paid between hands. Pause the game, and once this hand is over it can be paid here.";
  }
  if (!due) {
    return 'Nobody who has shown down since the bonus was last paid is seated, so there is nobody to pay it to.';
  }
  if (totalOf(view, due.playerIds) === 0) {
    return 'Nobody else seated has chips to pay it.';
  }

  return null;
}

/**
 * Paying the high-hand bonus before the night ends. It moves everyone's chips, so it says who pays
 * what and to whom and waits for a yes; during a hand it says why it has to wait.
 */
function payHighHand(view: TableView, handlers: DialogHandlers): HTMLElement {
  const { next, due } = view.tonight.highHand;
  const why = whyNot(view);
  const cancel = h('button.btn', { type: 'button', onclick: handlers.close }, why ? 'Close' : 'Cancel');
  const holders = next ? h('p', null, h('b', null, namesOf(view, next.playerIds)), ` ${next.playerIds.length > 1 ? 'share' : 'holds'} the high hand with ${midSentence(next.name)}.`) : null;

  if (why || !due) {
    return frame('Pay the high hand?', handlers, holders, h('p', null, why), h('div.buttons', null, cancel));
  }

  const total = formatAmount(totalOf(view, due.playerIds), view.config);
  const holderGone = next !== null && !next.playerIds.some((id) => due.playerIds.includes(id));
  const pay = () => {
    // The hand and the collectors shown here go with it, so a payout that has changed since is refused rather than made
    void handlers.send({ type: 'payHighHand', hand: due.hand, to: due.playerIds });
    handlers.close();
  };

  return frame(
    'Pay the high hand?',
    handlers,
    holders,
    holderGone
      ? h('p', null, `${namesOf(view, next.playerIds)} ${next.playerIds.length > 1 ? 'have' : 'has'} left, so ${namesOf(view, due.playerIds)} ${due.playerIds.length > 1 ? 'collect' : 'collects'} it, with the best hand of anyone seated.`)
      : null,
    h('p', null, `Everyone else seated pays ${formatAmount(view.config.highHandBonus, view.config)}, or what they have if that is less: ${total} in all${due.playerIds.length > 1 ? ', shared' : ''}.`),
    h('p.note', null, 'Once it is paid, the next high hand starts from nothing. The high hand of the night stays in Tonight.'),
    h('div.buttons', null, cancel, h('button.btn.primary', { type: 'button', 'data-action': 'pay-high-hand', onclick: pay }, `Pay ${total}`)),
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

      return due ? `${namesOf(view, due.playerIds)}: ${formatAmount(view.config.highHandBonus, view.config)} from everyone else` : 'Nobody seated to collect it';
    },
  },
  shows: (view) => [view.hand !== null, view.tonight.highHand, view.seats.map((seat) => seat && [seat.playerId, seat.stack]), view.config.highHandBonus, view.config.unit],
  draw: payHighHand,
};
