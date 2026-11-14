import { bountiesText } from '../../engine/bounties.ts';
import { CONFIG_SPECS, holdsAmounts, sameSetting, settingText, startingConfig } from '../../engine/config.ts';
import type { ConfigKey } from '../../engine/config.ts';
import { fromPreset, PRESET_KEYS } from '../../engine/presets.ts';
import type { Preset } from '../../engine/presets.ts';
import { stakesText } from '../../engine/stakes.ts';
import type { KnownPlayer, TableConfig } from '../../engine/types.ts';
import type { TableInfo } from '../../server/api.ts';
import type { Answer } from '../knownPlayers.ts';
import { h } from '../ui.ts';
import { configForm } from './configForm.ts';
import { inputOf } from './forms.ts';
import { whoField } from './whoField.ts';
import type { WhoField } from './whoField.ts';

const CODE_LENGTH = 12;

/** What the browser remembers of whoever last used it: the name they last typed, and the known player they said they were. */
export interface Visitor {
  name: string;
  player: KnownPlayer | null;
}

/** A screen that asks its visitor who they are before they are at a table. */
export interface AsksWho {
  element: HTMLElement;
  /** Offers the known players to pick from, once they have been heard from. As `WhoField.offer`. */
  offerPlayers: WhoField['offer'];
}

export interface LobbyHandlers {
  /** Resolves when the attempt is over, whichever way it went. */
  create(as: Answer, config: Partial<TableConfig>): Promise<void>;
  openTable(code: string): void;
}

export interface LobbyScreen extends AsksWho {
  /** Offers the group's presets in the form for a new table, once they have been heard from. */
  offerPresets(presets: Preset[]): void;
}

export interface JoinHandlers {
  /** Resolves when the attempt is over, whichever way it went. */
  join(as: Answer): Promise<void>;
  toLobby(): void;
}

export interface JoinScreen extends AsksWho {
  /** Fills in what the table is once the server has said, and lets the visitor join. */
  showTable(info: TableInfo): void;
}

function brand(): HTMLElement {
  return h('div.brand', null, h('h1', null, 'Chips n’ ', h('em', null, 'Dipshits')), h('p', null, 'No-limit hold’em for people who should know better.'));
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
export function lobbyEl(visitor: Visitor, themePicker: HTMLElement, handlers: LobbyHandlers): LobbyScreen {
  const who = whoField('host-name', visitor.name, visitor.player);
  const createButton = h('button.btn.primary', { type: 'submit', 'data-action': 'create-table' }, 'Create table');

  // The table's name starts out with the apostrophe the page's own title has
  const usual: TableConfig = { ...startingConfig(), name: 'Chips n’ Dipshits' };

  // A preset's settings that the form has no field for, which the table is created with all the same
  let unseen: Partial<TableConfig> = {};
  const presetPick = h('div.preset-pick', { hidden: true });
  const notes = h('div.preset-notes', { 'aria-live': 'polite' });

  const alsoSet = (table: TableConfig): HTMLElement[] => {
    const start = startingConfig(table);
    const differ = (Object.keys(unseen) as ConfigKey[]).filter((key) => !sameSetting(table[key], start[key]));

    return differ.length > 0 ? [h('p.note', null, `Also set, in the table settings: ${differ.map((key) => `${CONFIG_SPECS[key].label} ${settingText(key, table)}`).join(', ')}.`)] : [];
  };

  // An amount means something else once what the table plays with changes, so the preset's unseen ones start over too
  const startedOver = (start: TableConfig): void => {
    const amounts = (Object.keys(unseen) as ConfigKey[]).filter(holdsAmounts);

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
        void whilePending(createButton, 'Setting up…', () => handlers.create(who.answer(), { ...unseen, ...settings.read(create) }));
      },
    },
    h('h2', null, 'Start a table'),
    who.element,
    presetPick,
    settings.rows,
    h('p.note', null, 'You become the host. Clock, straddles and running it more than once are in the table settings.'),
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
    offerPlayers: who.offer,

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
export function joinScreen(tableId: string, visitor: Visitor, themePicker: HTMLElement, handlers: JoinHandlers): JoinScreen {
  const who = whoField('join-name', visitor.name, visitor.player);
  const about = h('div.about', null, h('h2', null, `Table ${tableId}`), h('p.note', null, 'Looking for the table…'));
  const joinButton = h('button.btn.primary', { type: 'submit', disabled: true, 'data-action': 'join-table' }, 'Join table');

  const form = h(
    'form.card-panel',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        void whilePending(joinButton, 'Joining…', () => handlers.join(who.answer()));
      },
    },
    about,
    who.element,
    joinButton,
    h('button.link', { type: 'button', onclick: handlers.toLobby }, 'Start my own table instead'),
  );

  return {
    element: h('main.lobby', null, brand(), h('div.panels.single', null, form, themeSection(themePicker))),
    offerPlayers: who.offer,

    showTable(info) {
      about.replaceChildren(
        h('h2', null, info.name),
        h('p', null, `Blinds ${stakesText(info)}`),
        ...(info.bounties.length > 0 ? [h('p', null, `Bounties: ${bountiesText(info.bounties, info)}`)] : []),
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
 * Shown to someone who asked for a table that was put away. `said` is the server's sentence, which
 * says how long a table may go without play. It stays up until they leave it: someone coming back to
 * a tab after weeks should not find the reason gone with a toast.
 */
export function putAwayEl(tableId: string, said: string, startNew: () => void): HTMLElement {
  const panel = h(
    'div.card-panel',
    { 'data-screen': 'put-away' },
    h('div.about', null, h('h2', null, `Table ${tableId}`), h('p', null, said), h('p.note', null, 'Whoever runs the game can still find its ledger and its hands in the game’s Sheet.')),
    h('button.btn.primary', { type: 'button', 'data-action': 'start-new-table', onclick: startNew }, 'Start a new table'),
  );

  return h('main.lobby', null, brand(), h('div.panels.single', null, panel));
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
