import { listedLike } from '../engine/names.ts';
import type { ApiRequest, ApiResponse } from '../server/api.ts';

/** A join or a new table as a form asks for it, before it has a key. */
export type Arrival = Omit<Extract<ApiRequest, { op: 'create' }>, 'key'> | Omit<Extract<ApiRequest, { op: 'join' }>, 'key'>;

// One symbol to a byte, six bits of it: 22 make 132 bits, as hard to guess as a member's token
const KEY_LENGTH = 22;
const SYMBOLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** No answer, or one that says to try again: the server may have let the arrival in before something went wrong. */
const unanswered = (response: ApiResponse | null): boolean => !response || (!response.ok && (response.code === 'busy' || response.code === 'internal'));

/** Where an arrival is for, whoever arrives: the table joined, or the new table as it is to be set up. */
const placeOf = (arrival: Arrival): string => JSON.stringify({ ...arrival, who: null, name: null });

/**
 * Whether the visitor asking `later` may be the one who asked `earlier` at the same place, so that
 * `earlier`, let in, is them already. Either both say they are the same player on the list, whose name
 * the list has changed between the two. Or `earlier` was for someone new and `later` says they are a
 * listed player whose name reads like the name `earlier` gave: the list takes no new name that reads
 * like one it has, so that player is the one `earlier` made, unless they were there before, or the
 * list could not be read and `earlier` was let in as nobody it knows.
 *
 * Names are read as the list itself reads them, by `listedLike`, which is what it refuses a new name
 * with: a reading of the page's own would part from it over a space or a capital, and fail a visitor
 * exactly here.
 */
function mayBeBy(earlier: Arrival, later: Arrival): boolean {
  if (later.who?.as !== 'known') {
    return false;
  }

  return earlier.who?.as === 'known' ? earlier.who.id === later.who.id : earlier.who?.as === 'new' && listedLike([later], earlier.name) !== null;
}

/**
 * The page's joins and new tables. Each goes to the server under a key, and one that got no answer
 * goes again under the same key, which the server answers with the member the first asking made: an
 * arrival whose answer was lost can be tried again without arriving twice. One asked in other words,
 * another name or another pick, is another arrival with a key of its own, and takes the place of the
 * one without an answer at the same table. One asked for somewhere else leaves it be.
 *
 * While an arrival has no answer its key is as good as the member's token. So it is held here, in the
 * page's memory, and nowhere else: not in the address, not in what the browser remembers, not in
 * anything the page reports. A reload forgets it, and the try after that is a new arrival.
 */
export class Arrivals {
  private readonly random: (bytes: number) => Uint8Array;
  private readonly send: (request: ApiRequest) => Promise<ApiResponse | null>;

  /** The arrival without an answer at each place, by `placeOf`. */
  private readonly held = new Map<string, { arrival: Arrival; words: string; key: string }>();

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
    const earlier = this.held.get(placeOf(arrival))?.arrival;

    if (earlier && mayBeBy(earlier, arrival)) {
      const response = await this.asked(earlier);

      if (response?.ok || unanswered(response)) {
        return response;
      }
    }

    return this.asked(arrival);
  }

  private async asked(arrival: Arrival): Promise<ApiResponse | null> {
    const place = placeOf(arrival);
    const words = JSON.stringify(arrival);
    const before = this.held.get(place);
    const { key } = before?.words === words ? before : { key: [...this.random(KEY_LENGTH)].map((byte) => SYMBOLS[byte & 63]).join('') };

    this.held.set(place, { arrival, words, key });
    const response = await this.send({ ...arrival, key });

    // The key is given up for the arrival it answers, and not for one asked there in other words since
    if (!unanswered(response) && this.held.get(place)?.key === key) {
      this.held.delete(place);
    }

    return response;
  }
}
