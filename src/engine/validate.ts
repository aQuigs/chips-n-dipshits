import { GameError } from './types.ts';

export const LIMITS = {
  nameLength: 16,
  tableNameLength: 40,
  chatLength: 200,
  members: 60,
  /** Keeps every chip count far inside the range where integers are exact. */
  chips: 1_000_000_000,
  minActionSeconds: 5,
  maxActionSeconds: 300,
};

export function wholeNumber(value: unknown, what: string, min: number, max = LIMITS.chips): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new GameError(`${what} must be a whole number from ${min} to ${max}`);
  }

  return value;
}

export function yesOrNo(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new GameError(`${what} must be on or off`);
  }

  return value;
}

/** Control characters, and the marks that reorder text: one of those in a chat line can make the rest of it read backward. */
const UNPRINTABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** More accents stacked on one letter than any language writes; a long enough stack draws over the lines around it. */
const STACKED_MARKS = /(\p{M}{3})\p{M}+/gu;

/**
 * An invisible joiner after an accent, which would let one tall stack be written as many short ones.
 * The marks that pick an emoji's style are left out: an emoji made of several needs the joiner after one.
 */
const JOINER_IN_STACK = /((?![\uFE00-\uFE0F])\p{M})\p{Cf}+/gu;

export function text(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new GameError(`${what} is missing`);
  }

  const trimmed = value.replace(UNPRINTABLE, '').replace(JOINER_IN_STACK, '$1').replace(STACKED_MARKS, '$1').trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new GameError(`${what} must be 1 to ${maxLength} characters`);
  }

  return trimmed;
}
