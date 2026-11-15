/*
 * The standings: every known player's record over the nights on record, and under each player their
 * nights one by one. The same thing is shown over the first screen and in a table's dialog, so it
 * asks for what it shows itself and keeps what the viewer has done to it: which money, which order,
 * whose line is open.
 */
import { formatAmount, signedAmount } from '../../engine/amounts.ts';
import { badgesIn } from '../../engine/badges.ts';
import { prettyCards } from '../../engine/cards.ts';
import type { Card } from '../../engine/cards.ts';
import { madeHandName } from '../../engine/handNames.ts';
import { evaluateHand } from '../../engine/handRank.ts';
import type { Unit } from '../../engine/types.ts';
import { SETTLE_AFTER_MS } from '../../server/api.ts';
import type { PlayerStanding, UnitStandings } from '../../server/api.ts';
import type { PlayedNight } from '../../server/resultStore.ts';
import { asOfText, firstUnit, MONEY, nightDate, nightSummary, potsWonText, ranked, SORTS, summaryOf } from '../standings.ts';
import type { SortId } from '../standings.ts';
import { h, readableText, youMark } from '../ui.ts';
import { badgeList, badgeMarks } from './badges.ts';

export interface StandingsHandlers {
  /** The records and when they were read. Rejects when they could not be had. */
  load(): Promise<{ asOf: number; units: UnitStandings[] }>;
  /** One player's nights at tables that play one kind of money, the latest first. Rejects like `load`. */
  nights(playerId: string, unit: Unit): Promise<PlayedNight[]>;
  /** The known player the viewer is, whose line is marked as theirs; null for nobody the list knows. */
  you: string | null;
  /** The deck the viewer picked, which is how cards are written. */
  deck: string;
}

const HOURS = SETTLE_AFTER_MS / (60 * 60 * 1000);

const netClass = (net: number): string => (net > 0 ? 'up' : net < 0 ? 'down' : '');

const handEl = (cards: Card[], deck: string): (string | HTMLElement)[] => [`${madeHandName(evaluateHand(cards))} `, h('span.standings-cards', null, readableText(prettyCards(cards), deck))];

/** A part of the page that has to be asked for: says so while it is, and offers another try when it could not be had. */
function asked<T>(load: () => Promise<T>, what: string, draw: (loaded: T) => (HTMLElement | null)[]): HTMLElement {
  const part = h('div.standings-asked', { 'aria-live': 'polite' });

  const ask = (): void => {
    part.replaceChildren(h('p.note', { 'data-standings': 'loading' }, 'Loading…'));
    part.setAttribute('aria-busy', 'true');

    // Whatever goes wrong, in the asking or in drawing the answer, ends with another try on offer and never with "Loading…"
    load()
      .then((loaded) => part.replaceChildren(...draw(loaded).filter((child) => child !== null)))
      .catch(() => part.replaceChildren(h('p.note', { 'data-standings': 'failed' }, `Could not load ${what}.`), h('button.btn', { type: 'button', 'data-action': 'retry-standings', onclick: ask }, 'Try again')))
      .finally(() => part.removeAttribute('aria-busy'));
  };

  ask();

  return part;
}

function nightEl(night: PlayedNight, unit: Unit, deck: string): HTMLElement {
  return h(
    'li',
    null,
    // A table's name can read as part of the date ("Friday" beside a Sunday's), so it is set apart from it
    h('span.when', null, nightDate(night.at), h('small', null, ` · ${night.table}`)),
    h('b', { class: `net ${netClass(night.net)}` }, signedAmount(night.net, { unit })),
    h('small.counts', null, nightSummary(night, unit), night.highHand ? ' · high hand of the night' : null),
    night.best ? h('small.counts', null, handEl(night.best, deck)) : null,
    badgeMarks(badgesIn(night.badges)),
  );
}

function nightsEl(player: PlayerStanding, unit: Unit, handlers: StandingsHandlers): HTMLElement {
  return asked(
    () => handlers.nights(player.id, unit),
    `${player.name}’s nights`,
    (nights) => [
      h('ol.standings-nights', { 'aria-label': `${player.name}’s nights` }, nights.map((night) => nightEl(night, unit, handlers.deck))),
      nights.length < player.nights ? h('p.note', null, `The latest ${nights.length} of ${player.nights} nights.`) : null,
    ],
  );
}

/** A player's line, and the part of it that says where they stand, which changes with the order. */
interface Line {
  element: HTMLElement;
  place: HTMLElement;
}

