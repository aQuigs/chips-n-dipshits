import { chipsFor, objectionTo, passesTo } from '../engine/betting.ts';
import type { BettingAction, Bettor } from '../engine/betting.ts';
import { eventsWith } from '../engine/events.ts';
import type { HandEvent } from '../engine/events.ts';
import type { Command, PlayerAction } from '../engine/types.ts';
import type { SeatView, TableView } from '../engine/view.ts';

/** A move of the turn: what a player sends when the action is on them. */
export type TurnMove = Extract<Command, { type: 'fold' | 'check' | 'call' | 'raise' }>;

const TURN_MOVES: readonly Command['type'][] = ['fold', 'check', 'call', 'raise'];

export function isTurnMove(command: Command): command is TurnMove {
  return TURN_MOVES.includes(command.type);
}

// What a seat is labeled with once it has acted on the street. A blind it posted is a label too, and no act
const ACTS: readonly (PlayerAction | null)[] = ['fold', 'check', 'call', 'bet', 'raise'];

/** The players of a hand as the betting rules see them, read off the seats of a view. */
function bettorsOf(seats: readonly (SeatView | null)[]): Bettor[] {
  return seats.flatMap((seat) => (seat?.inHand ? [{ seat: seat.seat, bet: seat.bet, folded: seat.folded, allIn: seat.allIn, hasActed: ACTS.includes(seat.lastAction) }] : []));
}

/**
 * The table as the viewer's own move leaves it, for the page to show the moment the move is made:
 * `view` with the move played and nothing that follows from it. Null when the view does not offer the
 * move: it is not the viewer's turn, the move answers another decision, or their options rule it out.
 * Such a move is the server's to refuse, in its own words.
 *
 * What it claims to know, each held to the engine by tests/prediction.test.ts:
 * - the viewer's own seat: their bet, their stack, whether they folded or are all in, and the move's label;
 * - the pot's total;
 * - the move as the hand's next event, which is all the effects hear of it;
 * - that the decision is made: no options, no clock running, no hint under cards that were folded;
 * - who the action passes to, with the next decision's number, when it simply passes on.
 *
 * What it does not know it leaves empty or as the view had it. Nobody is to act (`toAct` null) when
 * the move ends the street or the hand, or the next player is one the server acts for (away, or on
 * their way out): what comes then is for the cards and the server to say. No clock is given, since
 * the next one starts when the server hears the move. The side pots (`pots`), the play-by-play and
 * everything about anyone else are untouched.
 */
export function predict(view: TableView, move: TurnMove): TableView | null {
  const hand = view.hand;
  const seat = view.you.seat === null ? null : view.seats[view.you.seat];
  const options = hand?.options;

  // The options are only ever there for the player the action is on
  if (!hand || !seat || !options || (move.turn !== undefined && move.turn !== hand.turn)) {
    return null;
  }

  const action: BettingAction = move.type === 'raise' ? { type: 'raise', to: move.to } : { type: move.type };
  if (objectionTo(action, options, hand.currentBet, view.config) !== null) {
    return null;
  }

  const paid = chipsFor(action, options, seat.bet);
  const stack = seat.stack - paid;
  const opening = hand.currentBet === 0;

  let event: HandEvent;
  if (action.type === 'raise') {
    event = [opening ? 'bet' : 'raise', seat.seat, action.to, stack];
  } else if (action.type === 'call') {
    event = ['call', seat.seat, paid, stack];
  } else {
    event = [action.type, seat.seat];
  }

  const mine: SeatView = {
    ...seat,
    stack,
    bet: seat.bet + paid,
    folded: action.type === 'fold',
    allIn: paid > 0 && stack === 0,
    lastAction: event[0],
  };
  const seats = view.seats.map((other) => (other === seat ? mine : other));
  const currentBet = action.type === 'raise' ? action.to : hand.currentBet;

  const next = passesTo({ players: bettorsOf(seats), currentBet }, seat.seat);
  const nextSeat = next && seats[next.seat];
  // The server plays the turn of a player who is away or on their way out, in the same breath as this move
  const waitedFor = nextSeat && !nextSeat.away && !nextSeat.leaving ? nextSeat.seat : null;

  return {
    ...view,
    seats,
    hand: {
      ...hand,
      pot: hand.pot + paid,
      currentBet,
      toAct: waitedFor,
      turn: waitedFor === null ? hand.turn : hand.turn + 1,
      deadline: null,
      options: null,
      holding: action.type === 'fold' ? null : hand.holding,
      events: eventsWith(hand.events, event),
    },
  };
}
