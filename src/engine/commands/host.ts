/* What only the host may do. */
import { validatedConfig } from '../config.ts';
import { formatChips } from '../format.ts';
import { restartActionClock } from '../hand.ts';
import { grant, isDealtIn, leaveSeat, turnAway } from '../seating.ts';
import { addFeed, memberNamed, recordLedger, seatIndexOf } from '../seats.ts';
import { GameError } from '../types.ts';
import { wholeNumber } from '../validate.ts';
import type { Handler } from './handler.ts';

export const start: Handler<'start'> = {
  by: 'host',
  run: ({ state, ctx }) => {
    if (!state.running) {
      state.running = true;
      addFeed(state, ctx.now, 'system', null, 'The game is on');
    }
  },
};

export const pause: Handler<'pause'> = {
  by: 'host',
  run: ({ state, ctx }) => {
    if (state.running) {
      state.running = false;
      addFeed(state, ctx.now, 'system', null, state.hand ? 'The game pauses after this hand' : 'The game is paused');
    }
  },
};

export const approve: Handler<'approve'> = {
  by: 'host',
  run: ({ state, ctx, command }) => {
    const request = state.requests.find((r) => r.playerId === command.playerId);
    if (!request) {
      throw new GameError('That request is gone');
    }

    grant(state, ctx, request);
  },
};

export const deny: Handler<'deny'> = {
  by: 'host',
  run: ({ state, ctx, command }) => {
    turnAway(
      state,
      ctx,
      (r) => r.playerId === command.playerId,
      (name, r) => (r.kind === 'seat' ? `The host turned down ${name}'s request for a seat` : `The host turned down ${name}'s request for chips`),
    );
  },
};

export const kick: Handler<'kick'> = {
  by: 'host',
  run: ({ state, ctx, command }) => {
    const target = memberNamed(state, command.playerId);
    const index = seatIndexOf(state, target.id);

    state.requests = state.requests.filter((r) => r.playerId !== target.id);

    if (index >= 0) {
      addFeed(state, ctx.now, 'system', null, `The host removed ${target.name} from their seat`);
      leaveSeat(state, ctx, index);
    } else if (target.id !== state.hostId && target.buyIn === 0 && target.cashOut === 0) {
      // Someone who never played has no line in the ledger to be kept for, so their name and their place at the table are freed
      state.members = state.members.filter((m) => m !== target);
      addFeed(state, ctx.now, 'system', null, `The host removed ${target.name} from the table`);
    }
  },
};

export const setStack: Handler<'setStack'> = {
  by: 'host',
  run: ({ state, ctx, command }) => {
    const target = memberNamed(state, command.playerId);
    const index = seatIndexOf(state, target.id);
    const seat = state.seats[index];
    if (!seat) {
      throw new GameError(`${target.name} doesn't have a seat`);
    }

    if (isDealtIn(state, index)) {
      throw new GameError(`${target.name} is in the current hand, so wait until it is over`);
    }

    const stack = wholeNumber(command.stack, 'The stack', 0);
    const change = stack - seat.stack;
    if (change !== 0) {
      seat.stack = stack;
      recordLedger(state, ctx, target, 'adjustment', change);
      addFeed(state, ctx.now, 'system', null, `The host set ${target.name}'s stack to ${formatChips(stack)}`);
    }
  },
};

export const updateConfig: Handler<'updateConfig'> = {
  by: 'host',
  run: ({ state, ctx, command }) => {
    const before = state.config;
    state.config = validatedConfig(command.config, before);

    const when = state.hand ? ' from the next hand' : '';

    if (state.config.smallBlind !== before.smallBlind || state.config.bigBlind !== before.bigBlind) {
      addFeed(state, ctx.now, 'system', null, `Blinds are ${formatChips(state.config.smallBlind)}/${formatChips(state.config.bigBlind)}${when}`);
    }

    if (state.config.sevenDeuceBounty !== before.sevenDeuceBounty) {
      const bounty = state.config.sevenDeuceBounty;
      addFeed(state, ctx.now, 'system', null, bounty > 0 ? `The seven-deuce bounty is ${formatChips(bounty)}${when}` : `The seven-deuce bounty is off${when}`);
    }

    const { minBuyIn, maxBuyIn } = state.config;
    turnAway(
      state,
      ctx,
      (r) => r.kind === 'seat' && (r.amount < minBuyIn || r.amount > maxBuyIn),
      (name, r) => `${name} asked to sit down with ${formatChips(r.amount)}, which the new buy-in limits don't allow`,
    );

    if (!state.config.allowStraddle) {
      for (const seat of state.seats) {
        if (seat) {
          seat.straddle = false;
        }
      }
    }

    if (state.config.actionSeconds !== before.actionSeconds) {
      restartActionClock(state, ctx.now);
    }
  },
};

export const transferHost: Handler<'transferHost'> = {
  by: 'host',
  run: ({ state, ctx, command }) => {
    const target = memberNamed(state, command.playerId);

    state.hostId = target.id;
    addFeed(state, ctx.now, 'system', null, `${target.name} is now the host`);
  },
};
