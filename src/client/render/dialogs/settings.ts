import { CONFIG_KEYS } from '../../../engine/config.ts';
import type { TableView } from '../../../engine/view.ts';
import { chips, h } from '../../ui.ts';
import { configForm } from '../configForm.ts';
import { frame, submit, theHost } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function settings(view: TableView, handlers: DialogHandlers): HTMLElement {
  const fields = configForm(CONFIG_KEYS, view.config, 'table-');

  return frame(
    'Table settings',
    handlers,
    h(
      'form',
      {
        onsubmit: (event: Event) => submit(event, handlers, { type: 'updateConfig', config: fields.read(event.target as HTMLFormElement) }, handlers.close),
      },
      fields.rows,
      h('p.note', null, 'New blinds and a new bounty apply from the next hand.'),
      h('button.btn.primary', { type: 'submit', 'data-action': 'save-settings' }, 'Save'),
    ),
  );
}

export const settingsDialog: DialogKind<'settings'> = {
  kind: 'settings',
  menu: { label: 'Table settings', who: theHost, note: (view) => `Blinds ${chips(view.config.smallBlind)}/${chips(view.config.bigBlind)}` },
  draw: settings,
};
