import { CONFIG_SPECS, sameSetting } from '../../../engine/config.ts';
import type { ConfigKey } from '../../../engine/config.ts';
import { CONFIG_SECTION_KEYS } from '../../../engine/configSections.ts';
import { stakesText } from '../../../engine/stakes.ts';
import type { TableConfig } from '../../../engine/types.ts';
import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { configForm } from '../configForm.ts';
import { presetsPanel } from '../presets.ts';
import { hostOrCohost } from '../roles.ts';
import { footed, frame, submit } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

const FORM_ID = 'settings-form';

/**
 * Only what was changed in the form. The form is drawn once, so a field left alone may hold what another
 * host has changed since, and sending it would quietly undo their change.
 */
function changed(opened: TableConfig, held: Partial<TableConfig>): Partial<TableConfig> {
  return Object.fromEntries(Object.entries(held).filter(([key, value]) => !sameSetting(value, opened[key as keyof TableConfig])));
}

function settings(view: TableView, handlers: DialogHandlers): HTMLElement {
  const handInPlay = view.hand !== null && view.hand.stage !== 'done';
  const waits = h('p.note', { hidden: true, 'data-says': 'next-hand' }, 'Applies from the next hand.');
  const unsaved = () => changed(view.config, fields.read(form));

  const fields = configForm(view.config, {
    idPrefix: 'table-',
    creating: false,
    // What a host comes to change mid-game leads the registry, and is what the dialog opens on
    open: (section) => section === CONFIG_SECTION_KEYS[0],
    edited: () => {
      waits.hidden = !(handInPlay && Object.keys(unsaved()).some((key) => CONFIG_SPECS[key as ConfigKey].nextHand));
      presets.formChanged();
    },
  });

  const form: HTMLFormElement = h(
    'form',
    {
      id: FORM_ID,
      onsubmit: (event: Event) => {
        const sent = unsaved();

        // The table's words name a setting that was sent, which may be folded away by now
        submit(event, handlers, { type: 'updateConfig', config: sent }, handlers.close, () => handlers.byItself(() => fields.unfold(Object.keys(sent) as ConfigKey[])));
      },
    },
    fields.sections,
  );

  const presets = presetsPanel(view.config, handlers.presets, () => ({ ...view.config, ...fields.read(form) }));

  return footed(
    frame('Table settings', handlers, h('div.sections', null, form, presets.element)),
    waits,
    h('button.btn.primary', { type: 'submit', form: FORM_ID, 'data-action': 'save-settings' }, 'Save'),
  );
}

export const settingsDialog: DialogKind<'settings'> = {
  kind: 'settings',
  menu: { group: 'run', label: 'Table settings', who: hostOrCohost, state: (view) => `Blinds ${stakesText(view.config)}` },
  draw: settings,
};
