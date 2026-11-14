import type { Command } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';
import type { ApiError, ApiRequest, ApiResponse, Auth, Built } from '../server/api.ts';
import type { Transport } from './transport.ts';

// How long the server may sit on a poll before answering "nothing new"
const HOLD_MS = 20_000;

// A server that can't hold a poll answers at once, so those are spaced out instead
const QUICK_POLL_GAP_MS = 1200;

// Longer than any answer takes. Past this a request is taken for lost, as happens when a phone sleeps mid-request
const REQUEST_TIMEOUT_MS = 30_000;

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 10_000;

// How many of the latest answers the server's clock is judged from
const CLOCK_SAMPLES = 8;

// A move in the hand. Only one may be on its way at a time, and it must not be repeated on a guess
const MOVES = new Set<Command['type']>(['fold', 'check', 'call', 'raise', 'ritVote']);

/** Why the table isn't being heard from: no answer at all, or an answer saying the server couldn't cope. */
export type Trouble = 'unreachable' | 'struggling';

/**
 * Whether the buttons that play a move can be pressed. `sent` is a move on its way. `unanswered` is a
 * move that got no answer, so nobody knows yet whether it was played; the table has to be heard from first.
 */
type TurnLock = 'open' | 'sent' | 'unanswered';

/**
 * taken: the table carried the command out.
 * refused: it did not, and has said why (or the command was never sent).
 * unanswered: no answer came back, so it may or may not have been carried out.
 */
export type SendOutcome = 'taken' | 'refused' | 'unanswered';

/** A member at a table. */
export interface Session {
  tableId: string;
  auth: Auth;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nextRetry(last: number): number {
  return Math.min(MAX_RETRY_MS, last ? last * 2 : FIRST_RETRY_MS);
}

/** The server has said this member or table isn't there, as opposed to not having managed to answer. */
export function isRefusal(response: ApiResponse | null): response is ApiError {
  return response !== null && !response.ok && (response.code === 'unauthorized' || response.code === 'not_found');
}

/**
 * The page's one line to the server: every request it makes goes out here with the page's build on it,
 * and every answer comes back with the server's. An answer from another build means the game was
 * updated after this page was loaded, so the page may no longer understand what the server says or
 * what its own buttons would do. From then on nothing more is sent, and whoever is waiting for an
 * answer, then or later, is left waiting: nothing goes on to draw the answer, try again, or take a
 * refusal in it for the player's seat being gone.
 */
export class ServerLine {
  private readonly transport: Transport;
  private readonly build: string;
  private readonly onOutdated: () => void;

  /** The server has answered as another build than this page is. It stays so until the page is loaded again. */
  outdated = false;

  /** `onOutdated` is called once, when the first answer from another build arrives. */
  constructor(transport: Transport, build: string, onOutdated: () => void) {
    this.transport = transport;
    this.build = build;
    this.onOutdated = onOutdated;
  }

  /** One request; null when the server could not be reached, or took so long that the request must be lost. */
  async ask(request: ApiRequest): Promise<ApiResponse | null> {
    const response = this.outdated ? null : await this.answerTo(request);

    if (response && response.build !== this.build && !this.outdated) {
      this.outdated = true;
      this.onOutdated();
    }

    // Checked again for the request that was on its way when the answer to another gave the update away
    return this.outdated ? new Promise(() => undefined) : response;
  }

