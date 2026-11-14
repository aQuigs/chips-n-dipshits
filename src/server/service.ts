import { addMember, applyCommand, createTable, GameError, listedLike, playerName, presetName, presetSettings, randomId, requireLevel, setIdentity, sharedPreset, tick, UNITS, viewFor } from '../engine/index.ts';
import type { Arriving, Command, Ctx, Member, Preset, Rng, TableState, Unit } from '../engine/index.ts';
import { HISTORY_LIMIT } from './api.ts';
import type { ApiResponse, Auth, ErrorCode, Joined, UnitStandings, Who } from './api.ts';
import { NOWHERE } from './errorLog.ts';
import type { ErrorLog, Failure } from './errorLog.ts';
import { isPlayerId, NameOnList } from './playerStore.ts';
import type { PlayerStore } from './playerStore.ts';
import type { PresetStore } from './presetStore.ts';
import { PUT_AWAY_MESSAGE } from './putAway.ts';
import type { LastWords } from './putAway.ts';
import { NO_RESULTS } from './resultStore.ts';
import type { ResultStore } from './resultStore.ts';
import { StoreBusyError } from './store.ts';
import type { TableStore } from './store.ts';

export interface Clock {
  now(): number;
}

export interface ServiceDeps {
  store: TableStore;
  presets: PresetStore;
  players: PlayerStore;
  /** Where the players' records over time are read from; the store of tables is what writes them. Left out, nobody's record is kept. */
  results?: ResultStore;
  clock: Clock;
  rng: Rng;
  /** Where failures the game carries on through are written down. Left out, only Apps Script's own log hears of them. */
  errors?: ErrorLog;
}

const TABLE_ID_LENGTH = 6;

// Checked before an id goes anywhere near storage, which has limits on what a key may be
const TABLE_ID_PATTERN = new RegExp(`^[A-Z0-9]{${TABLE_ID_LENGTH}}$`);
const CREATE_ATTEMPTS = 5;

/** A poll that may be kept open: until the table moves on from `since`, or for `ms` at most. */
export interface PollWait {
  tableId: string;
  since: number;
  ms: number;
}

/** A request that can't be served, with the code the caller should react to. */
export class ApiFailure extends Error {
  readonly code: ErrorCode;
  /** The table asked for was put away, which a page tells its player in its own words. */
  readonly putAway: boolean;

  constructor(code: ErrorCode, message: string, putAway = false) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.putAway = putAway;
  }
}

type Fields = Record<string, unknown>;

function fieldsOf(value: unknown): Fields {
  if (typeof value !== 'object' || value === null) {
    throw new ApiFailure('invalid', 'Malformed request');
  }

  return value as Fields;
}

/** The id as tables are stored under, or null when no table could have one like it. */
function wellFormedTableId(typed: string): string | null {
  const id = typed.trim().toUpperCase();

  return TABLE_ID_PATTERN.test(id) ? id : null;
}

function tableIdOf(request: Fields): string {
  if (typeof request.tableId !== 'string' || request.tableId.length === 0) {
    throw new ApiFailure('invalid', 'The request names no table');
  }

  const id = wellFormedTableId(request.tableId);
  if (id === null) {
    throw new ApiFailure('not_found', NO_SUCH_TABLE);
  }

  return id;
}

function authOf(request: Fields): Auth {
  const auth = fieldsOf(request.auth);
  if (typeof auth.id !== 'string' || typeof auth.token !== 'string') {
    throw new ApiFailure('unauthorized', 'The request does not say who it is from');
  }

  return { id: auth.id, token: auth.token };
}

function authenticate(state: TableState, auth: Auth): Member {
  const member = state.members.find((m) => m.id === auth.id);

  if (!member || member.token !== auth.token) {
    throw new ApiFailure('unauthorized', 'This browser is not a member of the table; join again from the link');
  }

  return member;
}

/** What a request says of who its sender is on the list of players, or null when it says nothing. */
function whoOf(request: Fields): Who | null {
  if (request.who === undefined || request.who === null) {
    return null;
  }

  const who = fieldsOf(request.who);

  if (who.as === 'new') {
    return { as: 'new' };
  }

  if (who.as === 'known' && typeof who.id === 'string') {
    return { as: 'known', id: who.id };
  }

  throw new ApiFailure('invalid', 'Malformed request');
}

/** Someone about to become a member of a table: what they are called there, and who the list of players says they are. */
interface Arrival extends Arriving {
  name: unknown;
  /** Someone new, for the list of players to hear of once the table has let them in. */
  enlist: boolean;
}


