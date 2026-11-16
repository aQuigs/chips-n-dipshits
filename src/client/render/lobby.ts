import { bountiesText } from '../../engine/bounties.ts';
import { startingConfig } from '../../engine/config.ts';
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

/** A table the visitor was at, which the page can still take them back to. */
export interface TableLeft {
  name: string;
  back(): void;
}

export interface LobbyHandlers {
  /** Resolves when the attempt is over, to whether the server refused it: its words then say what in the form is wrong. */
  create(as: Answer, config: Partial<TableConfig>): Promise<boolean>;
  /** Makes a change to the screen that the game and not the visitor brings about, as on the server's answer: what comes up under a finger takes no tap for a moment (`TapGuard`). */
  byItself(change: () => void): void;
  /** Says a line to a screen reader alone, of a change the page itself shows the eye. */
  say(message: string): void;
  openTable(code: string): void;
  /** Shows the standings over this screen, which stays as it is underneath. */
  standings(): void;
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

/** The front door: start a table, or go to one with its code. `left` is the table the visitor came here from, to which the way back comes first. */
export function lobbyEl(visitor: Visitor, themePicker: HTMLElement, left: TableLeft | null, handlers: LobbyHandlers): LobbyScreen {
  const who = whoField('host-name', visitor.name, visitor.player);
  const createButton = h('button.btn.primary', { type: 'submit', 'data-action': 'create-table' }, 'Create table');

  // The table's name starts out with the apostrophe the page's own title has
  const usual: TableConfig = { ...startingConfig(), name: 'Chips n’ Dipshits' };

  let preset: Preset | null = null;
  const presetPick = h('div.preset-pick', { hidden: true });
  const notes = h('div.preset-notes', { 'aria-live': 'polite' });

  // Open on what a new host can answer: what the table is and what it plays for. A preset has answered the stakes too.
  // The rest waits folded under the line of what it holds, the table's name where a new host starts
  const settings = configForm(usual, {
    idPrefix: 'new-table-',
    creating: true,
    first: 'table',
    open: (section) => section === 'table' || (section === 'stakes' && !preset),
  });

  // The sections it opens on, and the folded rest as one stack: a wide screen stands them side by side
  const opensOn = settings.sections.filter((section) => section.open);
  const rest = settings.sections.filter((section) => !section.open);

  const pick = (chosen: Preset | null): void => {
    const used = fromPreset(chosen ? chosen.settings : usual);

    preset = chosen;

    // The stakes fold or unfold where the list of presets was just open, and Create table moves with them: a second press on a preset must not land on it
    handlers.byItself(() => {
      // Only what a preset keeps: the rest is still as the host has it
      settings.fill(create, Object.fromEntries(PRESET_KEYS.map((key) => [key, used.config[key]])));
      notes.replaceChildren(...used.notes.map((note) => h('p.note.warn', null, note)));
    });

    // The eye has the fields and the lines of the folded sections to go by
    handlers.say(chosen ? `Filled in from ${chosen.name}.` : 'Back to the usual settings.');
  };

  const create: HTMLFormElement = h(
    'form.card-panel.start-table',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();

        void whilePending(createButton, 'Setting up…', async () => {
          if (await handlers.create(who.answer(), settings.read(create))) {
            // The server's words name something the host changed, which may be folded away by now
            handlers.byItself(() => settings.unfold(Object.keys(settings.changed(create)) as ConfigKey[]));
          }
        });
      },
    },
    h('h2', null, 'Start a table'),
    who.element,
    presetPick,
    h('div.sections', null, opensOn, h('div.rest', null, rest)),
    createButton,
    h('p.note', null, 'You become the host. Everything but what the table plays with can be changed later in Table settings.'),
  );

  // One row, ahead of the host's form: nobody with a table's code reads through that form to reach it
  const join = h(
    'form.card-panel.join-strip',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        handlers.openTable(inputOf(event.target as HTMLFormElement, 'table-code').value);
      },
    },
    h('h2', null, 'Join a table'),
    h('input', {
      type: 'text',
      id: 'table-code',
      name: 'table-code',
      'aria-label': 'Table code',
      maxlength: CODE_LENGTH,
      required: true,
      autocapitalize: 'characters',
      autocomplete: 'off',
      placeholder: 'Table code',
    }),
    h('button.btn', { type: 'submit' }, 'Find table'),
  );

  const standings = h(
    'section.standings-door',
    null,
    h('button.btn', { type: 'button', 'data-action': 'standings', onclick: handlers.standings }, 'Standings'),
    h('p.note', null, 'Who is up and who is down, over every night.'),
  );

  // Ahead of everything else: whoever is here for a look, or by a slip of the thumb, has a seat waiting
  const wayBack = left && h('div.way-back', null, h('button.btn.primary', { type: 'button', 'data-action': 'back-to-table', onclick: left.back }, `Back to ${left.name}`));

  return {
    element: h('main.lobby', null, brand(), wayBack, standings, h('div.panels', null, join, create), themeSection(themePicker)),
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

      // The list comes when the server has answered, with the form up and maybe a finger on its way to a field it pushes down
      handlers.byItself(() => {
        presetPick.replaceChildren(h('label.field', { for: 'new-table-preset' }, h('span', null, 'Start from'), select), notes);
        presetPick.hidden = false;
      });
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