  private async answerTo(request: ApiRequest): Promise<(ApiResponse & Built) | null> {
    const patience = REQUEST_TIMEOUT_MS + (request.op === 'poll' ? (request.holdMs ?? 0) : 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lost = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), patience);
    });

    try {
      return await Promise.race([this.transport.send({ ...request, build: this.build }), lost]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** How far the server's clock is from this device's, judged from the times its answers carry. */
export class ServerClock {
  /** Server time minus this device's time, so countdowns agree with the server's clock. */
  offset = 0;
  private samples: number[] = [];

  /**
   * An answer's time is already old by however long it took to arrive, so every sample puts the
   * server's clock a little behind. The largest of the recent ones traveled fastest and is closest,
   * which also errs toward showing a player less time than they have, never more.
   */
  note(serverNow: number): void {
    this.samples.push(serverNow - Date.now());

    if (this.samples.length > CLOCK_SAMPLES) {
      this.samples.shift();
    }

    this.offset = Math.max(...this.samples);
  }

  /** The server's time, as near as this device can tell. */
  now(): number {
    return Date.now() + this.offset;
  }
}

/** What a table's connection tells whoever is showing the table. */
export interface TableListener {
  /** A view to put on screen: newer than the one before, or older because the table itself `wentBack`. */
  view(view: TableView, wentBack: boolean): void;
  /** Whether a move can be made, or whether the table is being heard from, has changed. */
  status(): void;
  /** The server has said this member or this table is not there. */
  refused(error: ApiError): void;
  /** Something the viewer should be told. */
  notice(message: string): void;
}

/**
 * The conversation with the server about one table, as one of its members: the request that is kept
 * open for news, the commands, and which of the views that come back is the one to show. It lasts
 * until the table is left.
 */
export class TableConnection {
  readonly session: Session;
  trouble: Trouble | null = null;

  private readonly server: ServerLine;
  private readonly clock: ServerClock;
  private readonly listener: TableListener;

  /** The newest view taken up, which is the one on screen. */
  private view: TableView | null = null;
  private turnLock: TurnLock = 'open';

  /** Bumped to retire the running poll loop, when a fresh one starts or the table is left. */
  private pollRun = 0;
  private closed = false;

  constructor(server: ServerLine, session: Session, clock: ServerClock, listener: TableListener) {
    this.server = server;
    this.session = session;
    this.clock = clock;
    this.listener = listener;
  }

  /** A move is on its way or unaccounted for, so the buttons that play one must not be pressed. */
  get turnLocked(): boolean {
    return this.turnLock !== 'open';
  }

  /** Takes up a view, unless it is no newer than the one held and the table hasn't `wentBack`. */
  take(view: TableView, wentBack = false): void {
    const previous = this.view;

    // An action's answer and a poll can cross; the older picture doesn't replace the newer one
    if (previous && view.version <= previous.version && !wentBack) {
      return;
    }

    this.clock.note(view.now);
    this.view = view;
    this.listener.view(view, wentBack);
  }

  /**
   * Retires the request that is waiting on the server and asks afresh, so the table is current right
   * away. `whole` asks for the table whether or not it has changed, for when what is on screen is in doubt.
   */
  refresh(whole = false): void {
    this.pollRun += 1;
    void this.poll(this.pollRun, whole);
  }

  /** The table has been left: nothing that is still on its way is acted on. */
  close(): void {
    this.closed = true;
    this.pollRun += 1;
  }

  async send(command: Command): Promise<SendOutcome> {
    const { tableId, auth } = this.session;
    const move = MOVES.has(command.type);

    if (move) {
      // A second tap while the first move is on its way would be a second move
      if (this.turnLock !== 'open') {
        return 'refused';
      }

      this.setTurnLock('sent');
    }

    const response = await this.server.ask({ op: 'act', tableId, auth, command });

    if (this.closed) {
      return 'unanswered';
    }

    if (!response) {
      // It may have been carried out all the same. Rather than invite a second try on a guess, ask the table what happened
      if (move) {
        this.setTurnLock('unanswered');
      }

      this.listener.notice(`No answer from the table. Checking whether that ${move ? 'was played' : 'went through'}…`);
      this.refresh(true);
      return 'unanswered';
    }

    if (move) {
      this.setTurnLock('open');
    }

    if (!response.ok) {
      this.fail(response);
    } else if (response.kind === 'view') {
      this.take(response.view);
    }

    return response.ok ? 'taken' : 'refused';
  }

  private fail(error: ApiError): void {
    if (error.code === 'unauthorized' || error.code === 'not_found') {
      this.listener.refused(error);
    } else {
      this.listener.notice(error.error);
    }
  }

  private async poll(run: number, whole: boolean): Promise<void> {
    const { tableId, auth } = this.session;
    let retryIn = 0;

    while (run === this.pollRun) {
      const asked = Date.now();
      const held = this.view?.version ?? -1;
      const response = await this.server.ask({ op: 'poll', tableId, auth, since: whole ? -1 : held, holdMs: HOLD_MS });

      if (run !== this.pollRun) {
        return;
      }

      if (isRefusal(response)) {
        this.listener.refused(response);
        return;
      }

      if (!response || !response.ok) {
        retryIn = nextRetry(retryIn);
        this.setTrouble(response ? 'struggling' : 'unreachable');
        await sleep(retryIn);
        continue;
      }

      retryIn = 0;
      whole = false;
      this.setTrouble(null);

      // The table has been heard from since the move that got no answer, so the screen can be trusted again
      if (this.turnLock === 'unanswered') {
        this.setTurnLock('open');
      }

      if (response.kind === 'view') {
        // The server answered after this page already held `held`, so a version below that is no late
        // arrival: the table itself has gone back, as after a restore of the Sheet, and the server is right.
        // Anything from `held` up to what is showing was only overtaken by the answer to a move or a chat line
        this.take(response.view, response.view.version < held);
      } else if (response.kind === 'unchanged') {
        this.clock.note(response.now);

        if (Date.now() - asked < QUICK_POLL_GAP_MS) {
          await sleep(QUICK_POLL_GAP_MS);
        }
      }
    }
  }

  private setTurnLock(lock: TurnLock): void {
    this.turnLock = lock;
    this.listener.status();
  }

  private setTrouble(trouble: Trouble | null): void {
    if (trouble !== this.trouble) {
      this.trouble = trouble;
      this.listener.status();
    }
  }
}
