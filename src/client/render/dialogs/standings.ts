import { standingsEl } from '../standings.ts';
import { everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/** Drawn once: it asks for what it shows itself, so what the viewer has opened in it stays open while the table plays on. */
export const standingsDialog: DialogKind<'standings'> = {
  kind: 'standings',
  menu: { label: 'Standings', who: everyone, note: () => 'Who is up and who is down, over every night' },
  draw: (view, handlers: DialogHandlers) => frame('Standings', handlers, standingsEl(handlers.standings(view.you.identity))),
};
