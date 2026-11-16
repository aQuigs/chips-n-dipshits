import { CONFIG_SPECS, fixedAtCreation, holdsAmounts, sameSetting, settingText, startingConfig } from '../../engine/config.ts';
import type { ConfigKey, ConfigSpec, SettingValue } from '../../engine/config.ts';
import { CONFIG_SECTION_KEYS, CONFIG_SECTIONS, sectionOf } from '../../engine/configSections.ts';
import type { ConfigSection } from '../../engine/configSections.ts';
import type { TableConfig } from '../../engine/types.ts';
import { h } from '../ui.ts';
import { bountiesHeld, bountyListField } from './bountyList.ts';
import type { BountyRow } from './bountyList.ts';
import { foldSection } from './foldSection.ts';
import type { FoldSection } from './foldSection.ts';
import { amountField, amountOf, checkField, inputOf, numberField, numberOf } from './forms.ts';

export interface ConfigFormOptions {
  /** Keeps the fields of two forms on one page apart. */
  idPrefix: string;
  /**
   * The form a new table is made with. It has only the settings asked for then, and it is the one place
   * a setting chosen for good is open; anywhere else it is told in words, not offered. Picking a choice
   * there that suggests where other settings start, as what the table plays with does, starts the
   * amounts over from that, since a number typed for whole chips means something else in dollars and cents.
   */
  creating: boolean;
  /** Whether a section starts unfolded. The rest start folded under the line of what they hold. */
  open(section: ConfigSection): boolean;
  /** The section the form leads with, ahead of the registry's order. */
  first?: ConfigSection;
  /** Told where the amounts start when a choice has started them over, for amounts kept outside the form. */
  startedOver?(start: TableConfig): void;
  /** Told whenever what the fields hold may have changed, with what they hold now (`read`). */
  edited?(held: Partial<TableConfig>): void;
}

export interface ConfigForm {
  /** One part per section of the settings with a field here, each under its heading, to put inside a form. */
  sections: HTMLElement[];
  /** The settings it has a field for. */
  shown: ConfigKey[];
  /** What the fields hold now, for the settings the form lets be changed. One that does not apply is left out: its field is out of sight, so nobody is changing it. */
  read(form: HTMLFormElement): Partial<TableConfig>;
  /** Puts `values` in every field, marking each field it changed and unfolding its section, and says which those were. */
  fill(form: HTMLFormElement, values: TableConfig): ConfigKey[];
  /** Unfolds the sections these settings stand in, for when something is about to be said of them. */
  unfold(keys: ConfigKey[]): void;
}

/** The field for one setting. `table` is the table its amounts are written for. */
function field(id: string, spec: ConfigSpec, value: SettingValue | readonly BountyRow[], table: TableConfig): HTMLElement {
  const hint = spec.hint ? h('small', null, spec.hint) : null;

  switch (spec.kind) {
    case 'text':
      return h('label.field', { for: id }, h('span', null, spec.label), h('input', { type: 'text', id, name: id, value, maxlength: spec.maxLength, required: true }), hint);

    // Plain text, not type="url", and no maxlength: the browser would stop the form in its own words, or cut a pasted address short without a word
    case 'link':
      return h(
        'label.field',
        { for: id },
        h('span', null, spec.label),
        h('input', { type: 'text', id, name: id, value, inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: spec.placeholder }),
        hint,
      );

    case 'chips':
      return amountField(id, spec.label, Number(value), table, spec.min, spec.max, spec.hint);

    case 'count':
    case 'seconds':
      return numberField(id, spec.label, Number(value), spec.min, spec.max, spec.hint);

    case 'toggle':
      return checkField(id, spec.label, value === true, spec.hint);

    case 'choice':
      return h(
        'div.field.choice',
        { id, role: 'radiogroup', 'aria-label': spec.label },
        h('span', null, spec.label),
        h(
          'div.options',
          null,
          spec.options.map((option) => h('label.check', null, h('input', { type: 'radio', name: id, value: String(option.value), checked: option.value === value }), h('span', null, option.label))),
        ),
        hint,
      );

    case 'handAmounts':
      return bountyListField(id, spec, value as readonly BountyRow[], table);
  }
}

