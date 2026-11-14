/*
 * What a player does in the hand on the table. Any member may send these: whether it is their turn,
 * their vote or their cards to show is for the hand to say, in its own words.
 */
import type { BettingAction } from '../betting.ts';
import { act, answerChop as answerChopIn, offerChop as offerChopIn, showCards as showCardsOf, voteRunItTwice } from '../hand.ts';
import { seatIndexOf } from '../seats.ts';
import { GameError } from '../types.ts';
import type { Ctx, Member, TableState } from '../types.ts';
import { yesOrNo } from '../validate.ts';
import type { Handler } from './handler.ts';

/** The decision an action says it answers. Left out, the action is for whichever decision is open. */
function turnOf(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GameError('The turn must be a whole number');
  }

  return value;
}

function bet(from: { state: TableState; ctx: Ctx; member: Member }, action: BettingAction, turn: unknown): void {
  act(from.state, from.ctx, seatIndexOf(from.state, from.member.id), action, turnOf(turn));
}

export const fold: Handler<'fold'> = { by: 'member', run: (sent) => bet(sent, { type: 'fold' }, sent.command.turn) };

export const check: Handler<'check'> = { by: 'member', run: (sent) => bet(sent, { type: 'check' }, sent.command.turn) };

export const call: Handler<'call'> = { by: 'member', run: (sent) => bet(sent, { type: 'call' }, sent.command.turn) };

export const raise: Handler<'raise'> = { by: 'member', run: (sent) => bet(sent, { type: 'raise', to: sent.command.to }, sent.command.turn) };

export const offerChop: Handler<'offerChop'> = {
  by: 'member',
  run: ({ state, ctx, member, command }) => offerChopIn(state, ctx, seatIndexOf(state, member.id), turnOf(command.turn)),
};

export const answerChop: Handler<'answerChop'> = {
  by: 'member',
  run: ({ state, ctx, member, command }) => answerChopIn(state, ctx, seatIndexOf(state, member.id), yesOrNo(command.agree, 'Your answer'), turnOf(command.turn)),
};

export const ritVote: Handler<'ritVote'> = {
  by: 'member',
  run: ({ state, ctx, member, command }) => voteRunItTwice(state, ctx, seatIndexOf(state, member.id), yesOrNo(command.agree, 'Your vote')),
};

export const showCards: Handler<'showCards'> = {
  by: 'member',
  run: ({ state, ctx, member }) => showCardsOf(state, ctx, seatIndexOf(state, member.id)),
};
