import { GameError, LIMITS, listedLike, randomId } from '../engine/index.ts';
import type { KnownPlayer, Rng } from '../engine/index.ts';

/**
 * Where the game keeps the players it knows from one night to the next. Implementations decide the
 * database, the locking and any caching. Who a player is can always be said again later, so nothing
 * here is worth holding a game up for: a caller treats a failure as the player being nobody it knows.
 */
export interface PlayerStore {
  /** Every known player that can be read, the most recently seen first. May be served from a cache. */
  list(): KnownPlayer[];

  /**
   * The known player with this id, or null when the list has none. They are noted as seen at `at`,
   * which is what the list is ordered by, unless they were so noted within `SEEN_EVERY_MS`; a note
   * that can't be made is left for the next time and fails nothing.
   */
  seen(id: string, at: number): KnownPlayer | null;

  /**
   * Adds someone new while nothing else can change the list, and gives them their id. Refuses a name
   * that is no name (`playerName`), one that reads like a name on the list (`NameOnList`), and anyone
   * at all once the list is full (`ListFull`).
   */
  add(name: string, at: number): KnownPlayer;
}

/**
 * The one player the check of the deployed game plays as, every time it runs. They are on the list like
 * anyone, so that the check reads and writes the real list, but friends are never offered them: the
 * list a page is sent leaves them out, and the name itself is how the check comes back as them.
 */
export const CHECK_PLAYER = 'Live check';

/** A known player as a store keeps them, with when they were last seen, which the list is ordered by. */
export interface KeptPlayer extends KnownPlayer {
  /** 0 when it is not known. */
  seenAt: number;
}

/** The name wanted for someone new reads like the name of a player already on the list, who may be the same person. */
export class NameOnList extends GameError {
  constructor(holder: string) {
    super(`${holder} is already on the list of players. If that is you, pick ${holder} from the list. If not, add something to your name`);
    this.name = 'NameOnList';
  }
}

/** The list has every player it may hold. */
export class ListFull extends GameError {
  constructor() {
    super(`The list of players is full at ${LIMITS.knownPlayers}. Whoever runs the game can make room in its Sheet`);
    this.name = 'ListFull';
  }
}

/**
 * Every member who is a known player carries this in their table's saved state, which has the cache's
 * limit to fit, so it is no longer than it must be: seven characters are tens of billions of ids for a
 * list of two hundred. A table's id has six and a member's eight, so the three are told apart at sight.
 */
const PLAYER_ID_LENGTH = 7;
const PLAYER_ID = new RegExp(`^[A-Z0-9]{${PLAYER_ID_LENGTH}}$`);

/** Whether this is an id the game gives a known player, as opposed to something typed into its place. */
export function isPlayerId(value: string): boolean {
  return PLAYER_ID.test(value);
}

/**
 * How long after a player was noted as seen before they are noted again. A night's joins are then one
 * write a player, and the list still has last night's players ahead of last month's.
 */
export const SEEN_EVERY_MS = 12 * 60 * 60 * 1000;

export function dueToBeSeen(player: KeptPlayer, at: number): boolean {
  return at - player.seenAt >= SEEN_EVERY_MS;
}

/** A player as the list hands them out, without what only a store keeps of them. */
export function listed({ id, name }: KnownPlayer): KnownPlayer {
  return { id, name };
}

/** The list as it is handed out: the most recently seen first, and among those seen at the same time by name. */
export function inListOrder(players: readonly KeptPlayer[]): KnownPlayer[] {
  return [...players].sort((a, b) => b.seenAt - a.seenAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(listed);
}

/**
 * Someone new under `name`, with an id none of `players` has, or the reason they can't be added: the
 * name is on the list, or the list is full. `places` is how many places of the list are taken, which
 * counts one holding something that can't be read; `players` are those that can.
 */
export function newcomer(players: readonly KnownPlayer[], places: number, name: string, at: number, rng: Rng): KeptPlayer {
  const holder = listedLike(players, name);
  if (holder) {
    throw new NameOnList(holder.name);
  }

  if (places >= LIMITS.knownPlayers) {
    throw new ListFull();
  }

  for (;;) {
    const id = randomId(rng, PLAYER_ID_LENGTH);

    if (!players.some((player) => player.id === id)) {
      return { id, name, seenAt: at };
    }
  }
}
