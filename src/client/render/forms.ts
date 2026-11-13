import { h } from '../ui.ts';

/** A labeled whole-number input. The id doubles as the name the form's values are read by. */
export function numberField(id: string, label: string, value: number, min: number, max?: number, hint?: string): HTMLElement {
  return h(
    'label.field',
    { for: id },
    h('span', null, label),
    h('input', { type: 'number', id, name: id, value, min, max, step: 1, inputmode: 'numeric', required: true }),
    hint ? h('small', null, hint) : null,
  );
}

export function checkField(id: string, label: string, checked: boolean): HTMLElement {
  return h('label.check', { for: id }, h('input', { type: 'checkbox', id, name: id, checked }), h('span', null, label));
}

export function inputOf(form: HTMLFormElement, name: string): HTMLInputElement {
  return form.elements.namedItem(name) as HTMLInputElement;
}

export function numberOf(form: HTMLFormElement, name: string): number {
  return Number(inputOf(form, name).value);
}