/** A setting chosen for good, told in words where its field would be: a control nobody can use only looks broken. */
function fixedLine(id: string, key: ConfigKey, table: TableConfig): HTMLElement {
  const spec = CONFIG_SPECS[key];
  const picked = spec.kind === 'choice' ? spec.options.find((option) => option.value === table[key]) : undefined;
  const said = picked?.chosen ?? `${spec.label}: ${settingText(key, table)}`;

  return h('p.note', { id }, `${[said, spec.hint].filter(Boolean).join('. ')}.`);
}

function held(form: HTMLFormElement, id: string, spec: ConfigSpec, table: TableConfig): SettingValue {
  switch (spec.kind) {
    case 'toggle':
      return inputOf(form, id).checked;

    case 'text':
    case 'link':
      return inputOf(form, id).value;

    // A group of radio buttons answers to its name with the value of the one that is picked, as text: a count is its number
    case 'choice': {
      const picked = inputOf(form, id).value;

      return spec.options.find((option) => String(option.value) === picked)?.value ?? picked;
    }

    case 'chips':
      return amountOf(form, id, table);

    case 'count':
    case 'seconds':
      return numberOf(form, id);

    case 'handAmounts':
      return bountiesHeld(form, id, table);
  }
}

/** A list cut where `of` changes from one item to the next. */
function runs<T>(items: T[], of: (item: T) => unknown): T[][] {
  const cut: T[][] = [];

  for (const item of items) {
    if (cut.length > 0 && of(cut.at(-1)![0]!) === of(item)) {
      cut.at(-1)!.push(item);
    } else {
      cut.push([item]);
    }
  }

  return cut;
}

/**
 * The form fields for the table's settings, built from the config registry: a part for each of its
 * sections, in its order, with the section's settings under its heading, each filled with its value in
 * `values`. A part folds away under one line that says what its fields hold, and unfolds by itself when
 * the browser refuses one of them, since a field out of sight can't be pointed at.
 */
