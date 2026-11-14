/* What a player asks for about their own seat. */
import { formatAmount, validAmount } from '../amounts.ts';
import { choosePosting } from '../handPlan.ts';
import { leaveSeat, submit } from '../seating.ts';
import { seatIndexOf } from '../seats.ts';
import { chooseStraddle, isStraddle, straddleKind } from '../straddles.ts';
import { GameError, SEAT_COUNT } from '../types.ts';
import { wholeNumber, yesOrNo } from '../validate.ts';
import type { Handler } from './handler.ts';

export const requestSeat: Handler<'requestSeat'> = {
  by: 'member',
  inPlayOnly: true,
  run: ({ state, ctx, member, command }) => {
    if (seatIndexOf(state, member.id) >= 0) {
      throw new GameError('You already have a seat');
    }

    const seat = wholeNumber(command.seat, 'The seat', 0, SEAT_COUNT - 1);
    if (state.seats[seat]) {
      throw new GameError('That seat is taken');
    }

    const { minBuyIn, maxBuyIn } = state.config;
    const amount = validAmount(command.buyIn, 'Your buy-in', state.config, minBuyIn, maxBuyIn);

    submit(state, ctx, { playerId: member.id, kind: 'seat', seat, amount });
  },
};

export const requestRebuy: Handler<'requestRebuy'> = {
  by: 'seat',
  inPlayOnly: true,
  run: ({ state, ctx, member, command, seat, seatIndex }) => {
    if (seat.leaving) {
      throw new GameError('You are giving up your seat when this hand ends');
    }

    const room = state.config.maxBuyIn - seat.stack - seat.pendingAdd;
    if (room < 1) {
      throw new GameError(`You already have the maximum buy-in of ${formatAmount(state.config.maxBuyIn, state.config)}`);
    }

    const amount = validAmount(command.amount, 'Your rebuy', state.config, 1, room);

    submit(state, ctx, { playerId: member.id, kind: 'rebuy', seat: seatIndex, amount });
  },
};

export const cancelRequest: Handler<'cancelRequest'> = {
  by: 'member',
  run: ({ state, member }) => {
    state.requests = state.requests.filter((r) => r.playerId !== member.id);
  },
};

export const standUp: Handler<'standUp'> = {
  by: 'seat',
  run: ({ state, ctx, seatIndex }) => leaveSeat(state, ctx, seatIndex),
};

export const sitOut: Handler<'sitOut'> = {
  by: 'seat',
  run: ({ seat }) => {
    seat.sittingOut = true;
  },
};

export const sitIn: Handler<'sitIn'> = {
  by: 'seat',
  run: ({ seat }) => {
    seat.sittingOut = false;
    seat.away = false;
  },
};

export const comeIn: Handler<'comeIn'> = {
  by: 'seat',
  run: ({ command, seat }) => {
    choosePosting(seat, yesOrNo(command.post, 'Posting what you owe'));
    seat.sittingOut = false;
    seat.away = false;
  },
};

export const setStraddle: Handler<'setStraddle'> = {
  by: 'seat',
  run: ({ state, command, seat }) => {
    const on = yesOrNo(command.on, 'Straddle');
    if (!isStraddle(command.kind)) {
      throw new GameError('That is no kind of straddle');
    }

    const kind = straddleKind(command.kind);
    if (on && !state.config[kind.setting]) {
      throw new GameError(`${kind.subject} is turned off at this table`);
    }

    chooseStraddle(seat, kind.what, on);
  },
};

export const setAlwaysChop: Handler<'setAlwaysChop'> = {
  by: 'seat',
  run: ({ state, command, seat }) => {
    const on = yesOrNo(command.on, 'Always chop');
    if (on && !state.config.allowChop) {
      throw new GameError("This table doesn't chop the blinds");
    }

    seat.alwaysChop = on;
  },
};
