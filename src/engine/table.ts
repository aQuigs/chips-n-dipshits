import type { Rng } from './cards.ts';
import { act, restartActionClock, showCards, startHand, stepHand, stopWaitingFor, TIMING, voteRunItTwice } from './hand.ts';
import { formatChips } from './format.ts';
import { addFeed, eligibleSeats, memberOf, recordLedger, seatIndexOf, vacateSeat } from './seats.ts';
import { GameError, SEAT_COUNT, STATE_SCHEMA } from './types.ts';
import type { Command, Ctx, Member, Seat, SeatRequest, TableConfig, TableState } from './types.ts';

export const DEFAULT_CONFIG: TableConfig = {
  name: "Chips n' Dipshits",
  smallBlind: 10,
  bigBlind: 20,
  minBuyIn: 400,
  maxBuyIn: 2000,
  actionSeconds: 30,
  allowStraddle: true,
  allowRunItTwice: true,
  sevenDeuceBounty: 0,
};

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

function wholeNumber(value: unknown, what: string, min: number, max = LIMITS.chips): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new GameError(`${what} must be a whole number from ${min} to ${max}`);
  }

  return value;
}

function yesOrNo(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new GameError(`${what} must be on or off`);
  }

  return value;
}

/** The decision an action says it answers. Left out, the action is for whichever decision is open. */
function turnOf(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GameError('The turn must be a whole number');
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

function text(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new GameError(`${what} is missing`);
  }

  const trimmed = value.replace(UNPRINTABLE, '').replace(JOINER_IN_STACK, '$1').replace(STACKED_MARKS, '$1').trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new GameError(`${what} must be 1 to ${maxLength} characters`);
  }

  return trimmed;
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

