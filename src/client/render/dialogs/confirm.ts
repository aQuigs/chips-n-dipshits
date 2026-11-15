import type { Command } from '../../../engine/types.ts';
import { h } from '../../ui.ts';
import { frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/** What is being asked, and the command that saying yes sends. */
interface Question {
  title: string;
  body: string;
  action: string;
  command: Command;
}

function confirm(dialog: Question, handlers: DialogHandlers): HTMLElement {
  return frame(
    dialog.title,
    handlers,
    h('p', null, dialog.body),
    h(
      'div.buttons',
      null,
      h('button.btn', { type: 'button', onclick: handlers.close }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          type: 'button',
          'data-action': 'confirm',
          onclick: () => {
            void handlers.send(dialog.command);
            handlers.close();
          },
        },
        dialog.action,
      ),
    ),
  );
}

export const confirmDialog: DialogKind<'confirm', Question> = {
  kind: 'confirm',
  draw: (_view, handlers, question) => confirm(question, handlers),
};
