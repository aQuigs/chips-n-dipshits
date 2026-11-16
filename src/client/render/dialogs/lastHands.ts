import { capitalized } from '../../../engine/handNames.ts';
import { LIMITS } from '../../../engine/validate.ts';
import type { TableView } from '../../../engine/view.ts';
import { h, heldTogether, sendingButton, sends } from '../../ui.ts';
import type { Child } from '../../ui.ts';
import { lastHandsText, nightOver } from '../night.ts';
import { hostOrCohost } from '../roles.ts';
import { frame, sendAndLeave } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/**
 * What ending the night does that its button does not say, each only when there is something for it to
 * do: said before the yes, so that nobody learns it from the chat afterwards.
 */
function endingAlso(view: TableView): string {
  const also = ['refused' in view.tonight.highHand.due ? '' : 'the high hand is paid', view.requests.length > 0 ? 'requests still waiting are dropped' : ''].filter(Boolean).join(', and ');

  return also === '' ? '' : ` ${capitalized(also)}.`;
}

/**
 * How many hands are left tonight, picked with one tap, or called off; and ending the night outright,
 * which can only be done between hands. During a hand the count is of hands after it, and the hand on
 * the table can itself be made the last. What is picked is held until the table has answered, and the
 * dialog is left then: a number has no room for words, and shows as the one picked meanwhile. The other
 * picks are held with it: a second one sent after it could reach the table first.
 */
function lastHands(view: TableView, handlers: DialogHandlers): HTMLElement {
  const choice = (hands: number, label: Child) =>
    sendingButton('button.chip-btn', { 'data-hands': hands, 'aria-pressed': String(view.handsLeft === hands) }, label, sendAndLeave(handlers, { type: 'setLastHands', hands, from: view.handCount }));
  const counts = Array.from({ length: LIMITS.lastHands }, (_, index) => choice(index + 1, String(index + 1)));
  const thisHand = view.hand ? choice(0, sends('This hand is the last', 'Calling it…')) : null;
  const callOff =
    view.handsLeft === null ? null : sendingButton('button.btn', { 'data-action': 'call-off-last-hands' }, sends('Call it off', 'Calling it off…'), sendAndLeave(handlers, { type: 'setLastHands', hands: null }));

  heldTogether(...counts, ...[thisHand, callOff].filter((pick): pick is HTMLButtonElement => pick !== null));

  return frame(
    'Last hands',
    handlers,
    h('p', null, view.hand ? 'How many more hands after this one? The night is over once they are played.' : 'How many more hands? The night is over once they are played.'),
    thisHand ? h('div.this-hand', null, thisHand) : null,
    h('div.hand-counts', { role: 'group', 'aria-label': 'Hands left' }, counts),
    h(
      'div.buttons',
      null,
      callOff,
      view.hand
        ? null
        : h(
            'button.btn.danger',
            {
              type: 'button',
              'data-action': 'end-night',
              onclick: () =>
                handlers.open({
                  kind: 'confirm',
                  title: 'End the night?',
                  body: `No more hands are dealt.${endingAlso(view)} Chips, the ledger and cashing out still work, and play can start again from the menu.`,
                  action: 'End the night',
                  doing: 'Ending…',
                  command: { type: 'endNight' },
                  danger: true,
                  // The night's numbers open by themselves once it is over, and this dialog has nothing left to offer
                  toTable: true,
                }),
            },
            'End the night now',
          ),
    ),
  );
}

export const lastHandsDialog: DialogKind<'lastHands'> = {
  kind: 'lastHands',
  menu: { group: 'run', label: 'Last hands', who: (view) => hostOrCohost(view) && !nightOver(view), state: lastHandsText },
  // Whoever backs out of ending the night still has the count of hands to set
  comesBack: true,
  // The hand on the table is what the count is from, so a new one is a new dialog
  shows: (view) => [view.hand !== null, view.handCount, view.handsLeft],
  draw: lastHands,
};
