import { CONFIG_GROUPS, CONFIG_KEYS, CONFIG_SPECS, fixedAtCreation, startingConfig } from '../../engine/config.ts';
import type { ConfigKey, ConfigSpec } from '../../engine/config.ts';
import type { TableConfig } from '../../engine/types.ts';
import { h } from '../ui.ts';
import { amountField, amountOf, checkField, inputOf, numberField, numberOf } from './forms.ts';

export interface ConfigForm {
  /** One row per setting, or per two that share a row, to put inside a form. */
  rows: HTMLElement[];
  /** What the rows hold now, for the settings the form lets be changed. */
  read(form: HTMLFormElement): Partial<TableConfig>;
}

/** The field for one setting. `table` is the table its amounts are written for. */
function field(id: string, spec: ConfigSpec, value: string | number | boolean, table: TableConfig): HTMLElement {
  const hint = 'hint' in spec && spec.hint ? h('small', null, spec.hint) : null;

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
      return checkField(id, spec.label, value === true);

    case 'choice':
      return h(
        'div.field.choice',
        { id, role: 'radiogroup', 'aria-label': spec.label },
        h('span', null, spec.label),
        h(
          'div.options',
          null,
          spec.options.map((option) => h('label.check', null, h('input', { type: 'radio', name: id, value: option.value, checked: option.value === value }), h('span', null, option.label))),
        ),
        hint,
      );
  }
}

function held(form: HTMLFormElement, id: string, spec: ConfigSpec, table: TableConfig): string | number | boolean {
  switch (spec.kind) {
    case 'toggle':
      return inputOf(form, id).checked;

    case 'text':
    case 'link':
    // A group of radio buttons answers to its name with the value of the one that is picked
    case 'choice':
      return inputOf(form, id).value;

    case 'chips':
      return amountOf(form, id, table);

    case 'count':
    case 'seconds':
      return numberOf(form, id);
  }
}

/**
 * The form fields for the table's settings, built from the config registry: section by section in the
 * registry's order, each filled with its value in `values`. `idPrefix` keeps the fields of two forms on
 * one page apart.
 *
 * `creating` is the form a new table is made with. It has only the settings asked for then, and it is
 * the one place a setting chosen for good is open; anywhere else it is shown, not offered. Picking a
 * choice there that suggests where other settings start, as what the table plays with does, starts the
 * amounts over from that, since a number typed for whole chips means something else in dollars and cents.
 */
export function configForm(values: TableConfig, idPrefix: string, creating: boolean): ConfigForm {
  const asked = CONFIG_KEYS.filter((key) => !creating || CONFIG_SPECS[key].atCreate);
  const shown = CONFIG_GROUPS.flatMap((group) => asked.filter((key) => CONFIG_SPECS[key].group === group));
  const idOf = (key: ConfigKey) => idPrefix + key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const closed = (key: ConfigKey) => !creating && fixedAtCreation(key);
  const choices = shown.filter((key) => CONFIG_SPECS[key].kind === 'choice');

  // The table the form's amounts are written for, which at creation changes with the choices
  let table = values;
  const fields = new Map<ConfigKey, HTMLElement>();

  const startOver = (event: Event): void => {
    const form = (event.target as HTMLInputElement).form!;

    table = startingConfig(Object.fromEntries(choices.map((key) => [key, held(form, idOf(key), CONFIG_SPECS[key], table)])));

    for (const key of shown.filter((amount) => CONFIG_SPECS[amount].kind === 'chips')) {
      const fresh = draw(key);

      fields.get(key)!.replaceWith(fresh);
      fields.set(key, fresh);
    }
  };

  const draw = (key: ConfigKey): HTMLElement => {
    const element = field(idOf(key), CONFIG_SPECS[key], table[key], table);

    if (closed(key)) {
      for (const input of element.querySelectorAll('input')) {
        input.disabled = true;
      }
    }

    return element;
  };

  const rows: HTMLElement[] = [];
  let open: { pair: HTMLElement; group: string } | null = null;

  for (const key of shown) {
    const spec = CONFIG_SPECS[key];
    const element = draw(key);

    fields.set(key, element);

    if (creating && spec.kind === 'choice' && spec.options.some((option) => option.suggests)) {
      element.addEventListener('change', startOver);
    }

    if (!spec.half) {
      rows.push(element);
      open = null;
    } else if (open && open.group === spec.group) {
      open.pair.append(element);
      open = null;
    } else {
      open = { pair: h('div.pair', null, element), group: spec.group };
      rows.push(open.pair);
    }
  }

  return {
    rows,

    read(form) {
      const open = shown.filter((key) => !closed(key));

      return Object.fromEntries(open.map((key) => [key, held(form, idOf(key), CONFIG_SPECS[key], table)])) as Partial<TableConfig>;
    },
  };
}
