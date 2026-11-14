import { formatAmount } from '../../../engine/amounts.ts';
import { listed, midSentence } from '../../../engine/handNames.ts';
import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { hostOrCohost } from '../roles.ts';
import { frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

const namesOf = (view: TableView, ids: readonly string[]): string => listed(ids.map((id) => view.tonight.players.find((row) => row.playerId === id)?.name ?? 'Someone'));

/** What everyone else seated would pay now: the bonus each, or what they have when that is less. */
function totalOf(view: TableView): number {
  const { collectors } = view.tonight.highHand;

  return view.seats.reduce((sum, seat) => sum + (seat && !collectors.includes(seat.playerId) ? Math.min(view.config.highHandBonus, seat.stack) : 0), 0);
}

/**
 * Paying the high-hand bonus before the night ends. It moves everyone's chips, so it says who pays
 * what and to whom and waits for a yes; during a hand it says why it has to wait.
 */
function payHighHand(view: TableView, handlers: DialogHandlers): HTMLElement {
  const { next, collectors } = view.tonight.highHand;
  const total = totalOf(view);
  const cancel = h('button.btn', { type: 'button', onclick: handlers.close }, view.hand ? 'Close' : 'Cancel');

  let why: string | null = null;
  if (view.hand) {
    why = "It moves everyone's chips, so it is paid between hands. Pause the game, and once this hand is over it can be paid here.";
  } else if (collectors.length === 0) {
    why = 'Nobody who has shown down since the bonus was last paid is seated, so there is nobody to pay it to.';
  } else if (total === 0) {
    why = 'Nobody else seated has chips to pay it.';
  }

  const gone = next ? next.playerIds.filter((id) => !collectors.includes(id)) : [];
  const pay = () => {
    void handlers.send({ type: 'payHighHand', hand: next!.hand });
    handlers.close();
  };

  return frame(
    'Pay the high hand?',
    handlers,
    next ? h('p', null, h('b', null, namesOf(view, next.playerIds)), ` ${next.playerIds.length > 1 ? 'share' : 'holds'} the high hand with ${midSentence(next.name)}.`) : null,
    why ? h('p', null, why) : null,
    !why && gone.length > 0 && collectors.length > 0 ? h('p', null, `${namesOf(view, gone)} ${gone.length > 1 ? 'have' : 'has'} left, so ${namesOf(view, collectors)} ${collectors.length > 1 ? 'collect' : 'collects'} it, with the best hand of anyone seated.`) : null,
    why
      ? null
      : h(
          'p',
          null,
          `Everyone else seated pays ${formatAmount(view.config.highHandBonus, view.config)}, or what they have if that is less: ${formatAmount(total, view.config)} in all${collectors.length > 1 ? ', shared' : ''}.`,
        ),
    why ? null : h('p.note', null, 'Once it is paid, the next high hand starts from nothing. The high hand of the night stays in Tonight.'),
    h('div.buttons', null, cancel, why ? null : h('button.btn.primary', { type: 'button', 'data-action': 'pay-high-hand', onclick: pay }, `Pay ${formatAmount(total, view.config)}`)),
  );
}

export const highHandDialog: DialogKind<'highHand'> = {
  kind: 'highHand',
  menu: {
    label: 'Pay the high hand',
    who: (view) => hostOrCohost(view) && view.config.highHandBonus > 0 && view.tonight.highHand.next !== null,
    note: (view) => (view.hand ? 'Between hands only' : `${namesOf(view, view.tonight.highHand.next!.playerIds)}: ${formatAmount(view.config.highHandBonus, view.config)} from everyone else`),
  },
  shows: (view) => [view.hand !== null, view.tonight.highHand, view.seats.map((seat) => seat && [seat.playerId, seat.stack]), view.config.highHandBonus, view.config.unit],
  draw: payHighHand,
};
