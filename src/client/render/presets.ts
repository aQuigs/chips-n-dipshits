import { matchingPreset, presetName, sameName } from '../../engine/presets.ts';
import type { Preset } from '../../engine/presets.ts';
import type { TableConfig } from '../../engine/types.ts';
import { LIMITS } from '../../engine/validate.ts';
import { h, holdWhile } from '../ui.ts';
import { foldSection } from './foldSection.ts';

export interface PresetHandlers {
  /** Rejects when they could not be loaded. */
  list(): Promise<Preset[]>;
  /** The presets once it is saved, or null when it was refused or got no answer, which the player has been told. */
  save(name: string, settings: TableConfig, replace: boolean): Promise<Preset[] | null>;
  /** As `save`. */
  remove(name: string): Promise<Preset[] | null>;
}

/** A name as the server will keep it, so the page finds the one it would replace. One it would refuse is sent as typed, for the server to say why. */
function cleaned(typed: string): string {
  try {
    return presetName(typed);
  } catch {
    return typed;
  }
}

/** A question waiting for the player before something is overwritten or thrown away for the whole group. */
type Asking = { kind: 'replace' | 'delete'; name: string } | null;

/** The settings form a preset is saved from. */
export interface SettingsHeld {
  /** What it holds now. */
  current(): TableConfig;
  /** Whether all of it can be read. When not, the form has pointed at what can't. */
  readable(): boolean;
}

export interface PresetsPanel {
  element: HTMLElement;
  /** Told whether the settings form now differs from the table, since a preset is saved from what the form holds. */
  differs(fromTable: boolean): void;
}

/**
 * The section of a table's settings where its host or a co-host keeps them as a preset for the group,
 * and deletes ones the group no longer wants, folded under a line that says how the presets stand.
 * `table` is the table's settings, for saying whether it plays one; `form` is the settings form,
 * since what it holds is what a preset is saved from.
 */
export function presetsPanel(table: TableConfig, handlers: PresetHandlers, form: SettingsHeld): PresetsPanel {
  let presets: Preset[] | null = null;
  let failed = false;
  let asking: Asking = null;

  const nameInput = h('input', { type: 'text', id: 'preset-name', name: 'preset-name', maxlength: LIMITS.presetNameLength, required: true, autocomplete: 'off', placeholder: 'Friday 25/50' });
  const saveButton = h('button.btn', { type: 'submit', 'data-action': 'save-preset' }, 'Save as preset');
  const playing = h('p.note', { hidden: true });
  // Saving a preset and saving the table are two things: said where one could be taken for the other
  const unsaved = h('p.note', { hidden: true, 'data-says': 'table-unchanged' }, 'A preset keeps what this form holds now. The table itself is unchanged until you press Save.');
  const status = h('p.note', { 'aria-live': 'polite' });
  const question = h('div.preset-question', { hidden: true });
  const list = h('ul.rows.preset-list');

  const show = (fresh: Preset[] | null, said = ''): void => {
    if (fresh) {
      presets = fresh;
      failed = false;
      status.textContent = said;
    } else {
      void reload();
    }

    asking = null;
    draw();
  };

  const reload = async (): Promise<void> => {
    try {
      presets = await handlers.list();
      failed = false;
    } catch {
      failed = presets === null;
    }

    draw();
  };

  const save = (button: HTMLButtonElement, name: string, replace: boolean): void => {
    if (form.readable()) {
      holdWhile(button, async () => show(await handlers.save(name, form.current(), replace), `Saved ${name}.`));
    }
  };

  const keepIt = () => h('button.btn.small', { type: 'button', 'data-action': 'keep-preset', onclick: () => show(presets) }, 'Keep it');

  const ask = (question: Asking): void => {
    asking = question;
    draw();

    // The question may take more room than what it replaced, which on a phone can push its buttons out of sight
    panel.querySelector('.preset-question:not([hidden]), .asking')?.scrollIntoView({ block: 'nearest' });
  };

  const draw = (): void => {
    const match = presets && matchingPreset(presets, table);

    playing.hidden = !match;
    playing.textContent = match ? `This table plays the preset ${match.name}.` : '';
    section.hold(match ? `Plays ${match.name}` : presets ? (presets.length === 0 ? 'None saved' : `${presets.length} saved`) : failed ? 'Could not load' : '');

    question.hidden = asking?.kind !== 'replace';
    question.replaceChildren();

    if (asking?.kind === 'replace') {
      const name = asking.name;
      const replace = h('button.btn.small.primary', { type: 'button', 'data-action': 'replace-preset' }, 'Replace');

      replace.addEventListener('click', () => save(replace, name, true));
      question.append(
        h('p', null, `There is already a preset called ${name}. Replace it with these settings?`),
        h('span.row-actions', null, replace, keepIt()),
      );
    }

    if (!presets) {
      list.replaceChildren(h('li.note', null, failed ? 'Could not load the presets. Close this and try again.' : 'Looking for presets…'));
      return;
    }

    if (presets.length === 0) {
      list.replaceChildren(h('li.note', null, 'None yet. A preset is offered in the form for a new table.'));
      return;
    }

    list.replaceChildren(
      ...presets.map((preset) => {
        if (asking?.kind === 'delete' && sameName(asking.name, preset.name)) {
          const confirm = h('button.btn.small.danger', { type: 'button', 'data-action': 'confirm-delete-preset' }, 'Delete');

          confirm.addEventListener('click', () => holdWhile(confirm, async () => show(await handlers.remove(preset.name), `Deleted ${preset.name}.`)));

          return h(
            'li.asking',
            null,
            h('span.preset-name', null, `Delete ${preset.name} for everyone?`),
            h('span.row-actions', null, confirm, keepIt()),
          );
        }

        const remove = () => ask({ kind: 'delete', name: preset.name });

        return h('li', null, h('span.preset-name', null, preset.name), h('button.btn.small', { type: 'button', 'data-action': 'delete-preset', 'aria-label': `Delete ${preset.name}`, onclick: remove }, 'Delete'));
      }),
    );
  };

  const naming = h(
    'form.preset-save',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();

        const name = cleaned(nameInput.value);
        const taken = presets?.find((preset) => sameName(preset.name, name));

        if (taken) {
          ask({ kind: 'replace', name: taken.name });
        } else {
          save(saveButton, name, false);
        }
      },
    },
    h('label.field', { for: 'preset-name' }, h('span', null, 'Name these settings'), nameInput),
    saveButton,
  );

  const panel = h('div.preset-panel', null, playing, naming, unsaved, question, status, list);
  const section = foldSection('presets', 'Presets', false, panel);

  draw();
  void reload();

  return { element: section.element, differs: (fromTable) => (unsaved.hidden = !fromTable) };
}
