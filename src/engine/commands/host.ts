/* What the host may do, and of that what co-hosts may do too: each handler's `by` says which. */
import { formatAmount, validAmount } from '../amounts.ts';
import { validatedConfig } from '../config.ts';
import { restartActionClock } from '../hand.ts';
import { actorName, dropCohost, requireMayRemove } from '../hosts.ts';
import { movePlayer, shuffleEveryone } from '../reseating.ts';
import { grant, isDealtIn, leaveSeat, turnAway } from '../seating.ts';
import { addFeed, memberNamed, recordLedger, seatIndexOf } from '../seats.ts';
import { GameError, SEAT_COUNT } from '../types.ts';
import { wholeNumber, yesOrNo } from '../validate.ts';
import type { Handler } from './handler.ts';

export const start: Handler<'start'> = {
  by: 'host or cohost',
  run: ({ state, ctx }) => {
    if (!state.running) {
      state.running = true;
      addFeed(state, ctx.now, 'system', null, 'The game is on');
    }
  },
};

export const pause: Handler<'pause'> = {
  by: 'host or cohost',
  run: ({ state, ctx }) => {
    if (state.running) {
      state.running = false;
      addFeed(state, ctx.now, 'system', null, state.hand ? 'The game pauses after this hand' : 'The game is paused');
    }
  },
};

export const approve: Handler<'approve'> = {
  by: 'host or cohost',
  run: ({ state, ctx, command }) => {
    const request = state.requests.find((r) => r.playerId === command.playerId);
    if (!request) {
      throw new GameError('That request is gone');
    }

    grant(state, ctx, request);
  },
};

export const deny: Handler<'deny'> = {
  by: 'host or cohost',
  run: ({ state, ctx, member, command }) => {
    const who = actorName(state, member);

    turnAway(
      state,
      ctx,
      (r) => r.playerId === command.playerId,
      (name, r) => (r.kind === 'seat' ? `${who} turned down ${name}'s request for a seat` : `${who} turned down ${name}'s request for chips`),
    );
  },
};

export const kick: Handler<'kick'> = {
  by: 'host or cohost',
  run: ({ state, ctx, member, command }) => {
    const target = memberNamed(state, command.playerId);
    const index = seatIndexOf(state, target.id);
    requireMayRemove(state, member, target, index < 0);

    state.requests = state.requests.filter((r) => r.playerId !== target.id);

    if (index >= 0) {
      addFeed(state, ctx.now, 'system', null, `${actorName(state, member)} removed ${target.name} from their seat`);
      leaveSeat(state, ctx, index);
    } else if (target.id !== state.hostId && target.buyIn === 0 && target.cashOut === 0) {
      // Someone who never played has no line in the ledger to be kept for, so their name and their place at the table are freed
      state.members = state.members.filter((m) => m !== target);
      dropCohost(state, target.id);
      addFeed(state, ctx.now, 'system', null, `${actorName(state, member)} removed ${target.name} from the table`);
    }
  },
};

export const setStack: Handler<'setStack'> = {
  by: 'host or cohost',
  run: ({ state, ctx, member, command }) => {
    const target = memberNamed(state, command.playerId);
    const index = seatIndexOf(state, target.id);
    const seat = state.seats[index];
    if (!seat) {
      throw new GameError(`${target.name} doesn't have a seat`);
    }

    if (isDealtIn(state, index)) {
      throw new GameError(`${target.name} is in the current hand, so wait until it is over`);
    }

    const stack = validAmount(command.stack, 'The stack', state.config, 0);
    const change = stack - seat.stack;
    if (change !== 0) {
      seat.stack = stack;
      recordLedger(state, ctx, target, 'adjustment', change);
      addFeed(state, ctx.now, 'system', null, `${actorName(state, member)} set ${target.name}'s stack to ${formatAmount(stack, state.config)}`);
    }
  },
};

export const moveSeat: Handler<'moveSeat'> = {
  by: 'host or cohost',
  run: ({ state, ctx, member, command }) => {
    const target = memberNamed(state, command.playerId);
    const from = seatIndexOf(state, target.id);
    if (from < 0) {
      throw new GameError(`${target.name} doesn't have a seat`);
    }

    movePlayer(state, ctx, actorName(state, member), from, wholeNumber(command.seat, 'The seat', 0, SEAT_COUNT - 1));
  },
};

export const shuffleSeats: Handler<'shuffleSeats'> = {
  by: 'host or cohost',
  run: ({ state, ctx, member }) => shuffleEveryone(state, ctx, actorName(state, member)),
};

export const updateConfig: Handler<'updateConfig'> = {
  by: 'host or cohost',
  run: ({ state, ctx, member, command }) => {
    const before = state.config;
    state.config = validatedConfig(command.config, before);

    const when = state.hand ? ' from the next hand' : '';

    if (state.config.smallBlind !== before.smallBlind || state.config.bigBlind !== before.bigBlind) {
      addFeed(state, ctx.now, 'system', null, `Blinds are ${formatAmount(state.config.smallBlind, state.config)}/${formatAmount(state.config.bigBlind, state.config)}${when}`);
    }

    const { ante, anteFrom } = state.config;
    if (ante !== before.ante || (ante > 0 && anteFrom !== before.anteFrom)) {
      const paidBy = anteFrom === 'bigBlind' ? 'the big blind for the table' : 'everyone';
      addFeed(state, ctx.now, 'system', null, ante > 0 ? `The ante is ${formatAmount(ante, state.config)}, paid by ${paidBy}${when}` : `The ante is off${when}`);
    }

    if (state.config.sevenDeuceBounty !== before.sevenDeuceBounty) {
      const bounty = state.config.sevenDeuceBounty;
      addFeed(state, ctx.now, 'system', null, bounty > 0 ? `The seven-deuce bounty is ${formatAmount(bounty, state.config)}${when}` : `The seven-deuce bounty is off${when}`);
    }

    if (state.config.voiceLink !== before.voiceLink) {
      const change = before.voiceLink === '' ? 'set' : state.config.voiceLink === '' ? 'removed' : 'changed';
      addFeed(state, ctx.now, 'system', null, `${actorName(state, member)} ${change} the voice chat link`);
    }

    const { minBuyIn, maxBuyIn } = state.config;
    turnAway(
      state,
      ctx,
      (r) => r.kind === 'seat' && (r.amount < minBuyIn || r.amount > maxBuyIn),
      (name, r) => `${name} asked to sit down with ${formatAmount(r.amount, state.config)}, which the new buy-in limits don't allow`,
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
  by: 'host alone',
  run: ({ state, ctx, member, command }) => {
    const target = memberNamed(state, command.playerId);
    if (target.id === member.id) {
      return;
    }

    // The old host stays trusted with the game, so they keep its powers until the new host says otherwise
    state.hostId = target.id;
    dropCohost(state, target.id);
    state.cohostIds.push(member.id);
    addFeed(state, ctx.now, 'system', null, `${target.name} is now the host, and ${member.name} a co-host`);
  },
};

export const setCohost: Handler<'setCohost'> = {
  by: 'host alone',
  run: ({ state, ctx, command }) => {
    const target = memberNamed(state, command.playerId);
    const on = yesOrNo(command.on, 'Co-host');
    if (target.id === state.hostId) {
      throw new GameError('The host has every power a co-host has');
    }

    if (on === state.cohostIds.includes(target.id)) {
      return;
    }

    if (on) {
      state.cohostIds.push(target.id);
    } else {
      dropCohost(state, target.id);
    }

    addFeed(state, ctx.now, 'system', null, on ? `${target.name} is now a co-host` : `${target.name} is no longer a co-host`);
  },
};
