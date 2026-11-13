import type { TableConfig } from '../../engine/types.ts';
import type { TableInfo } from '../../server/api.ts';
import { chips, h } from '../ui.ts';

const NAME_LENGTH = 16;
const CODE_LENGTH = 12;

export interface LobbyHandlers {
  create(name: string, config: Partial<TableConfig>): void;
  openTable(code: string): void;
}

export interface JoinHandlers {
  join(name: string): void;
  toLobby(): void;
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

function numberField(id: string, label: string, value: number): HTMLElement {
  return h('label.field', { for: id }, h('span', null, label), h('input', { type: 'number', id, name: id, value, min: 1, step: 1, inputmode: 'numeric', required: true }));
}

function field(form: HTMLFormElement, name: string): HTMLInputElement {
  return form.elements.namedItem(name) as HTMLInputElement;
}

/** The front door: start a table, or go to one with its code. */
export function lobbyEl(rememberedName: string, busy: boolean, handlers: LobbyHandlers): HTMLElement {
  const create = h(
    'form.card-panel',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        const form = event.target as HTMLFormElement;
        const bigBlind = Number(field(form, 'new-big-blind').value);

        handlers.create(field(form, 'host-name').value, {
          name: field(form, 'new-table-name').value,
          smallBlind: Number(field(form, 'new-small-blind').value),
          bigBlind,
          minBuyIn: Number(field(form, 'new-min-buy-in').value),
          maxBuyIn: Number(field(form, 'new-max-buy-in').value),
        });
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
    h('div.pair', null, numberField('new-small-blind', 'Small blind', 10), numberField('new-big-blind', 'Big blind', 20)),
    h('div.pair', null, numberField('new-min-buy-in', 'Minimum buy-in', 400), numberField('new-max-buy-in', 'Maximum buy-in', 2000)),
    h('p.note', null, 'You become the host. Clock, straddles, run it twice and the 7-2 bounty are in the table settings.'),
    h('button.btn.primary', { type: 'submit', disabled: busy, 'data-action': 'create-table' }, busy ? 'Setting up…' : 'Create table'),
  );

  const join = h(
    'form.card-panel',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        handlers.openTable(field(event.target as HTMLFormElement, 'table-code').value);
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
    h('button.btn', { type: 'submit', disabled: busy }, 'Find table'),
  );

  return h('main.lobby', null, brand(), h('div.panels', null, create, join));
}

/** Shown to someone who opened a table link but has not picked a name there yet. */
export function joinEl(tableId: string, info: TableInfo | null, rememberedName: string, busy: boolean, handlers: JoinHandlers): HTMLElement {
  const about = info
    ? h(
        'div.about',
        null,
        h('h2', null, info.name),
        h('p', null, `Blinds ${chips(info.smallBlind)}/${chips(info.bigBlind)}`),
        h('p.note', null, info.players.length > 0 ? `At the table: ${info.players.join(', ')}` : 'Nobody is seated yet.'),
      )
    : h('div.about', null, h('h2', null, `Table ${tableId}`), h('p.note', null, 'Looking for the table…'));

  const form = h(
    'form.card-panel',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        handlers.join(field(event.target as HTMLFormElement, 'join-name').value);
      },
    },
    about,
    nameField('join-name', rememberedName),
    h('button.btn.primary', { type: 'submit', disabled: busy || !info, 'data-action': 'join-table' }, busy ? 'Joining…' : 'Join table'),
    h('button.link', { type: 'button', onclick: handlers.toLobby }, 'Start my own table instead'),
  );

  return h('main.lobby', null, brand(), h('div.panels.single', null, form));
}

/** A screen with nothing on it but a line of text, for the moment before the page knows what to show. */
export function noticeEl(text: string): HTMLElement {
  return h('main.lobby', null, brand(), h('p.note', null, text));
}

/** Shown to someone who arrived by a personal link on a browser that doesn't know them yet. */
export function welcomeBackEl(name: string, tableName: string, handlers: { yes(): void; no(): void }): HTMLElement {
  const panel = h(
    'div.card-panel',
    null,
    h('div.about', null, h('h2', null, `Continue as ${name}?`), h('p.note', null, `This link is for ${name}’s seat at ${tableName}.`)),
    h('button.btn.primary', { type: 'button', 'data-action': 'confirm-member', onclick: handlers.yes }, `Yes, I’m ${name}`),
    h('button.btn', { type: 'button', 'data-action': 'decline-member', onclick: handlers.no }, 'No, join as someone else'),
  );

  return h('main.lobby', null, brand(), h('div.panels.single', null, panel));
}
