import type { Command, HandRecord } from '../../../engine/types.ts';
import type { TableView } from '../../../engine/view.ts';
import type { SendOutcome } from '../../connection.ts';
import type { MuteList } from '../../mutes.ts';
import type { Abilities, AppPreferences } from '../../prefs.ts';
import type { PresetHandlers } from '../presets.ts';
import type { StandingsHandlers } from '../standings.ts';
import type { PlayerHandlers } from '../whoField.ts';
import { h, holdWhile } from '../../ui.ts';
import type { Child } from '../../ui.ts';
import type { Dialog } from './index.ts';

export interface DialogHandlers {
  /** Resolves to whether the table took the command. */
  send(command: Command): Promise<SendOutcome>;
  open(dialog: Dialog): void;
  /** Leaves for the table whatever the dialog was opened from: for an answer that puts something else on the screen by itself. */
  toTable(): void;
  /** Leaves the dialog: for the one it was opened from when that one has its viewer back (`comesBack`), else for the table. */
  close(): void;
  /** Makes a change to the open dialog that the game and not the viewer brings about, as on an answer from the table: what comes up under a finger takes no tap for a moment (`TapGuard`). */
  byItself(change: () => void): void;
  copy(text: string): Promise<boolean>;
  loadHistory(): Promise<HandRecord[]>;
  /** Plays a finished hand back, over the table and whatever is open on it. */
  replay(record: HandRecord): void;
  presets: PresetHandlers;
  players: PlayerHandlers;
  /** What the standings ask with, for a viewer who is the known player `you`, or null for nobody the list knows. */
  standings(you: string | null): StandingsHandlers;
  tableLink(): string;
  memberLink(): string;
  prefs: AppPreferences;
  /** Who the viewer has muted at this table. */
  mutes: MuteList;
  /** What this device can do of what the preferences switch on. */
  abilities: Abilities;
  /**
   * Runs a choice of the viewer's that resizes what the dialog shows, a text size: what it brings up
   * where something else lay takes no tap for a moment (`TapGuard`), so a second tap is not on it.
   */
  resizing(change: () => void): void;
  toLobby(): void;
  /** Leaves the dialog for the table, where an open seat is picked for the player. */
  pickSeat(playerId: string): void;
}

/** The parts of the menu, each under its heading, in the order the menu shows them. */
export const MENU_GROUPS = {
  run: 'Run the game',
  scores: 'Scores and history',
  you: 'You',
  leave: 'Leave',
} as const;

/** A dialog's line in the menu. */
export interface MenuEntry {
  group: keyof typeof MENU_GROUPS;
  /** What the line does, in the words for where the table stands when those differ. */
  label: string | ((view: TableView) => string);
  /** Who gets to see it: `everyone`, `seated`, `hostOrCohost` or `hostAlone` (`roles.ts`), or a rule of its own. */
  who(view: TableView): boolean;
  /**
   * How things stand behind the line, where the viewer needs that before opening it: who waits, what it
   * is set to. Never what the label already says, so most lines have none, and null is none for now.
   */
  state?(view: TableView, handlers: DialogHandlers): string | null;
}

export const everyone = (): boolean => true;
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
   * Who may keep it open, checked with every view so a dialog closes when, say, a co-host stops being
   * one. Left out, it is whoever its menu entry is for, or anyone.
   */
  who?(view: TableView): boolean;
  /**
   * Whether the viewer is brought back here from whatever this dialog opens: closed or answered, that
   * gives way to this dialog again as they left it, not to the table. A list someone works down says so.
   * Left out, what it opens closes to the table.
   */
  comesBack?: boolean;
  /**
   * What its content depends on. A dialog showing live table data is redrawn when this changes; one
   * that leaves it out holds a form someone may be filling in, and is drawn once.
   */
  shows?(view: TableView, handlers: DialogHandlers, params: P): unknown;
  draw(view: TableView, handlers: DialogHandlers, params: P): HTMLElement;
}

export function frame(title: string, handlers: Pick<DialogHandlers, 'close'>, ...body: (HTMLElement | null)[]): HTMLElement {
  return h(
    'div.dialog',
    // Focusable by script only: opening a dialog puts the keyboard here, not on the page behind it
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: -1 },
    // The dialog's own heading, not the page's banner, which is what a header outside any section is taken for
    h('header', { role: 'none' }, h('h2', null, title), h('button.icon', { type: 'button', 'aria-label': 'Close', 'data-action': 'close', onclick: handlers.close }, '✕')),
    h('div.dialog-body', null, body),
  );
}

/**
 * Gives a dialog a foot that stays in sight under its body however far that is scrolled, for the one
 * button that must always be in reach. A button there belongs to a form in the body by the form's id.
 */
export function footed(dialog: HTMLElement, ...foot: Child[]): HTMLElement {
  dialog.append(h('div.dialog-foot', null, foot));

  return dialog;
}

/**
 * The buttons at the end of a player's row in a list, each marked as that player's and named with their
 * name. A dialog drawn again puts the keyboard back on the button that had it, found by its marks
 * (`Slot`): found by its place among its like, it would be the same button on another player's row once
 * the rows had changed. And a row of buttons heard one after another says whose each is.
 */
export function rowActions(player: { id: string; name: string }, ...buttons: Child[]): HTMLElement {
  const actions = h('span.row-actions', null, buttons);

  for (const button of actions.querySelectorAll('button')) {
    button.dataset.player = player.id;

    if (!button.hasAttribute('aria-label')) {
      button.setAttribute('aria-label', `${button.textContent}, ${player.name}`);
    }
  }

  return actions;
}

/**
 * Makes `button` copy `text`, and say how that went. A page inside someone else's frame is often
 * refused the clipboard: there the text is put in `field` and selected, where copying the selection
 * still works in most browsers, and where the viewer can copy it by hand in the rest.
 */
export function copyOnClick(button: HTMLButtonElement, field: HTMLInputElement | HTMLTextAreaElement, text: () => string, handlers: DialogHandlers): void {
  button.addEventListener('click', async () => {
    const value = text();
    let copied = await handlers.copy(value);

    if (!copied) {
      field.value = value;
      field.hidden = false;
      field.focus();
      field.select();

      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
    }

    button.textContent = copied ? 'Copied' : 'Copy it from the box';
  });
}

/**
 * Sends what a form asks for. A refusal leaves the form as it was typed, with the reason in a toast,
 * instead of costing the player their entries; `refused` is then told, for a form that has to bring
 * what was refused into sight. With no answer the table may have taken it all the same, so the form
 * moves on rather than invite a second try: the host adding chips twice would get them twice.
 */
export function submit(event: Event, handlers: DialogHandlers, command: Command, then: () => void, refused?: () => void): void {
  event.preventDefault();

  // Among the form's own controls, wherever they stand: its button may be in the dialog's foot
  const controls = [...(event.target as HTMLFormElement).elements];
  const button = controls.find((control): control is HTMLButtonElement => control instanceof HTMLButtonElement && control.type === 'submit')!;

  holdWhile(button, async () => {
    const outcome = await handlers.send(command);

    // If the dialog was closed while the answer was on its way, there is nothing left to move on from
    if (!button.isConnected) {
      return;
    }

    if (outcome === 'refused') {
      refused?.();
    } else {
      then();
    }
  });
}
