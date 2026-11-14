import type { HostLevel } from '../hosts.ts';
import type { Command, Ctx, Member, Seat, TableState } from '../types.ts';

export type CommandType = Command['type'];

export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

/** One command as it reaches its handler, from someone already known to be a member of the table. */
export interface Call<T extends CommandType> {
  state: TableState;
  ctx: Ctx;
  member: Member;
  command: CommandOf<T>;
}

export interface SeatedCall<T extends CommandType> extends Call<T> {
  seat: Seat;
  seatIndex: number;
}

/**
 * What a command does, and who may send it, which is checked before `run` is called:
 * member: anyone at the table.
 * seat: a player with a seat, which `run` is handed.
 * host or cohost: the host or any co-host; what running the game takes.
 * host alone: the host and nobody else; what decides who runs the game.
 * `inPlayOnly` marks a command that makes sense only while the night goes on, refused once it is over.
 */
export type Handler<T extends CommandType> = ({ by: 'member' | HostLevel; run: (call: Call<T>) => void } | { by: 'seat'; run: (call: SeatedCall<T>) => void }) & { inPlayOnly?: true };
