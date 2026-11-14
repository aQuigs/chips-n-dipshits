import { formatChips } from './format.ts';
import { stopWaitingFor } from './hand.ts';
import { reaches, roleOf } from './hosts.ts';
import { addFeed, memberOf, recordLedger, seatIndexOf, vacateSeat } from './seats.ts';
import { GameError } from './types.ts';
import type { Ctx, SeatRequest, TableState } from './types.ts';

export function isDealtIn(state: TableState, seatIndex: number): boolean {
  return state.hand?.players.some((p) => p.seat === seatIndex) ?? false;
}

function grantSeat(state: TableState, ctx: Ctx, request: SeatRequest): void {
  if (state.seats[request.seat]) {
    throw new GameError('That seat has been taken, so they need to pick another');
  }

  const member = memberOf(state, request.playerId);
  state.seats[request.seat] = {
    playerId: member.id,
    stack: request.amount,
    sittingOut: false,
    away: false,
    leaving: false,
    straddle: false,
    pendingAdd: 0,
  };

  recordLedger(state, ctx, member, 'buy-in', request.amount);
  addFeed(state, ctx.now, 'system', null, `${member.name} sits down with ${formatChips(request.amount)}`);
}

function grantRebuy(state: TableState, ctx: Ctx, request: SeatRequest): void {
  const index = seatIndexOf(state, request.playerId);
  const seat = state.seats[index];
  if (!seat) {
    throw new GameError('They no longer have a seat');
  }

  const member = memberOf(state, request.playerId);

  // The stack or the maximum may have changed since they asked. Refusing would leave a request nobody can approve.
  const amount = Math.min(request.amount, state.config.maxBuyIn - seat.stack - seat.pendingAdd);
  if (amount < 1) {
    addFeed(state, ctx.now, 'system', null, `${member.name} is at the table maximum, so no chips are added`);
    return;
  }

  // Chips can't join a hand that is already being played, so they wait for its end and are bought then
  if (isDealtIn(state, index)) {
    seat.pendingAdd += amount;
    addFeed(state, ctx.now, 'system', null, `${member.name} adds ${formatChips(amount)} after this hand`);
    return;
  }

  seat.stack += amount;
  recordLedger(state, ctx, member, 'buy-in', amount);
  addFeed(state, ctx.now, 'system', null, `${member.name} adds ${formatChips(amount)}`);
}

export function grant(state: TableState, ctx: Ctx, request: SeatRequest): void {
  if (request.kind === 'seat') {
    grantSeat(state, ctx, request);
  } else {
    grantRebuy(state, ctx, request);
  }

  state.requests = state.requests.filter((r) => r.playerId !== request.playerId);

  if (request.kind === 'seat') {
    turnAway(
      state,
      ctx,
      (r) => r.kind === 'seat' && r.seat === request.seat,
      (name) => `Seat ${request.seat + 1} is taken, so ${name} needs to pick another`,
    );
  }
}

/** Drops the requests that can no longer be granted and says why, so none is left that the host could only fail to approve. */
export function turnAway(state: TableState, ctx: Ctx, hopeless: (request: SeatRequest) => boolean, why: (name: string, request: SeatRequest) => string): void {
  const dropped = state.requests.filter(hopeless);

  for (const request of dropped) {
    addFeed(state, ctx.now, 'system', null, why(memberOf(state, request.playerId).name, request));
  }

  state.requests = state.requests.filter((r) => !dropped.includes(r));
}

/** Files a request for the host and co-hosts, who don't need to approve their own. */
export function submit(state: TableState, ctx: Ctx, request: SeatRequest): void {
  state.requests = state.requests.filter((r) => r.playerId !== request.playerId);

  if (reaches(roleOf(state, request.playerId), 'host or cohost')) {
    grant(state, ctx, request);
    return;
  }

  state.requests.push(request);
}

/** Takes a player out of their seat: now if they have no part in the current hand, otherwise once it ends. */
export function leaveSeat(state: TableState, ctx: Ctx, seatIndex: number): void {
  const seat = state.seats[seatIndex]!;

  if (!isDealtIn(state, seatIndex)) {
    vacateSeat(state, ctx, seatIndex);
    return;
  }

  seat.leaving = true;
  state.requests = state.requests.filter((r) => r.playerId !== seat.playerId);
  stopWaitingFor(state, ctx, seatIndex);
}