/** One player's line, which unfolds into their record and, asked for then, their nights. */
function playerLine(player: PlayerStanding, unit: Unit, handlers: StandingsHandlers): Line {
  const badges = badgesIn(player.badges);
  const place = h('span.place', { 'aria-hidden': 'true' });
  const nights = h('div.standings-player-nights', null, h('h3', null, 'Nights'));

  const details = h(
    'details',
    null,
    h(
      'summary',
      null,
      place,
      h('span.who', null, player.name, player.id === handlers.you ? youMark() : null),
      h('b', { class: `net ${netClass(player.net)}` }, signedAmount(player.net, { unit })),
      h('span.fold', { 'aria-hidden': 'true' }, '▾'),
      h('small.counts', null, summaryOf(player)),
      badgeMarks(badges),
    ),
    h(
      'dl',
      null,
      h('div', null, h('dt', null, 'Hands won'), h('dd', null, potsWonText(player))),
      h('div', null, h('dt', null, 'Biggest pot'), h('dd', null, player.won > 0 ? formatAmount(player.biggest, { unit }) : 'None yet')),
      h('div', null, h('dt', null, 'Best hand shown'), h('dd', null, player.best ? handEl(player.best, handlers.deck) : 'None yet')),
      player.highHands > 0 ? h('div', null, h('dt', null, 'High hand of the night'), h('dd', null, player.highHands === 1 ? 'Once' : `${player.highHands} times`)) : null,
      badges.length > 0 ? h('div', null, h('dt', null, 'Badges'), h('dd', null, badgeList(badges))) : null,
    ),
    nights,
  );

  // A player's nights are asked for when their line is first opened, so the page itself is one request
  details.addEventListener('toggle', () => details.open && nights.append(nightsEl(player, unit, handlers)), { once: true });

  return { element: h('li', { class: player.id === handlers.you ? 'me' : null, 'data-player': player.name }, details), place };
}

function aboutEl(asOf: number): HTMLElement {
  return h(
    'div.standings-about',
    null,
    h('p.note', { 'data-standings': 'as-of' }, `${asOfText(asOf)} A night goes on record when it is ended, or once its table has been left alone for ${HOURS} hours.`),
    h('p.note', null, 'A night is a table. It counts for the players who said who they are, when at least two people had chips there. Chips and dollars are never added together.'),
  );
}

function loadedEl(asOf: number, units: UnitStandings[], handlers: StandingsHandlers): (HTMLElement | null)[] {
  let unit = firstUnit(units, handlers.you);
  if (unit === null) {
    return [h('p', { 'data-standings': 'empty' }, 'No nights on record yet.'), aboutEl(asOf)];
  }

  let sort: SortId = SORTS[0]!.id;
  // Each line is made once and moved from then on, so that sorting again or looking at the other money
  // closes nothing the viewer opened, and asks for nobody's nights twice
  const lines = new Map<string, Line>();
  const list = h('ol.standings-players', { 'aria-label': 'Players' });

  const draw = (): void => {
    const shown = unit!;
    const { players } = units.find((of) => of.unit === shown)!;

    list.replaceChildren(
      ...ranked(players, sort).map((player, index) => {
        const key = `${shown} ${player.id}`;
        const line = lines.get(key) ?? playerLine(player, shown, handlers);

        lines.set(key, line);
        line.place.textContent = String(index + 1);

        return line.element;
      }),
    );
  };

  const pick = units.map((of) =>
    h(
      'button.btn',
      {
        type: 'button',
        'data-unit': of.unit,
        'aria-pressed': String(of.unit === unit),
        onclick: () => {
          unit = of.unit;
          pick.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.unit === unit)));
          draw();
        },
      },
      MONEY[of.unit],
    ),
  );

  const order = h(
    'select',
    { id: 'standings-sort', name: 'standings-sort', onchange: () => {
      sort = order.value as SortId;
      draw();
    } },
    SORTS.map((by) => h('option', { value: by.id }, by.label)),
  );

  draw();

  return [
    h(
      'div.standings-controls',
      null,
      // One kind of money needs no picking
      units.length > 1 ? h('div.standings-units', { role: 'group', 'aria-label': 'Played in' }, pick) : null,
      h('label.field', { for: 'standings-sort' }, h('span', null, 'Sort by'), order),
    ),
    list,
    aboutEl(asOf),
  ];
}

/** The standings, which load as soon as this is made. */
export function standingsEl(handlers: StandingsHandlers): HTMLElement {
  return h('div.standings', null, asked(handlers.load, 'the standings', ({ asOf, units }) => loadedEl(asOf, units, handlers)));
}
