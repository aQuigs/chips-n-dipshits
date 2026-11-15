import { listedLike } from '../engine/names.ts';
import type { ApiRequest, ApiResponse } from '../server/api.ts';

/** A join or a new table as a form asks for it, before it has a key. */
export type Arrival = Omit<Extract<ApiRequest, { op: 'create' }>, 'key'> | Omit<Extract<ApiRequest, { op: 'join' }>, 'key'>;

// One symbol to a byte, six bits of it: 22 make 132 bits, as hard to guess as a member's token
const KEY_LENGTH = 22;
const SYMBOLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** No answer, or one that says to try again: the server may have let the arrival in before something went wrong. */
const unanswered = (response: ApiResponse | null): boolean => !response || (!response.ok && (response.code === 'busy' || response.code === 'internal'));

/**
 * Whether the visitor asking `later` may be the player `earlier` made: `earlier` was for someone new,
 * and `later` is the same but for saying they are a player on the list, one whose name reads like the
 * name `earlier` gave. The list refuses a new name that reads like one it has, so that player is either
 * the one `earlier` made or was there before it, and then `earlier` was never let in.
 */
function mayBeBy(earlier: Arrival, later: Arrival): boolean {
  const rest = (arrival: Arrival) => JSON.stringify({ ...arrival, who: null, name: null });

  return earlier.who?.as === 'new' && later.who?.as === 'known' && listedLike([later], earlier.name) !== null && rest(earlier) === rest(later);
}

/**
 * The page's joins and new tables. Each goes to the server under a key, and one that got no answer
 * goes again under the same key, which the server answers with the member the first asking made: an
 * arrival whose answer was lost can be tried again without arriving twice. One asked in other words,
 * another name or another pick, is another arrival with a key of its own.
 *
 * While an arrival has no answer its key is as good as the member's token. So it is held here, in the
 * page's memory, and nowhere else: not in the address, not in what the browser remembers, not in
 * anything the page reports. A reload forgets it, and the try after that is a new arrival.
 */
export class Arrivals {
  private readonly random: (bytes: number) => Uint8Array;
  private readonly send: (request: ApiRequest) => Promise<ApiResponse | null>;
  private held: { arrival: Arrival; words: string; key: string } | null = null;

  /** `random` gives that many bytes nobody could guess: the browser's own, never `Math.random`. */
  constructor(random: (bytes: number) => Uint8Array, send: (request: ApiRequest) => Promise<ApiResponse | null>) {
    this.random = random;
    this.send = send;
  }

  /**
   * Asks the server for this arrival. A visitor whose arrival got no answer finds their own name on the
   * list, where that arrival put it, and is right to say that is them: so the arrival without an
   * answer is asked again first, and only when the server turns it down, which says it was never let
   * in, is this one asked.
   */
  async ask(arrival: Arrival): Promise<ApiResponse | null> {
    const earlier = this.held?.arrival;

    if (earlier && mayBeBy(earlier, arrival)) {
      const response = await this.asked(earlier);

      if (response?.ok || unanswered(response)) {
        return response;
      }
    }

    return this.asked(arrival);
  }

  private async asked(arrival: Arrival): Promise<ApiResponse | null> {
    const words = JSON.stringify(arrival);

    if (this.held?.words !== words) {
      this.held = { arrival, words, key: [...this.random(KEY_LENGTH)].map((byte) => SYMBOLS[byte & 63]).join('') };
    }

    const { key } = this.held;
    const response = await this.send({ ...arrival, key });

    // The key is given up for the arrival it answers, and not for one asked in other words since
    if (!unanswered(response) && this.held?.key === key) {
      this.held = null;
    }

    return response;
  }
}
