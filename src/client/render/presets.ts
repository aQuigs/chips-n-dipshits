import { matchingPreset, presetName, sameName } from '../../engine/presets.ts';
import type { Preset } from '../../engine/presets.ts';
import type { TableConfig } from '../../engine/types.ts';
import { LIMITS } from '../../engine/validate.ts';
import { h, holdWhile } from '../ui.ts';

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

/**
 * The part of a table's settings where its host or a co-host keeps them as a preset for the group, and
 * deletes ones the group no longer wants. `table` is the table's settings, for saying whether it plays
 * one; `current` is what the settings form above holds, which is what a preset is saved from.
 */
export function presetsPanel(table: TableConfig, handlers: PresetHandlers, current: () => TableConfig): HTMLElement {
  let presets: Preset[] | null = null;
  let failed = false;
  let asking: Asking = null;

  const nameInput = h('input', { type: 'text', id: 'preset-name', name: 'preset-name', maxlength: LIMITS.presetNameLength, required: true, autocomplete: 'off', placeholder: 'Friday 25/50' });
  const saveButton = h('button.btn', { type: 'submit', 'data-action': 'save-preset' }, 'Save preset');
  const playing = h('p.note', { hidden: true });
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
    holdWhile(button, async () => show(await handlers.save(name, current(), replace), `Saved ${name}.`));
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

  const form = h(
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
    h('label.field', { for: 'preset-name' }, h('span', null, 'Save the settings above as a preset'), nameInput),
    saveButton,
  );

  const panel = h('section.preset-panel', null, h('h3', null, 'Presets'), playing, form, question, status, list);

  draw();
  void reload();

  return panel;
}
