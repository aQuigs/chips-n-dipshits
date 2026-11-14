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
  /** Long enough for a Teams or Zoom invitation with its passcode, short enough to stay out of the way in every view. */
  linkLength: 500,
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

/** Anything a pasted address could hide or be split by: whitespace of any kind, control and format characters. */
const NOT_IN_ADDRESS = /[\s\p{C}]/u;

/**
 * Parts of a name joined by dots, the last not starting with a digit: a browser takes a host ending in a
 * number for an IP address. Only a to z, so no look-alike letter from another alphabet can pass one site
 * off as another; a name in another alphabet is written in its xn-- form, as browsers show it.
 */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** What may follow the host: the characters a web address is written in, so nothing a browser would read as a different host. */
const ADDRESS_REST = /^(?:[/?#][A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?$/;

const MAX_PORT = 65535;
const MAX_HOST_LENGTH = 253;

/**
 * A secure web address such as a call's invitation, or '' for none. Checked by hand rather than with
 * `URL`, which Apps Script does not have, and strictly enough that a browser finds the same host in it.
 */
export function webAddress(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new GameError(`${what} is missing`);
  }

  const address = value.trim();
  if (address === '') {
    return '';
  }

  if (address.length > maxLength) {
    throw new GameError(`${what} must be at most ${maxLength} characters`);
  }

  if (NOT_IN_ADDRESS.test(address)) {
    throw new GameError(`${what} can't have spaces or hidden characters in it`);
  }

  const scheme = 'https://';
  if (address.slice(0, scheme.length).toLowerCase() !== scheme) {
    throw new GameError(`${what} must start with ${scheme}`);
  }

  const rest = address.slice(scheme.length);
  const authority = rest.split(/[/?#\\]/, 1)[0]!;
  if (authority.includes('@')) {
    throw new GameError(`${what} can't have a username or password in it`);
  }

  const [host = '', port, ...extra] = authority.split(':');
  if (/[^\x00-\x7F]/.test(host)) {
    throw new GameError(`${what} must spell its site's name in a to z, 0 to 9 and hyphens`);
  }

  const hostFine = host.length <= MAX_HOST_LENGTH && HOST.test(host);
  const portFine = port === undefined || (/^\d{1,5}$/.test(port) && Number(port) <= MAX_PORT);

  if (!hostFine || !portFine || extra.length > 0 || !ADDRESS_REST.test(rest.slice(authority.length))) {
    throw new GameError(`${what} isn't a web address like https://meet.google.com/abc-defg-hij`);
  }

  return scheme + rest;
}
