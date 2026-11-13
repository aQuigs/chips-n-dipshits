/* Who runs the table: one host, who owns it, and any co-hosts the host names to share the work. */
import { GameError } from './types.ts';
import type { Member, TableState } from './types.ts';

export type Role = 'host' | 'cohost' | 'member';

/**
 * Who may send one of the host's commands. Each such command declares one of these as its `by`:
 * 'host or cohost' for running the game, 'host alone' for what decides who runs it.
 */
export type HostLevel = 'host or cohost' | 'host alone';

const LEVELS: Record<HostLevel, { roles: readonly Role[]; refusal: string }> = {
  'host or cohost': { roles: ['host', 'cohost'], refusal: 'Only the host or a co-host can do that' },
  'host alone': { roles: ['host'], refusal: 'Only the host can do that' },
};

export function isHostLevel(by: string): by is HostLevel {
  return by === 'host or cohost' || by === 'host alone';
}

export function roleOf(state: TableState, playerId: string): Role {
  if (playerId === state.hostId) {
    return 'host';
  }

  return state.cohostIds.includes(playerId) ? 'cohost' : 'member';
}

export function reaches(role: Role, level: HostLevel): boolean {
  return LEVELS[level].roles.includes(role);
}

export function requireLevel(state: TableState, playerId: string, level: HostLevel): void {
  if (!reaches(roleOf(state, playerId), level)) {
    throw new GameError(LEVELS[level].refusal);
  }
}

/** A co-host acts for the host but not against them: the host's seat and place at the table are the host's own to give up. */
export function requireMayRemove(state: TableState, sender: Member, target: Member): void {
  if (target.id === state.hostId && sender.id !== state.hostId) {
    throw new GameError('Only the host can remove the host');
  }
}

/** How the chat names whoever used the host's powers: "The host", or a co-host by name. */
export function actorName(state: TableState, member: Member): string {
  return member.id === state.hostId ? 'The host' : member.name;
}