/** Anyone with the game's address may list the presets, so they are handed out holding only what presets keep. */
function presetsAnswer(presets: Preset[]): ApiResponse {
  return { ok: true, kind: 'presets', presets: presets.map(sharedPreset) };
}

const NO_SUCH_TABLE = 'That table does not exist';

/** The store has no table under this id. Whether it was put away is found out in one place, `answer`. */
class NoSuchTable extends ApiFailure {
  readonly tableId: string;

  constructor(tableId: string) {
    super('not_found', NO_SUCH_TABLE);
    this.tableId = tableId;
  }
}

/**
 * A failure in answering a request, for the log: where is the operation, when it is one this code
 * could have known, and the table is the one the request names, when it is a table's id.
 */
export function failureOf(request: unknown, error: unknown): Failure {
  const { op, tableId } = (typeof request === 'object' && request !== null ? request : {}) as Fields;

  return {
    where: typeof op === 'string' && /^[A-Za-z]{1,20}$/.test(op) ? `server ${op}` : 'server',
    error,
    tableId: typeof tableId === 'string' ? wellFormedTableId(tableId) : null,
  };
}

/**
 * A table that is put away has had its last night, ended or not, and says so: that is what has its
 * results written as they finally stand, the way the end of a night does.
 */
export const LAST_WORDS: LastWords = (state, at) => [{ type: 'nightEnded', night: { at, tableId: state.id } }];

/**
 * Serves every request the game's clients make. It knows nothing about HTTP, Apps Script or Sheets:
 * hosts hand it a decoded request, and storage, time and randomness come in through interfaces.
 * No call ever waits, so a host that wants long polling asks `hasNews` until it is worth calling `handle`.
 */
