import type { Denominated } from '../../engine/amounts.ts';
import { listedTwice } from '../../engine/bounties.ts';
import type { Bounty } from '../../engine/bounties.ts';
import type { HandAmountsSpec } from '../../engine/config.ts';
import { capitalized, startingHandWords } from '../../engine/handNames.ts';
import { parseStartingHand } from '../../engine/startingHands.ts';
import { h } from '../ui.ts';
import { amountInput, amountOf } from './forms.ts';

/** A hand as typed into a row: in the form it is kept in, or why it is not a hand. */
function typedHand(typed: string): { hand: string; problem: null } | { hand: null; problem: string } {
  try {
    return { hand: parseStartingHand(typed), problem: null };
  } catch (error) {
    return { hand: null, problem: (error as Error).message };
  }
}

/** A row as the list is drawn with it: a hand, and what it pays or nothing yet. */
export type BountyRow = readonly [hand: string, amount: number | null];

const handInputOf = (row: Element) => row.querySelector<HTMLInputElement>('input.bounty-hand')!;

/**
 * The bounties of a table's settings: a row for each hand, with what each player pays for it and a
 * button to take it off, and a button to add one up to the most a table can have. Under each hand
 * its name in words, or what is wrong with it, so a refused row says why where it is typed; the form
 * isn't sent while a row is refused. Drawn once with its form, so rows half typed stay as they are.
 */
export function bountyListField(id: string, spec: HandAmountsSpec, value: readonly BountyRow[], table: Denominated): HTMLElement {
  const rows = h('div.bounty-rows');
  const heads = h('div.bounty-heads', { 'aria-hidden': 'true' }, h('span', null, 'Hand'), h('span', null, 'Each pays'));
  const none = h('p.note', null, 'No bounties.');
  const full = h('small', null, `A table can have at most ${spec.most} bounty hands.`);
  const add = h('button.btn.small', { type: 'button', 'data-action': 'add-bounty' }, 'Add a bounty hand');
  let made = 0;

  // Every row at once, since a hand is refused for being on a row above too
  const check = (): void => {
    const seen = new Set<string>();

    for (const row of rows.children) {
      const input = handInputOf(row);
      const said = row.querySelector<HTMLElement>('.said')!;
      const { hand, problem } = typedHand(input.value);
      const twice = hand !== null && seen.has(hand) ? listedTwice(hand) : null;
      const wrong = twice ?? problem;

      input.setCustomValidity(wrong ?? '');
      if (hand !== null) {
        seen.add(hand);
      }

      // An empty row says nothing until it stops the form being sent
      const quiet = input.value.trim() === '' && row.getAttribute('data-tried') === null;
      said.textContent = wrong === null ? capitalized(startingHandWords(hand!)) : quiet ? '' : wrong;
      said.classList.toggle('warn', wrong !== null);
    }

    none.hidden = rows.children.length > 0;
    heads.hidden = rows.children.length === 0;
    add.hidden = rows.children.length >= spec.most;
    full.hidden = !add.hidden;
  };

  const addRow = ([hand, amount]: BountyRow): HTMLElement => {
    const n = made++;
    const handId = `${id}-hand-${n}`;
    const amountId = `${id}-amount-${n}`;
    const saidId = `${id}-said-${n}`;
    const input = h('input.bounty-hand', {
      type: 'text',
      id: handId,
      value: hand,
      placeholder: '72',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      'aria-describedby': saidId,
    });
    const remove = h('button.btn.small', { type: 'button', 'data-action': 'remove-bounty' }, 'Remove');
    const row = h(
      'div.bounty-row',
      { role: 'group', 'aria-label': 'Bounty hand' },
      h('label.unseen', { for: handId }, 'Hand'),
      input,
      h('label.unseen', { for: amountId }, 'Each pays'),
      amountInput(amountId, amount, table, spec.min, spec.max),
      remove,
      h('small.said', { id: saidId }),
    );

    input.addEventListener('input', check);
    // Written the one way the table keeps it, once the player moves on
    input.addEventListener('change', () => {
      input.value = typedHand(input.value).hand ?? input.value;
      check();
    });
    input.addEventListener('invalid', () => {
      row.setAttribute('data-tried', '');
      check();
    });
    remove.addEventListener('click', () => {
      row.remove();
      check();
      add.focus();
    });

    rows.append(row);

    return input;
  };

  add.addEventListener('click', () => {
    const input = addRow(['', null]);

    check();
    input.focus();
  });

  for (const bounty of value) {
    addRow(bounty);
  }

  check();

  return h('fieldset.field.bounty-list', { id }, h('legend', null, spec.label), heads, rows, none, add, full, spec.hint ? h('small', null, spec.hint) : null);
}

/** What the rows of a `bountyListField` hold: each hand in kept form, or as typed when it is not a hand, which the table refuses in its own words. */
export function bountiesHeld(form: HTMLFormElement, id: string, table: Denominated): Bounty[] {
  const rows = form.querySelectorAll(`#${id} .bounty-row`);

  return [...rows].map((row): Bounty => {
    const typed = handInputOf(row).value;
    const amount = row.querySelector<HTMLInputElement>('input:not(.bounty-hand)')!;

    return [typedHand(typed).hand ?? typed, amountOf(form, amount.name, table)];
  });
}
