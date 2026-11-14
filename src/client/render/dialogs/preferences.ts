import type { Abilities, ChoicePref, OnOffPref, Pref, Preferences } from '../../prefs.ts';
import { cardEl, h } from '../../ui.ts';
import { everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/** The store as this dialog uses it: whatever is in the registry, by the kind of each entry. */
type AnyPreferences = Preferences<Record<string, Pref>>;

// Radios with one name are one group across the document, and the showcase page holds two apps
let groupsDrawn = 0;

/** A choice whose options are drawn as samples: one tile per option, each showing what picking it looks like. */
function samples(prefs: AnyPreferences, key: string, pref: ChoicePref, preview: NonNullable<ChoicePref['preview']>): HTMLElement {
  const name = `pref-${key}-${(groupsDrawn += 1)}`;
  const tiles = pref.options.map((option) => {
    const sample = h('span.sample', { 'aria-hidden': 'true' }, preview.map(cardEl));
    sample.dataset[key] = option.value;

    return h(
      'label.tile',
      null,
      // A click, not a change: picking the option already marked still applies it, as after it was chosen in another tab
      h('input', { type: 'radio', name, value: option.value, checked: prefs.get(key) === option.value, onclick: () => prefs.set(key, option.value) }),
      sample,
      h('span', null, option.label),
    );
  });

  return h(
    'div.samples',
    { role: 'radiogroup', id: `pref-${key}`, 'data-pref': key, 'aria-labelledby': `pref-${key}-label` },
    h('span', { id: `pref-${key}-label` }, pref.label),
    pref.hint ? h('small', null, pref.hint) : null,
    h('div.tiles', null, tiles),
  );
}

// Said in place of the hint of a switch whose ability the player said no to in the browser
const BLOCKED = 'Blocked in this browser’s settings';

/**
 * An on/off switch, showing on only while the device can do what it switches on. Where the browser
 * wants the player's leave first, the tap that switches it on is what asks.
 */
function onOff(prefs: AnyPreferences, abilities: Abilities, key: string, id: string, pref: OnOffPref): HTMLElement | null {
  if (abilities.of(key) === 'no') {
    return null;
  }

  const note = h('small');
  const button = h(
    'button.toggle.pref',
    { type: 'button', role: 'switch', id, 'data-pref': key, class: pref.compact ? 'compact' : null, title: pref.compact ? pref.hint : null },
    h('i'),
    h('span', null, pref.label, note),
  );

  const paint = () => {
    const ability = abilities.of(key);

    button.setAttribute('aria-checked', String(ability === 'yes' && prefs.get(key)));
    button.setAttribute('aria-disabled', String(ability === 'blocked'));
    note.textContent = ability === 'blocked' ? BLOCKED : pref.compact ? '' : (pref.hint ?? '');
  };

  button.addEventListener('click', async () => {
    const ability = abilities.of(key);

    try {
      if (ability === 'yes') {
        prefs.set(key, !prefs.get(key));
      } else if (ability === 'ask' && (await abilities.ask(key)) === 'yes') {
        prefs.set(key, true);
      }
    } finally {
      paint();
    }
  });
  paint();

  return button;
}

/**
 * The control for one preference. It keeps itself up to date as it is used, so the dialog is drawn
 * once and the keyboard stays on the control that was just changed.
 */
function control(prefs: AnyPreferences, abilities: Abilities, key: string, pref: Pref): HTMLElement | null {
  const id = `pref-${key}`;
  const hint = pref.hint ? h('small', null, pref.hint) : null;
  const field = (input: HTMLElement) => h('label.field', { for: id }, h('span', null, pref.label), input, hint);

  switch (pref.kind) {
    case 'onOff':
      return onOff(prefs, abilities, key, id, pref);

    case 'choice': {
      if (pref.preview) {
        return samples(prefs, key, pref, pref.preview);
      }

      const select = h(
        'select',
        { id, 'data-pref': key, onchange: () => prefs.set(key, select.value) },
        pref.options.map((option) => h('option', { value: option.value }, option.label)),
      );
      select.value = String(prefs.get(key));

      return field(select);
    }

    case 'range': {
      const slider = h('input', {
        type: 'range',
        id,
        'data-pref': key,
        min: pref.min,
        max: pref.max,
        step: pref.step,
        value: prefs.get(key),
        oninput: () => prefs.set(key, Number(slider.value)),
      });

      return field(slider);
    }
  }
}

function glossary(key: string, lines: NonNullable<Pref['glossary']>): HTMLElement {
  return h(
    'dl.glossary',
    { 'data-glossary': key },
    lines.map((line) => h('div', null, h('dt', null, line.term), h('dd', null, line.meaning))),
  );
}

function preferences(handlers: DialogHandlers): HTMLElement {
  const prefs: AnyPreferences = handlers.prefs;
  const groups = new Map<string, HTMLElement[]>();

  for (const [key, pref] of Object.entries(prefs.registry)) {
    if (!pref.group) {
      continue;
    }

    const drawn = control(prefs, handlers.abilities, key, pref);
    if (!drawn) {
      continue;
    }

    const controls = groups.get(pref.group) ?? [];
    const row = controls.at(-1);
    const compact = pref.kind === 'onOff' && pref.compact;

    groups.set(pref.group, controls);

    if (compact && row?.classList.contains('switches')) {
      row.append(drawn);
    } else {
      controls.push(compact ? h('div.switches', null, drawn) : drawn);
    }

    if (pref.glossary) {
      controls.push(glossary(key, pref.glossary));
    }
  }

  return frame(
    'Preferences',
    handlers,
    ...[...groups].map(([group, controls]) => h('section', null, h('h3', null, group), controls)),
    h('p.note', null, 'These are yours alone, and are kept on this device.'),
  );
}

export const preferencesDialog: DialogKind<'preferences'> = {
  kind: 'preferences',
  menu: { label: 'Preferences', who: everyone, note: () => 'Sound, cards and the like, just for you' },
  draw: (_view, handlers) => preferences(handlers),
};
