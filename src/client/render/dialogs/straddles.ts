import type { Command } from '../../../engine/types.ts';
import type { TableView } from '../../../engine/view.ts';
import { standingName, standingOf } from '../../standing.ts';
import { h, holdWhile } from '../../ui.ts';
import { frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/** A switch with its name and a sentence on what it does. Each tap is sent at once. */
function choice(marks: Record<string, string>, label: string, says: string, on: boolean, flip: (on: boolean) => Command, handlers: DialogHandlers): HTMLElement {
  const button = h('button.toggle.pref', { type: 'button', role: 'switch', 'aria-checked': String(on), ...marks }, h('i'), h('span', null, label, h('small', null, says)));

  button.addEventListener('click', () => holdWhile(button, () => handlers.send(flip(!on))));

  return button;
}

/**
 * A player's standing choices (`standing.ts`): a switch for each kind of straddle the table allows, with
 * what it costs and when it is posted, and one for chopping the blinds where the table allows that. The
 * dialog and its button keep the name `straddles`, which other files list.
 */
function standing(view: TableView, handlers: DialogHandlers): HTMLElement {
  const mine = standingOf(view)!;

  const straddles = mine.straddles.map((kind) =>
    choice({ 'data-action': 'straddle', 'data-straddle': kind.what }, kind.label, kind.says, mine.straddling.includes(kind), (on) => ({ type: 'setStraddle', kind: kind.what, on }), handlers),
  );
  const chop = mine.chops
    ? choice(
        { 'data-action': 'always-chop' },
        'Always chop',
        'You say yes to an offer to chop the blinds without being asked. When the other blind has this on too, the hand is chopped the moment it folds to you both.',
        mine.alwaysChop,
        (on) => ({ type: 'setAlwaysChop', on }),
        handlers,
      )
    : null;

  return frame(standingName(mine).full, handlers, h('p.note', null, 'Each one you switch on is done for you whenever it comes up, until you switch it off.'), h('div.straddle-kinds', null, straddles, chop));
}

export const straddlesDialog: DialogKind<'straddles'> = {
  kind: 'straddles',
  who: (view) => standingOf(view) !== null,
  shows: standingOf,
  draw: standing,
};
