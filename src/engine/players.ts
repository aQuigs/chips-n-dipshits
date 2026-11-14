/*
 * The players the game knows from one night to the next, as a list anyone picks themselves from.
 * Where the list is kept is the server's business (`PlayerStore`); what is on it, and when a name is
 * already there, is said here, for the server and the page alike.
 */
import { readAlike } from './names.ts';

/**
 * A player on the game's list. The id is the player: it is what a member of a table carries and what
 * anything kept about them over time is kept under, and it never changes. The name is only how the
 * list shows them, and whoever runs the game may change it.
 */
export interface KnownPlayer {
  id: string;
  name: string;
}

/**
 * The player on the list whose name reads like this one, or null when nobody's does. Names are held
 * to what a table holds them to and then read with their spaces gone, so that "Big Al", "big al" and
 * "BigAl" are one player. No two players on the list read alike, which also means any two of them can
 * sit at one table.
 */
export function listedLike<P extends KnownPlayer>(players: readonly P[], name: string): P | null {
  const squeezed = (spaced: string) => spaced.replace(/\s/g, '');

  return players.find((player) => readAlike(squeezed(player.name), squeezed(name))) ?? null;
}
