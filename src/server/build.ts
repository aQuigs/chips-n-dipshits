import type { ApiError, ApiRequest, ApiResponse, Built } from './api.ts';
import type { PokerService, PollWait } from './service.ts';

/**
 * What stands where a build id goes until a build writes one in. A page and a script that were never
 * stamped agree with each other, which is how the local server and the tests run.
 */
export const UNSTAMPED_BUILD = '__BUILD__';

/** A page from before pages named their build shows this word for word when a command of its is refused. */
export const OUTDATED_MESSAGE = 'The game was updated. Reload to keep playing.';

/**
 * Whether a page of another build may still ask this: only what changes nothing for anyone at the
 * request of the page. A new operation gets its line here.
 */
const OPEN_TO_ANOTHER_BUILD: Record<ApiRequest['op'], boolean> = {
  create: false,
  join: false,
  act: false,
  poll: true,
  info: true,
  history: true,
  presets: true,
  savePreset: false,
  deletePreset: false,
};

const STALE: ApiError = { ok: false, code: 'stale', error: OUTDATED_MESSAGE };

function fieldsOf(request: unknown): { op?: unknown; build?: unknown } {
  return typeof request === 'object' && request !== null ? request : {};
}

/**
 * The game as one build of it answers pages. Every answer says which build the server is, so a page
 * can tell that it was loaded from another one, and such a page gets nothing changed at a table: what
 * it shows the player, and what it thinks its buttons do, may no longer be what this build means.
 */
export class BuildGate {
  readonly build: string;
  private readonly service: PokerService;

  constructor(service: PokerService, build: string) {
    this.service = service;
    this.build = build;
  }

  handle(request: unknown): ApiResponse & Built {
    const response = this.turnsAway(request) ? STALE : this.service.handle(request);

    return { ...response, build: this.build };
  }

  /**
   * As the service's, for a page of this build. A page of another is answered at once: holding its poll
   * would only delay its finding out, and tie up one of the few requests a host serves at a time.
   */
  waitFor(request: unknown): PollWait | null {
    return fieldsOf(request).build === this.build ? this.service.waitFor(request) : null;
  }

  hasNews(tableId: string, since: number): boolean {
    return this.service.hasNews(tableId, since);
  }

  private turnsAway(request: unknown): boolean {
    const { op, build } = fieldsOf(request);

    if (build === this.build) {
      return false;
    }

    // A page from before pages named their build can't tell from an answer that it is out of date, and
    // would go on drawing whatever table it was sent. All it is still told is what its join screen
    // shows of a table before joining, which that screen asks again and again until it hears
    if (typeof build !== 'string') {
      return op !== 'info';
    }

    // One that names a build stops at the build on the answer, whatever else the answer holds
    return OPEN_TO_ANOTHER_BUILD[op as ApiRequest['op']] !== true;
  }
}
