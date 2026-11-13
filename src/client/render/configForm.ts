import { CONFIG_GROUPS, CONFIG_SPECS } from '../../engine/config.ts';
import type { ConfigKey, ConfigSpec } from '../../engine/config.ts';
import type { TableConfig } from '../../engine/types.ts';
import { h } from '../ui.ts';
import { checkField, inputOf, numberField, numberOf } from './forms.ts';

export interface ConfigForm {
  /** One row per setting, or per two that share a row, to put inside a form. */
  rows: HTMLElement[];
  /** What the rows hold now, for the settings they show. */
  read(form: HTMLFormElement): Partial<TableConfig>;
}

function field(id: string, spec: ConfigSpec, value: string | number | boolean): HTMLElement {
  const hint = 'hint' in spec && spec.hint ? h('small', null, spec.hint) : null;

  switch (spec.kind) {
    case 'text':
      return h('label.field', { for: id }, h('span', null, spec.label), h('input', { type: 'text', id, name: id, value, maxlength: spec.maxLength, required: true }), hint);

    case 'chips':
    case 'count':
    case 'seconds':
      return numberField(id, spec.label, Number(value), spec.min, spec.max, spec.hint);

    case 'toggle':
      return checkField(id, spec.label, value === true);

    case 'choice':
      return h(
        'div.field',
        { role: 'radiogroup', 'aria-label': spec.label },
        h('span', null, spec.label),
        spec.options.map((option) => h('label.check', null, h('input', { type: 'radio', name: id, value: option.value, checked: option.value === value }), h('span', null, option.label))),
        hint,
      );
  }
}

function held(form: HTMLFormElement, id: string, spec: ConfigSpec): string | number | boolean {
  switch (spec.kind) {
    case 'toggle':
      return inputOf(form, id).checked;

    case 'text':
    // A group of radio buttons answers to its name with the value of the one that is picked
    case 'choice':
      return inputOf(form, id).value;

    case 'chips':
    case 'count':
    case 'seconds':
      return numberOf(form, id);
  }
}

/**
 * The form fields for some of the table's settings, built from the config registry: section by
 * section in the registry's order, each filled with its value in `values`. `idPrefix` keeps the fields
 * of two forms on one page apart.
 */
export function configForm(keys: readonly ConfigKey[], values: TableConfig, idPrefix: string): ConfigForm {
  const shown = CONFIG_GROUPS.flatMap((group) => keys.filter((key) => CONFIG_SPECS[key].group === group));
  const idOf = (key: ConfigKey) => idPrefix + key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

  const rows: HTMLElement[] = [];
  let open: { pair: HTMLElement; group: string } | null = null;

  for (const key of shown) {
    const spec = CONFIG_SPECS[key];
    const element = field(idOf(key), spec, values[key]);

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
      return Object.fromEntries(shown.map((key) => [key, held(form, idOf(key), CONFIG_SPECS[key])])) as Partial<TableConfig>;
    },
  };
}
