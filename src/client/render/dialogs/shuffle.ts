import type { TableView } from '../../../engine/view.ts';
import { hostOrCohost } from '../roles.ts';
import type { MenuAction } from './menu.ts';

const seatedCount = (view: TableView): number => view.seats.filter((seat) => seat !== null).length;

export const shuffleSeats: MenuAction = {
  action: 'shuffle',
  menu: { group: 'run', label: 'Shuffle seats', who: (view) => hostOrCohost(view) && seatedCount(view) >= 2, state: (view) => (view.shuffleAfterHand ? 'Set for when this hand ends' : null) },
  pick: (handlers) =>
    handlers.open({
      kind: 'confirm',
      title: 'Shuffle the seats?',
      body: 'Everyone seated gets a random seat among those taken, with their chips. The open seats stay open, and the dealer button is drawn again for the next hand. During a hand, this happens when it ends.',
      action: 'Shuffle',
      command: { type: 'shuffleSeats' },
    }),
};
