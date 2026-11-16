import { PREF_GROUPS } from '../../prefs.ts';
import type { Abilities, ChoicePref, OnOffPref, Pref, Preferences } from '../../prefs.ts';
import { cardEl, h } from '../../ui.ts';
import { themeSwatch } from '../themePicker.ts';
import { everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/** The store as this dialog uses it: whatever is in the registry, by the kind of each entry. */
type AnyPreferences = Preferences<Record<string, Pref>>;

type Resizing = DialogHandlers['resizing'];

// Radios with one name are one group across the document, and the showcase page holds two apps
let groupsDrawn = 0;

function sample(preview: ChoicePref['preview']): HTMLElement | null {
  return preview ? h('span.sample', { 'aria-hidden': 'true' }, preview === 'swatch' ? themeSwatch() : preview.map(cardEl)) : null;
}

/**
 * Picks an option whose choice may resize what is read above its tile, as a text size does, and scrolls
 * the dialog by as much, so the tile stays under the finger that picked it. Where the dialog cannot
 * scroll that far, at its top with everything above the tile grown smaller, what comes up under the
 * finger instead is held back for a moment.
 */
function pickInPlace(tile: HTMLElement, resizing: Resizing, pick: () => void): void {
  resizing(() => {
    const top = tile.getBoundingClientRect().top;

    pick();
    tile.closest('.dialog-body')?.scrollBy(0, tile.getBoundingClientRect().top - top);
  });
}

/** A choice of one among a few: a tile per option, each showing what picking it looks like. */
function tiles(prefs: AnyPreferences, resizing: Resizing, key: string, pref: ChoicePref): HTMLElement {
  const name = `pref-${key}-${(groupsDrawn += 1)}`;
  const options = pref.options.map((option) => {
    const tile: HTMLElement = h(
      'label.tile',
      null,
      // A click, not a change: picking the option already marked still applies it, as after it was chosen in another tab
      h('input', { type: 'radio', name, value: option.value, checked: prefs.get(key) === option.value, onclick: () => pickInPlace(tile, resizing, () => prefs.set(key, option.value)) }),
      sample(pref.preview),
      h('span', null, option.label),
    );

    tile.dataset[key] = option.value;

    return tile;
  });

  return h(
    'div.samples',
    { role: 'radiogroup', id: `pref-${key}`, 'data-pref': key, 'aria-labelledby': `pref-${key}-label`, 'aria-describedby': pref.hint ? `pref-${key}-hint` : null },
    h('span', { id: `pref-${key}-label` }, pref.label),
    pref.hint ? h('small', { id: `pref-${key}-hint` }, pref.hint) : null,
    h('div.tiles', null, options),
  );
}

// Said in place of the hint of a switch whose ability the player said no to in the browser
const BLOCKED = 'Blocked in this browser’s settings.';

/**
 * An on/off switch, showing on only while the device can do what it switches on. Where the browser
 * wants the player's leave first, the tap that switches it on is what asks.
 */
function onOff(prefs: AnyPreferences, abilities: Abilities, key: string, id: string, pref: OnOffPref): HTMLElement | null {
  if (abilities.of(key) === 'no') {
    return null;
  }

  const note = h('small');
  const button = h('button.toggle.pref', { type: 'button', role: 'switch', id, 'data-pref': key }, h('i'), h('span', null, pref.label, note));

  const paint = () => {
    const ability = abilities.of(key);

    button.setAttribute('aria-checked', String(ability === 'yes' && prefs.get(key)));
    button.setAttribute('aria-disabled', String(ability === 'blocked'));
    note.textContent = ability === 'blocked' ? (pref.blocked ?? BLOCKED) : (pref.hint ?? '');
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
function control(handlers: DialogHandlers, key: string, pref: Pref): HTMLElement | null {
  const prefs: AnyPreferences = handlers.prefs;
  const id = `pref-${key}`;

  switch (pref.kind) {
    case 'onOff':
      return onOff(prefs, handlers.abilities, key, id, pref);

    case 'choice':
      return tiles(prefs, handlers.resizing, key, pref);

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

      return h('label.field.slider', { for: id }, h('span', null, pref.label), slider, pref.hint ? h('small', null, pref.hint) : null);
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

/** The controls of one part of the dialog, in the registry's order. A preference this device can do nothing with has none, and neither has what goes with it. */
function controlsOf(group: string, handlers: DialogHandlers): HTMLElement[] {
  return (Object.entries(handlers.prefs.registry) as [string, Pref][])
    .filter(([, pref]) => pref.group === group)
    .flatMap(([key, pref]) => {
      const drawn = control(handlers, key, pref);

      return drawn ? [drawn, ...(pref.glossary ? [glossary(key, pref.glossary)] : [])] : [];
    });
}

function preferences(handlers: DialogHandlers): HTMLElement {
  const parts = Object.entries(PREF_GROUPS).map(([group, heading]) => ({ group, heading, controls: controlsOf(group, handlers) }));

  return frame(
    'Preferences',
    handlers,
    h(
      'div.prefs',
      null,
      parts.filter((part) => part.controls.length > 0).map(({ group, heading, controls }) => h('section', { 'data-group': group }, h('h3', null, heading), controls)),
      h('p.note', null, 'These are yours alone, kept on this device.'),
    ),
  );
}

export const preferencesDialog: DialogKind<'preferences'> = {
  kind: 'preferences',
  menu: { group: 'you', label: 'Preferences', who: everyone },
  draw: (_view, handlers) => preferences(handlers),
};
