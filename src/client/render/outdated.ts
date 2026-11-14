import { h } from '../ui.ts';

/**
 * Tells the player the game was updated after their page was loaded, with the one thing left to do.
 * `reloadLink` is where a page that can't reload itself is loaded again from (`Links.reloadLink`).
 */
export function outdatedEl(reloadLink: string | null, atTable: boolean): HTMLElement {
  const reload =
    reloadLink === null
      ? h('button.btn.primary', { type: 'button', 'data-action': 'reload', onclick: () => location.reload() }, 'Reload')
      : h('a.btn.primary', { href: reloadLink, target: '_top', 'data-action': 'reload' }, 'Reload');

  return h(
    'div.overlay.outdated',
    null,
    h(
      'div.dialog',
      // Focusable by script only, as a dialog is: the keyboard is put here and has nowhere else to go
      { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'The game was updated', tabindex: -1 },
      h('h2', null, 'The game was updated'),
      h('p', null, atTable ? 'Reload to keep playing. Your place at the table is kept.' : 'Reload to keep playing.'),
      reload,
    ),
  );
}
