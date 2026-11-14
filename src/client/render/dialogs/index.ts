import type { TableView } from '../../../engine/view.ts';
import { confirmDialog } from './confirm.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';
import { historyDialog } from './history.ts';
import { inviteDialog } from './invite.ts';
import { ledgerDialog } from './ledger.ts';
import { menuDialog, pauseGame, standUp, startGame, toLobby } from './menu.ts';
import { playersDialog } from './players.ts';
import { preferencesDialog } from './preferences.ts';
import { rebuyDialog } from './rebuy.ts';
import { setStackDialog } from './setStack.ts';
import { settingsDialog } from './settings.ts';
import { shuffleSeats } from './shuffle.ts';
import { sitDialog } from './sit.ts';
import { themeDialog } from './theme.ts';
import { transferDialog } from './transfer.ts';

export type { DialogHandlers } from './dialog.ts';

/**
 * Every dialog, and the things the menu does without one. A new dialog is a file in this folder and a
 * line here. Where it stands in this list is where its entry stands in the menu; one that has no
 * entry can stand anywhere. One to a line: .gitattributes joins the lines two branches add to this file.
 */
const REGISTERED = [
  inviteDialog,
  ledgerDialog,
  historyDialog,
  playersDialog,
  shuffleSeats,
  settingsDialog,
  pauseGame,
  startGame,
  themeDialog,
  preferencesDialog,
  standUp,
  toLobby,
  sitDialog,
  rebuyDialog,
  setStackDialog,
  transferDialog,
  confirmDialog,
];

const menu = menuDialog(REGISTERED);

// A dialog not declared as a DialogKind<'its-kind'> has any word for a kind, and would let every misspelled one through
type OpenOf<Kind> = Kind extends DialogKind<infer K, infer P> ? (string extends K ? never : { kind: K } & P) : never;

/** A dialog that is open or is to be opened: its kind, with whatever that kind has to be told. */
export type Dialog = OpenOf<(typeof REGISTERED)[number] | typeof menu>;

const BY_KIND = new Map<string, DialogKind>([menu, ...REGISTERED].flatMap((item) => ('kind' in item ? [[item.kind, item]] : [])));

/** What the open dialog's content depends on, for telling whether it needs drawing again. */
export function dialogShows(dialog: Dialog, view: TableView, handlers: DialogHandlers): unknown {
  return BY_KIND.get(dialog.kind)!.shows?.(view, handlers, dialog);
}

/** Whether the viewer may still have the dialog open. */
export function dialogAllowed(dialog: Dialog, view: TableView): boolean {
  const kind = BY_KIND.get(dialog.kind)!;

  return (kind.who ?? kind.menu?.who)?.(view) ?? true;
}

export function dialogEl(dialog: Dialog, view: TableView, handlers: DialogHandlers): HTMLElement {
  return BY_KIND.get(dialog.kind)!.draw(view, handlers, dialog);
}
