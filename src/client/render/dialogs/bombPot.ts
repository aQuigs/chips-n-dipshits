import { formatAmount } from '../../../engine/amounts.ts';
import { boardsDealt, bombPotOf } from '../../../engine/bombPots.ts';
import { nightOver, onLastHand } from '../night.ts';
import { hostOrCohost } from '../roles.ts';
import type { MenuAction } from './menu.ts';

/** Not offered while the next hand is a bomb pot anyway, called or by the table's count, nor when no next hand is coming. */
export const callBombPot: MenuAction = {
  action: 'bomb-pot',
  menu: {
    group: 'run',
    label: 'Bomb pot next hand',
    who: (view) => hostOrCohost(view) && view.nextBombPot === null && !nightOver(view) && !onLastHand(view),
    state: (view) => `${formatAmount(view.config.bombPotAmount, view.config)} each${boardsDealt(bombPotOf(view.config)) > 1 ? ', on two boards' : ''}`,
  },
  pick(handlers) {
    void handlers.send({ type: 'setBombPot', on: true });
    handlers.close();
  },
};

/** Offered only when it makes the next hand an ordinary one: a bomb pot the table's count brings is changed in the settings. */
export const callOffBombPot: MenuAction = {
  action: 'bomb-pot-off',
  menu: { group: 'run', label: 'Call off the bomb pot', who: (view) => hostOrCohost(view) && view.bombPotCalled },
  pick(handlers) {
    void handlers.send({ type: 'setBombPot', on: false });
    handlers.close();
  },
};
