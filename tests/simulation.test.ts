import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, nextDeadline, SEAT_COUNT, viewFor } from '../src/engine/index.ts';
import type { Command, Effect, GameError, Rng } from '../src/engine/index.ts';
import { assertChipsConserved, seededRng, TestTable } from './helpers.ts';

// SIM_TABLES=2000 npm test runs a much longer soak than the default
const TABLES = Number(process.env.SIM_TABLES ?? 60);
const STEPS_PER_TABLE = 600;

// Building every player's view is the slow part, so it is checked on a sample of steps
const VIEW_CHECK_PERCENT = 10;

function chance(rng: Rng, percent: number): boolean {
  return rng.int(100) < percent;
}

/** Runs a command that the rules may refuse; a refusal must come back as a GameError, never a crash. */
function attempt(t: TestTable, seat: number, command: Command): void {
  try {
    t.cmd(seat, command);
  } catch (error) {
    assert.equal((error as GameError).name, 'GameError', `unexpected crash: ${(error as Error).stack}`);
  }
}

/** What a view shows must be exactly what that viewer is allowed to know. */
function assertViewsKeepSecrets(t: TestTable): void {
  const hand = t.state.hand;

  t.ids.forEach((playerId, viewerIndex) => {
    const view = viewFor(t.state, playerId, t.now);
    const json = JSON.stringify(view);
    assert.ok(!json.includes('"deck"') && !json.includes('"token"'), 'a view leaked the deck or a token');

    for (const player of hand?.players ?? []) {
      const seen = view.seats[player.seat]!.cards!;
      const allowed = player.shown || t.ids[viewerIndex] === player.playerId;

      assert.deepEqual(seen, allowed ? player.cards : [null, null], 'a view shows the wrong cards');
    }

    const options = view.hand?.options;
    if (options) {
      assert.equal(hand!.toAct, view.you.seat);
      assert.ok(options.callAmount >= 0 && options.callCost <= options.callAmount);
      if (options.canRaise) {
        assert.ok(options.minRaiseTo > hand!.currentBet && options.minRaiseTo <= options.maxRaiseTo, 'raise bounds are inverted');
      }
    }
  });
}

