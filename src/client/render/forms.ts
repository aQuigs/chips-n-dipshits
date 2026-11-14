import { editableAmount, formatAmount, hasDecimals, parseAmount } from '../../engine/amounts.ts';
import type { Denominated } from '../../engine/amounts.ts';
import { LIMITS } from '../../engine/validate.ts';
import { h } from '../ui.ts';

/** A labeled whole-number input, for what is counted or timed. The id doubles as the name the form's values are read by. */
export function numberField(id: string, label: string, value: number, min: number, max?: number, hint?: string): HTMLElement {
  return h(
    'label.field',
    { for: id },
    h('span', null, label),
    h('input', { type: 'number', id, name: id, value, min, max, step: 1, inputmode: 'numeric', required: true }),
    hint ? h('small', null, hint) : null,
  );
}

/** What is wrong with what was typed for an amount that has to lie between `min` and `max`, or nothing. */
function complaint(typed: string, table: Denominated, min: number, max: number): string {
  const read = parseAmount(typed, table);

  if (!read.ok) {
    return read.problem;
  }

  if (read.amount < min) {
    return `This can't be less than ${formatAmount(min, table)}`;
  }

  return read.amount > max ? `This can't be more than ${formatAmount(max, table)}` : '';
}

/**
 * A labeled field for an amount, typed the way its table writes amounts. It is a box of plain text,
 * since a number box won't take 1,000.50, and it tells the browser itself what a number box would have
 * about an amount that is out of range or can't be read, so its form is only ever sent with one that can.
 * A `value` of null leaves it empty, for an amount that has no likely answer.
 */
export function amountField(id: string, label: string, value: number | null, table: Denominated, min: number, max = LIMITS.chips, hint?: string): HTMLElement {
  const input = h('input', { type: 'text', id, name: id, value: value === null ? '' : editableAmount(value, table), inputmode: hasDecimals(table) ? 'decimal' : 'numeric', autocomplete: 'off', required: true });
  const check = () => input.setCustomValidity(complaint(input.value, table, min, max));

  input.addEventListener('input', check);
  check();

  return h('label.field', { for: id }, h('span', null, label), input, hint ? h('small', null, hint) : null);
}

/** A labeled list to pick one of. It starts on `prompt`, which can't be sent, so nothing is picked by accident. */
export function pickField(id: string, label: string, prompt: string, choices: { value: string; label: string }[]): HTMLElement {
  return h(
    'label.field',
    { for: id },
    h('span', null, label),
    h('select', { id, name: id, required: true }, h('option', { value: '', disabled: true, selected: true }, prompt), choices.map((choice) => h('option', { value: choice.value }, choice.label))),
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

/** The amount in one of a form's amount fields, in the table's smallest unit. */
export function amountOf(form: HTMLFormElement, name: string, table: Denominated): number {
  const read = parseAmount(inputOf(form, name).value, table);

  // The field keeps its form from being sent while it can't be read, so this is only for a form sent by other means
  return read.ok ? read.amount : Number.NaN;
}
