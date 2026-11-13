import type { Rng } from './cards.ts';
import { dispatch } from './commands/index.ts';
import { DEFAULT_CONFIG, validatedConfig } from './config.ts';
import { startHand, stepHand, TIMING } from './hand.ts';
import { addFeed, eligibleSeats } from './seats.ts';
import { GameError, SEAT_COUNT, STATE_SCHEMA } from './types.ts';
import type { Command, Ctx, Member, TableState } from './types.ts';
import { LIMITS, text } from './validate.ts';

// Without look-alike characters, so an id read aloud or retyped survives
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLAYER_ID_LENGTH = 8;
const TOKEN_LENGTH = 24;

// Starting with a letter or digit keeps a name from being read as a formula when it lands in a spreadsheet
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.'!?-]*$/u;

// A tick that cascades through more steps than this means a deadline is not moving forward
const MAX_STEPS_PER_TICK = 200;

export function randomId(rng: Rng, length: number): string {
  let id = '';

  for (let i = 0; i < length; i++) {
    id += ID_ALPHABET[rng.int(ID_ALPHABET.length)];
  }

  return id;
}

/**
 * Letters of other alphabets drawn like a Latin one, each followed by the letter it passes for.
 * Cyrillic and Greek are the two that are on every keyboard and stand in for Latin letter by letter;
 * this is not Unicode's whole list of look-alikes.
 */
const LOOKALIKE_PAIRS = [
  '\u0410A\u0412B\u0415E\u0401E\u041AK\u041CM\u041DH\u041EO\u0420P\u0421C\u0422T\u0423Y\u0425X\u0405S\u0406I\u0408J\u0430a\u0432b\u0435e\u0451e\u043Ak\u043Cm\u043Dh\u043Eo\u0440p\u0441c\u0442t\u0443y\u0445x\u0455s\u0456i\u0458j\u0433r\u043Fn',
  '\u0391A\u0392B\u0395E\u0396Z\u0397H\u0399I\u039AK\u039CM\u039DN\u039FO\u03A1P\u03A4T\u03A5Y\u03A7X\u03B1a\u03B2b\u03B5e\u03B7n\u03B9i\u03BAk\u03BCu\u03BDv\u03BFo\u03C1p\u03C4t\u03C5u\u03C7x',
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
function skeleton(name: string): string {
  const latin = [...name.normalize('NFKC')].map((letter) => LOOKALIKES.get(letter) ?? letter).join('');

  return latin.replace(/[I1]/g, 'l').replace(/0/g, 'o').toLowerCase();
}

function playerName(value: unknown): string {
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

function newMember(state: TableState, rawName: unknown, rng: Rng): Member {
  const name = playerName(rawName);

  const taken = state.members.find((m) => skeleton(m.name) === skeleton(name));
  if (taken) {
    throw new GameError(
      taken.name.toLowerCase() === name.toLowerCase()
        ? `Someone at this table is already called ${name}`
        : `That name reads too much like ${taken.name}, who is already at this table`,
    );
  }

  if (state.members.length >= LIMITS.members) {
    throw new GameError('This table is full. The host can make room by removing someone who is only watching');
  }

  const member: Member = {
    id: randomId(rng, PLAYER_ID_LENGTH),
    name,
    token: randomId(rng, TOKEN_LENGTH),
    buyIn: 0,
    cashOut: 0,
  };
  state.members.push(member);

  return member;
}

export function createTable(id: string, hostName: unknown, configInput: unknown, ctx: Ctx): { state: TableState; host: Member } {
  const state: TableState = {
    schema: STATE_SCHEMA,
    id,
    version: 0,
    createdAt: ctx.now,
    config: validatedConfig(configInput, DEFAULT_CONFIG),
    hostId: '',
    members: [],
    seats: Array.from({ length: SEAT_COUNT }, () => null),
    requests: [],
    buttonSeat: null,
    running: false,
    nextHandAt: null,
    handCount: 0,
    turn: 0,
    hand: null,
    feed: [],
    feedSeq: 0,
  };

  const host = newMember(state, hostName, ctx.rng);
  state.hostId = host.id;
  addFeed(state, ctx.now, 'system', null, `${host.name} opened the table`);

  return { state, host };
}

export function addMember(state: TableState, name: unknown, ctx: Ctx): Member {
  const member = newMember(state, name, ctx.rng);
  addFeed(state, ctx.now, 'system', null, `${member.name} joined`);

  return member;
}

/** With no hand on the table, the next one is dealt shortly after two players are able to play. */
function scheduleNextHand(state: TableState, now: number): void {
  if (state.hand) {
    return;
  }

  const ready = state.running && eligibleSeats(state).length >= 2;

  if (!ready) {
    state.nextHandAt = null;
  } else if (state.nextHandAt === null) {
    state.nextHandAt = now + TIMING.startDelayMs;
  }
}

export function applyCommand(state: TableState, ctx: Ctx, playerId: string, command: Command): void {
  if (typeof command !== 'object' || command === null) {
    throw new GameError('Unknown command');
  }

  dispatch(state, ctx, playerId, command);
  scheduleNextHand(state, ctx.now);
}

/** When the table next changes by itself, or null if it is waiting on a player. */
export function nextDeadline(state: TableState): number | null {
  return state.hand ? state.hand.deadline : state.nextHandAt;
}

/** Applies everything whose time has come. Returns whether anything changed. */
export function tick(state: TableState, ctx: Ctx): boolean {
  let changed = false;

  for (let steps = 0; steps < MAX_STEPS_PER_TICK; steps++) {
    const deadline = nextDeadline(state);
    if (deadline === null || deadline > ctx.now) {
      break;
    }

    if (state.hand) {
      stepHand(state, ctx);
    } else {
      state.nextHandAt = null;
    }

    // A finished hand rolls straight into the next one, with no second countdown
    if (!state.hand && state.running && eligibleSeats(state).length >= 2) {
      startHand(state, ctx);
    }

    scheduleNextHand(state, ctx.now);
    changed = true;
  }

  return changed;
}
