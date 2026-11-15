import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { nightOver } from '../night.ts';
import { hostOrCohost } from '../roles.ts';
import { everyone, frame, seated } from './dialog.ts';
import type { DialogHandlers, DialogKind, MenuEntry } from './dialog.ts';
import type { Dialog } from './index.ts';

/** Something the menu does itself, with no dialog of its own behind it. */
export interface MenuAction {
  /** Names the entry on the page, as a dialog's kind names its own. */
  action: string;
  menu: MenuEntry;
  pick(handlers: DialogHandlers): void;
}

export const pauseGame: MenuAction = {
  action: 'pause',
  menu: { label: 'Pause the game', who: (view) => hostOrCohost(view) && view.running, note: () => 'No new hands until you resume' },
  pick(handlers) {
    void handlers.send({ type: 'pause' });
    handlers.close();
  },
};

export const startGame: MenuAction = {
  action: 'start',
  menu: { label: 'Start the game', who: (view) => hostOrCohost(view) && !view.running && !nightOver(view) },
  pick(handlers) {
    void handlers.send({ type: 'start' });
    handlers.close();
  },
};

export const keepPlaying: MenuAction = {
  action: 'keep-playing',
  menu: { label: 'Keep playing', who: (view) => hostOrCohost(view) && nightOver(view), note: () => 'Start dealing again: the night goes on' },
  pick(handlers) {
    void handlers.send({ type: 'playOn' });
    handlers.close();
  },
};

export const standUp: MenuAction = {
  action: 'stand',
  menu: { label: 'Stand up', who: seated },
  pick: (handlers) =>
    handlers.open({
      kind: 'confirm',
      title: 'Stand up?',
      body: 'You leave your seat and your chips are cashed out in the ledger. If you are in a hand, it is folded.',
      action: 'Stand up',
      command: { type: 'standUp' },
    }),
};

export const toLobby: MenuAction = {
  action: 'lobby',
  menu: { label: 'Back to the lobby', who: everyone, note: () => 'Your seat stays yours' },
  pick: (handlers) => handlers.toLobby(),
};

interface Line {
  action: string;
  label: string;
  note: string | undefined;
  pick(): void;
}

/** The lines this viewer gets, top to bottom. */
function lines(items: readonly (DialogKind | MenuAction)[], view: TableView, handlers: DialogHandlers): Line[] {
  return items.flatMap((item): Line[] => {
    const entry = item.menu;
    if (!entry?.who(view)) {
      return [];
    }

    const line = { label: entry.label, note: entry.note?.(view, handlers) };

    if ('pick' in item) {
      return [{ ...line, action: item.action, pick: () => item.pick(handlers) }];
    }

    // A dialog that is in the menu is one that needs telling nothing to open
    return [{ ...line, action: item.kind, pick: () => handlers.open({ kind: item.kind } as Dialog) }];
  });
}

/** The menu over a list of dialogs and actions: it shows the entries of those that have one, in the order given. */
export function menuDialog(items: readonly (DialogKind | MenuAction)[]): DialogKind<'menu'> {
  return {
    kind: 'menu',
    // Exactly what is drawn, so the menu is redrawn when one of its lines changes and at no other time
    shows: (view, handlers) => [view.config.name, lines(items, view, handlers).map(({ action, label, note }) => [action, label, note])],
    draw: (view, handlers) =>
      frame(
        view.config.name,
        handlers,
        h(
          'div.menu',
          null,
          lines(items, view, handlers).map(({ action, label, note, pick }) =>
            h('button.menu-item', { type: 'button', 'data-action': action, onclick: pick }, label, note ? h('small', null, note) : null),
          ),
        ),
      ),
  };
}
