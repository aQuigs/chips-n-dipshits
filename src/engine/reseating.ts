/*
 * The host changing who sits where: one player to an open seat, or everyone shuffled. A player dealt
 * into the hand on the table keeps their seat until it ends, so the change waits for that.
 */
import { shuffle } from './cards.ts';
import { followMove, startOver } from './handPlan.ts';
import { isDealtIn, turnAwayFrom } from './seating.ts';
import { addFeed, memberOf } from './seats.ts';
import { GameError } from './types.ts';
import type { Ctx, Seat, TableState } from './types.ts';

/** Puts a seat, and so everything it holds, at another place at the table. */
function place(state: TableState, seat: Seat, to: number): void {
  state.seats[to] = seat;
  seat.moveTo = null;

  for (const request of state.requests) {
    if (request.playerId === seat.playerId && request.kind === 'rebuy') {
      request.seat = to;
    }
  }
}

function move(state: TableState, ctx: Ctx, from: number, to: number): void {
  const seat = state.seats[from]!;

  state.seats[from] = null;
  place(state, seat, to);
  followMove(state, from, to);
  turnAwayFrom(state, ctx, to);
}

/** Every seated player gets a random one of the seats already taken, so the open seats, and the requests for them, stay as they were. */
function shuffleNow(state: TableState, ctx: Ctx): void {
  const taken = state.seats.flatMap((seat, index) => (seat ? [index] : []));
  const seats = shuffle(taken.map((index) => state.seats[index]!), ctx.rng);

  taken.forEach((index, order) => place(state, seats[order]!, index));

  // Where the button and the blinds were says nothing about the new order, so the next hand starts a new game
  startOver(state);
  state.shuffleAfterHand = false;
}

/** `by` is how the chat names whoever asked for the move. Moving a player to the seat they are in takes back a move that is waiting. */
export function movePlayer(state: TableState, ctx: Ctx, by: string, from: number, to: number): void {
  const seat = state.seats[from]!;
  const { name } = memberOf(state, seat.playerId);

  if (to === from) {
    if (seat.moveTo !== null) {
      seat.moveTo = null;
      addFeed(state, ctx.now, 'system', null, `${name} stays in seat ${from + 1}`);
    }
    return;
  }

  if (seat.leaving) {
    throw new GameError(`${name} is giving up their seat when this hand ends`);
  }

  if (state.shuffleAfterHand) {
    throw new GameError('The seats are being shuffled when this hand ends');
  }

  if (state.seats[to]) {
    throw new GameError(`Seat ${to + 1} is taken`);
  }

  // A second move into a seat that one is already waiting for would undo the host's first choice when the hand ends
  const promised = state.seats.find((other) => other?.moveTo === to);
  if (promised) {
    throw new GameError(`Seat ${to + 1} is kept for ${memberOf(state, promised.playerId).name}, who moves there after this hand`);
  }

  if (isDealtIn(state, from)) {
    seat.moveTo = to;
    addFeed(state, ctx.now, 'system', null, `${by} moves ${name} to seat ${to + 1} after this hand`);
    return;
  }

  addFeed(state, ctx.now, 'system', null, `${by} moved ${name} to seat ${to + 1}`);
  move(state, ctx, from, to);
}

export function shuffleEveryone(state: TableState, ctx: Ctx, by: string): void {
  if (state.seats.filter((seat) => seat !== null).length < 2) {
    throw new GameError('Shuffling takes at least two seated players');
  }

  if (!state.hand) {
    shuffleNow(state, ctx);
    addFeed(state, ctx.now, 'system', null, `${by} shuffled the seats`);
    return;
  }

  if (state.shuffleAfterHand) {
    return;
  }

  // The shuffle decides everyone's seat, so a single move still waiting would be undone by it
  for (const seat of state.seats) {
    if (seat) {
      seat.moveTo = null;
    }
  }

  state.shuffleAfterHand = true;
  addFeed(state, ctx.now, 'system', null, `${by} shuffles the seats after this hand`);
}

/** Makes the moves that waited for the hand to end, now that it is off the table and those leaving have gone. */
export function reseatAfterHand(state: TableState, ctx: Ctx): void {
  const waiting = state.seats.flatMap((seat, from) => (seat?.moveTo != null ? [{ seat, from, to: seat.moveTo }] : []));

  for (const { seat, from, to } of waiting) {
    const { name } = memberOf(state, seat.playerId);

    if (state.seats[to]) {
      seat.moveTo = null;
      addFeed(state, ctx.now, 'system', null, `Seat ${to + 1} was taken, so ${name} stays in seat ${from + 1}`);
      continue;
    }

    addFeed(state, ctx.now, 'system', null, `${name} moves to seat ${to + 1}`);
    move(state, ctx, from, to);
  }

  if (state.shuffleAfterHand) {
    shuffleNow(state, ctx);
    addFeed(state, ctx.now, 'system', null, 'The seats are shuffled');
  }
}
