import { boardsDealt } from '../engine/bombPots.ts';
import { replayHand } from '../engine/events.ts';
import type { HandEvent, ReplayPosition, ReplaySeat } from '../engine/events.ts';
import { clockwiseAfter } from '../engine/seats.ts';
import type { TableView } from '../engine/view.ts';
import { soundsPlaced } from './handSounds.ts';
import type { Move, Place, TableMotion } from './motion.ts';
import { SOUND_GAP_MS } from './sound.ts';
import type { TableChange } from './tableChange.ts';

/** The longest any one move may take, from leaving to landing. */
export const MOST_MOVE_MS = 300;

/**
 * The longest everything one view sets moving may take, from the view being shown to the last piece
 * landing. A view moves on the beats of its sounds and never has more than a few (`soundsPlaced`), so
 * one that brings a burst is seen as it is heard, by how it ended: whatever came before its last
 * sounds jumps to the first beat, each thing once. `tests/motion.test.ts` holds the beats to this.
 */
export const MOST_VIEW_MS = 900;

/**
 * What a view brings plays a beat at a time, each starting this long after the one before, whether or
 * not that one has landed. It is the gap the sounds of a view are played at, and a step starts on the
 * beat of its sound, so each thing is seen in the frame it is heard.
 */
export const STEP_GAP_MS = SOUND_GAP_MS;

// The longest a step may take to set off all its moves, as a deal does going around a full table
const MOST_SPREAD_MS = 240;

// How long after the cards of one seat those of the next are dealt, where the table is small enough to allow it
const DEAL_GAP_MS = 60;

// How long after one card of a flop the next lands
const BOARD_GAP_MS = 60;

/** What an event sets moving together, give or take a spread: the `after` of its moves counts from the step's own start. */
interface Step {
  moves: Move[];
  /**
   * Left out of a step seen as its own event is heard. `gathered` is the bets going to the pot, seen with
   * whatever ended the betting, which is the event before the one that says so. A view has one sound for
   * all its `street` steps and one for all its `won`, heard with the last, and they are seen together then.
   */
  kind?: 'gathered' | 'street' | 'won';
}

const seatOf = (seat: number): Place => ({ at: 'seat', seat });
const betOf = (seat: number): Place => ({ at: 'bet', seat });
const cardsOf = (seat: number): Place => ({ at: 'cards', seat });
const POT: Place = { at: 'pot' };
const DECK: Place = { at: 'deck' };

/**
 * A seat's chips going in front of it: how a blind, a bet, a call or a raise is shown. Whatever else
 * puts a bet on the table plays this once the bet is drawn, and gets the same slide. A page that shows
 * a player's own bet before the server has answered can: when the view that confirms it comes, the bet
 * is lying there already and is not slid again.
 */
export const betSlide = (seat: number): Move => ({ name: 'bet', from: seatOf(seat), to: betOf(seat), after: 0 });

/** A pile of chips crossing the table. With no amount it is a bare chip. */
const chips = (from: Place, to: Place, amount?: number): Move => ({ name: 'chips', from, to, amount, after: 0 });

/** The bets in front of these seats go to the pot, as every bet does when a street ends. */
function gather(seats: ReplaySeat[]): Step[] {
  const moves = seats.filter((seat) => seat.bet > 0).map((seat) => chips(betOf(seat.seat), POT, seat.bet));

  return moves.length > 0 ? [{ kind: 'gathered', moves }] : [];
}

/**
 * The seats the events leave a bet in front of where the table, as it was drawn at that moment, has
 * none. When the betting ends with players all in and a vote on running it twice, the bets go to the
 * pot at once, and the events only say so when the vote is over.
 */
