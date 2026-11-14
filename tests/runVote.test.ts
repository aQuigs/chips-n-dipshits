import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOTKEYS } from '../src/client/hotkeys.ts';
import { CONFIG_SPECS, MOST_RUNS, timesText, timesToRun, TIMING, voteStory } from '../src/engine/index.ts';
import { assertChipsConserved, assertInvariants } from './invariants.ts';
import { ACES, BOARD, KINGS, QUEENS, TestTable } from './helpers.ts';

/** Everyone at a table of `players` all in before the flop, at a table that runs it up to `cap` times. */
function allIn(players: number, cap: 1 | 2 | 3): TestTable {
  const t = new TestTable({ stacks: Array.from({ length: players }, () => 500), config: { maxRuns: cap } });
  t.deal({ button: 0 });

  t.raise(t.toAct!, 500);
  while (t.state.hand!.stage === 'betting') {
    t.call(t.toAct!);
  }

  return t;
}

/** Every way `players` players can pick under `cap`: each picks a number up to it, or says nothing (null). */
function everyMix(players: number, cap: number): (number | null)[][] {
  const choices = [null, ...Array.from({ length: cap }, (_pick, nth) => nth + 1)];

  return Array.from({ length: players }).reduce<(number | null)[][]>((mixes) => mixes.flatMap((mix) => choices.map((pick) => [...mix, pick])), [[]]);
}

test('the count is the fewest picked under the cap, open until everyone has picked unless someone picked once', () => {
  assert.equal(timesToRun([3, 3], 3), 3);
  assert.equal(timesToRun([3, 2, 3], 3), 2);
  assert.equal(timesToRun([3, 3], 2), 2, 'a pick over the cap counts as the cap');
  assert.equal(timesToRun([3, null], 3), null, 'still waiting on a pick that could bring it down');
  assert.equal(timesToRun([null, 1, null], 3), 1, 'nobody can pick fewer than once');
  assert.equal(timesToRun([null, null], 1), 1, 'a table that runs it once has nothing to wait for');
});

test('every mix of picks and silence for two, three and four players under each cap comes to the fewest picked, a player who says nothing having picked once', () => {
  for (const cap of [1, 2, 3] as const) {
    for (const players of [2, 3, 4]) {
      for (const mix of everyMix(players, cap)) {
        const t = allIn(players, cap);
        const hand = t.state.hand!;
        const where = `${players} players up to ${cap}, picking ${mix.map((pick) => pick ?? '-').join(' ')}`;

        // A table that runs it once only asks nothing, and the rest is run out at once
        assert.equal(hand.stage, cap === 1 ? 'runout' : 'ritVote', where);

        mix.forEach((pick, seat) => {
          if (pick === null) {
            return;
          }

          if (hand.stage === 'ritVote') {
            t.cmd(seat, { type: 'ritVote', runs: pick });
          } else {
            assert.throws(() => t.cmd(seat, { type: 'ritVote', runs: pick }), { message: 'There is nothing to pick for you right now' }, where);
          }
        });

        if (hand.stage === 'ritVote') {
          assert.ok(mix.includes(null), `${where}: everyone picked and it is still open`);
          t.wait(TIMING.ritVoteMs);
        }

        const expected = Math.min(...mix.map((pick) => pick ?? 1));
        assert.deepEqual([hand.stage, hand.runs, hand.events.at(-1)], ['runout', expected, ['runs', expected]], where);

        t.runToResult();
        assert.equal(hand.boards.length, expected, where);
        assertChipsConserved(t.state);
      }
    }
  }
});

test('the play-by-play says what each player picked and how it came out', () => {
  const said = (mix: (number | null)[], cap: 2 | 3 = 3) => {
    const t = allIn(mix.length, cap);
    mix.forEach((pick, seat) => pick !== null && t.state.hand!.stage === 'ritVote' && t.cmd(seat, { type: 'ritVote', runs: pick }));
    if (t.state.hand!.stage === 'ritVote') {
      t.wait(TIMING.ritVoteMs);
    }

    return t.feedText().filter((line) => line.includes('running it'));
  };

  assert.deepEqual(said([3, 3, 3]), ['Everyone agreed: running it three times']);
  assert.deepEqual(said([2, 2], 2), ['Everyone agreed: running it twice']);
  assert.deepEqual(said([3, 2]), ['P0 picked three times, P1 twice: running it twice']);
  assert.deepEqual(said([3, 1, 2]), ['P0 picked three times, P1 once: running it once'], 'a pick of once settles it at once');
  assert.deepEqual(said([3, null, null]), ["P0 picked three times, P1 and P2 didn't pick in time: running it once"]);
  assert.deepEqual(said([null, null]), ["P0 and P1 didn't pick in time: running it once"]);

  assert.equal(voteStory([{ name: 'Dana', ritVote: 3 }, { name: 'Sam', ritVote: null }], 1, { why: 'left', name: 'Sam' }), 'Dana picked three times, Sam left without picking: running it once');
});

