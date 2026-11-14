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
  '\u0410A\u0412B\u0415E\u0401E\u041AK\u041CM\u041DH\u041EO\u0420P\u0421C\u0422T\u0423Y\u0425X\u0405S\u0406I\u0408J\u0430a\u0432b\u0435e\u0451e\u043Ak\u043Cm\u043Dh\u043Eo\u0440p\u0441c\u0442t\u0443y\u0445x\u0455s\u0456i\u0458j\u0433r\u043Fn',
  '\u0391A\u0392B\u0395E\u0396Z\u0397H\u0399I\u039AK\u039CM\u039DN\u039FO\u03A1P\u03A4T\u03A5Y\u03A7X\u03B1a\u03B2b\u03B5e\u03B7n\u03B9i\u03BAk\u03BCu\u03BDv\u03BFo\u03C1p\u03C4t\u03C5u\u03C7x',
  // Turkish, whose two extra letters are Latin ones that no change of case turns into an I or an i
  '\u0130I\u0131i',
].join('');
const LOOKALIKES = new Map<string, string>();
for (let index = 0; index < LOOKALIKE_PAIRS.length; index += 2) {
  LOOKALIKES.set(LOOKALIKE_PAIRS[index]!, LOOKALIKE_PAIRS[index + 1]!);
}

/** A name's letters, each of another alphabet as the Latin letter it passes for. */
function letters(name: string): string[] {
  return [...name.normalize('NFKC')].map((letter) => LOOKALIKES.get(letter) ?? letter);
}

/** What a letter comes down to when read at a glance: a capital I, a small l and a 1 are one stroke in most fonts, and so are O and 0. */
function stroke(letter: string): string {
  return letter.replace(/[I1]/, 'l').replace('0', 'o').toLowerCase();
}

/**
 * Whether two names read as one, and so can't be told apart at the table or in who pays whom: letter
 * for letter, each is the other's in another case or is drawn like it ("Big AI" for "Big Al"). It is
 * asked of each letter and not of the whole name because a name may be both at once, "BIG AI", and
 * because the two don't add up: an i is an I and an I passes for an l, but "Kai" is not "Kal".
 */
export function readAlike(a: string, b: string): boolean {
  const [one, other] = [letters(a), letters(b)];

  return one.length === other.length && one.every((letter, at) => letter.toLowerCase() === other[at]!.toLowerCase() || stroke(letter) === stroke(other[at]!));
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
