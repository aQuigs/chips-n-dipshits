import type { KnownPlayer } from '../../engine/players.ts';
import { LIMITS } from '../../engine/validate.ts';
import { answerOf, offerOf } from '../knownPlayers.ts';
import type { Answer, Asked } from '../knownPlayers.ts';
import { h, Slot } from '../ui.ts';

/** The list of known players as the page was last given it, with who the browser still remembers being now that it has. */
export interface Listed {
  players: KnownPlayer[];
  remembered: KnownPlayer | null;
}

export interface PlayerHandlers {
  /** Rejects when the list could not be loaded. */
  list(): Promise<Listed>;
  /** Who the browser remembers being, by what it last knew. */
  remembered(): KnownPlayer | null;
  /** Tells the table who this member is. Resolves to whether it took that; if not, the player has been told why. */
  identify(as: Answer): Promise<boolean>;
}

export interface WhoField {
  element: HTMLElement;
  /** The list of known players has been heard from. `remembered` is who the browser still remembers being, now that it has. */
  offer(players: readonly KnownPlayer[], remembered: KnownPlayer | null): void;
  /** What the form it stands in sends. */
  answer(): Answer;
}

/**
 * The part of a form that asks who the visitor is: the players the game knows to pick from, and a
 * name to type for someone new. With nobody known it is the name alone. It is built once and changed
 * in place, so a name half typed is still there when the list arrives or changes. `id` names the box
 * the name is typed in; `said` is a known player's id to start out picked.
 */
export function whoField(id: string, typed: string, remembered: KnownPlayer | null, said: string | null = null): WhoField {
  const asked: Asked = { players: null, remembered, said, filter: '', typed };

  const nameInput = h('input', { type: 'text', id, name: id, value: typed, maxlength: LIMITS.nameLength, required: true, autocomplete: 'nickname', placeholder: 'What the table calls you' });
  const alikeText = h('span');
  const alikePick = h('button.link', { type: 'button', 'data-action': 'pick-alike' });
  const alike = h('small.who-alike', { hidden: true, 'aria-live': 'polite' }, alikeText, alikePick);
  const nameRow = h('label.field.who-name', { for: id }, h('span', null, 'Your name'), nameInput, alike);

  const rememberedName = h('b');
  const rememberedRow = h(
    'p.who-remembered',
    { hidden: true },
    h('span', null, 'Playing as ', rememberedName),
    h('button.link', { type: 'button', 'data-action': 'not-me', onclick: () => say('new') }, 'Not me'),
  );

  const filter = h('input.who-filter', { type: 'search', id: `${id}-find`, name: `${id}-find`, autocomplete: 'off', placeholder: 'Find your name', 'aria-label': 'Find your name', hidden: true });
  // Redrawn only when the players in it or the one picked change, so a tap on a name is not lost to a key pressed elsewhere
  const list = new Slot(h('div.who-list', { role: 'group', 'aria-label': 'Players the game knows' }));
  const someoneNew = h('button.who-pill.who-new', { type: 'button', 'data-action': 'someone-new' }, 'Someone new');
  const pick = h('div.who-pick', { hidden: true }, h('span.who-question', null, 'Who are you?'), filter, list.element, someoneNew);

  const element = h('div.who-ask', null, rememberedRow, pick, nameRow);

  const draw = (): void => {
    const offer = offerOf(asked);
    const typing = offer.as === null;

    element.dataset.who = offer.mode;

    rememberedRow.hidden = offer.mode !== 'remembered';
    rememberedName.textContent = offer.mode === 'remembered' ? offer.as!.name : '';

    pick.hidden = offer.mode !== 'pick';
    filter.hidden = !offer.filtered;
    someoneNew.setAttribute('aria-pressed', String(typing));
    list.draw([offer.shown, offer.as?.id], () =>
      offer.shown.length > 0
        ? offer.shown.map((player) => h('button.who-pill', { type: 'button', 'data-player': player.id, 'aria-pressed': String(player.id === offer.as?.id), onclick: () => say(player.id) }, player.name))
        : h('p.note', null, 'Nobody by that name. New here? Pick “Someone new”.'),
    );

    // A box that is not shown must not hold the form back for being empty
    nameRow.hidden = !typing;
    nameInput.required = typing;

    alike.hidden = offer.alike === null;
    alikeText.textContent = offer.alike ? `${offer.alike.name} is on the list already. ` : '';
    alikePick.textContent = offer.alike ? `I’m ${offer.alike.name}` : '';
    alikePick.onclick = offer.alike ? () => say(offer.alike!.id) : null;
  };

  const say = (said: string): void => {
    asked.said = said;
    draw();

    if (said === 'new') {
      nameInput.focus();
    }
  };

  someoneNew.addEventListener('click', () => say('new'));

  filter.addEventListener('input', () => {
    asked.filter = filter.value;
    draw();
  });

  // Enter in a box inside a form sends the form, which here would be joining as whoever happened to be picked.
  // It picks the one name left instead, when the search has come down to one
  filter.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();

    const { shown } = offerOf(asked);
    if (shown.length === 1) {
      say(shown[0]!.id);
    }
  });

  nameInput.addEventListener('input', () => {
    asked.typed = nameInput.value;
    draw();
  });

  draw();

  return {
    element,

    offer(players, stillRemembered) {
      asked.players = players;
      asked.remembered = stillRemembered;
      draw();
    },

    answer: () => answerOf({ ...asked, typed: nameInput.value }),
  };
}
