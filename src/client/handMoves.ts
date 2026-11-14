import { replayHand } from '../engine/events.ts';
import type { HandEvent, ReplayPosition, ReplaySeat } from '../engine/events.ts';
import { clockwiseAfter } from '../engine/seats.ts';
import type { TableView } from '../engine/view.ts';
import { MOVE_MS } from './motion.ts';
import type { Move, Place, TableMotion } from './motion.ts';
import { SOUND_GAP_MS } from './sound.ts';
import type { TableChange } from './tableChange.ts';

/** The longest any one move may take, from leaving to landing. */
export const MOST_MOVE_MS = 300;

/**
 * The longest everything one view sets moving may take, from the view being shown to the last piece
 * landing. A view that brings more than fits is shown by how it ended: its earliest steps are left
 * out, which leaves what they would have moved where the table already draws it.
 */
export const MOST_VIEW_MS = 900;

/**
 * What a view brings plays a step at a time, each starting this long after the one before, whether or
 * not that one has landed. It is the gap the sounds of a view are played at, so the first thing seen
 * starts with the first thing heard, and the next with the next.
 */
export const STEP_GAP_MS = SOUND_GAP_MS;

// The longest a step may take to set off all its moves, as a deal does going around a full table
const MOST_SPREAD_MS = 240;

// How long after the cards of one seat those of the next are dealt, where the table is small enough to allow it
const DEAL_GAP_MS = 60;

// How long after one card of a flop the next lands
const BOARD_GAP_MS = 60;

/** What happens together, give or take a spread: the `after` of its moves counts from the step's own start. */
interface Step {
  /** Events that follow one another and make steps of one kind are one step. */
  kind: 'dealt' | 'acted' | 'shown' | 'gathered' | 'street' | 'won' | 'bounty';
  moves: Move[];
}

const seatOf = (seat: number): Place => ({ at: 'seat', seat });
const betOf = (seat: number): Place => ({ at: 'bet', seat });
const cardsOf = (seat: number): Place => ({ at: 'cards', seat });
const POT: Place = { at: 'pot' };
const DECK: Place = { at: 'deck' };

/**
 * A seat's chips going in front of it: how a blind, a bet, a call or a raise is shown. Whatever else
 * puts a bet on the table, such as showing a player's own before the server has answered, plays this
 * once the bet is drawn and gets the same slide.
 */
export const betSlide = (seat: number): Move => ({ name: 'bet', from: seatOf(seat), to: betOf(seat), after: 0 });

/** A pile of chips crossing the table. With no amount it is a bare chip. */
const chips = (from: Place, to: Place, amount?: number): Move => ({ name: 'chips', from, to, ...(amount === undefined ? {} : { amount }), after: 0 });

/** The bets in front of these seats go to the pot, as every bet does when a street ends: all but those of the seats in `gone`, which went before. */
function gather(seats: ReplaySeat[], gone: number[]): Step[] {
  const moves = seats.filter((seat) => seat.bet > 0 && !gone.includes(seat.seat)).map((seat) => chips(betOf(seat.seat), POT, seat.bet));

  return moves.length > 0 ? [{ kind: 'gathered', moves }] : [];
}

/**
 * The seats the events leave a bet in front of where the table, as it was drawn at that moment, has
 * none. When the betting ends with players all in and a vote on running it twice, the bets go to the
 * pot at once, and the events only say so when the vote is over.
 */
function gatheredUnsaid(table: ReplayPosition | null, drawn: TableView | null): ReplaySeat[] {
  return (table?.seats ?? []).filter((seat) => seat.bet > 0 && !drawn?.seats[seat.seat]?.bet);
}

/** Two cards to each player, going around from the button's left, a full table no slower than a short one. */
function deal(table: ReplayPosition): Move[] {
  const seats = clockwiseAfter(table.seats, table.button);
  const gap = Math.min(DEAL_GAP_MS, MOST_SPREAD_MS / Math.max(1, seats.length - 1));

  return seats.map(({ seat }, nth) => ({ name: 'deal', from: DECK, to: cardsOf(seat), after: Math.round(nth * gap) }));
}

/**
 * What one hand event moves, for the viewer at `viewer`: the table of which event moves what. `before`
 * and `after` are the table either side of the event, and `gone` the seats whose bets went to the pot
 * before the events said so. A new kind of event takes a case here, moves or none, and the build fails
 * until it has one.
 */
