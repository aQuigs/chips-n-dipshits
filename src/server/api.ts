import type { Bounty, Command, HandRecord, KnownPlayer, Preset, Stakes, TableConfig, TableView, Unit } from '../engine/index.ts';
import type { PlayedNight, PlayerRecord } from './resultStore.ts';

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

/** How many of a table's latest hands its history holds: what a page can open, and so all it has any use remembering of them. */
export const HISTORY_LIMIT = 30;

/** The most a page sends of a failure's message and of its trace. */
export const REPORTED_MESSAGE_LENGTH = 500;
export const REPORTED_TRACE_LENGTH = 3000;

/**
 * How long a table goes unsaved before its results are kept without its night having been ended,
 * which is how most nights among friends end: everyone closes the tab. Longer than any break, and
 * short enough that last night is on record by morning. A table played on afterwards is simply
 * written again. It is here because the standings page says it.
 */
export const SETTLE_AFTER_MS = 3 * 60 * 60 * 1000;

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
   *
   * `key` is one the page makes up for this arrival and sends again with it when no answer came. Asked
   * again under its key in the same words, an arrival is answered with the member the first asking
   * made. Without one, asking twice is arriving twice.
   */
  | { op: 'create'; name: string; who?: Who; config?: Partial<TableConfig>; key?: string }
  | { op: 'info'; tableId: string }
  | { op: 'join'; tableId: string; name: string; who?: Who; key?: string }
  | {
      op: 'poll';
      tableId: string;
      auth: Auth;
      /** The version the caller already has. */
      since: number;
      /** How long the host may hold the request open waiting for something new. */
      holdMs?: number;
    }
  /** Under `key`, a command asked again is done once, and answered with the table as it stands (`src/engine/once.ts`). */
  | { op: 'act'; tableId: string; auth: Auth; command: Command; key?: string }
  | { op: 'history'; tableId: string; auth: Auth }
  | { op: 'presets' }
  /** Presets belong to the group, but only a host or co-host of a table may save one, from that table. */
  | { op: 'savePreset'; tableId: string; auth: Auth; name: string; settings: Partial<TableConfig>; replace: boolean }
  | { op: 'deletePreset'; tableId: string; auth: Auth; name: string }
  /** A failure a member's page saw, for the error log. Its answer says nothing a page acts on. */
  | { op: 'report'; tableId: string; auth: Auth; message: string; trace: string; browser: PageBrowser }
  | { op: 'players' }
  /** A member says who they are after joining. `name` is only for someone new: what the list is to call them. */
  | { op: 'identify'; tableId: string; auth: Auth; who: Who; name?: string }
  /** Every known player's record over the nights the game has kept. Like the list of players, for anyone with the game's address. */
  | { op: 'standings' }
  /** One known player's nights at tables that play one kind of money, the latest first. */
  | { op: 'nights'; playerId: string; unit: Unit };

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
  bounties: Bounty[];
  players: string[];
}

/** A known player's record with the name the list of players has for them. */
export interface PlayerStanding extends PlayerRecord {
  name: string;
}

/** The records at tables that play one kind of money: those are never added to another kind's. */
export interface UnitStandings {
  unit: Unit;
  players: PlayerStanding[];
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
  | { ok: true; kind: 'players'; players: KnownPlayer[] }
  /**
   * `asOf` is when the records were read. `units` has an entry for each kind of money somebody on the
   * list of players has a night in, so none when nobody has one. It names nobody the list does not,
   * and no table.
   */
  | { ok: true; kind: 'standings'; asOf: number; units: UnitStandings[] }
  /** A table is told by its name and when it was made, never by its id. */
  | { ok: true; kind: 'nights'; nights: PlayedNight[] };

/** The answer to someone who made a table or joined one: who they are there, and the table as they see it. */
export type Joined = Extract<ApiResponse, { kind: 'joined' }>;
