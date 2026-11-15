import { carriesOn, opensMention } from '../engine/mentions.ts';
import { LIMITS } from '../engine/validate.ts';

/** The most names offered at once: the rest come into the list as more of the name is typed. */
export const MOST_OFFERED = 5;

/** A name being typed after an @, and the names it could be. */
export interface Completion {
  /** Where its @ is in the box's text. */
  at: number;
  /** What has been typed of the name so far. */
  typed: string;
  names: string[];
}

/**
 * The name being typed where the caret is in `text`, and those of `names` it could be, in the order
 * given; null when nothing is being named there or nobody fits. Nothing is offered with the caret in
 * the middle of a word, and the @ has to start a word, as it must for the table to take it as naming
 * someone. A name may have spaces in it, so what follows the @ is read up to the caret.
 */
export function completionAt(text: string, caret: number, names: readonly string[]): Completion | null {
  if (carriesOn(text[caret])) {
    return null;
  }

  const at = text.lastIndexOf('@', caret - 1);
  if (at === -1 || at >= caret || caret - at > LIMITS.nameLength + 1 || !opensMention(text, at)) {
    return null;
  }

  const typed = text.slice(at + 1, caret).toLowerCase();
  const fitting = names.filter((name) => name.toLowerCase().startsWith(typed));

  return fitting.length > 0 ? { at, typed: text.slice(at + 1, caret), names: fitting.slice(0, MOST_OFFERED) } : null;
}

/**
 * `text` with the name being typed at `completion` written out as `name`, and a space after it unless
 * one follows already, and where the caret goes: after that space. Null when the line would grow past
 * what the table takes, which would cost the player the whole line when they sent it.
 */
export function completed(text: string, caret: number, completion: Completion, name: string): { text: string; caret: number } | null {
  const after = text.slice(caret);
  const written = `@${name}${after.startsWith(' ') ? '' : ' '}`;
  const result = text.slice(0, completion.at) + written + after;

  if (result.length > LIMITS.chatLength) {
    return null;
  }

  return { text: result, caret: completion.at + written.length + (after.startsWith(' ') ? 1 : 0) };
}
