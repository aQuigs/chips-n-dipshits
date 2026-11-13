import type { Command, HandRecord } from '../../../engine/types.ts';
import type { TableView } from '../../../engine/view.ts';
import type { AppPreferences } from '../../prefs.ts';
import { h, holdWhile } from '../../ui.ts';
import type { Dialog } from './index.ts';

/**
 * taken: the table carried the command out.
 * refused: it did not, and has said why (or the command was never sent).
 * unanswered: no answer came back, so it may or may not have been carried out.
 */
export type SendOutcome = 'taken' | 'refused' | 'unanswered';

export interface DialogHandlers {
  /** Resolves to whether the table took the command. */
  send(command: Command): Promise<SendOutcome>;
  open(dialog: Dialog): void;
  close(): void;
  copy(text: string): Promise<boolean>;
  loadHistory(): Promise<HandRecord[]>;
  tableLink(): string;
  memberLink(): string;
  prefs: AppPreferences;
  toLobby(): void;
}

/** A dialog's line in the menu. */
export interface MenuEntry {
  label: string;
  /** Who gets to see it: `everyone`, `theHost`, `seated`, or a rule of its own. */
  who(view: TableView): boolean;
  /** The small print under the label. */
  note?(view: TableView, handlers: DialogHandlers): string;
}

export const everyone = (): boolean => true;
export const theHost = (view: TableView): boolean => view.you.isHost;
export const seated = (view: TableView): boolean => view.you.seat !== null;

/**
 * One kind of dialog. `P` is what it has to be told when it is opened, such as which seat; the
 * dialog that is open is handed to it as that.
 */
export interface DialogKind<K extends string = string, P = unknown> {
  /** The name it is opened by, and that its menu entry carries on the page. */
  kind: K;
  /**
   * Left out, the dialog is not in the menu and is opened from somewhere else. Only for a dialog that
   * has to be told nothing, since the menu opens it by its kind alone.
   */
  menu?: MenuEntry;
  /**
   * What its content depends on. A dialog showing live table data is redrawn when this changes; one
   * that leaves it out holds a form someone may be filling in, and is drawn once.
   */
  shows?(view: TableView, handlers: DialogHandlers, params: P): unknown;
  draw(view: TableView, handlers: DialogHandlers, params: P): HTMLElement;
}

export function frame(title: string, handlers: DialogHandlers, ...body: (HTMLElement | null)[]): HTMLElement {
  return h(
    'div.dialog',
    // Focusable by script only: opening a dialog puts the keyboard here, not on the page behind it
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: -1 },
    h('header', null, h('h2', null, title), h('button.icon', { type: 'button', 'aria-label': 'Close', 'data-action': 'close', onclick: handlers.close }, '✕')),
    h('div.dialog-body', null, body),
  );
}

/**
 * Sends what a form asks for. A refusal leaves the form as it was typed, with the reason in a toast,
 * instead of costing the player their entries. With no answer the table may have taken it all the
 * same, so the form moves on rather than invite a second try: the host adding chips twice would get them twice.
 */
export function submit(event: Event, handlers: DialogHandlers, command: Command, then: () => void): void {
  event.preventDefault();

  const button = (event.target as HTMLFormElement).querySelector<HTMLButtonElement>('button[type="submit"]')!;

  holdWhile(button, async () => {
    // If the dialog was closed while the answer was on its way, there is nothing left to move on from
    if ((await handlers.send(command)) !== 'refused' && button.isConnected) {
      then();
    }
  });
}
