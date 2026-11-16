import type { TableView } from '../../../engine/view.ts';
import { h, holdWhile, sends } from '../../ui.ts';
import { whoField } from '../whoField.ts';
import type { WhoField } from '../whoField.ts';
import { everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

function who(view: TableView, handlers: DialogHandlers): HTMLElement {
  const status = h('p.note', { 'aria-live': 'polite' }, 'Looking for the list of players…');
  const button = h('button.btn.primary', { type: 'submit', 'data-action': 'say-who', disabled: true }, sends('That’s me', 'Saving…'));
  const place = h('div');
  let field: WhoField | null = null;

  const load = async (): Promise<void> => {
    try {
      const { players, remembered } = await handlers.players.list();

      // Whoever they said they are here comes first, then whoever the browser remembers them as from another night
      field ??= whoField('who-name', view.you.name, null, view.you.identity ?? remembered?.id ?? null);
      field.offer({ players, remembered: null });

      place.replaceChildren(field.element);
      status.textContent = '';
      button.disabled = false;
    } catch {
      status.textContent = field ? '' : 'Could not load the list of players. Close this and try again.';
    }
  };

  const form = h(
    'form.who-form',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();

        holdWhile(button, async () => {
          if (await handlers.players.identify(field!.answer())) {
            handlers.answered();
          } else {
            // The usual reason is a name the list turned out to have, which is then there to pick
            await load();
          }
        });
      },
    },
    place,
    button,
  );

  void load();

  return frame(
    'Who you are',
    handlers,
    h('p.note', null, 'Pick yourself, and the game knows it is you from one night to the next. It is only a name tag: it changes nothing at this table, and anyone can pick anyone.'),
    form,
    status,
  );
}

export const whoDialog: DialogKind<'who'> = {
  kind: 'who',
  menu: {
    group: 'you',
    label: 'Who you are',
    who: everyone,
    state: (view, handlers) => {
      if (view.you.identity === null) {
        return 'Not on the list yet';
      }

      const remembered = handlers.players.remembered();

      return remembered?.id === view.you.identity ? remembered.name : 'On the list';
    },
  },
  draw: who,
};