function gatheredUnsaid(table: ReplayPosition | null | undefined, drawn: TableView | null): ReplaySeat[] {
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
 * and `after` are the table either side of the event. A new kind of event takes a case here, moves or
 * none, and the build fails until it has one.
 */
function stepsOf(event: HandEvent, before: ReplayPosition, after: ReplayPosition, viewer: number | null): Step[] {
  switch (event[0]) {
    case 'post': {
      const [, seat, , , , as] = event;

      // A blind sits in front of the player like any bet, a missed big blind too, whichever seat posts it. An ante,
      // a bomb pot's chips and a missed small blind posted dead go straight to the pot and leave nothing in front of
      // the seat: each is a bare chip, as they come from several seats at once, and the pot says what they came to
      return [{ moves: [as ? chips(seatOf(seat), POT) : betSlide(seat)] }];
    }

    case 'deal':
      return [{ moves: deal(before) }];

    case 'fold':
      // The viewer's own folded cards stay in front of them to look at
      return event[1] === viewer ? [] : [{ moves: [{ name: 'muck', from: cardsOf(event[1]), to: DECK, after: 0 }] }];

    case 'call':
    case 'bet':
    case 'raise':
      return [{ moves: [betSlide(event[1])] }];

    case 'return': {
      const [, seat, amount] = event;
      // A bet nobody called goes back from in front of the player. What is more than their bet is the
      // part of an ante or a bomb pot nobody could match, which went to the pot and comes back from there
      const fromBet = Math.min(amount, before.seats.find((player) => player.seat === seat)?.bet ?? 0);
      const moves = [fromBet > 0 ? chips(betOf(seat), seatOf(seat), fromBet) : null, amount > fromBet ? chips(POT, seatOf(seat), amount - fromBet) : null];

      return [{ moves: moves.filter((move) => move !== null) }];
    }

    case 'street': {
      const [, board, cards] = event;
      const first = after.boards[board]!.length - cards.length;

      // Boards dealt a street together make one sound for it, so their cards come together and two take no longer than one
      return [...gather(before.seats), { kind: 'street', moves: cards.map((_card, nth) => ({ name: 'board', to: { at: 'board', board, card: first + nth }, after: nth * BOARD_GAP_MS })) }];
    }

    case 'runs':
      return gather(before.seats);

    case 'show':
      // The viewer has been looking at their own cards all along
      return event[1] === viewer ? [] : [{ moves: [{ name: 'show', to: cardsOf(event[1]), after: 0 }] }];

    // One pile to each winner, with all they won: the shares of a split pot, of side pots and of two boards leave together
    case 'win':
      return [...gather(before.seats), { kind: 'won', moves: [chips(POT, seatOf(event[1]), event[2])] }];

    case 'bounty':
      return [{ moves: event[2].map(([payer, amount]) => chips(seatOf(payer), seatOf(event[1]), amount)) }];

    // Each blind goes back from in front of its seat, as a bet nobody called does
    case 'chop':
      return [{ moves: event[1].map(([seat, amount]) => chips(betOf(seat), seatOf(seat), amount)) }];

    // A check is heard, not seen, and a mucked hand stays face down where it is until the next deal
    case 'start':
    case 'check':
    case 'timeout':
    case 'vote':
    case 'muck':
    case 'chopOffer':
    case 'chopAnswer':
      return [];

    default:
      // An event this page does not know, from a newer server, moves nothing
      event satisfies never;
      return [];
  }
}

const sameWay = (a: Move, b: Move) => a.name === b.name && JSON.stringify([a.from, a.to]) === JSON.stringify([b.from, b.to]);

/** Adds a move to those of a beat. One that goes the way another already does joins it: a second bet from a seat is one slide, and two shares of a pot one pile. */
function add(moves: Move[], move: Move): void {
  const twin = moves.find((other) => sameWay(other, move));

  if (!twin) {
    moves.push(move);
  } else if (twin.amount !== undefined && move.amount !== undefined) {
    twin.amount += move.amount;
  }
}

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
  // The table before the first of the new events, between each and the next, and after the last
  const tables = Array.from({ length: events.length + 1 }, (_, nth) => replayHand(all, had + nth));
  // Each step with the event it came of, counted from the first of the new ones
  const steps: (Step & { event: number })[] = [];

  events.forEach((event, nth) => {
    const [before, after] = [tables[nth], tables[nth + 1]];

    steps.push(...(before && after ? stepsOf(event, before, after, viewer) : []).map((step) => ({ ...step, event: nth })));
  });

  // Bets this view stopped drawing are gathered now, though no event has said it yet
  steps.push(...gather(gatheredUnsaid(tables.at(-1), view)).map((step) => ({ ...step, event: events.length })));

  // What the table draws has the last word on its bets. One it stopped drawing before this view was seen
  // going to the pot then. And a bet slides only where this view puts one: one that went to the pot in the
  // same view is seen going there, one that came back whole is seen coming back, and one the table was
  // drawing just so already, as a page does that shows a player's own move before the server answers, has had its slide
  const gone = gatheredUnsaid(tables[0], shown).map((seat) => seat.seat);
  const gathered = steps.map((step) => step.kind).lastIndexOf('gathered');
  const betAt = (table: TableView | null, at: Place) => (at.at === 'bet' ? (table?.seats[at.seat]?.bet ?? 0) : 0);
  const slides = (move: Move, nth: number) => nth > gathered && betAt(view, move.to) > 0 && (gathered >= 0 || betAt(view, move.to) !== betAt(shown, move.to));
  const leavesGoneBet = (move: Move) => move.from?.at === 'bet' && gone.includes(move.from.seat);

  // The sounds of a view play a beat apart, the first at once. An event is seen on the beat of its own
  // sound, and one that makes none on the beat of the last sound before it
  const heard = soundsPlaced(events, viewer, boardsDealt(view.hand?.bombPot ?? null)).map((sound) => sound.event);
  const beatOf = (event: number) => Math.max(0, heard.filter((at) => at <= event).length - 1);
  const lastOf = (kind: Step['kind']) => steps.filter((step) => step.kind === kind).at(-1)!.event;
  const seenWith = ({ kind, event }: (typeof steps)[number]) => (kind === 'gathered' ? event - 1 : kind ? lastOf(kind) : event);
  // A slow view can bring a street and the bets after it before any sound of its own: a bet then slides in a
  // beat after the last ones left for the pot, not onto the place they are leaving
  const afterGather = gathered >= 0 ? beatOf(seenWith(steps[gathered]!)) + 1 : 0;
  const beats: Move[][] = [];

  steps.forEach((step, nth) => {
    const beat = beatOf(seenWith(step));

    for (const move of step.moves) {
      if (move.name === 'bet' ? slides(move, nth) : !leavesGoneBet(move)) {
        add((beats[move.name === 'bet' ? Math.max(beat, afterGather) : beat] ??= []), move);
      }
    }
  });

  return beats.flatMap((moves, beat) => moves.map((move) => ({ ...move, after: beat * STEP_GAP_MS + move.after })));
}

/** Shows on the table what a view brought to the viewer at `viewer`: what the hand-moves effect does with a change. */
export function followHand(change: TableChange, viewer: number | null, motion: TableMotion): void {
  // The hand has moved on, and what the last view set moving is no longer the news
  if (change.events.length > 0) {
    motion.cancel();
  }

  motion.play(movesSeen(change, viewer));
}