/** Checks a full set of table settings, filling anything missing from the current ones. */
export function validatedConfig(input: unknown, current: TableConfig): TableConfig {
  const given = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const pick = <K extends keyof TableConfig>(key: K): unknown => (given[key] === undefined ? current[key] : given[key]);

  const smallBlind = wholeNumber(pick('smallBlind'), 'The small blind', 1);
  const bigBlind = wholeNumber(pick('bigBlind'), 'The big blind', 1);
  if (bigBlind < smallBlind) {
    throw new GameError("The big blind can't be smaller than the small blind");
  }

  const minBuyIn = wholeNumber(pick('minBuyIn'), 'The minimum buy-in', 1);
  const maxBuyIn = wholeNumber(pick('maxBuyIn'), 'The maximum buy-in', 1);
  if (maxBuyIn < minBuyIn) {
    throw new GameError("The maximum buy-in can't be smaller than the minimum");
  }

  const actionSeconds = wholeNumber(pick('actionSeconds'), 'The action clock', 0, LIMITS.maxActionSeconds);
  if (actionSeconds !== 0 && actionSeconds < LIMITS.minActionSeconds) {
    throw new GameError(`The action clock must be off or at least ${LIMITS.minActionSeconds} seconds`);
  }

  return {
    name: text(pick('name'), 'The table name', LIMITS.tableNameLength),
    smallBlind,
    bigBlind,
    minBuyIn,
    maxBuyIn,
    actionSeconds,
    allowStraddle: yesOrNo(pick('allowStraddle'), 'Straddles'),
    allowRunItTwice: yesOrNo(pick('allowRunItTwice'), 'Run it twice'),
    sevenDeuceBounty: wholeNumber(pick('sevenDeuceBounty'), 'The seven-deuce bounty', 0),
  };
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

/** The member a host's command is about, who may have been removed since the host's screen was drawn. */
function memberNamed(state: TableState, playerId: string): Member {
  const member = state.members.find((m) => m.id === playerId);
  if (!member) {
    throw new GameError('That player is no longer at the table');
  }

  return member;
}

function requireHost(state: TableState, playerId: string): void {
  if (state.hostId !== playerId) {
    throw new GameError('Only the host can do that');
  }
}

function requireSeat(state: TableState, playerId: string): { seat: Seat; index: number } {
  const index = seatIndexOf(state, playerId);
  if (index < 0) {
    throw new GameError('You need a seat for that');
  }

  return { seat: state.seats[index]!, index };
}

function isDealtIn(state: TableState, seatIndex: number): boolean {
  return state.hand?.players.some((p) => p.seat === seatIndex) ?? false;
}

function grantSeat(state: TableState, ctx: Ctx, request: SeatRequest): void {
  if (state.seats[request.seat]) {
    throw new GameError('That seat has been taken, so they need to pick another');
  }

  const member = memberOf(state, request.playerId);
  state.seats[request.seat] = {
    playerId: member.id,
    stack: request.amount,
    sittingOut: false,
    away: false,
    leaving: false,
    straddle: false,
    pendingAdd: 0,
  };

  recordLedger(state, ctx, member, 'buy-in', request.amount);
  addFeed(state, ctx.now, 'system', null, `${member.name} sits down with ${formatChips(request.amount)}`);
}

function grantRebuy(state: TableState, ctx: Ctx, request: SeatRequest): void {
  const index = seatIndexOf(state, request.playerId);
  const seat = state.seats[index];
  if (!seat) {
    throw new GameError('They no longer have a seat');
  }

  const member = memberOf(state, request.playerId);

  // The stack or the maximum may have changed since they asked. Refusing would leave a request nobody can approve.
  const amount = Math.min(request.amount, state.config.maxBuyIn - seat.stack - seat.pendingAdd);
  if (amount < 1) {
    addFeed(state, ctx.now, 'system', null, `${member.name} is at the table maximum, so no chips are added`);
    return;
  }

  // Chips can't join a hand that is already being played, so they wait for its end and are bought then
  if (isDealtIn(state, index)) {
    seat.pendingAdd += amount;
    addFeed(state, ctx.now, 'system', null, `${member.name} adds ${formatChips(amount)} after this hand`);
    return;
  }

  seat.stack += amount;
  recordLedger(state, ctx, member, 'buy-in', amount);
  addFeed(state, ctx.now, 'system', null, `${member.name} adds ${formatChips(amount)}`);
}

function grant(state: TableState, ctx: Ctx, request: SeatRequest): void {
  if (request.kind === 'seat') {
    grantSeat(state, ctx, request);
  } else {
    grantRebuy(state, ctx, request);
  }

  state.requests = state.requests.filter((r) => r.playerId !== request.playerId);

  if (request.kind === 'seat') {
    turnAway(
      state,
      ctx,
      (r) => r.kind === 'seat' && r.seat === request.seat,
      (name) => `Seat ${request.seat + 1} is taken, so ${name} needs to pick another`,
    );
  }
}

/** Drops the requests that can no longer be granted and says why, so none is left that the host could only fail to approve. */
function turnAway(state: TableState, ctx: Ctx, hopeless: (request: SeatRequest) => boolean, why: (name: string, request: SeatRequest) => string): void {
  const dropped = state.requests.filter(hopeless);

  for (const request of dropped) {
    addFeed(state, ctx.now, 'system', null, why(memberOf(state, request.playerId).name, request));
  }

  state.requests = state.requests.filter((r) => !dropped.includes(r));
}

/** Files a request for the host, who doesn't need to approve their own. */
function submit(state: TableState, ctx: Ctx, request: SeatRequest): void {
  state.requests = state.requests.filter((r) => r.playerId !== request.playerId);

  if (request.playerId === state.hostId) {
    grant(state, ctx, request);
    return;
  }

  state.requests.push(request);
}

/** Takes a player out of their seat: now if they have no part in the current hand, otherwise once it ends. */
function leaveSeat(state: TableState, ctx: Ctx, seatIndex: number): void {
  const seat = state.seats[seatIndex]!;

  if (!isDealtIn(state, seatIndex)) {
    vacateSeat(state, ctx, seatIndex);
    return;
  }

  seat.leaving = true;
  state.requests = state.requests.filter((r) => r.playerId !== seat.playerId);
  stopWaitingFor(state, ctx, seatIndex);
}

function applyTo(state: TableState, ctx: Ctx, playerId: string, command: Command): void {
  const member = memberOf(state, playerId);

  switch (command.type) {
    case 'requestSeat': {
      if (seatIndexOf(state, playerId) >= 0) {
        throw new GameError('You already have a seat');
      }

      const seat = wholeNumber(command.seat, 'The seat', 0, SEAT_COUNT - 1);
      if (state.seats[seat]) {
        throw new GameError('That seat is taken');
      }

      const { minBuyIn, maxBuyIn } = state.config;
      const amount = wholeNumber(command.buyIn, 'Your buy-in', minBuyIn, maxBuyIn);

      submit(state, ctx, { playerId, kind: 'seat', seat, amount });
      return;
    }

    case 'requestRebuy': {
      const { seat, index } = requireSeat(state, playerId);
      if (seat.leaving) {
        throw new GameError('You are giving up your seat when this hand ends');
      }

      const room = state.config.maxBuyIn - seat.stack - seat.pendingAdd;
      if (room < 1) {
        throw new GameError(`You already have the maximum buy-in of ${state.config.maxBuyIn}`);
      }

      const amount = wholeNumber(command.amount, 'Your rebuy', 1, room);

      submit(state, ctx, { playerId, kind: 'rebuy', seat: index, amount });
      return;
    }

    case 'cancelRequest': {
      state.requests = state.requests.filter((r) => r.playerId !== playerId);
      return;
    }

    case 'standUp': {
      leaveSeat(state, ctx, requireSeat(state, playerId).index);
      return;
    }

    case 'sitOut': {
      requireSeat(state, playerId).seat.sittingOut = true;
      return;
    }

    case 'sitIn': {
      const { seat } = requireSeat(state, playerId);
      seat.sittingOut = false;
      seat.away = false;
      return;
    }

    case 'setStraddle': {
      const { seat } = requireSeat(state, playerId);
      const on = yesOrNo(command.on, 'Straddle');
      if (on && !state.config.allowStraddle) {
        throw new GameError('Straddles are turned off at this table');
      }

      seat.straddle = on;
      return;
    }

    case 'fold':
    case 'check':
    case 'call': {
      act(state, ctx, seatIndexOf(state, playerId), { type: command.type }, turnOf(command.turn));
      return;
    }

    case 'raise': {
      act(state, ctx, seatIndexOf(state, playerId), { type: 'raise', to: command.to }, turnOf(command.turn));
      return;
    }

    case 'ritVote': {
      voteRunItTwice(state, ctx, seatIndexOf(state, playerId), yesOrNo(command.agree, 'Your vote'));
      return;
    }

    case 'showCards': {
      showCards(state, ctx, seatIndexOf(state, playerId));
      return;
    }

    case 'chat': {
      addFeed(state, ctx.now, 'chat', member.name, text(command.text, 'Your message', LIMITS.chatLength));
      return;
    }

    case 'start': {
      requireHost(state, playerId);
      if (!state.running) {
        state.running = true;
        addFeed(state, ctx.now, 'system', null, 'The game is on');
      }

      return;
    }

    case 'pause': {
      requireHost(state, playerId);
      if (state.running) {
        state.running = false;
        addFeed(state, ctx.now, 'system', null, state.hand ? 'The game pauses after this hand' : 'The game is paused');
      }

      return;
    }

    case 'approve': {
      requireHost(state, playerId);
      const request = state.requests.find((r) => r.playerId === command.playerId);
      if (!request) {
        throw new GameError('That request is gone');
      }

      grant(state, ctx, request);
      return;
    }

    case 'deny': {
      requireHost(state, playerId);
      turnAway(
        state,
        ctx,
        (r) => r.playerId === command.playerId,
        (name, r) => (r.kind === 'seat' ? `The host turned down ${name}'s request for a seat` : `The host turned down ${name}'s request for chips`),
      );
      return;
    }

    case 'kick': {
      requireHost(state, playerId);
      const target = memberNamed(state, command.playerId);
      const index = seatIndexOf(state, target.id);

      state.requests = state.requests.filter((r) => r.playerId !== target.id);

      if (index >= 0) {
        addFeed(state, ctx.now, 'system', null, `The host removed ${target.name} from their seat`);
        leaveSeat(state, ctx, index);
      } else if (target.id !== state.hostId && target.buyIn === 0 && target.cashOut === 0) {
        // Someone who never played has no line in the ledger to be kept for, so their name and their place at the table are freed
        state.members = state.members.filter((m) => m !== target);
        addFeed(state, ctx.now, 'system', null, `The host removed ${target.name} from the table`);
      }

      return;
    }

    case 'setStack': {
      requireHost(state, playerId);
      const target = memberNamed(state, command.playerId);
      const index = seatIndexOf(state, target.id);
      const seat = state.seats[index];
      if (!seat) {
        throw new GameError(`${target.name} doesn't have a seat`);
      }

      if (isDealtIn(state, index)) {
        throw new GameError(`${target.name} is in the current hand, so wait until it is over`);
      }

      const stack = wholeNumber(command.stack, 'The stack', 0);
      const change = stack - seat.stack;
      if (change !== 0) {
        seat.stack = stack;
        recordLedger(state, ctx, target, 'adjustment', change);
        addFeed(state, ctx.now, 'system', null, `The host set ${target.name}'s stack to ${formatChips(stack)}`);
      }

      return;
    }

    case 'updateConfig': {
      requireHost(state, playerId);
      const before = state.config;
      state.config = validatedConfig(command.config, before);

      const when = state.hand ? ' from the next hand' : '';

      if (state.config.smallBlind !== before.smallBlind || state.config.bigBlind !== before.bigBlind) {
        addFeed(state, ctx.now, 'system', null, `Blinds are ${formatChips(state.config.smallBlind)}/${formatChips(state.config.bigBlind)}${when}`);
      }

      if (state.config.sevenDeuceBounty !== before.sevenDeuceBounty) {
        const bounty = state.config.sevenDeuceBounty;
        addFeed(state, ctx.now, 'system', null, bounty > 0 ? `The seven-deuce bounty is ${formatChips(bounty)}${when}` : `The seven-deuce bounty is off${when}`);
      }

      const { minBuyIn, maxBuyIn } = state.config;
      turnAway(
        state,
        ctx,
        (r) => r.kind === 'seat' && (r.amount < minBuyIn || r.amount > maxBuyIn),
        (name, r) => `${name} asked to sit down with ${formatChips(r.amount)}, which the new buy-in limits don't allow`,
      );

      if (!state.config.allowStraddle) {
        for (const seat of state.seats) {
          if (seat) {
            seat.straddle = false;
          }
        }
      }

      if (state.config.actionSeconds !== before.actionSeconds) {
        restartActionClock(state, ctx.now);
      }

      return;
    }

    case 'transferHost': {
      requireHost(state, playerId);
      const target = memberNamed(state, command.playerId);

      state.hostId = target.id;
      addFeed(state, ctx.now, 'system', null, `${target.name} is now the host`);
      return;
    }

    default: {
      throw new GameError('Unknown command');
    }
  }
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

  applyTo(state, ctx, playerId, command);
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
