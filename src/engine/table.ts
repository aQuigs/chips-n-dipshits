import type { Rng } from './cards.ts';
import { dispatch } from './commands/index.ts';
import { newConfig } from './config.ts';
import { startHand, stepHand, TIMING } from './hand.ts';
import { handEnded } from './handEnd.ts';
import { numberedName, playerName, readAlike } from './names.ts';
import type { KnownPlayer } from './players.ts';
import { addFeed, eligibleSeats, memberOf } from './seats.ts';
import { newTonight } from './tonight.ts';
import { GameError, SEAT_COUNT, STATE_SCHEMA } from './types.ts';
import type { Command, Ctx, Member, TableState } from './types.ts';
import { LIMITS } from './validate.ts';

// Without look-alike characters, so an id read aloud or retyped survives
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLAYER_ID_LENGTH = 8;
const TOKEN_LENGTH = 24;

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
 * Who a new member is, as far as the game's list of players goes. `identity` is their id on the list,
 * or null for nobody it knows. `keepsName` says the name is the list's and not theirs to change, so a
 * table that has the name already makes room for them as "Bob 2" instead of turning them away.
 */
export interface Arriving {
  identity: string | null;
  keepsName: boolean;
}

const NOBODY_KNOWN: Arriving = { identity: null, keepsName: false };

/** The name someone goes by as a new member of this table, or the reason the table can't take them: a name it already has, or no room. */
function joiningName(state: TableState, rawName: unknown, keepsName: boolean): string {
  const name = playerName(rawName);
  const holderOf = (wanted: string) => state.members.find((m) => readAlike(m.name, wanted));

  const holder = holderOf(name);
  if (holder && !keepsName) {
    throw new GameError(
      holder.name.toLowerCase() === name.toLowerCase()
        ? `Someone at this table is already called ${name}`
        : `That name reads too much like ${holder.name}, who is already at this table`,
    );
  }

  if (state.members.length >= LIMITS.members) {
    throw new GameError('This table is full. The host can make room by removing someone who is only watching');
  }

  // A table has fewer members than there are numbers to try, so one of them is free
  let free = name;
  for (let number = 2; holderOf(free); number++) {
    free = numberedName(name, number);
  }

  return free;
}

function newMember(state: TableState, rawName: unknown, rng: Rng, arriving: Arriving): Member {
  // Settled before anything is drawn, so a join the table turns away takes nothing from its randomness
  const name = joiningName(state, rawName, arriving.keepsName);

  const member: Member = {
    id: randomId(rng, PLAYER_ID_LENGTH),
    name,
    token: randomId(rng, TOKEN_LENGTH),
    buyIn: 0,
    cashOut: 0,
    transferred: 0,
    identity: arriving.identity,
  };
  state.members.push(member);

  return member;
}

export function createTable(id: string, hostName: unknown, configInput: unknown, ctx: Ctx, arriving: Arriving = NOBODY_KNOWN): { state: TableState; host: Member } {
  const state: TableState = {
    schema: STATE_SCHEMA,
    id,
    version: 0,
    createdAt: ctx.now,
    config: newConfig(configInput),
    hostId: '',
    cohostIds: [],
    members: [],
    seats: Array.from({ length: SEAT_COUNT }, () => null),
    requests: [],
    buttonSeat: null,
    blinds: null,
    running: false,
    nextHandAt: null,
    handCount: 0,
    turn: 0,
    hand: null,
    shuffleAfterHand: false,
    bombPotCalled: false,
    handsSinceBombPot: 0,
    lastHand: null,
    nightEndedAt: null,
    tonight: newTonight(),
    feed: [],
    feedSeq: 0,
    reactions: [],
  };

  const host = newMember(state, hostName, ctx.rng, arriving);
  state.hostId = host.id;
  addFeed(state, ctx.now, 'system', null, `${host.name} opened the table`);

  return { state, host };
}

export function addMember(state: TableState, name: unknown, ctx: Ctx, arriving: Arriving = NOBODY_KNOWN): Member {
  const member = newMember(state, name, ctx.rng, arriving);
  addFeed(state, ctx.now, 'system', null, `${member.name} joined`);

  return member;
}

/**
 * Notes which known player a member says they are. It changes nothing else of them: the name they go
 * by here stays, so when the list has them under another the table is told, as it would have seen had
 * they joined under it.
 */
export function setIdentity(state: TableState, playerId: string, known: KnownPlayer, ctx: Ctx): void {
  const member = memberOf(state, playerId);
  if (member.identity === known.id) {
    return;
  }

  member.identity = known.id;

  if (member.name !== known.name) {
    addFeed(state, ctx.now, 'system', null, `${member.name} is ${known.name} on the list of players`);
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
      const ended = stepHand(state, ctx);

      if (ended) {
        handEnded(ended, state, ctx);
      }
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