function stepsOf(event: HandEvent, before: ReplayPosition, after: ReplayPosition, viewer: number | null, gone: number[]): Step[] {
  switch (event[0]) {
    case 'post': {
      const [, seat, , , , as] = event;

      // A blind sits in front of the player like any bet. An ante or a bomb pot's chips go straight to the pot,
      // from every seat at once, so each is a bare chip and the pot says what they came to
      return [{ kind: 'dealt', moves: [as ? chips(seatOf(seat), POT) : betSlide(seat)] }];
    }

    case 'deal':
      return [{ kind: 'dealt', moves: deal(before) }];

    case 'fold':
      // The viewer's own folded cards stay in front of them to look at
      return event[1] === viewer ? [] : [{ kind: 'acted', moves: [{ name: 'muck', from: cardsOf(event[1]), to: DECK, after: 0 }] }];

    case 'call':
    case 'bet':
    case 'raise':
      return [{ kind: 'acted', moves: [betSlide(event[1])] }];

    case 'return':
      return [{ kind: 'acted', moves: [chips(betOf(event[1]), seatOf(event[1]), event[2])] }];

    case 'street': {
      const [, board, cards] = event;
      const first = after.boards[board]!.length - cards.length;

      // Two boards dealt a street together get their cards together, so two take no longer than one
      return [...gather(before.seats, gone), { kind: 'street', moves: cards.map((_card, nth) => ({ name: 'board', from: DECK, to: { at: 'board', board, card: first + nth }, after: nth * BOARD_GAP_MS })) }];
    }

    case 'runs':
      return gather(before.seats, gone);

    case 'show':
      // The viewer has been looking at their own cards all along
      return event[1] === viewer ? [] : [{ kind: 'shown', moves: [{ name: 'show', to: cardsOf(event[1]), after: 0 }] }];

    // One pile to each winner, with all they won: the shares of a split pot, of side pots and of two boards leave together
    case 'win':
      return [...gather(before.seats, gone), { kind: 'won', moves: [chips(POT, seatOf(event[1]), event[2])] }];

    case 'bounty':
      return [{ kind: 'bounty', moves: event[2].map(([payer, amount]) => chips(seatOf(payer), seatOf(event[1]), amount)) }];

    // A check is heard, not seen, and a mucked hand stays face down where it is until the next deal
    case 'start':
    case 'check':
    case 'timeout':
    case 'vote':
    case 'muck':
      return [];

    default:
      // An event this page does not know, from a newer server, moves nothing
      event satisfies never;
      return [];
  }
}

const sameWay = (a: Move, b: Move) => a.name === b.name && JSON.stringify([a.from, a.to]) === JSON.stringify([b.from, b.to]);

/** Adds a move to a step. One that goes the way another already does joins it: a second bet from a seat is one slide, and two shares of a pot one pile. */
function add(step: Step, move: Move): void {
  const twin = step.moves.find((other) => sameWay(other, move));

  if (!twin) {
    step.moves.push(move);
  } else if (twin.amount !== undefined && move.amount !== undefined) {
    twin.amount += move.amount;
  }
}

const lengthOf = (step: Step) => Math.max(...step.moves.map((move) => move.after + MOVE_MS[move.name]));

/**
 * What the hand's new events move on the table of the viewer at `viewer`, each move with how long
 * after the view is shown it starts. Nothing for a view that is catching the viewer up, which has no
 * new events.
 */
export function movesSeen({ before: shown, view, events }: TableChange, viewer: number | null): Move[] {
  // Whatever else differs in a view with no news of the hand is something the viewer missed
  if (events.length === 0) {
    return [];
  }

  const all = view.hand?.events ?? [];
  const had = all.length - events.length;
  let steps: Step[] = [];

  const take = (made: Step[]): void => {
    for (const { kind, moves } of made) {
      const last = steps.at(-1);
      const step = last?.kind === kind ? last : { kind, moves: [] };

      if (step !== last) {
        steps.push(step);
      }

      moves.forEach((move) => add(step, move));
    }
  };

  // Bets the table stopped drawing before this view are not gathered again when the events come to say it
  const gone = gatheredUnsaid(replayHand(all, had), shown).map((seat) => seat.seat);

  for (let nth = had; nth < all.length; nth++) {
    const before = replayHand(all, nth);
    const after = replayHand(all, nth + 1);

    take(before && after ? stepsOf(all[nth]!, before, after, viewer, gone) : []);
  }

  // And bets this view stopped drawing are gathered now, though no event has said it yet
  take(gather(gatheredUnsaid(replayHand(all), view), gone));

  // A bet slides only where the table still draws it. One that went to the pot in the same view is seen going there, and one that came back whole is seen coming back
  const gathered = steps.map((step) => step.kind).lastIndexOf('gathered');
  const stillDrawn = (move: Move) => move.to.at === 'bet' && (view.seats[move.to.seat]?.bet ?? 0) > 0;

  steps = steps.map((step, nth) => ({ ...step, moves: step.moves.filter((move) => move.name !== 'bet' || (nth > gathered && stillDrawn(move))) })).filter((step) => step.moves.length > 0);

  // Over budget, the view is shown by how it ended
  while (steps.some((step, nth) => nth * STEP_GAP_MS + lengthOf(step) > MOST_VIEW_MS)) {
    steps.shift();
  }

  return steps.flatMap((step, nth) => step.moves.map((move) => ({ ...move, after: nth * STEP_GAP_MS + move.after })));
}

/** Shows on the table what a view brought to the viewer at `viewer`: what the hand-moves effect does with a change. */
export function followHand(change: TableChange, viewer: number | null, motion: TableMotion): void {
  // The hand has moved on, and what the last view set moving is no longer the news
  if (change.events.length > 0) {
    motion.cancel();
  }

  motion.play(movesSeen(change, viewer));
}
