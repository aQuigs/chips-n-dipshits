import { stakesText } from '../../../engine/stakes.ts';
import type { TableConfig } from '../../../engine/types.ts';
import type { TableView } from '../../../engine/view.ts';
import { h } from '../../ui.ts';
import { configForm } from '../configForm.ts';
import { hostOrCohost } from '../roles.ts';
import { frame, submit } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/**
 * Only what was changed in the form. The form is drawn once, so a field left alone may hold what another
 * host has changed since, and sending it would quietly undo their change.
 */
function changed(opened: TableConfig, held: Partial<TableConfig>): Partial<TableConfig> {
  return Object.fromEntries(Object.entries(held).filter(([key, value]) => value !== opened[key as keyof TableConfig]));
}

function settings(view: TableView, handlers: DialogHandlers): HTMLElement {
  const fields = configForm(view.config, 'table-', false);

  return frame(
    'Table settings',
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => submit(event, handlers, { type: 'updateConfig', config: changed(view.config, fields.read(event.target as HTMLFormElement)) }, handlers.close),
      },
      fields.rows,
      h('p.note', null, 'New blinds, a new ante, a new bounty and new bomb pot settings apply from the next hand.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'save-settings' }, 'Save'),
    ),
  );
}

export const settingsDialog: DialogKind<'settings'> = {
  kind: 'settings',
  menu: { label: 'Table settings', who: hostOrCohost, note: (view) => `Blinds ${stakesText(view.config)}` },
  draw: settings,
};