export class PokerService {
  private readonly store: TableStore;
  private readonly presets: PresetStore;
  private readonly players: PlayerStore;
  private readonly results: ResultStore;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly errors: ErrorLog;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.presets = deps.presets;
    this.players = deps.players;
    this.results = deps.results ?? NO_RESULTS;
    this.clock = deps.clock;
    this.rng = deps.rng;
    this.errors = deps.errors ?? NOWHERE;
  }

  /** Answers one request. Rule violations and bad requests come back as error responses; only bugs and outages throw. */
  handle(request: unknown): ApiResponse {
    try {
      return this.answer(fieldsOf(request));
    } catch (error) {
      if (error instanceof GameError) {
        return { ok: false, code: 'invalid', error: error.message };
      }

      if (error instanceof ApiFailure) {
        return { ok: false, code: error.code, error: error.message, ...(error.putAway ? { putAway: true } : {}) };
      }

      // The commonest failure of the live game, and the player is asked to try again: the answer stands, and the log hears of it
      if (error instanceof StoreBusyError) {
        this.failed(failureOf(request, `The lock was not free in time: ${error.message}`));

        return { ok: false, code: 'busy', error: error.message };
      }

      this.failed(failureOf(request, error));
      throw error;
    }
  }

  /** Tells Apps Script's own log and the error log of something that went wrong. */
  private failed(failure: Failure): void {
    console.error(failure.where, failure.error);
    this.errors.report(failure);
  }

  /**
   * The wait a host may give this request before handing it to `handle`, or null when it gets none.
   * Only a poll from a member of the table is worth holding. Anyone else is answered at once, so a
   * stranger who knows a table code can't tie up the few requests a host serves at a time.
   */
  waitFor(request: unknown): PollWait | null {
    try {
      const fields = fieldsOf(request);
      const { op, since, holdMs } = fields;
      if (op !== 'poll' || typeof since !== 'number' || typeof holdMs !== 'number' || !(holdMs > 0)) {
        return null;
      }

      const tableId = tableIdOf(fields);
      const state = this.store.read(tableId);
      if (!state) {
        return null;
      }

      authenticate(state, authOf(fields));

      return { tableId, since, ms: holdMs };
    } catch (error) {
      if (error instanceof ApiFailure) {
        return null;
      }

      throw error;
    }
  }

  /** Whether a poll that already has version `since` of a table would get anything back. */
  hasNews(tableId: string, since: number): boolean {
    const id = wellFormedTableId(tableId);
    const peek = id === null ? null : this.store.peek(id);

    return !peek || peek.version !== since || (peek.wakeAt !== null && peek.wakeAt <= this.clock.now());
  }

  /**
   * The answer to a request, with one failure looked into: of a table that isn't there, whether it was
   * put away. Asked here, when the request holds no lock any more, since the store may take one to find out.
   */
  private answer(request: Fields): ApiResponse {
    try {
      return this.route(request);
    } catch (error) {
      if (error instanceof NoSuchTable && this.store.wasPutAway(error.tableId)) {
        throw new ApiFailure('not_found', PUT_AWAY_MESSAGE, true);
      }

      throw error;
    }
  }

  private route(request: Fields): ApiResponse {
    switch (request.op) {
      case 'create':
        return this.create(request);
      case 'info':
        return this.info(tableIdOf(request));
      case 'join':
        return this.join(tableIdOf(request), request);
      case 'poll':
        return this.poll(tableIdOf(request), authOf(request), request.since);
      case 'act':
        return this.act(tableIdOf(request), authOf(request), request.command as Command);
      case 'history':
        return this.history(tableIdOf(request), authOf(request));
      case 'presets':
        return this.listPresets();
      case 'savePreset':
        return this.savePreset(tableIdOf(request), authOf(request), request);
      case 'deletePreset':
        return this.deletePreset(tableIdOf(request), authOf(request), request.name);
      case 'report':
        return this.reportFromPage(tableIdOf(request), authOf(request), request);
      case 'players':
        return { ok: true, kind: 'players', players: this.players.list() };
      case 'identify':
        return this.identify(tableIdOf(request), authOf(request), request);
      case 'standings':
        return this.standings();
      case 'nights':
        return this.nights(request);
      default:
        throw new ApiFailure('invalid', 'Unknown request');
    }
  }

  private ctx(): Ctx {
    return { now: this.clock.now(), rng: this.rng, effects: [] };
  }

  /** Changes a table under its lock. Time is brought up to date first, so the change sees the table as it is now. */
  private mutate<T>(tableId: string, change: (state: TableState, ctx: Ctx) => T): T {
    return this.store.transact(tableId, (state) => {
      if (!state) {
        throw new NoSuchTable(tableId);
      }

      const ctx = this.ctx();
      tick(state, ctx);
      state.version += 1;

      return { save: state, at: ctx.now, effects: ctx.effects, result: change(state, ctx) };
    });
  }

  /**
   * Puts away the tables nobody has changed for a long time. The one place it is asked for, so that
   * whatever else comes to ask does it the same way. It rides on a request a player made for something
   * else, which nothing that goes wrong here may fail.
   */
  private putAwayOldTables(): void {
    try {
      this.store.putAwayOld(this.clock.now(), LAST_WORDS);
    } catch (error) {
      this.failed({ where: 'server put away', error });
    }
  }

  /**
   * Has the results written of tables whose night nobody ended, before they are read. Like putting
   * tables away it rides on a request made for something else, which nothing that goes wrong here may fail.
   */
  private settleIdleTables(): void {
    try {
      this.store.settleIdle(this.clock.now());
    } catch (error) {
      this.failed({ where: 'server settle results', error });
    }
  }

  /**
   * Who is arriving at a table, from what their request says of it. Being known is only a label, so
   * nothing here stops a game: when the list of players can't be asked, or has no such player, they
   * arrive all the same, as nobody it knows. Only a name is refused: a new one that the list already
   * has, since its holder may be the one asking.
   */
  private arrival(request: Fields, tableId: string | null): Arrival {
    const who = whoOf(request);

    if (!who) {
      return { name: request.name, identity: null, keepsName: false, enlist: false };
    }

    if (who.as === 'known') {
      const known = this.without('server find player', tableId, () => this.players.seen(who.id, this.clock.now()));

      // The name is the list's whether or not the list could say so, and not the player's to change
      return { name: known?.name ?? request.name, identity: known?.id ?? null, keepsName: true, enlist: false };
    }

    const name = playerName(request.name);
    this.refuseNameOnList(name, tableId);

    return { name, identity: null, keepsName: false, enlist: true };
  }

  /**
   * A step an arrival goes ahead without: what it gives, or null when it could not be done. The error
   * log hears of a failure, and never of an answer, such as a list that is full.
   */
  private without<T>(where: string, tableId: string | null, step: () => T): T | null {
    try {
      return step();
    } catch (error) {
      if (!(error instanceof GameError || error instanceof ApiFailure)) {
        this.failed({ where, error, tableId });
      }

      return null;
    }
  }

  /**
   * Puts a member who came in as someone new on the list of players, and has their table say who they
   * are. The table lets them in first, so that nobody is on the list for an arrival that came to
   * nothing, and a request sent again after one finds no name of its own in the way. Whatever goes
   * wrong here, they are in, as nobody the list knows.
   */
  private enlisted(tableId: string, joined: Joined): ApiResponse {
    const { id } = joined.auth;

    const added = this.without('server add player', tableId, () => this.players.add(joined.view.you.name, this.clock.now()));
    if (!added) {
      return joined;
    }

    const told = this.without('server tell table who', tableId, () =>
      this.mutate(tableId, (state, ctx) => {
        setIdentity(state, id, added, ctx);

        return { ...joined, view: viewFor(state, id, ctx.now) };
      }),
    );

    return told ?? joined;
  }

  /**
   * Turns away a name for someone new that the list has, before the table has its say: where both
   * have the name, "pick yourself from the list" is the answer that gets its holder in. A list that
   * can't be read turns nobody away.
   */
  private refuseNameOnList(name: string, tableId: string | null): void {
    const holder = this.without('server check name', tableId, () => listedLike(this.players.list(), name));

    if (holder) {
      throw new NameOnList(holder.name);
    }
  }

  private create(request: Fields): ApiResponse {
    const arriving = this.arrival(request, null);

    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      const tableId = randomId(this.rng, TABLE_ID_LENGTH);

      const created = this.store.transact(tableId, (existing) => {
        if (existing) {
          return { save: null, effects: [], result: null };
        }

        const ctx = this.ctx();
        const { state, host } = createTable(tableId, arriving.name, request.config, ctx, arriving);
        state.version = 1;

        const auth: Auth = { id: host.id, token: host.token };

        return { save: state, at: ctx.now, effects: ctx.effects, result: { auth, view: viewFor(state, host.id, ctx.now) } };
      });

      if (created) {
        // A new table is rare and already a write to the store, so it is when the old ones are seen to
        this.putAwayOldTables();

        const joined: Joined = { ok: true, kind: 'joined', ...created };

        return arriving.enlist ? this.enlisted(tableId, joined) : joined;
      }
    }

    throw new Error(`No free table id after ${CREATE_ATTEMPTS} attempts`);
  }

  private info(tableId: string): ApiResponse {
    const state = this.tableAt(tableId);
    const players = state.seats.flatMap((seat) => (seat ? [state.members.find((m) => m.id === seat.playerId)!.name] : []));

    return {
      ok: true,
      kind: 'info',
      table: {
        id: state.id,
        name: state.config.name,
        unit: state.config.unit,
        smallBlind: state.config.smallBlind,
        bigBlind: state.config.bigBlind,
        ante: state.config.ante,
        anteFrom: state.config.anteFrom,
        bounties: state.config.bounties,
        players,
      },
    };
  }

  private join(tableId: string, request: Fields): ApiResponse {
    const arriving = this.arrival(request, tableId);

    const joined = this.mutate(tableId, (state, ctx): Joined => {
      const member = addMember(state, arriving.name, ctx, arriving);

      return { ok: true, kind: 'joined', auth: { id: member.id, token: member.token }, view: viewFor(state, member.id, ctx.now) };
    });

    return arriving.enlist ? this.enlisted(tableId, joined) : joined;
  }

  private poll(tableId: string, auth: Auth, since: unknown): ApiResponse {
    const now = this.clock.now();
    const peek = this.store.peek(tableId);
    if (!peek) {
      throw new NoSuchTable(tableId);
    }

    // Nothing runs in the background, so whoever polls first after a deadline is the one who applies it
    if (peek.wakeAt !== null && peek.wakeAt <= now) {
      this.advance(tableId);
    }

    const { state } = this.memberOf(tableId, auth);

    if (state.version === since) {
      return { ok: true, kind: 'unchanged', now };
    }

    return { ok: true, kind: 'view', view: viewFor(state, auth.id, now) };
  }

  /** Applies whatever came due on a table, saving only if something actually changed. */
  private advance(tableId: string): void {
    this.store.transact(tableId, (state) => {
      const ctx = this.ctx();

      if (!state || !tick(state, ctx)) {
        return { save: null, effects: [], result: null };
      }

      state.version += 1;

      return { save: state, at: ctx.now, effects: ctx.effects, result: null };
    });
  }

  private act(tableId: string, auth: Auth, command: Command): ApiResponse {
    return this.mutate(tableId, (state, ctx) => {
      authenticate(state, auth);
      applyCommand(state, ctx, auth.id, command);

      return { ok: true, kind: 'view', view: viewFor(state, auth.id, ctx.now) };
    });
  }

  private history(tableId: string, auth: Auth): ApiResponse {
    this.memberOf(tableId, auth);

    return { ok: true, kind: 'history', hands: this.store.recentHands(tableId, HISTORY_LIMIT) };
  }

  private listPresets(): ApiResponse {
    return presetsAnswer(this.presets.list());
  }

  private savePreset(tableId: string, auth: Auth, request: Fields): ApiResponse {
    const member = this.hostOrCohost(tableId, auth);

    return presetsAnswer(this.presets.save({ name: presetName(request.name), settings: presetSettings(request.settings), savedAt: this.clock.now(), savedBy: member.name }, request.replace === true));
  }

  private deletePreset(tableId: string, auth: Auth, name: unknown): ApiResponse {
    this.hostOrCohost(tableId, auth);

    return presetsAnswer(this.presets.delete(presetName(name)));
  }

  /**
   * A failure a member's page saw. Only a member may write to the log, which anyone with the game's
   * address could otherwise fill; the log holds each to its limits. The answer is the same whatever the
   * log does with it.
   */
  private reportFromPage(tableId: string, auth: Auth, request: Fields): ApiResponse {
    const { member } = this.memberOf(tableId, auth);
    const error = { message: request.message, stack: request.trace };

    this.errors.report({ where: 'page', error, tableId, page: { memberId: member.id, build: request.build, browser: request.browser } });

    return { ok: true, kind: 'reported' };
  }

  /**
   * A member says who they are on the list of players, after joining: someone on it, or someone new
   * under the name given or else the one they go by here. It is the whole of what was asked, so unlike
   * an arrival it is refused when the list can't oblige.
   */
  private identify(tableId: string, auth: Auth, request: Fields): ApiResponse {
    const { member } = this.memberOf(tableId, auth);
    const who = whoOf(request);
    const now = this.clock.now();

    if (!who) {
      throw new ApiFailure('invalid', 'The request does not say who you are');
    }

    const known = who.as === 'known' ? this.players.seen(who.id, now) : this.players.add(playerName(request.name ?? member.name), now);
    if (!known) {
      throw new GameError('That player is no longer on the list. Pick again');
    }

    return this.mutate(tableId, (state, ctx) => {
      authenticate(state, auth);
      setIdentity(state, auth.id, known, ctx);

      return { ok: true, kind: 'view', view: viewFor(state, auth.id, ctx.now) };
    });
  }

  /**
   * Every known player's record. Anyone with the game's address may ask, as for the list of players,
   * so it holds what the page shows and no more: a player by the id and name the list hands out
   * anyway, and nothing of a table. Someone taken off the list is in no answer, whatever is kept of them.
   */
  private standings(): ApiResponse {
    this.settleIdleTables();

    const names = new Map(this.players.list().map((player) => [player.id, player.name]));
    const { asOf, records } = this.results.standings();

    const units = UNITS.flatMap((unit): UnitStandings[] => {
      const players = records[unit].flatMap((record) => (names.has(record.id) ? [{ ...record, name: names.get(record.id)! }] : []));

      return players.length > 0 ? [{ unit, players }] : [];
    });

    return { ok: true, kind: 'standings', asOf, units };
  }

  private nights(request: Fields): ApiResponse {
    const { playerId, unit } = request;

    if (typeof playerId !== 'string' || !isPlayerId(playerId) || !UNITS.includes(unit as Unit)) {
      throw new ApiFailure('invalid', 'Malformed request');
    }

    const listed = this.players.list().some((player) => player.id === playerId);

    return { ok: true, kind: 'nights', nights: listed ? this.results.nights(playerId, unit as Unit) : [] };
  }

  private tableAt(tableId: string): TableState {
    const state = this.store.read(tableId);
    if (!state) {
      throw new NoSuchTable(tableId);
    }

    return state;
  }

  private memberOf(tableId: string, auth: Auth): { state: TableState; member: Member } {
    const state = this.tableAt(tableId);

    return { state, member: authenticate(state, auth) };
  }

  /** Presets are the group's, so changing one is for whoever runs a table, as they would run its settings. */
  private hostOrCohost(tableId: string, auth: Auth): Member {
    const { state, member } = this.memberOf(tableId, auth);

    requireLevel(state, member.id, 'host or cohost');

    return member;
  }
}
