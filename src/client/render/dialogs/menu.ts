import type { Command } from '../../../engine/types.ts';
import type { TableView } from '../../../engine/view.ts';
import { h, holdWhile, sends } from '../../ui.ts';
import { enoughSeated, nightOver, startingText, startText } from '../night.ts';
import { hostOrCohost } from '../roles.ts';
import { everyone, frame, MENU_GROUPS, seated, sendAndLeave } from './dialog.ts';
import type { DialogHandlers, DialogKind, MenuEntry } from './dialog.ts';
import type { Dialog } from './index.ts';

/** Something the menu does itself, with no dialog of its own behind it: it opens or leaves for something, or it sends at once. */
export type MenuAction = MenuPick | MenuSend;

interface MenuLine {
  /** Names the entry on the page, as a dialog's kind names its own. */
  action: string;
  menu: MenuEntry;
}

export interface MenuPick extends MenuLine {
  pick(handlers: DialogHandlers): void;
}

/**
 * A line that sends its command the moment it is pressed. It stays where it is, held and saying what it
 * is doing, until the table has answered, and the menu is left for the table then.
 */
export interface MenuSend extends MenuLine {
  sends: Command;
  /** What the line says while the table has not answered, in the words for where the table stands when those differ. */
  doing: string | ((view: TableView) => string);
}

export const pauseGame: MenuSend = {
  action: 'pause',
  menu: { group: 'run', label: 'Pause the game', who: (view) => hostOrCohost(view) && view.running },
  sends: { type: 'pause' },
  doing: 'Pausing…',
};

export const startGame: MenuSend = {
  action: 'start',
  menu: { group: 'run', label: startText, who: (view) => hostOrCohost(view) && !view.running && !nightOver(view) && enoughSeated(view) },
  sends: { type: 'start' },
  doing: startingText,
};

export const keepPlaying: MenuSend = {
  action: 'keep-playing',
  menu: { group: 'run', label: 'Keep playing', who: (view) => hostOrCohost(view) && nightOver(view) },
  sends: { type: 'playOn' },
  doing: 'Playing on…',
};

export const standUp: MenuPick = {
  action: 'stand',
  menu: { group: 'leave', label: 'Stand up', who: seated },
  pick: (handlers) =>
    handlers.open({
      kind: 'confirm',
      title: 'Stand up?',
      body: 'You leave your seat and your chips are cashed out in the ledger. If you are in a hand, it is folded.',
      action: 'Stand up',
      doing: 'Standing up…',
      command: { type: 'standUp' },
      danger: true,
    }),
};

export const toLobby: MenuPick = {
  action: 'lobby',
  // Said beside the way out that costs a seat, which this one does not
  menu: { group: 'leave', label: 'Back to the lobby', who: everyone, state: (view) => (seated(view) ? 'Your seat stays yours' : null) },
  pick: (handlers) => handlers.toLobby(),
};

interface Line {
  action: string;
  label: string;
  /** What the line says while the table has not answered, for a line that sends at a press, and null for one that opens something. */
  doing: string | null;
  state: string | null;
  pick(line: HTMLButtonElement): void;
}

const inWordsFor = (view: TableView, words: string | ((view: TableView) => string)): string => (typeof words === 'string' ? words : words(view));

/** The lines this viewer gets, in the order given. */
function lines(items: readonly (DialogKind | MenuAction)[], view: TableView, handlers: DialogHandlers): Line[] {
  return items.flatMap((item): Line[] => {
    const entry = item.menu;
    if (!entry?.who(view)) {
      return [];
    }

    const line = { label: inWordsFor(view, entry.label), doing: null, state: entry.state?.(view, handlers) ?? null };

    if ('sends' in item) {
      return [{ ...line, action: item.action, doing: inWordsFor(view, item.doing), pick: (pressed) => holdWhile(pressed, sendAndLeave(handlers, item.sends, true)) }];
    }

    if ('pick' in item) {
      return [{ ...line, action: item.action, pick: () => item.pick(handlers) }];
    }

    // A dialog that is in the menu is one that needs telling nothing to open
    return [{ ...line, action: item.kind, pick: () => handlers.open({ kind: item.kind } as Dialog) }];
  });
}

/** The parts of the menu this viewer gets, each with its lines: a part with none for them is no part of their menu. */
function groups(items: readonly (DialogKind | MenuAction)[], view: TableView, handlers: DialogHandlers): { heading: string; lines: Line[] }[] {
  return Object.entries(MENU_GROUPS)
    .map(([group, heading]) => ({ heading, lines: lines(items.filter((item) => item.menu?.group === group), view, handlers) }))
    .filter((part) => part.lines.length > 0);
}

/**
 * The menu over a list of dialogs and actions: the entries of those that have one, each in the part
 * its entry names, and within a part in the order given.
 */
export function menuDialog(items: readonly (DialogKind | MenuAction)[]): DialogKind<'menu'> {
  return {
    kind: 'menu',
    // Exactly what is drawn, so the menu is redrawn when one of its lines changes and at no other time
    shows: (view, handlers) => [view.config.name, groups(items, view, handlers)],
    draw: (view, handlers) =>
      frame(
        view.config.name,
        handlers,
        h(
          'div.menu',
          null,
          groups(items, view, handlers).map(({ heading, lines }) =>
            h(
              'section',
              null,
              h('h3', null, heading),
              h(
                'div.menu-group',
                null,
                // The space is for whoever hears the line read out: the label and how things stand are two things
                lines.map(({ action, label, doing, state, pick }) =>
                  h(
                    'button.menu-item',
                    { type: 'button', 'data-action': action, onclick: (event: Event) => pick(event.currentTarget as HTMLButtonElement) },
                    doing === null ? h('span', null, label) : sends(label, doing),
                    state ? [' ', h('small', null, state)] : null,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
  };
}
