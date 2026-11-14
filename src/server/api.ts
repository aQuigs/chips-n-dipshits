import type { Command, HandRecord, KnownPlayer, Preset, Stakes, TableConfig, TableView } from '../engine/index.ts';

/**
 * Which build of the game a page or a server is. On the way between them every request carries the
 * page's and every answer the server's (`BuildGate`), beside what `ApiRequest` and `ApiResponse` hold.
 */
export interface Built {
  build: string;
}

/** Proof of which member a request comes from. */
export interface Auth {
  id: string;
  token: string;
}

/** The most a page sends of a failure's message and of its trace. */
export const REPORTED_MESSAGE_LENGTH = 500;
export const REPORTED_TRACE_LENGTH = 3000;

/** What a page says of its browser when it reports a failure: its name, major version and kind of device, nothing else. */
export interface PageBrowser {
  name: string;
  major: number;
  device: 'phone' | 'tablet' | 'desktop';
}

/**
 * Who someone says they are on the game's list of players: one already on it, by id, or someone new to
 * be added to it under the name the request gives. Nothing checks it, and it earns nothing: see `Member.identity`.
 */
export type Who = { as: 'known'; id: string } | { as: 'new' };

export type ApiRequest =
  /**
   * `name` is what the member is called, and for a known player it is the list's name for them as the
   * page had it, used when the list can't be asked. Without `who` the member is nobody the list knows.
   */
  | { op: 'create'; name: string; who?: Who; config?: Partial<TableConfig> }
  | { op: 'info'; tableId: string }
  | { op: 'join'; tableId: string; name: string; who?: Who }
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
  | { op: 'history'; tableId: string; auth: Auth }
  | { op: 'presets' }
  /** Presets belong to the group, but only a host or co-host of a table may save one, from that table. */
  | { op: 'savePreset'; tableId: string; auth: Auth; name: string; settings: Partial<TableConfig>; replace: boolean }
  | { op: 'deletePreset'; tableId: string; auth: Auth; name: string }
  /** A failure a member's page saw, for the error log. Its answer says nothing a page acts on. */
  | { op: 'report'; tableId: string; auth: Auth; message: string; trace: string; browser: PageBrowser }
  | { op: 'players' }
  /** A member says who they are after joining. `name` is only for someone new: what the list is to call them. */
  | { op: 'identify'; tableId: string; auth: Auth; who: Who; name?: string };

/**
 * invalid: the request broke a rule; the message is for the player.
 * not_found: no such table, either because there never was one or, with `putAway`, because it was put away.
 * unauthorized: the id and token don't match a member.
 * busy: the table could not be locked in time; try again.
 * stale: the page is from another build of the game than the server, and has to be loaded again.
 * internal: a bug or an outage.
 */
export type ErrorCode = 'invalid' | 'not_found' | 'unauthorized' | 'busy' | 'stale' | 'internal';

export interface ApiError {
  ok: false;
  code: ErrorCode;
  error: string;
  /** On `not_found` only: there was such a table, and it was put away after going too long without play. */
  putAway?: true;
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
  | { ok: true; kind: 'history'; hands: HandRecord[] }
  | { ok: true; kind: 'presets'; presets: Preset[] }
  | { ok: true; kind: 'reported' }
  | { ok: true; kind: 'players'; players: KnownPlayer[] };
