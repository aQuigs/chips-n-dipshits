import { formatChips } from './format.ts';
import { GameError, SEAT_COUNT } from './types.ts';
import type { Ctx, FeedKind, LedgerKind, Member, TableState } from './types.ts';

export const FEED_LIMIT = 60;

/** Steps clockwise from one seat to another; 0 when they are the same seat. */
function stepsClockwise(from: number, to: number): number {
  return (to - from + SEAT_COUNT) % SEAT_COUNT;
}

/** Orders by seat going clockwise, starting with the seat after the given one, which itself comes last. */
export function clockwiseAfter<T extends { seat: number }>(items: readonly T[], seat: number): T[] {
  const distance = (item: T) => stepsClockwise(seat, item.seat) || SEAT_COUNT;

  return [...items].sort((a, b) => distance(a) - distance(b));
}

/** Orders by seat going clockwise, starting with the given seat. */
export function clockwiseFrom<T extends { seat: number }>(items: readonly T[], seat: number): T[] {
  return [...items].sort((a, b) => stepsClockwise(seat, a.seat) - stepsClockwise(seat, b.seat));
}

export function seatsClockwiseAfter(seats: readonly number[], seat: number): number[] {
  return clockwiseAfter(seats.map((s) => ({ seat: s })), seat).map((item) => item.seat);
}

/** Seats that get cards in the next hand. */
export function eligibleSeats(state: TableState): number[] {
  const seats: number[] = [];

  state.seats.forEach((seat, index) => {
    if (seat && !seat.sittingOut && !seat.leaving && seat.stack > 0) {
      seats.push(index);
    }
  });

  return seats;
}

export function memberOf(state: TableState, playerId: string): Member {
  const member = state.members.find((m) => m.id === playerId);
  if (!member) {
    throw new GameError('You are not part of this table');
  }

  return member;
}

/** The member a host's command is about, who may have been removed since the host's screen was drawn. */
export function memberNamed(state: TableState, playerId: string): Member {
  const member = state.members.find((m) => m.id === playerId);
  if (!member) {
    throw new GameError('That player is no longer at the table');
  }

  return member;
}

export function seatIndexOf(state: TableState, playerId: string): number {
  return state.seats.findIndex((seat) => seat?.playerId === playerId);
}

export function addFeed(state: TableState, now: number, kind: FeedKind, from: string | null, text: string): void {
  state.feedSeq += 1;
  state.feed.push({ seq: state.feedSeq, at: now, kind, from, text });

  if (state.feed.length > FEED_LIMIT) {
    state.feed.splice(0, state.feed.length - FEED_LIMIT);
  }
}

export function recordLedger(state: TableState, ctx: Ctx, member: Member, kind: LedgerKind, amount: number): void {
  if (amount > 0) {
    member.buyIn += amount;
  } else {
    member.cashOut -= amount;
  }

  ctx.effects.push({
    type: 'ledger',
    entry: { at: ctx.now, tableId: state.id, playerId: member.id, name: member.name, kind, amount },
  });
}

/**
 * Chips asked for during a hand reach the stack when it ends, and only then are they bought: by then
 * the hand may have left the player too rich for all of them, or any of them, to fit under the maximum.
 */
export function addPendingChips(state: TableState, ctx: Ctx, seatIndex: number): void {
  const seat = state.seats[seatIndex]!;
  const asked = seat.pendingAdd;
  if (asked === 0) {
    return;
  }

  const member = memberOf(state, seat.playerId);
  const added = Math.min(asked, Math.max(0, state.config.maxBuyIn - seat.stack));

  seat.pendingAdd = 0;

  if (added > 0) {
    seat.stack += added;
    recordLedger(state, ctx, member, 'buy-in', added);
  }

  if (added === 0) {
    addFeed(state, ctx.now, 'system', null, `${member.name} is over the table maximum, so no chips are added`);
  } else if (added < asked) {
    addFeed(state, ctx.now, 'system', null, `${member.name} adds ${formatChips(added)}, which brings them to the table maximum`);
  }
}

/** Empties a seat and cashes its chips out. Chips still waiting to be added were never bought. */
export function vacateSeat(state: TableState, ctx: Ctx, seatIndex: number): void {
  const seat = state.seats[seatIndex];
  if (!seat) {
    return;
  }

  const member = memberOf(state, seat.playerId);
  const chips = seat.stack;

  state.seats[seatIndex] = null;
  state.requests = state.requests.filter((request) => request.playerId !== seat.playerId);

  if (chips > 0) {
    recordLedger(state, ctx, member, 'cash-out', -chips);
  }

  addFeed(state, ctx.now, 'system', null, `${member.name} leaves the table with ${formatChips(chips)}`);
}
