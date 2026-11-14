/*
 * Who the person at this browser is on the game's list of players: what the browser remembers of it,
 * and what a form asking "who are you?" offers and sends. No part of it touches the page.
 */
import { playerName } from '../engine/names.ts';
import { listedLike } from '../engine/players.ts';
import type { KnownPlayer } from '../engine/players.ts';
import type { Who } from '../server/api.ts';

/**
 * Kept beside the preferences and the name last typed, and apart from any seat: who someone says they
 * are opens nothing, so nothing that forgets it may touch a seat, and nothing that drops a seat forgets it.
 */
const PLAYER_KEY = 'cnd.player';

/** More known players than this and the list gets a box to find a name in. */
const FILTER_FROM = 9;

function playerFrom(kept: string | null): KnownPlayer | null {
  try {
    const { id, name } = JSON.parse(kept ?? 'null') as Partial<KnownPlayer>;

    return typeof id === 'string' && typeof name === 'string' && id !== '' && name !== '' ? { id, name } : null;
  } catch {
    return null;
  }
}

/** The part of the browser's memory this needs. It never throws: a browser that refuses storage just forgets. */
export interface PlayerMemory {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The known player this browser was last used as, with the name the list had for them then. */
export class RememberedPlayer {
  private readonly memory: PlayerMemory;

  constructor(memory: PlayerMemory) {
    this.memory = memory;
  }

  get(): KnownPlayer | null {
    return playerFrom(this.memory.get(PLAYER_KEY));
  }

  set(player: KnownPlayer): void {
    this.memory.set(PLAYER_KEY, JSON.stringify({ id: player.id, name: player.name }));
  }

  /**
   * Holds what is remembered to the list as it was just loaded: a player no longer on it is forgotten,
   * and one the list now calls something else is remembered by that. A list that could not be loaded
   * says nothing about who is on it, so this is only ever called with one that was.
   */
  heldTo(players: readonly KnownPlayer[]): KnownPlayer | null {
    const remembered = this.get();
    const listed = remembered && (players.find((player) => player.id === remembered.id) ?? null);

    if (remembered && !listed) {
      this.memory.remove(PLAYER_KEY);
    } else if (listed && listed.name !== remembered!.name) {
      this.set(listed);
    }

    return listed;
  }
}

/** Everything a "who are you?" question goes by. */
export interface Asked {
  /** The known players, or null until the list has been heard from, which it may never be. */
  players: readonly KnownPlayer[] | null;
  /** Who the browser remembers being, and the page says so until told otherwise. */
  remembered: KnownPlayer | null;
  /** What the visitor has said here: a known player's id, 'new' for none of them, or null for nothing yet. */
  said: string | null;
  /** What is typed in the box for finding a name. */
  filter: string;
  /** What is typed for a new player's name. */
  typed: string;
}

/** What the question shows. */
export interface Offer {
  /**
   * `name` is the old question alone, "what's your name?", as when nobody is known. `remembered` says
   * who the page takes the visitor for and lets them say otherwise. `pick` is the list with someone new.
   */
  mode: 'name' | 'remembered' | 'pick';
  /** The known player the visitor is taken for or has picked; null for someone new. */
  as: KnownPlayer | null;
  /** The known players to pick from, as the box for finding a name leaves them. */
  shown: KnownPlayer[];
  /** Whether there are enough of them for that box. */
  filtered: boolean;
  /** A known player whose name the new one typed reads like, who may be the one typing it. */
  alike: KnownPlayer | null;
}

/** What a form that asked sends: who, and the name to go with it. */
export interface Answer {
  who: Who;
  /** For someone new, the name typed. For a known player, the list's name for them as the page has it. */
  name: string;
}

function chosen(asked: Asked): KnownPlayer | null {
  const { players, remembered, said } = asked;

  if (said === null) {
    // Remembered from another night, they are offered even before the list is in, and even if it never comes
    return remembered && (players === null || players.some((player) => player.id === remembered.id)) ? remembered : null;
  }

  return players?.find((player) => player.id === said) ?? null;
}

export function offerOf(asked: Asked): Offer {
  const players = asked.players ?? [];
  const as = chosen(asked);
  const wanted = asked.filter.trim().toLowerCase();

  return {
    mode: as && asked.said === null ? 'remembered' : players.length > 0 ? 'pick' : 'name',
    as,
    shown: players.filter((player) => player.name.toLowerCase().includes(wanted)),
    filtered: players.length >= FILTER_FROM,
    alike: as || asked.typed.trim() === '' ? null : listedLike(players, asked.typed),
  };
}

/**
 * The known player an answer made of the visitor, once the table has said which one that is: under the
 * name the list has for them, which for someone new is the name they typed as the list keeps names.
 */
export function playerFor(id: string, as: Answer): KnownPlayer {
  try {
    return { id, name: playerName(as.name) };
  } catch {
    return { id, name: as.name };
  }
}

export function answerOf(asked: Asked): Answer {
  const as = chosen(asked);

  return as ? { who: { as: 'known', id: as.id }, name: as.name } : { who: { as: 'new' }, name: asked.typed };
}
