import { formatAmount } from '../../../engine/amounts.ts';
import { boardsDealt, bombPotOf } from '../../../engine/bombPots.ts';
import { nightOver, onLastHand } from '../night.ts';
import { hostOrCohost } from '../roles.ts';
import type { MenuSend } from './menu.ts';

/** Not offered while the next hand is a bomb pot anyway, called or by the table's count, nor when no next hand is coming. */
export const callBombPot: MenuSend = {
  action: 'bomb-pot',
  menu: {
    group: 'run',
    label: 'Bomb pot next hand',
    who: (view) => hostOrCohost(view) && view.nextBombPot === null && !nightOver(view) && !onLastHand(view),
    state: (view) => `${formatAmount(view.config.bombPotAmount, view.config)} each${boardsDealt(bombPotOf(view.config)) > 1 ? ', on two boards' : ''}`,
  },
  sends: { type: 'setBombPot', on: true },
  doing: 'Calling it…',
};

/** Offered only when it makes the next hand an ordinary one: a bomb pot the table's count brings is changed in the settings. */
export const callOffBombPot: MenuSend = {
  action: 'bomb-pot-off',
  menu: { group: 'run', label: 'Call off the bomb pot', who: (view) => hostOrCohost(view) && view.bombPotCalled },
  sends: { type: 'setBombPot', on: false },
  doing: 'Calling it off…',
};
