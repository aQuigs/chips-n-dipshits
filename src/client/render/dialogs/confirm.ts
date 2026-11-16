import type { Command } from '../../../engine/types.ts';
import { h, heldTogether, sendingButton, sends } from '../../ui.ts';
import { frame, sendAndLeave } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/** What is being asked, and the command that saying yes sends. */
interface Question {
  title: string;
  body: string;
  action: string;
  /** What the button says while the table has not answered. */
  doing: string;
  command: Command;
  /**
   * Yes takes a seat, chips or the table from someone, and no one tap gives it back: its button is drawn
   * as the one to stop at, not as the one every other dialog has under the thumb.
   */
  danger?: boolean;
  /** What yes does shows on the table by itself, so yes leaves for the table and not for the dialog the question was opened from. */
  toTable?: boolean;
}

/**
 * The question stays up with its answer held until the table has answered, and is left then: whoever said
 * yes sees that it was heard, and what they come back to is the table or the list as the answer left it.
 * Cancel is held with it, since it can take nothing back by then; the dialog can still be closed.
 */
function confirm(question: Question, handlers: DialogHandlers): HTMLElement {
  const yes = sendingButton('button.btn', { class: question.danger ? 'danger' : 'primary', 'data-action': 'confirm' }, sends(question.action, question.doing), sendAndLeave(handlers, question.command, question.toTable));

  return frame(question.title, handlers, h('p', null, question.body), h('div.buttons', null, heldTogether(h('button.btn', { type: 'button', onclick: handlers.close }, 'Cancel'), yes)));
}

export const confirmDialog: DialogKind<'confirm', Question> = {
  kind: 'confirm',
  draw: (_view, handlers, question) => confirm(question, handlers),
};
