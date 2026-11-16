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
  /**
   * Yes takes a seat, chips or the table from someone, and no one tap gives it back: its button is drawn
   * as the one to stop at, not as the one every other dialog has under the thumb.
   */
  danger?: boolean;
  /** What yes does shows on the table by itself, so yes leaves for the table and not for the dialog the question was opened from. */
  toTable?: boolean;
}

function confirm(question: Question, handlers: DialogHandlers): HTMLElement {
  return frame(
    question.title,
    handlers,
    h('p', null, question.body),
    h(
      'div.buttons',
      null,
      h('button.btn', { type: 'button', onclick: handlers.close }, 'Cancel'),
      h(
        'button.btn',
        {
          type: 'button',
          class: question.danger ? 'danger' : 'primary',
          'data-action': 'confirm',
          onclick: () => {
            void handlers.send(question.command);

            if (question.toTable) {
              handlers.toTable();
            } else {
              handlers.close();
            }
          },
        },
        question.action,
      ),
    ),
  );
}

export const confirmDialog: DialogKind<'confirm', Question> = {
  kind: 'confirm',
  draw: (_view, handlers, question) => confirm(question, handlers),
};
