/*
 * The host moving chips from one player's stack to another's, to settle a side bet or stake a friend.
 * The chips change hands on the table, so nobody buys or cashes out: the giver ends that much further
 * down for the night and the receiver that much further up, as if the giver had paid for the receiver's chips.
 */
import { formatAmount, validAmount } from './amounts.ts';
import { isDealtIn } from './seating.ts';
import { addFeed, memberNamed, recordTransfer, seatIndexOf } from './seats.ts';
import { GameError } from './types.ts';
import type { Ctx, Member, Seat, TableState } from './types.ts';

/** One side of a transfer, who must be sitting at the table with chips nobody is playing for. */
function partyTo(state: TableState, playerId: string): { member: Member; seat: Seat } {
  const member = memberNamed(state, playerId);
  const index = seatIndexOf(state, member.id);
  const seat = state.seats[index];

  if (!seat) {
    throw new GameError(`${member.name} doesn't have a seat`);
  }

  if (seat.leaving) {
    throw new GameError(`${member.name} is leaving the table`);
  }

  // The same rule as setting a stack: a stack that a hand is being played for can't change under it. A
  // running game deals the next hand as this one ends, so a player who isn't sitting out is free only once it pauses
  if (isDealtIn(state, index)) {
    throw new GameError(`${member.name} is in the current hand. Pause the game, and once this hand is over the chips can move`);
  }

  return { member, seat };
}

/**
 * Moves chips between two seated players, neither of them in the hand being played. The receiver may
 * end above the table maximum, which limits what is bought, not what is won or given.
 */
export function transfer(state: TableState, ctx: Ctx, actor: string, fromId: string, toId: string, amount: unknown): void {
  if (fromId === toId) {
    throw new GameError('Chips move between two different players');
  }

  const from = partyTo(state, fromId);
  const to = partyTo(state, toId);

  if (from.seat.stack === 0) {
    throw new GameError(`${from.member.name} has no chips to give`);
  }

  const chips = validAmount(amount, 'The amount', state.config, 1, from.seat.stack);

  from.seat.stack -= chips;
  to.seat.stack += chips;
  recordTransfer(state, ctx, from.member, to.member, chips);

  addFeed(state, ctx.now, 'system', null, `${actor} moved ${formatAmount(chips, state.config)} from ${from.member.name} to ${to.member.name}`);
}
