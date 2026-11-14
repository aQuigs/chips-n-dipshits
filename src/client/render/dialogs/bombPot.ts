import { formatAmount } from '../../../engine/amounts.ts';
import { boardsDealt, bombPotOf } from '../../../engine/bombPots.ts';
import { hostOrCohost } from '../roles.ts';
import type { MenuAction } from './menu.ts';

/** Not offered while the next hand is a bomb pot anyway, called or by the table's count. */
export const callBombPot: MenuAction = {
  action: 'bomb-pot',
  menu: {
    label: 'Bomb pot next hand',
    who: (view) => hostOrCohost(view) && view.nextBombPot === null,
    note: (view) => `${formatAmount(view.config.bombPotAmount, view.config)} each, no blinds, starts on ${boardsDealt(bombPotOf(view.config)) > 1 ? 'two flops' : 'the flop'}`,
  },
  pick(handlers) {
    void handlers.send({ type: 'setBombPot', on: true });
    handlers.close();
  },
};

/** Offered only when it makes the next hand an ordinary one: a bomb pot the table's count brings is changed in the settings. */
export const callOffBombPot: MenuAction = {
  action: 'bomb-pot-off',
  menu: { label: 'Call off the bomb pot', who: (view) => hostOrCohost(view) && view.bombPotCalled, note: () => 'The next hand is an ordinary one' },
  pick(handlers) {
    void handlers.send({ type: 'setBombPot', on: false });
    handlers.close();
  },
};
