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
  // Apps Script's runtime predates Object.hasOwn
  return Object.prototype.hasOwnProperty.call(LEVELS, by);
}

/** Takes a table or a view of one, which both say who the host and co-hosts are. */
export function roleOf(state: Pick<TableState, 'hostId' | 'cohostIds'>, playerId: string): Role {
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

export function dropCohost(state: TableState, playerId: string): void {
  state.cohostIds = state.cohostIds.filter((id) => id !== playerId);
}

/**
 * A co-host acts for the host but not against them: the host's seat and place at the table are the
 * host's own to give up, and taking a co-host off the table altogether would end their role, which only
 * the host may do. Another co-host's seat is fair game.
 */
export function requireMayRemove(state: TableState, sender: Member, target: Member, altogether: boolean): void {
  if (sender.id === state.hostId) {
    return;
  }

  const role = roleOf(state, target.id);
  if (role === 'host') {
    throw new GameError('Only the host can remove the host');
  }

  if (role === 'cohost' && altogether) {
    throw new GameError('Only the host can take a co-host off the table');
  }
}

/** How the chat names whoever used the host's powers, which no name a player picks can pass for. */
export function actorName(state: TableState, member: Member): string {
  return member.id === state.hostId ? 'The host' : `Co-host ${member.name}`;
}
