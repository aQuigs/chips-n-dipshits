import { themeById } from '../../themes.ts';
import { h } from '../../ui.ts';
import { createThemePicker } from '../themePicker.ts';
import { everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function theme(handlers: DialogHandlers): HTMLElement {
  return frame(
    'Theme',
    handlers,
    createThemePicker(handlers.prefs.get('theme'), (id) => handlers.prefs.set('theme', id)).element,
    h('p.note', null, 'Changes how the table looks for you, on this device. Everyone picks their own.'),
  );
}

export const themeDialog: DialogKind<'theme'> = {
  kind: 'theme',
  menu: { label: 'Theme', who: everyone, note: (_view, handlers) => themeById(handlers.prefs.get('theme')).name },
  draw: (_view, handlers) => theme(handlers),
};
