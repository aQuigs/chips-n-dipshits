import { THEMES } from '../themes.ts';
import { h } from '../ui.ts';

export interface ThemePicker {
  element: HTMLElement;
  /** Marks which theme is the one in use, for when it was changed somewhere else. */
  show(id: string): void;
}

/** One button per theme, each drawn in its own colors. `compact` leaves out the descriptions. */
export function createThemePicker(current: string, onPick: (id: string) => void, compact = false): ThemePicker {
  const buttons = THEMES.map((theme) =>
    h(
      'button.theme-option',
      {
        type: 'button',
        'data-theme': theme.id,
        onclick: () => {
          show(theme.id);
          onPick(theme.id);
        },
      },
      h('span.swatch', null, h('i.felt-dot'), h('i.accent-dot'), h('i.card-dot')),
      h('span', null, h('b', null, theme.name), compact ? null : h('small', null, theme.blurb)),
    ),
  );

  function show(id: string): void {
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.theme === id));
    }
  }

  show(current);

  return { element: h('div.theme-options', { class: compact ? 'compact' : '', role: 'group', 'aria-label': 'Theme' }, buttons), show };
}
