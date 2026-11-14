import type { Command, HandRecord, Stakes, TableConfig, TableView } from '../engine/index.ts';

/** Proof of which member a request comes from. */
export interface Auth {
  id: string;
  token: string;
}

export type ApiRequest =
  | { op: 'create'; name: string; config?: Partial<TableConfig> }
  | { op: 'info'; tableId: string }
  | { op: 'join'; tableId: string; name: string }
  | {
      op: 'poll';
      tableId: string;
      auth: Auth;
      /** The version the caller already has. */
      since: number;
      /** How long the host may hold the request open waiting for something new. */
      holdMs?: number;
    }
  | { op: 'act'; tableId: string; auth: Auth; command: Command }
  | { op: 'history'; tableId: string; auth: Auth };

/**
 * invalid: the request broke a rule; the message is for the player.
 * not_found: no such table.
 * unauthorized: the id and token don't match a member.
 * busy: the table could not be locked in time; try again.
 * internal: a bug or an outage.
 */
export type ErrorCode = 'invalid' | 'not_found' | 'unauthorized' | 'busy' | 'internal';

export interface ApiError {
  ok: false;
  code: ErrorCode;
  error: string;
}

/** What someone sees of a table before they have joined it. */
export interface TableInfo extends Stakes {
  id: string;
  name: string;
  players: string[];
}

export type ApiResponse =
  | ApiError
  | { ok: true; kind: 'joined'; auth: Auth; view: TableView }
  | { ok: true; kind: 'info'; table: TableInfo }
  | { ok: true; kind: 'view'; view: TableView }
  | { ok: true; kind: 'unchanged'; now: number }
  | { ok: true; kind: 'history'; hands: HandRecord[] };
