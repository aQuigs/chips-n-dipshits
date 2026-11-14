/*
 * What a player's name may be, and when two names read as one. The one rule for a name, whether it
 * is typed at a table or kept on the game's list of players.
 */
import { GameError } from './types.ts';
import { LIMITS, text } from './validate.ts';

// Starting with a letter or digit keeps a name from being read as a formula when it lands in a spreadsheet
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.'!?-]*$/u;

/**
 * Letters of other alphabets drawn like a Latin one, each followed by the letter it passes for.
 * Cyrillic and Greek are the two that are on every keyboard and stand in for Latin letter by letter;
 * this is not Unicode's whole list of look-alikes.
 */
const LOOKALIKE_PAIRS = [
  'АAВBЕEЁEКKМMНHОOРPСCТTУYХXЅSІIЈJаaвbеeёeкkмmнhоoрpсcтtуyхxѕsіiјjгrпn',
  'ΑAΒBΕEΖZΗHΙIΚKΜMΝNΟOΡPΤTΥYΧXαaβbεeηnιiκkμuνvοoρpτtυuχx',
].join('');
const LOOKALIKES = new Map<string, string>();
for (let index = 0; index < LOOKALIKE_PAIRS.length; index += 2) {
  LOOKALIKES.set(LOOKALIKE_PAIRS[index]!, LOOKALIKE_PAIRS[index + 1]!);
}

/**
 * What a name comes down to when read at a glance: two names with the same skeleton can't be told
 * apart at the table or in who pays whom. Besides other alphabets, a capital I, a small l and a 1 are
 * one stroke in most fonts ("Big AI" for "Big Al"), and so are O and 0.
 */
export function skeleton(name: string): string {
  const latin = [...name.normalize('NFKC')].map((letter) => LOOKALIKES.get(letter) ?? letter).join('');

  return latin.replace(/[I1]/g, 'l').replace(/0/g, 'o').toLowerCase();
}

/**
 * Whether two names read as one: by their skeletons, or as the same letters in another case. The
 * second is not covered by the first, which takes the I of "BIG AL" for an l and the i of "Big Al" for itself.
 */
export function readAlike(a: string, b: string): boolean {
  return skeleton(a) === skeleton(b) || a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
}

/** A name as it is kept, or the reason it can't be one. */
export function playerName(value: unknown): string {
  const name = text(value, 'Your name', LIMITS.nameLength);

  if (!NAME_PATTERN.test(name)) {
    throw new GameError('Names start with a letter or number and use only letters, numbers, spaces and . _ - \' ! ?');
  }

  // One letter borrowed from another alphabet is how a name is made to read as someone else's, and
  // no list of look-alikes covers every alphabet there is
  if (/\p{Script=Latin}/u.test(name) && /(?!\p{Script=Latin})\p{L}/u.test(name)) {
    throw new GameError('Names use one alphabet, not a mix');
  }

  return name;
}

/**
 * A name with a number after it, cut short where the two together would be too long for a name:
 * "Bob 2", and "Christopher Wr 2" for "Christopher Wren".
 */
export function numberedName(name: string, number: number): string {
  const suffix = ` ${number}`;
  const letters = [...name];

  // By whole letters, since one outside the basic plane is two of the units a name's length is counted in
  while (letters.join('').trimEnd().length + suffix.length > LIMITS.nameLength) {
    letters.pop();
  }

  return letters.join('').trimEnd() + suffix;
}