test('a player who folded has no pick, and the players still in decide it', () => {
  const t = new TestTable({ stacks: [500, 500, 500], config: { maxRuns: 3 } });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD });
  t.raise(0, 500);
  t.fold(1);
  t.call(2);

  assert.deepEqual([0, 1, 2].map((seat) => t.view(seat).hand!.canVote), [true, false, true]);
  assert.throws(() => t.cmd(1, { type: 'ritVote', runs: 1 }), { message: 'There is nothing to pick for you right now' });

  t.cmd(0, { type: 'ritVote', runs: 3 });
  t.cmd(2, { type: 'ritVote', runs: 3 });
  assert.equal(t.state.hand!.runs, 3);
});

test('a pick over what the table allows is refused, and a pick is made once', () => {
  const t = allIn(2, 2);

  assert.throws(() => t.cmd(0, { type: 'ritVote', runs: 3 }), { message: 'This table runs it twice at most' });
  t.cmd(0, { type: 'ritVote', runs: 2 });
  assert.throws(() => t.cmd(0, { type: 'ritVote', runs: 1 }), { message: 'You already picked' });
  assert.equal(t.state.hand!.stage, 'ritVote');
});

test('a player who leaves or is removed while the others pick has picked once; a pick they made first still stands', () => {
  const t = allIn(3, 3);
  t.cmd(0, { type: 'ritVote', runs: 3 });
  t.cmd(2, { type: 'standUp' });
  assert.deepEqual([t.state.hand!.stage, t.state.hand!.runs], ['runout', 1]);
  assert.ok(t.feedText().includes('P0 picked three times, P2 left without picking: running it once'));

  const removed = allIn(3, 3);
  removed.cmd(0, { type: 'kick', playerId: removed.ids[1]! });
  assert.deepEqual([removed.state.hand!.stage, removed.state.hand!.runs], ['runout', 1]);
  assert.ok(removed.feedText().includes('P1 left without picking: running it once'));

  const pickedFirst = allIn(3, 3);
  pickedFirst.cmd(1, { type: 'ritVote', runs: 3 });
  pickedFirst.cmd(1, { type: 'standUp' });
  pickedFirst.cmd(0, { type: 'ritVote', runs: 3 });
  pickedFirst.cmd(2, { type: 'ritVote', runs: 3 });
  assert.equal(pickedFirst.state.hand!.runs, 3);
  pickedFirst.finishHand();
  assertInvariants(pickedFirst.state, pickedFirst.now);
});

test('a hand is run on the terms it was dealt under: the most times changed while players pick waits for the next hand', () => {
  const lowered = allIn(2, 3);
  lowered.cmd(0, { type: 'ritVote', runs: 3 });
  lowered.cmd(0, { type: 'updateConfig', config: { maxRuns: 1 } });
  assert.equal(lowered.view(1).hand!.maxRuns, 3);
  lowered.cmd(1, { type: 'ritVote', runs: 3 });
  assert.equal(lowered.state.hand!.runs, 3);

  // Switched on during the betting, it is not offered until the next hand
  const t = new TestTable({ stacks: [500, 500, 2000], config: { maxRuns: 1 } });
  t.deal({ button: 0 });
  t.cmd(0, { type: 'updateConfig', config: { maxRuns: 3 } });
  t.raise(0, 500);
  t.call(1);
  t.fold(2);
  assert.deepEqual([t.state.hand!.stage, t.state.hand!.runs], ['runout', 1]);
  t.finishHand();

  t.deal();
  t.raise(t.toAct!, t.view(t.toAct!).hand!.options!.maxRaiseTo);
  while (t.state.hand!.stage === 'betting') {
    t.call(t.toAct!);
  }
  assert.deepEqual([t.state.hand!.stage, t.view(2).hand!.maxRuns], ['ritVote', 3]);
});

test('every list of how many times it can be run goes up to the most there is: the setting, the words and the keys', () => {
  const upTo = Array.from({ length: MOST_RUNS }, (_runs, nth) => nth + 1);

  assert.deepEqual(CONFIG_SPECS.maxRuns.options.map((option) => option.value), upTo);
  assert.ok(upTo.every((runs) => !timesText(runs).includes(String(runs))), 'each number has its word');
  assert.equal(HOTKEYS.runs.length, MOST_RUNS);
});
