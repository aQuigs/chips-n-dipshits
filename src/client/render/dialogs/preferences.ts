import type { Pref, Preferences } from '../../prefs.ts';
import { h } from '../../ui.ts';
import { everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/** The store as this dialog uses it: whatever is in the registry, by the kind of each entry. */
type AnyPreferences = Preferences<Record<string, Pref>>;

/**
 * The control for one preference. It keeps itself up to date as it is used, so the dialog is drawn
 * once and the keyboard stays on the control that was just changed.
 */
function control(prefs: AnyPreferences, key: string, pref: Pref): HTMLElement {
  const id = `pref-${key}`;
  const hint = pref.hint ? h('small', null, pref.hint) : null;
  const field = (input: HTMLElement) => h('label.field', { for: id }, h('span', null, pref.label), input, hint);

  switch (pref.kind) {
    case 'onOff': {
      const flip = () => {
        prefs.set(key, !prefs.get(key));
        button.setAttribute('aria-checked', String(prefs.get(key)));
      };
      const button = h(
        'button.toggle.pref',
        { type: 'button', role: 'switch', 'aria-checked': String(prefs.get(key)), id, 'data-pref': key, onclick: flip },
        h('i'),
        h('span', null, pref.label, hint),
      );

      return button;
    }

    case 'choice': {
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

function preferences(handlers: DialogHandlers): HTMLElement {
  const prefs: AnyPreferences = handlers.prefs;
  const groups = new Map<string, HTMLElement[]>();

  for (const [key, pref] of Object.entries(prefs.registry)) {
    if (pref.group) {
      const controls = groups.get(pref.group) ?? [];

      groups.set(pref.group, controls);
      controls.push(control(prefs, key, pref));
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
  menu: { label: 'Preferences', who: everyone, note: () => 'Sound and the like, just for you' },
  draw: (_view, handlers) => preferences(handlers),
};
