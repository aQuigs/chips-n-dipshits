import type { TableConfig } from '../../engine/types.ts';
import type { TableInfo } from '../../server/api.ts';
import { chips, h } from '../ui.ts';
import { inputOf, numberField, numberOf } from './forms.ts';

const NAME_LENGTH = 16;
const CODE_LENGTH = 12;

export interface LobbyHandlers {
  /** Resolves when the attempt is over, whichever way it went. */
  create(name: string, config: Partial<TableConfig>): Promise<void>;
  openTable(code: string): void;
}

export interface JoinHandlers {
  /** Resolves when the attempt is over, whichever way it went. */
  join(name: string): Promise<void>;
  toLobby(): void;
}

export interface JoinScreen {
  element: HTMLElement;
  /** Fills in what the table is once the server has said, and lets the visitor join. */
  showTable(info: TableInfo): void;
}

function brand(): HTMLElement {
  return h('div.brand', null, h('h1', null, 'Chips n’ ', h('em', null, 'Dipshits')), h('p', null, 'No-limit hold’em for people who should know better.'));
}

function nameField(id: string, value: string): HTMLElement {
  return h(
    'label.field',
    { for: id },
    h('span', null, 'Your name'),
    h('input', { type: 'text', id, name: id, value, maxlength: NAME_LENGTH, required: true, autocomplete: 'nickname', placeholder: 'What the table calls you' }),
  );
}

function themeSection(themePicker: HTMLElement): HTMLElement {
  return h('section.theme-section', null, h('h2', null, 'Theme'), themePicker);
}

/**
 * Runs a form's action with its button showing that it is under way. The form itself stays as it is,
 * so nothing typed is lost if the attempt fails, and it can't be sent twice.
 */
async function whilePending(button: HTMLButtonElement, label: string, action: () => Promise<void>): Promise<void> {
  const idle = button.textContent;

  button.disabled = true;
  button.textContent = label;

  try {
    await action();
  } finally {
    button.disabled = false;
    button.textContent = idle;
  }
}

/** The front door: start a table, or go to one with its code. */
export function lobbyEl(rememberedName: string, themePicker: HTMLElement, handlers: LobbyHandlers): HTMLElement {
  const createButton = h('button.btn.primary', { type: 'submit', 'data-action': 'create-table' }, 'Create table');

  const create = h(
    'form.card-panel',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        const form = event.target as HTMLFormElement;

        void whilePending(createButton, 'Setting up…', () =>
          handlers.create(inputOf(form, 'host-name').value, {
            name: inputOf(form, 'new-table-name').value,
            smallBlind: numberOf(form, 'new-small-blind'),
            bigBlind: numberOf(form, 'new-big-blind'),
            minBuyIn: numberOf(form, 'new-min-buy-in'),
            maxBuyIn: numberOf(form, 'new-max-buy-in'),
          }),
        );
      },
    },
    h('h2', null, 'Start a table'),
    nameField('host-name', rememberedName),
    h(
      'label.field',
      { for: 'new-table-name' },
      h('span', null, 'Table name'),
      h('input', { type: 'text', id: 'new-table-name', name: 'new-table-name', value: 'Chips n’ Dipshits', maxlength: 40, required: true }),
    ),
    h('div.pair', null, numberField('new-small-blind', 'Small blind', 10, 1), numberField('new-big-blind', 'Big blind', 20, 1)),
    h('div.pair', null, numberField('new-min-buy-in', 'Minimum buy-in', 400, 1), numberField('new-max-buy-in', 'Maximum buy-in', 2000, 1)),
    h('p.note', null, 'You become the host. Clock, straddles, run it twice and the 7-2 bounty are in the table settings.'),
    createButton,
  );

  const join = h(
    'form.card-panel',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        handlers.openTable(inputOf(event.target as HTMLFormElement, 'table-code').value);
      },
    },
    h('h2', null, 'Join a table'),
    h(
      'label.field',
      { for: 'table-code' },
      h('span', null, 'Table code'),
      h('input', { type: 'text', id: 'table-code', name: 'table-code', maxlength: CODE_LENGTH, required: true, autocapitalize: 'characters', autocomplete: 'off', placeholder: 'e.g. K7QF2M' }),
    ),
    h('p.note', null, 'Got a link from the host? Opening it brings you straight to the table.'),
    h('button.btn', { type: 'submit' }, 'Find table'),
  );

  return h('main.lobby', null, brand(), h('div.panels', null, create, join), themeSection(themePicker));
}

/** Shown to someone who opened a table link but has not picked a name there yet. */
export function joinScreen(tableId: string, rememberedName: string, themePicker: HTMLElement, handlers: JoinHandlers): JoinScreen {
  const about = h('div.about', null, h('h2', null, `Table ${tableId}`), h('p.note', null, 'Looking for the table…'));
  const joinButton = h('button.btn.primary', { type: 'submit', disabled: true, 'data-action': 'join-table' }, 'Join table');

  const form = h(
    'form.card-panel',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        void whilePending(joinButton, 'Joining…', () => handlers.join(inputOf(event.target as HTMLFormElement, 'join-name').value));
      },
    },
    about,
    nameField('join-name', rememberedName),
    joinButton,
    h('button.link', { type: 'button', onclick: handlers.toLobby }, 'Start my own table instead'),
  );

  return {
    element: h('main.lobby', null, brand(), h('div.panels.single', null, form, themeSection(themePicker))),

    showTable(info) {
      about.replaceChildren(
        h('h2', null, info.name),
        h('p', null, `Blinds ${chips(info.smallBlind)}/${chips(info.bigBlind)}`),
        h('p.note', null, info.players.length > 0 ? `At the table: ${info.players.join(', ')}` : 'Nobody is seated yet.'),
      );
      joinButton.disabled = false;
    },
  };
}

/** A screen with nothing on it but a line of text, for the moment before the page knows what to show. */
export function noticeEl(text: string): HTMLElement {
  return h('main.lobby', null, brand(), h('p.note', null, text));
}

/**
 * Shown to someone who arrived by a personal link on a browser that doesn't know them yet.
 * `hasOwnSeat` says this browser already sits at the table as someone else, which "no" goes back to.
 */
export function welcomeBackEl(name: string, tableName: string, hasOwnSeat: boolean, handlers: { yes(): void; no(): void }): HTMLElement {
  const about = hasOwnSeat
    ? `This link is for ${name}’s seat at ${tableName}, and this browser already has a different seat there. Saying yes switches it to ${name}’s.`
    : `This link is for ${name}’s seat at ${tableName}.`;

  const panel = h(
    'div.card-panel',
    null,
    h('div.about', null, h('h2', null, `Continue as ${name}?`), h('p.note', null, about)),
    h('button.btn.primary', { type: 'button', 'data-action': 'confirm-member', onclick: handlers.yes }, `Yes, I’m ${name}`),
    h('button.btn', { type: 'button', 'data-action': 'decline-member', onclick: handlers.no }, hasOwnSeat ? 'No, back to my own seat' : 'No, join as someone else'),
  );

  return h('main.lobby', null, brand(), h('div.panels.single', null, panel));
}