export function configForm(values: TableConfig, options: ConfigFormOptions): ConfigForm {
  const { idPrefix, creating } = options;
  const idOf = (key: ConfigKey) => idPrefix + key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const closed = (key: ConfigKey) => !creating && fixedAtCreation(key);
  const asked = (key: ConfigKey) => !creating || CONFIG_SPECS[key].atCreate;

  // What is settled for good comes after what can be changed
  const settingsOf = (section: ConfigSection): ConfigKey[] => {
    const keys = CONFIG_SECTIONS[section].settings.filter(asked);

    return [...keys.filter((key) => !closed(key)), ...keys.filter(closed)];
  };

  const order = options.first ? [options.first, ...CONFIG_SECTION_KEYS.filter((section) => section !== options.first)] : CONFIG_SECTION_KEYS;
  const filled = order.filter((section) => settingsOf(section).length > 0);
  const shown = filled.flatMap(settingsOf);
  const choices = shown.filter((key) => CONFIG_SPECS[key].kind === 'choice');

  // The table the form's amounts are written for, which at creation changes with the choices
  let table = values;
  const fields = new Map<ConfigKey, HTMLElement>();
  const parts = new Map<ConfigSection, FoldSection>();

  const applies = (key: ConfigKey, config: TableConfig): boolean => CONFIG_SPECS[key].applies?.(config) !== false;

  const read = (form: HTMLFormElement): Partial<TableConfig> => {
    const open = shown.filter((key) => !closed(key));
    const all = Object.fromEntries(open.map((key) => [key, held(form, idOf(key), CONFIG_SPECS[key], table)])) as Partial<TableConfig>;
    const now = { ...table, ...all };

    return Object.fromEntries(Object.entries(all).filter(([key]) => applies(key as ConfigKey, now))) as Partial<TableConfig>;
  };

  /** Brings what follows from the fields in line with them: which settings apply, and the line each section is folded under. */
  const follow = (form: HTMLFormElement): void => {
    const held = read(form);
    const now = { ...table, ...held };

    for (const [section, part] of parts) {
      // A field that can't be read has nothing to say yet: its section stays as it last could be told, so nothing jumps while an amount is half typed
      if (part.element.querySelector(':invalid') !== null) {
        continue;
      }

      for (const key of settingsOf(section)) {
        fields.get(key)!.hidden = !applies(key, now);
      }

      part.hold(CONFIG_SECTIONS[section].holds(now));
    }

    options.edited?.(held);
  };

  const startOver = (event: Event): void => {
    const form = (event.target as HTMLInputElement).form!;

    table = startingConfig(Object.fromEntries(choices.map((key) => [key, held(form, idOf(key), CONFIG_SPECS[key], table)])));

    for (const key of shown.filter(holdsAmounts)) {
      const spec = CONFIG_SPECS[key];

      // A hand is the same hand in chips and in dollars: only what it pays starts over
      redraw(key, spec.kind === 'handAmounts' ? bountiesHeld(form, idOf(key), table).map(([hand]): BountyRow => [hand, null]) : table[key]);
    }

    options.startedOver?.(table);
  };

  const draw = (key: ConfigKey, value: SettingValue | readonly BountyRow[] = table[key]): HTMLElement => {
    const spec = CONFIG_SPECS[key];
    const element = closed(key) ? fixedLine(idOf(key), key, table) : field(idOf(key), spec, value, table);

    element.hidden = !applies(key, table);

    if (creating && spec.kind === 'choice' && spec.options.some((option) => option.suggests)) {
      element.addEventListener('change', startOver);
    }

    return element;
  };

  const redraw = (key: ConfigKey, value?: SettingValue | readonly BountyRow[]): HTMLElement => {
    const fresh = draw(key, value);

    fields.get(key)!.replaceWith(fresh);
    fields.set(key, fresh);

    return fresh;
  };

  /** The rows of some settings that follow one another: each alone, or two to a row where both are narrow. */
  const rowsOf = (keys: ConfigKey[]): HTMLElement[] => {
    const rows: HTMLElement[] = [];
    let pair: HTMLElement | null = null;

    for (const key of keys) {
      const element = draw(key);

      fields.set(key, element);

      if (!CONFIG_SPECS[key].half) {
        rows.push(element);
        pair = null;
      } else if (pair) {
        pair.append(element);
        pair = null;
      } else {
        pair = h('div.pair', null, element);
        rows.push(pair);
      }
    }

    return rows;
  };

  for (const section of filled) {
    const rows = runs(settingsOf(section), (key) => CONFIG_SPECS[key].among).flatMap((together) => {
      const heading = CONFIG_SPECS[together[0]!].among;

      return heading ? [h('fieldset.field.among', null, h('legend', null, heading), rowsOf(together))] : rowsOf(together);
    });
    const part = foldSection(section, CONFIG_SECTIONS[section].label, options.open(section), rows);

    part.hold(CONFIG_SECTIONS[section].holds(table));
    parts.set(section, part);

    // A click too: a row of a list is added and taken away with a button, which no field hears of
    for (const type of ['input', 'change', 'click']) {
      part.element.addEventListener(type, () => {
        const form = part.element.closest('form');

        if (form) {
          follow(form);
        }
      });
    }

    // Before the browser looks for the field to point at, which it only finds unfolded
    part.element.addEventListener('invalid', () => (part.element.open = true), true);
  }

  const unfold = (keys: ConfigKey[]): void => {
    for (const key of keys) {
      const part = parts.get(sectionOf(key));

      if (part) {
        part.element.open = true;
      }
    }
  };

  return {
    sections: filled.map((section) => parts.get(section)!.element),
    shown,
    read,
    unfold,

    fill(form, values) {
      const before = { ...table, ...read(form) };
      const changed = shown.filter((key) => applies(key, values) && !sameSetting(before[key], values[key]));

      table = values;

      for (const key of shown) {
        redraw(key).classList.toggle('changed', changed.includes(key));
      }

      follow(form);
      unfold(changed);

      return changed;
    },
  };
}
