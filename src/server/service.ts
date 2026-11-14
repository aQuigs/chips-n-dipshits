import { addMember, applyCommand, createTable, GameError, randomId, tick, viewFor } from '../engine/index.ts';
import type { Command, Ctx, Rng, TableState } from '../engine/index.ts';
import type { ApiResponse, Auth, ErrorCode } from './api.ts';
import { StoreBusyError } from './store.ts';
import type { TableStore } from './store.ts';

export interface Clock {
  now(): number;
}

export interface ServiceDeps {
  store: TableStore;
  clock: Clock;
  rng: Rng;
}

const TABLE_ID_LENGTH = 6;

// Checked before an id goes anywhere near storage, which has limits on what a key may be
const TABLE_ID_PATTERN = new RegExp(`^[A-Z0-9]{${TABLE_ID_LENGTH}}$`);
const CREATE_ATTEMPTS = 5;
const HISTORY_LIMIT = 30;

/** A poll that may be kept open: until the table moves on from `since`, or for `ms` at most. */
export interface PollWait {
  tableId: string;
  since: number;
  ms: number;
}

/** A request that can't be served, with the code the caller should react to. */
export class ApiFailure extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
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
    throw noSuchTable();
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

function authenticate(state: TableState, auth: Auth): void {
  const member = state.members.find((m) => m.id === auth.id);

  if (!member || member.token !== auth.token) {
    throw new ApiFailure('unauthorized', 'This browser is not a member of the table; join again from the link');
  }
}

function noSuchTable(): ApiFailure {
  return new ApiFailure('not_found', 'That table does not exist');
}

/**
 * Serves every request the game's clients make. It knows nothing about HTTP, Apps Script or Sheets:
 * hosts hand it a decoded request, and storage, time and randomness come in through interfaces.
 * No call ever waits, so a host that wants long polling asks `hasNews` until it is worth calling `handle`.
 */
export class PokerService {
  private readonly store: TableStore;
  private readonly clock: Clock;
  private readonly rng: Rng;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.rng = deps.rng;
  }

  /** Answers one request. Rule violations and bad requests come back as error responses; only bugs and outages throw. */
  handle(request: unknown): ApiResponse {
    try {
      return this.route(fieldsOf(request));
    } catch (error) {
      if (error instanceof GameError) {
        return { ok: false, code: 'invalid', error: error.message };
      }

      if (error instanceof ApiFailure) {
        return { ok: false, code: error.code, error: error.message };
      }

      if (error instanceof StoreBusyError) {
        return { ok: false, code: 'busy', error: error.message };
      }

      throw error;
    }
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

  private route(request: Fields): ApiResponse {
    switch (request.op) {
      case 'create':
        return this.create(request);
      case 'info':
        return this.info(tableIdOf(request));
      case 'join':
        return this.join(tableIdOf(request), request.name);
      case 'poll':
        return this.poll(tableIdOf(request), authOf(request), request.since);
      case 'act':
        return this.act(tableIdOf(request), authOf(request), request.command as Command);
      case 'history':
        return this.history(tableIdOf(request), authOf(request));
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
        throw noSuchTable();
      }

      const ctx = this.ctx();
      tick(state, ctx);
      state.version += 1;

      return { save: state, effects: ctx.effects, result: change(state, ctx) };
    });
  }

  private create(request: Fields): ApiResponse {
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      const tableId = randomId(this.rng, TABLE_ID_LENGTH);

      const created = this.store.transact(tableId, (existing) => {
        if (existing) {
          return { save: null, effects: [], result: null };
        }

        const ctx = this.ctx();
        const { state, host } = createTable(tableId, request.name, request.config, ctx);
        state.version = 1;

        const auth: Auth = { id: host.id, token: host.token };

        return { save: state, effects: ctx.effects, result: { auth, view: viewFor(state, host.id, ctx.now) } };
      });

      if (created) {
        return { ok: true, kind: 'joined', ...created };
      }
    }

    throw new Error(`No free table id after ${CREATE_ATTEMPTS} attempts`);
  }

  private info(tableId: string): ApiResponse {
    const state = this.store.read(tableId);
    if (!state) {
      throw noSuchTable();
    }

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
        players,
      },
    };
  }

  private join(tableId: string, name: unknown): ApiResponse {
    return this.mutate(tableId, (state, ctx) => {
      const member = addMember(state, name, ctx);

      return { ok: true, kind: 'joined', auth: { id: member.id, token: member.token }, view: viewFor(state, member.id, ctx.now) };
    });
  }

  private poll(tableId: string, auth: Auth, since: unknown): ApiResponse {
    const now = this.clock.now();
    const peek = this.store.peek(tableId);
    if (!peek) {
      throw noSuchTable();
    }

    // Nothing runs in the background, so whoever polls first after a deadline is the one who applies it
    if (peek.wakeAt !== null && peek.wakeAt <= now) {
      this.advance(tableId);
    }

    const state = this.store.read(tableId);
    if (!state) {
      throw noSuchTable();
    }

    authenticate(state, auth);

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

      return { save: state, effects: ctx.effects, result: null };
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
    const state = this.store.read(tableId);
    if (!state) {
      throw noSuchTable();
    }

    authenticate(state, auth);

    return { ok: true, kind: 'history', hands: this.store.recentHands(tableId, HISTORY_LIMIT) };
  }
}
