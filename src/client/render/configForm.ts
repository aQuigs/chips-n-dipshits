import { CONFIG_SPECS, fixedAtCreation, holdsAmounts, sameSetting, settingsRefused, settingText, startingConfig } from '../../engine/config.ts';
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
   * The form a new table is made with: the one place a setting chosen for good is open; anywhere else
   * it is told in words, not offered. Picking a choice there that suggests where other settings start,
   * as what the table plays with does, starts the amounts over from that, since a number typed for whole
   * chips means something else in dollars and cents.
   */
  creating: boolean;
  /**
   * Whether a section is unfolded; the rest are folded under the line of what they hold. Asked as the
   * form is drawn and again each time it is filled, when a section its user has had a hand in, by its
   * heading or by changing a field, is left as they have it.
   */
  open(section: ConfigSection): boolean;
  /** The section the form leads with, ahead of the registry's order. */
  first?: ConfigSection;
  /** Told whenever what the fields hold may have changed, with what of it their user has changed (`changed`). */
  edited?(changed: Partial<TableConfig>): void;
}

export interface ConfigForm {
  /** One part per section of the settings, each under its heading, to put inside a form. */
  sections: HTMLDetailsElement[];
  /** What the fields hold now, for the settings the form lets be changed. One that does not apply is left out: its field is out of sight, so nobody is changing it. */
  read(form: HTMLFormElement): Partial<TableConfig>;
  /** What of that its user has changed: whatever is not as the form itself last put it in the fields. */
  changed(form: HTMLFormElement): Partial<TableConfig>;
  /** Puts `values` in the fields of the settings it names, and folds the sections as `open` now says. */
  fill(form: HTMLFormElement, values: Partial<TableConfig>): void;
  /**
   * The boxes of the settings a refusal is about, their sections unfolded, for the form's line to mark
   * (`refusalLine`). Of the settings a rule between them reads, those the form's user changed are the ones
   * to look at.
   */
  refusedAt(form: HTMLFormElement, reason: string): HTMLElement[];
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

  // What is settled for good comes after what can be changed
  const settingsOf = (section: ConfigSection): ConfigKey[] => {
    const keys: readonly ConfigKey[] = CONFIG_SECTIONS[section].settings;

    return [...keys.filter((key) => !closed(key)), ...keys.filter(closed)];
  };

  const order = options.first ? [options.first, ...CONFIG_SECTION_KEYS.filter((section) => section !== options.first)] : CONFIG_SECTION_KEYS;
  const shown = order.flatMap(settingsOf);
  const choices = shown.filter((key) => CONFIG_SPECS[key].kind === 'choice');

  // What the form itself last put in the fields, which is also the table its amounts are written for
  let table = values;
  const fields = new Map<ConfigKey, HTMLElement>();
  const parts = new Map<ConfigSection, FoldSection>();
  /** The sections whose user has had a hand in them: how each is folded is theirs to say from then on. */
  const theirs = new Set<ConfigSection>();

  const applies = (key: ConfigKey, config: TableConfig): boolean => CONFIG_SPECS[key].applies?.(config) !== false;

  const read = (form: HTMLFormElement): Partial<TableConfig> => {
    const open = shown.filter((key) => !closed(key));
    const all = Object.fromEntries(open.map((key) => [key, held(form, idOf(key), CONFIG_SPECS[key], table)])) as Partial<TableConfig>;
    const now = { ...table, ...all };

    return Object.fromEntries(Object.entries(all).filter(([key]) => applies(key as ConfigKey, now))) as Partial<TableConfig>;
  };

  const changedOf = (held: Partial<TableConfig>): Partial<TableConfig> =>
    Object.fromEntries(Object.entries(held).filter(([key, value]) => !sameSetting(value, table[key as ConfigKey]))) as Partial<TableConfig>;

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

    options.edited?.(changedOf(held));
  };

  const startOver = (event: Event): void => {
    const form = (event.target as HTMLInputElement).form!;
    const start = startingConfig(Object.fromEntries(choices.map((key) => [key, held(form, idOf(key), CONFIG_SPECS[key], table)])));
    const amounts = shown.filter(holdsAmounts);

    // Only the choices and the amounts: every other field still holds what it was filled with
    table = { ...table, ...Object.fromEntries([...choices, ...amounts].map((key) => [key, start[key]])) };

    for (const key of amounts) {
      const spec = CONFIG_SPECS[key];

      // A hand is the same hand in chips and in dollars: only what it pays starts over
      redraw(key, spec.kind === 'handAmounts' ? bountiesHeld(form, idOf(key), table).map(([hand]): BountyRow => [hand, null]) : table[key]);
    }

    // An amount left empty is theirs to write again, and the line it is folded under still says the old one
    for (const part of parts.values()) {
      part.element.open ||= part.element.querySelector(':invalid') !== null;
    }
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

  const redraw = (key: ConfigKey, value?: SettingValue | readonly BountyRow[]): void => {
    const fresh = draw(key, value);

    fields.get(key)!.replaceWith(fresh);
    fields.set(key, fresh);
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

  for (const section of order) {
    const rows = runs(settingsOf(section), (key) => CONFIG_SPECS[key].among).flatMap((together) => {
      const heading = CONFIG_SPECS[together[0]!].among;

      return heading ? [h('fieldset.field.among', null, h('legend', null, heading), rowsOf(together))] : rowsOf(together);
    });
    const part = foldSection(section, CONFIG_SECTIONS[section].label, options.open(section), rows);

    part.hold(CONFIG_SECTIONS[section].holds(table));
    parts.set(section, part);

    // A click too: a row of a list is added and taken away with a button, which no field hears of
    for (const type of ['input', 'change', 'click']) {
      part.element.addEventListener(type, (event) => {
        const form = part.element.closest('form');

        // A press on its heading or on a button of a list is a hand in it; one that only puts the keyboard in a field is not
        if (type !== 'click' || (event.target as Element).closest('summary, button') !== null) {
          theirs.add(section);
        }

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
    sections: order.map((section) => parts.get(section)!.element),
    read,
    changed: (form) => changedOf(read(form)),

    refusedAt(form, reason) {
      const held = read(form);
      const changed = changedOf(held);
      const named = settingsRefused(reason, { ...table, ...held }).filter((key) => fields.get(key)?.hidden === false);
      const theirs = named.filter((key) => key in changed);
      const at = theirs.length > 0 ? theirs : named;

      unfold(at);

      return at.flatMap((key) => [...fields.get(key)!.querySelectorAll<HTMLElement>('input, select')]);
    },

    fill(form, values) {
      table = { ...table, ...values };

      for (const key of shown.filter((key) => key in values)) {
        redraw(key);
      }

      for (const [section, part] of parts) {
        if (!theirs.has(section)) {
          part.element.open = options.open(section);
        }
      }

      follow(form);
    },
  };
}