function assertHandRecordsBalance(effects: Effect[]): number {
  let hands = 0;

  for (const effect of effects) {
    if (effect.type !== 'hand') {
      continue;
    }

    hands += 1;
    const { record } = effect;
    const moved = record.players.reduce((sum, p) => sum + p.endStack - p.startStack, 0);
    const pots = record.result.pots.reduce((sum, pot) => sum + pot.amount, 0);
    const awarded = record.result.pots.reduce((sum, pot) => sum + pot.awards.reduce((s, award) => s + award.amount, 0), 0);
    const won = record.result.winnings.reduce((sum, w) => sum + w.amount, 0);

    assert.equal(moved, 0, `hand ${record.number} created or destroyed chips`);
    assert.equal(awarded, pots, `hand ${record.number} did not award every pot in full`);
    assert.equal(won, pots);
    assert.ok(record.boards.every((board) => board.length === 0 || board.length >= 3));
    assert.equal(new Set([...record.boards.flat(), ...record.players.flatMap((p) => p.cards ?? [])]).size >= record.boards[0]!.length, true);
  }

  return hands;
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

/** The index into the test table's player list for whoever sits in a seat. */
function seatOwnerIndex(t: TestTable, seat: number): number {
  return t.ids.indexOf(t.state.seats[seat]!.playerId);
}

/** Things players and the host do around the game itself. Any of them may be refused. */
function randomSideEvent(t: TestTable, rng: Rng): void {
  const who = rng.int(t.ids.length);
  const playerId = t.ids[who]!;

  switch (rng.int(12)) {
    case 0:
      attempt(t, who, { type: 'sitOut' });
      break;
    case 1:
      attempt(t, who, { type: 'sitIn' });
      break;
    case 2:
      attempt(t, who, { type: 'standUp' });
      break;
    case 3:
      attempt(t, who, { type: 'requestSeat', seat: rng.int(SEAT_COUNT), buyIn: 1 + rng.int(1500) });
      attempt(t, 0, { type: 'approve', playerId });
      break;
    case 4:
      attempt(t, who, { type: 'requestRebuy', amount: 1 + rng.int(1000) });
      attempt(t, 0, { type: chance(rng, 80) ? 'approve' : 'deny', playerId });
      break;
    case 5:
      attempt(t, who, { type: 'setStraddle', on: chance(rng, 50) });
      break;
    case 6:
      attempt(t, who, { type: 'showCards' });
      break;
    case 7:
      attempt(t, 0, { type: 'setStack', playerId, stack: rng.int(2000) });
      break;
    case 8:
      attempt(t, 0, { type: 'kick', playerId });
      break;
    case 9:
      attempt(t, who, { type: 'ritVote', agree: chance(rng, 70) });
      break;
    case 10:
      attempt(t, 0, { type: 'updateConfig', config: { smallBlind: 1 + rng.int(10), bigBlind: 10 + rng.int(40), sevenDeuceBounty: rng.int(3) * 20 } });
      break;
    default:
      if (t.ids.length < 14) {
        t.ids.push(addMember(t.state, `N${t.ids.length}`, t.ctx()).id);
      }
  }
}

test('random play never breaks the rules of chip accounting, secrecy or turn order', () => {
  let handsPlayed = 0;
  let showdowns = 0;
  let runTwice = 0;
  let bounties = 0;

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 7919);
    const players = 2 + rng.int(SEAT_COUNT - 1);
    const stacks = Array.from({ length: players }, () => (chance(rng, 15) ? 1 + rng.int(30) : 100 + rng.int(1900)));
    const smallBlind = 1 + rng.int(10);

    const t = new TestTable({
      stacks,
      seed,
      config: {
        smallBlind,
        bigBlind: smallBlind + rng.int(smallBlind * 2 + 1),
        actionSeconds: chance(rng, 50) ? 15 : 0,
        allowRunItTwice: chance(rng, 60),
        allowStraddle: chance(rng, 70),
        sevenDeuceBounty: chance(rng, 40) ? 25 : 0,
      },
    });
    t.cmd(0, { type: 'start' });

    for (let step = 0; step < STEPS_PER_TABLE; step++) {
      assertChipsConserved(t.state);
      if (chance(rng, VIEW_CHECK_PERCENT)) {
        assertViewsKeepSecrets(t);
      }

      if (chance(rng, 6)) {
        randomSideEvent(t, rng);
        continue;
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
        continue;
      }

      if (hand?.stage === 'ritVote' && chance(rng, 70)) {
        const voter = hand.players.find((p) => !p.folded && p.ritVote === null)!;
        t.cmd(seatOwnerIndex(t, voter.seat), { type: 'ritVote', agree: chance(rng, 85) });
        continue;
      }

      if (deadline !== null) {
        t.wait(Math.max(0, deadline - t.now));
        continue;
      }

      // Nothing is scheduled: the table is short of players, so someone comes back or buys chips
      randomSideEvent(t, rng);
    }

    assertChipsConserved(t.state);
    handsPlayed += assertHandRecordsBalance(t.effects);

    for (const effect of t.effects) {
      if (effect.type === 'hand') {
        showdowns += effect.record.result.uncontested ? 0 : 1;
        runTwice += effect.record.boards.length > 1 ? 1 : 0;
        bounties += effect.record.result.bounty ? 1 : 0;
      }
    }
  }

  // The run only proves something if it actually reached the interesting parts of the game
  const reached = `${handsPlayed} hands, ${showdowns} showdowns, ${runTwice} run twice, ${bounties} bounties`;
  assert.ok(handsPlayed >= TABLES * 30, reached);
  assert.ok(showdowns >= TABLES * 10, reached);
  assert.ok(runTwice >= TABLES, reached);
  assert.ok(bounties >= 1, reached);
});
