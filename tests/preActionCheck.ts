/*
 * Holds a table to what its players chose ahead of their turns (pre-actions), whatever plays it. Every
 * change made to the table while someone has a move chosen is made again on a copy where nobody has,
 * and there each move the table played for a player is tapped by that player on their turn instead.
 * The two must come out the same hand, card for card and chip for chip, with the same records.
 */
import assert from 'node:assert/strict';

import { act, applyCommand, bettingOptions, PRE_ACTIONS, tick } from '../src/engine/index.ts';
import type { BettingAction, BettingOptions, Command, Ctx, Effect, PreAction, PreActionKind, TableState } from '../src/engine/index.ts';
import type { TestTable } from './helpers.ts';

/** How many moves the table played for a player, by what they had chosen. */
export type PlayedAhead = Record<PreActionKind, number>;

/**
 * The one move a choice stands for with these options, or null when it stands for none of them. Said
 * here apart from the engine: a check never pays, a call pays the amount it was chosen for and no other.
 */
function moveFor([what, amount]: PreAction, options: BettingOptions): BettingAction['type'] | null {
  const free = options.canCheck;

  return {
    checkFold: free ? 'check' : 'fold',
    check: free ? 'check' : null,
    call: !free && options.callAmount === amount ? 'call' : null,
    callAny: free ? 'check' : 'call',
    fold: 'fold',
  }[what] as BettingAction['type'] | null;
}

function withoutChoices(state: TableState): TableState {
  const copy = structuredClone(state);

  copy.hand?.players.forEach((player) => delete player.pre);

  return copy;
}

/**
 * Makes `change`, which the table has just been through (as `run`), again on the table as it was
 * `before`, with nothing chosen ahead: whenever that leaves a player on the clock who had chosen,
 * and the table went on, they tap the move the table made for them.
 */
function playedByHand(t: TestTable, before: TableState, change: (state: TableState, ctx: Ctx) => void, ctx: Ctx, played: PlayedAhead): void {
  const chosen = new Map(before.hand!.players.flatMap((player) => (player.pre ? [[player.seat, player.pre] as const] : [])));
  const hand = before.hand!;

  hand.players.forEach((player) => delete player.pre);
  change(before, ctx);

  for (;;) {
    const made = t.state.hand!.events[hand.events.length];
    const choice = hand.stage === 'betting' && hand.toAct !== null ? chosen.get(hand.toAct) : undefined;

    if (made === undefined || choice === undefined) {
      break;
    }

    const seat = hand.toAct!;
    const player = hand.players.find((p) => p.seat === seat)!;
    const move = moveFor(choice, bettingOptions(before, hand, player));
    const told = `hand ${hand.number}: ${player.name} had chosen ${JSON.stringify(choice)} and the table played ${JSON.stringify(made)}`;

    assert.notEqual(move, null, `${told}, which they did not choose`);
    assert.deepEqual(made.slice(0, 2), [move, seat], told);
    assert.ok(move !== 'call' || choice[0] !== 'call' || made[2] === choice[1], `${told}: a call for another amount`);

    // Legal for them then, by the rules a tapped move is held to
    act(before, ctx, seat, { type: move } as BettingAction);
    chosen.delete(seat);
    played[choice[0]] += 1;
  }

  assert.deepEqual(before, withoutChoices(t.state), `hand ${hand.number}: the moves chosen ahead made another hand than the same moves tapped`);
}

/** Nothing played yet, for `holdToWhatWasChosen` to count from. */
export const nonePlayedAhead = (): PlayedAhead => Object.fromEntries(PRE_ACTIONS.map((what) => [what, 0])) as PlayedAhead;

/**
 * From here on, everything done to `t` through `cmd` and `wait` is checked as above, and choosing a
 * move changes nothing of the table but the choice. Each move played for a player is added to `played`.
 */
export function holdToWhatWasChosen(t: TestTable, played: PlayedAhead = nonePlayedAhead()): void {
  const cmd = t.cmd.bind(t);
  const wait = t.wait.bind(t);

  // The key a choice was sent under is remembered with it, and is no more of the game than the choice
  const besidesTheChoice = (state: TableState): TableState => ({ ...withoutChoices(state), asked: [] });

  const choosing = (run: () => void): void => {
    const before = besidesTheChoice(t.state);
    const effectsBefore = t.effects.length;

    run();

    assert.deepEqual(besidesTheChoice(t.state), before, 'choosing a move ahead changed more of the table than the choice');
    assert.equal(t.effects.length, effectsBefore, 'choosing a move ahead wrote to the ledger or the hand records');
  };

  const checked = (run: () => void, change: (state: TableState, ctx: Ctx) => void): void => {
    if (!t.state.hand?.players.some((player) => player.pre)) {
      run();
      return;
    }

    const before = structuredClone(t.state);
    const effectsBefore = t.effects.length;
    const real = t.rng;
    const drawn: number[] = [];

    t.rng = {
      int: (maxExclusive) => {
        drawn.push(real.int(maxExclusive));

        return drawn.at(-1)!;
      },
    };

    try {
      run();
    } finally {
      t.rng = real;
    }

    const effects: Effect[] = [];
    playedByHand(t, before, change, { now: t.now, effects, rng: { int: () => drawn.shift() ?? assert.fail('the hand drew differently when its moves were tapped') } }, played);

    assert.deepEqual(effects, t.effects.slice(effectsBefore), 'the moves chosen ahead left other records than the same moves tapped');
  };

  t.cmd = (seat: number, command: Command, key?: string) =>
    command.type === 'preAct' ? choosing(() => cmd(seat, command, key)) : checked(() => cmd(seat, command, key), (state, ctx) => applyCommand(state, ctx, t.ids[seat]!, command, key));
  t.wait = (ms: number) => checked(() => wait(ms), (state, ctx) => tick(state, ctx));
}
