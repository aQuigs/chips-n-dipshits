import { CONFIG_SPECS, settingText, startingConfig } from '../../engine/config.ts';
import type { ConfigKey } from '../../engine/config.ts';
import { fromPreset, PRESET_KEYS } from '../../engine/presets.ts';
import type { Preset } from '../../engine/presets.ts';
import { stakesText } from '../../engine/stakes.ts';
import type { TableConfig } from '../../engine/types.ts';
import type { TableInfo } from '../../server/api.ts';
import { h } from '../ui.ts';
import { configForm } from './configForm.ts';
import { inputOf } from './forms.ts';

const NAME_LENGTH = 16;
const CODE_LENGTH = 12;

export interface LobbyHandlers {
  /** Resolves when the attempt is over, whichever way it went. */
  create(name: string, config: Partial<TableConfig>): Promise<void>;
  openTable(code: string): void;
}

export interface LobbyScreen {
  element: HTMLElement;
  /** Offers the group's presets in the form for a new table, once they have been heard from. */
  offerPresets(presets: Preset[]): void;
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
export function lobbyEl(rememberedName: string, themePicker: HTMLElement, handlers: LobbyHandlers): LobbyScreen {
  const createButton = h('button.btn.primary', { type: 'submit', 'data-action': 'create-table' }, 'Create table');

  // The table's name starts out with the apostrophe the page's own title has
  const usual: TableConfig = { ...startingConfig(), name: 'Chips n’ Dipshits' };

  // A preset's settings that the form has no field for, which the table is created with all the same
  let unseen: Partial<TableConfig> = {};
  const presetPick = h('div.preset-pick', { hidden: true });
  const notes = h('div.preset-notes', { 'aria-live': 'polite' });

  const alsoSet = (table: TableConfig): HTMLElement[] => {
    const start = startingConfig(table);
    const differ = (Object.keys(unseen) as ConfigKey[]).filter((key) => table[key] !== start[key]);

    return differ.length > 0 ? [h('p.note', null, `Also set, in the table settings: ${differ.map((key) => `${CONFIG_SPECS[key].label} ${settingText(key, table)}`).join(', ')}.`)] : [];
  };

  // An amount means something else once what the table plays with changes, so the preset's unseen ones start over too
  const startedOver = (start: TableConfig): void => {
    const amounts = (Object.keys(unseen) as ConfigKey[]).filter((key) => CONFIG_SPECS[key].kind === 'chips');

    unseen = { ...unseen, ...Object.fromEntries(amounts.map((key) => [key, start[key]])) };
    notes.replaceChildren(...alsoSet({ ...start, ...unseen }));
  };

  const settings = configForm(usual, 'new-table-', true, startedOver);

  const pick = (chosen: Preset | null): void => {
    const current = { ...usual, ...settings.read(create) };
    const used = fromPreset(chosen ? chosen.settings : usual, current);
    const changed = settings.fill(create, used.config);

    unseen = Object.fromEntries(PRESET_KEYS.filter((key) => !settings.shown.includes(key)).map((key) => [key, used.config[key]]));

    notes.replaceChildren(
      h('p.note', null, changed.length > 0 ? `Changed here: ${changed.map((key) => CONFIG_SPECS[key].label).join(', ')}.` : 'The form already held these settings.'),
      ...alsoSet(used.config),
      ...used.notes.map((note) => h('p.note.warn', null, note)),
    );
  };

  const create: HTMLFormElement = h(
    'form.card-panel',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        void whilePending(createButton, 'Setting up…', () => handlers.create(inputOf(create, 'host-name').value, { ...unseen, ...settings.read(create) }));
      },
    },
    h('h2', null, 'Start a table'),
    nameField('host-name', rememberedName),
    presetPick,
    settings.rows,
    h('p.note', null, 'You become the host. Clock, straddles, running it more than once and the 7-2 bounty are in the table settings.'),
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

  return {
    element: h('main.lobby', null, brand(), h('div.panels', null, create, join), themeSection(themePicker)),

    offerPresets(presets) {
      if (presets.length === 0) {
        return;
      }

      const select = h(
        'select',
        { id: 'new-table-preset', name: 'new-table-preset', onchange: () => pick(select.value === '' ? null : presets[Number(select.value)]!) },
        h('option', { value: '' }, 'The usual settings'),
        presets.map((preset, index) => h('option', { value: String(index) }, preset.name)),
      );

      presetPick.replaceChildren(h('label.field', { for: 'new-table-preset' }, h('span', null, 'Start from'), select), notes);
      presetPick.hidden = false;
    },
  };
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
        h('p', null, `Blinds ${stakesText(info)}`),
        h('p.note', null, info.players.length > 0 ? `At the table: ${info.players.join(', ')}` : 'Nobody is seated yet.'),
      );
      joinButton.disabled = false;
    },
  };
}

/** A screen with nothing on it but a line of text, for the moment before the page knows what to show. */
export function noticeEl(text: string, wayOut?: { label: string; action(): void }): HTMLElement {
  return h(
    'main.lobby',
    null,
    brand(),
    h('p.note', null, text),
    wayOut ? h('button.btn', { type: 'button', 'data-action': 'leave-notice', onclick: wayOut.action }, wayOut.label) : null,
  );
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
