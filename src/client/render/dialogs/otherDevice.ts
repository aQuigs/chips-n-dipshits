import { h } from '../../ui.ts';
import { everyone, frame, linkToCopy } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/**
 * A member's own link, which is their seat to whoever opens it. It stands alone, away from the link
 * that is sent to friends, and not under Who you are, which is a name tag and never a key. Its button
 * is a plain one: nothing here is the next thing to do at a table.
 */
function otherDevice(handlers: DialogHandlers): HTMLElement {
  return frame(
    'Play on another device',
    handlers,
    h('p.note', null, 'Open your personal link on another phone or computer to carry on from there as you.'),
    linkToCopy(
      {
        id: 'member-link',
        label: 'Your personal link',
        link: handlers.memberLink(),
        copies: 'Copy my link',
        main: false,
        givesAway: 'Keep it to yourself: whoever opens it plays as you and sees your cards.',
      },
      handlers,
    ),
  );
}

export const otherDeviceDialog: DialogKind<'otherDevice'> = {
  kind: 'otherDevice',
  menu: { group: 'you', label: 'Play on another device', who: everyone },
  draw: (_view, handlers) => otherDevice(handlers),
};
