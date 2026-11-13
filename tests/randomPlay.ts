/* Random play on a test table: what the simulation runs, and what plays a saved table on after it is read back. */
import assert from 'node:assert/strict';

import { addMember, CONFIG_KEYS, nextDeadline, SEAT_COUNT, viewFor } from '../src/engine/index.ts';
import type { Command, GameError, Rng } from '../src/engine/index.ts';
import type { TestTable } from './helpers.ts';
import { randomConfig } from './randomConfig.ts';

export function chance(rng: Rng, percent: number): boolean {
  return rng.int(100) < percent;
}

/** Runs something the rules may refuse; a refusal must come back as a GameError, never a crash. */
function allowRefusal(action: () => void): void {
  try {
    action();
  } catch (error) {
    assert.equal((error as GameError).name, 'GameError', `unexpected crash: ${(error as Error).stack}`);
  }
}

function attempt(t: TestTable, player: number, command: Command): void {
  allowRefusal(() => t.cmd(player, command));
}

/** The index into the test table's player list for whoever sits in a seat. */
function seatOwnerIndex(t: TestTable, seat: number): number {
  return t.ids.indexOf(t.state.seats[seat]!.playerId);
}

/** One thing a player or the host does around the game itself, picked at random. Player 0 is the host. */
export interface Fuzz {
  t: TestTable;
  rng: Rng;
  /** A player picked at random, as an index into the table's player list, and their id. */
  who: number;
  playerId: string;
}

/**
 * The commands random play sends besides betting, each of which the table may refuse. A new command
 * joins the simulation by adding an entry that sends it.
 */
export const FUZZ_COMMANDS: ((fuzz: Fuzz) => void)[] = [
  ({ t, who }) => attempt(t, who, { type: 'sitOut' }),
  ({ t, who }) => attempt(t, who, { type: 'sitIn' }),
  ({ t, who }) => attempt(t, who, { type: 'standUp' }),

  ({ t, rng, who, playerId }) => {
    const { minBuyIn, maxBuyIn } = t.state.config;

    attempt(t, who, { type: 'requestSeat', seat: rng.int(SEAT_COUNT), buyIn: minBuyIn + rng.int(Math.min(maxBuyIn - minBuyIn, 1500) + 1) });
    attempt(t, 0, { type: 'approve', playerId });
  },

  ({ t, rng, who, playerId }) => {
    attempt(t, who, { type: 'requestRebuy', amount: 1 + rng.int(1000) });
    attempt(t, 0, { type: chance(rng, 80) ? 'approve' : 'deny', playerId });
  },

  ({ t, rng, who }) => attempt(t, who, { type: 'setStraddle', on: chance(rng, 50) }),
  ({ t, who }) => attempt(t, who, { type: 'showCards' }),
  ({ t, rng, playerId }) => attempt(t, 0, { type: 'setStack', playerId, stack: rng.int(2000) }),
  ({ t, playerId }) => attempt(t, 0, { type: 'kick', playerId }),
  ({ t, rng, who }) => attempt(t, who, { type: 'ritVote', agree: chance(rng, 70) }),

  ({ t, rng }) => {
    const config = randomConfig(rng);
    const one = CONFIG_KEYS[rng.int(CONFIG_KEYS.length)]!;

    // Every setting at once, or one by itself, which the settings already in force may not allow
    attempt(t, 0, { type: 'updateConfig', config: chance(rng, 50) ? config : { [one]: config[one] } });
  },

  ({ t }) => {
    if (t.ids.length < 14) {
      allowRefusal(() => t.ids.push(addMember(t.state, `N${t.ids.length}`, t.ctx()).id));
    }
  },
];

function randomSideEvent(t: TestTable, rng: Rng): void {
  const who = rng.int(t.ids.length);

  FUZZ_COMMANDS[rng.int(FUZZ_COMMANDS.length)]!({ t, rng, who, playerId: t.ids[who]! });
}

function playRandomAction(t: TestTable, rng: Rng): void {
  const hand = t.state.hand!;
  const seat = hand.toAct!;
  const options = viewFor(t.state, t.ids[seatOwnerIndex(t, seat)]!, t.now).hand!.options!;
  const roll = rng.int(100);

  if (options.canRaise && roll < 30) {
    const allIn = chance(rng, 20);
    const to = allIn ? options.maxRaiseTo : options.minRaiseTo + rng.int(Math.min(options.maxRaiseTo - options.minRaiseTo, 300) + 1);
    t.raise(seatOwnerIndex(t, seat), to);
    return;
  }

  if (options.canCheck) {
    t.check(seatOwnerIndex(t, seat));
    return;
  }

  if (roll < 45) {
    t.fold(seatOwnerIndex(t, seat));
  } else {
    t.call(seatOwnerIndex(t, seat));
  }
}

/** One random thing happens at the table: a legal move by whoever it is on, a clock running out, or something on the side. */
export function randomStep(t: TestTable, rng: Rng): void {
  if (chance(rng, 6)) {
    randomSideEvent(t, rng);
    return;
  }

  const hand = t.state.hand;
  const deadline = nextDeadline(t.state);

  if (hand?.stage === 'betting') {
    assert.notEqual(hand.toAct, null, 'a betting round has nobody on the clock');
    const owner = t.state.seats[hand.toAct!]!;
    assert.ok(!hand.players.find((p) => p.seat === hand.toAct)!.folded, 'a folded player is on the clock');
    assert.ok(owner.stack > 0, 'a player with no chips is on the clock');

    if (deadline !== null && chance(rng, 4)) {
      t.wait(deadline - t.now);
    } else {
      playRandomAction(t, rng);
    }
    return;
  }

  if (hand?.stage === 'ritVote' && chance(rng, 70)) {
    const voter = hand.players.find((p) => !p.folded && p.ritVote === null)!;
    t.cmd(seatOwnerIndex(t, voter.seat), { type: 'ritVote', agree: chance(rng, 85) });
    return;
  }

  if (deadline !== null) {
    t.wait(Math.max(0, deadline - t.now));
    return;
  }

  // Nothing is scheduled: the table is short of players, so someone comes back or buys chips
  randomSideEvent(t, rng);
}
