import type { TableView } from '../../../engine/view.ts';
import { autoShowDialog } from './autoShow.ts';
import { callBombPot, callOffBombPot } from './bombPot.ts';
import { confirmDialog } from './confirm.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';
import { highHandDialog } from './highHand.ts';
import { historyDialog } from './history.ts';
import { inviteDialog } from './invite.ts';
import { ledgerDialog } from './ledger.ts';
import { lastHandsDialog } from './lastHands.ts';
import { muteDialog } from './mute.ts';
import { keepPlaying, menuDialog, pauseGame, standUp, startGame, toLobby } from './menu.ts';
import { playersDialog } from './players.ts';
import { preferencesDialog } from './preferences.ts';
import { rebuyDialog } from './rebuy.ts';
import { setStackDialog } from './setStack.ts';
import { settingsDialog } from './settings.ts';
import { shuffleSeats } from './shuffle.ts';
import { sitDialog } from './sit.ts';
import { standingsDialog } from './standings.ts';
import { straddlesDialog } from './straddles.ts';
import { tonightDialog } from './tonight.ts';
import { transferDialog } from './transfer.ts';
import { whoDialog } from './who.ts';

export type { DialogHandlers } from './dialog.ts';

/**
 * Every dialog, and the things the menu does without one. A new dialog is a file in this folder and a
 * line here. Its entry says which part of the menu it stands in, and where it stands in this list is
 * where it stands in that part; one that has no entry can stand anywhere. One to a line:
 * .gitattributes joins the lines two branches add to this file.
 */
const REGISTERED = [
  pauseGame,
  startGame,
  keepPlaying,
  playersDialog,
  callBombPot,
  callOffBombPot,
  lastHandsDialog,
  highHandDialog,
  settingsDialog,
  shuffleSeats,
  ledgerDialog,
  tonightDialog,
  historyDialog,
  standingsDialog,
  autoShowDialog,
  muteDialog,
  preferencesDialog,
  whoDialog,
  standUp,
  toLobby,
  inviteDialog,
  sitDialog,
  rebuyDialog,
  setStackDialog,
  transferDialog,
  confirmDialog,
  straddlesDialog,
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
