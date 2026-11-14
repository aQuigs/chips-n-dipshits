import { isHostLevel, requireLevel } from '../hosts.ts';
import { nightIsOver } from '../night.ts';
import { memberOf, seatIndexOf } from '../seats.ts';
import { GameError } from '../types.ts';
import type { Command, Ctx, TableState } from '../types.ts';
import { chat } from './anyone.ts';
import type { Call, CommandType, Handler, SeatedCall } from './handler.ts';
import { approve, deny, endTheNight, forgiveBlinds, kick, moveSeat, pause, playOn, setBombPot, setCohost, setLastHands, setStack, shuffleSeats, start, transferChips, transferHost, updateConfig } from './host.ts';
import { call, check, fold, raise, ritVote, showCards } from './play.ts';
import { cancelRequest, comeIn, requestRebuy, requestSeat, setStraddle, sitIn, sitOut, standUp } from './seat.ts';

/** Every command the table takes. A new one is a member of `Command`, its handler, and its line here. */
export const HANDLERS: { [T in CommandType]: Handler<T> } = {
  requestSeat,
  requestRebuy,
  cancelRequest,
  standUp,
  sitOut,
  sitIn,
  comeIn,
  setStraddle,

  fold,
  check,
  call,
  raise,
  ritVote,
  showCards,

  chat,

  start,
  pause,
  approve,
  deny,
  kick,
  setStack,
  moveSeat,
  shuffleSeats,
  transferChips,
  setBombPot,
  setLastHands,
  endNight: endTheNight,
  playOn,
  forgiveBlinds,
  updateConfig,
  transferHost,
  setCohost,
};

/** Runs a member's command through its handler, once they are seen to be allowed to send it. */
export function dispatch(state: TableState, ctx: Ctx, playerId: string, command: Command): void {
  const member = memberOf(state, playerId);

  // Only a name the table itself lists is a command: "constructor" names something on every object, and ['fold'] reads as "fold" when used as a key
  if (typeof command.type !== 'string' || !Object.prototype.hasOwnProperty.call(HANDLERS, command.type)) {
    throw new GameError('Unknown command');
  }

  const handler = HANDLERS[command.type] as Handler<CommandType>;
  const request: Call<CommandType> = { state, ctx, member, command };

  if (isHostLevel(handler.by)) {
    requireLevel(state, playerId, handler.by);
  }

  if (handler.inPlayOnly && nightIsOver(state)) {
    throw new GameError('The night is over, so that waits until play starts again');
  }

  if (handler.by !== 'seat') {
    handler.run(request);
    return;
  }

  const seatIndex = seatIndexOf(state, playerId);
  if (seatIndex < 0) {
    throw new GameError('You need a seat for that');
  }

  const seated: SeatedCall<CommandType> = { ...request, seat: state.seats[seatIndex]!, seatIndex };
  handler.run(seated);
}
