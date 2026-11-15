import { straddlesAllowed } from '../../../engine/straddles.ts';
import type { TableView } from '../../../engine/view.ts';
import { h, holdWhile } from '../../ui.ts';
import { frame, seated } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

const chosen = (view: TableView) => (view.you.seat === null ? [] : (view.seats[view.you.seat]?.straddles ?? []));

/** A switch for each kind of straddle the table allows, with what it costs and when it is posted. Each tap is sent at once, as the switch under the table is. */
function straddles(view: TableView, handlers: DialogHandlers): HTMLElement {
  const mine = chosen(view);

  const switches = straddlesAllowed(view.config).map((kind) => {
    const on = mine.includes(kind.what);
    const button = h('button.toggle.pref', { type: 'button', role: 'switch', 'aria-checked': String(on), 'data-straddle': kind.what }, h('i'), h('span', null, kind.label, h('small', null, kind.says)));

    button.addEventListener('click', () => holdWhile(button, () => handlers.send({ type: 'setStraddle', kind: kind.what, on: !on })));

    return button;
  });

  return frame('Straddles', handlers, h('p.note', null, 'Each one you switch on is posted for you whenever it is yours to post, until you switch it off.'), h('div.straddle-kinds', null, switches));
}

export const straddlesDialog: DialogKind<'straddles'> = {
  kind: 'straddles',
  who: (view) => seated(view) && straddlesAllowed(view.config).length > 0,
  shows: (view) => [chosen(view), straddlesAllowed(view.config).map((kind) => kind.what)],
  draw: straddles,
};
