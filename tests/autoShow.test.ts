import assert from 'node:assert/strict';
import { test } from 'node:test';

import { spotsOf } from '../src/client/tableChances.ts';
import { addMember, handFacts, replayHand } from '../src/engine/index.ts';
import type { AutoShow, Command, HandRecord, TableConfig } from '../src/engine/index.ts';
import { ACES, BOARD, checkAround, handRecords, KINGS, QUEENS, TestTable } from './helpers.ts';
import { assertInvariants, assertViewsKeepSecrets } from './invariants.ts';

const NAMES = ['Pam', 'Stu', 'Kim', 'Ann'];
// On the first board aces beat kings beat queens; on the second a king makes the kings three of a kind
const SECOND = 'Kd 4c 5h 8s Td';

function table(stacks: number[], config: Partial<TableConfig> = {}): TestTable {
  return new TestTable({ stacks, config, names: NAMES });
}

function choose(t: TestTable, player: number, when: AutoShow, on = true): void {
  t.cmd(player, { type: 'setAutoShow', when, on });
}

/** Plays the hand on the table to its result: the players given cards call and check, everyone else folds. */
function playDown(t: TestTable, holes: Record<number, string>): void {
  while (t.state.hand?.stage === 'betting') {
    const seat = t.toAct!;
    const player = t.playerIn(seat);

    if (!(seat in holes)) {
      t.fold(player);
    } else if (t.view(player).hand!.options!.canCheck) {
      t.check(player);
    } else {
      t.call(player);
    }
  }

  t.runToResult();
}

/** A hand dealt with the button on seat 0 and played down to its showdown. */
function showDown(t: TestTable, holes: Record<number, string>, board = BOARD): void {
  t.deal({ button: 0, holes, board });
  playDown(t, holes);
}

/** Who was turned up and who mucked, in the order it happened. */
const reveals = (t: TestTable) => t.state.hand!.events.flatMap((event) => (event[0] === 'show' || event[0] === 'muck' ? [`${event[0]} ${event[1]}`] : []));

const lastRecord = (t: TestTable): HandRecord => handRecords(t.effects).at(-1)!;

test('at a showdown a loser who chose to show is turned up in their turn, one who did not mucks, and the hands that had to be shown come in the same order as with nobody choosing', () => {
  // Queens show first, the fours and the fives cannot beat them, and the aces can
  const holes = { 0: '5c 5d', 1: 'Qd Qc', 2: '4h 4d', 3: ACES };
  const play = (choices: [player: number, when: AutoShow][]) => {
    const t = table([1000, 1000, 1000, 1000]);
    choices.forEach(([player, when]) => choose(t, player, when));
    showDown(t, holes);

    return t;
  };

  const nobody = play([]);
  assert.deepEqual(reveals(nobody), ['show 1', 'muck 2', 'show 3', 'muck 0']);

  // Kim shows her losers, and so does Ann, who wins; Pam chose only to show when everyone folds to her
  const some = play([[2, 'lost'], [3, 'lost'], [0, 'foldedTo']]);
  assert.deepEqual(reveals(some), ['show 1', 'show 2', 'show 3', 'muck 0']);
  assert.deepEqual(some.state.hand!.log.slice(-5, -1), ['Stu shows Q♦ Q♣ (Pair of queens)', 'Kim shows 4♥ 4♦ (Pair of fours)', 'Ann shows A♠ A♥ (Pair of aces)', 'Pam mucks']);

  // What the losers showed changes nothing of who was paid
  assert.deepEqual(some.state.hand!.result!.winnings, nobody.state.hand!.result!.winnings);
  assert.deepEqual(some.stacks(), nobody.stacks());
  assert.deepEqual(some.view(0).seats[2]!.cards, ['4h', '4d']);
  assert.deepEqual(some.view(2).seats[0]!.cards, [null, null]);
  assertInvariants(some.state, some.now);
});

test('a player who lost the main pot but wins a side pot is always turned up; the choice decides only for one who can win nothing', () => {
  for (const chose of [false, true]) {
    // Stu is all in for 100 with aces; Kim's kings lose the main pot to them and win the side pot from Pam's queens
    const t = table([1000, 100, 1000]);

    if (chose) {
      choose(t, 0, 'lost');
    }

    t.deal({ button: 0, holes: { 0: QUEENS, 1: ACES, 2: KINGS }, board: BOARD });
    t.call(0);
    t.raise(1, 100);
    t.call(2);
    t.call(0);
    t.raise(2, 100);
    t.call(0);
    checkAround(t, [2, 0], 2);
    t.runToResult();

    assert.equal(t.state.hand!.result!.pots.length, 2);
    assert.deepEqual(reveals(t), ['show 1', 'show 2', chose ? 'show 0' : 'muck 0']);
    assert.deepEqual(t.state.hand!.result!.winnings.map((win) => win.seat).sort(), [1, 2]);
  }
});

test('a bomb pot checked down is a showdown like any: on one board a loser shows by choice, and on two "can win nothing" is on every board', () => {
  const holes = { 0: QUEENS, 1: ACES, 2: KINGS };
  const play = (boards: 'one' | 'two', chooser: number) => {
    const t = table([1000, 1000, 1000], { bombPotBoards: boards });
    choose(t, chooser, 'lost');
    t.cmd(0, { type: 'setBombPot', on: true });
    t.deal({ button: 0, holes, board: BOARD, secondBoard: boards === 'two' ? SECOND : undefined });
    checkAround(t, [1, 2, 0], 3);
    t.runToResult();

    return t;
  };

  // On one board the kings and the queens both lose to the aces, and only Kim chose to show
  assert.deepEqual(reveals(play('one', 2)), ['show 1', 'show 2', 'muck 0']);

  // On two the kings lose the first board but make three of a kind on the second, so they are turned up without being chosen;
  // the queens lose both, and are shown only when Pam chose to
  assert.deepEqual(reveals(play('two', 1)), ['show 1', 'show 2', 'muck 0']);
  const two = play('two', 0);
  assert.deepEqual(reveals(two), ['show 1', 'show 2', 'show 0']);
  assert.deepEqual(
    two.state.hand!.log.filter((line) => line.startsWith('Pam shows')),
    ['Pam shows Q♠ Q♥ (Pair of queens / Pair of queens)'],
  );
  assert.deepEqual(two.state.hand!.result!.hands.filter((hand) => hand.seat === 0).map((hand) => hand.run), [0, 1]);
});

test('a split pot: a player who ties is turned up whatever they chose, and a loser beside them by their choice', () => {
  const holes = { 0: '4h 5h', 1: 'As Kd', 2: 'Ac Kh' };
  const t = table([1000, 1000, 1000]);
  choose(t, 0, 'lost');
  showDown(t, holes);

  assert.deepEqual(reveals(t), ['show 1', 'show 2', 'show 0']);
  assert.deepEqual(t.state.hand!.result!.winnings.map((win) => win.seat).sort(), [1, 2]);
});

test('an all-in runout turns every hand up before it, on one board or three, so the choices change nothing: not the events, the play-by-play, the result or the chances shown', () => {
  for (const maxRuns of [1, 3] as const) {
    const play = (choices: boolean) => {
      const t = table([1000, 1000, 1000], { maxRuns });

      if (choices) {
        [0, 1, 2].forEach((player) => (['lost', 'foldedTo'] as const).forEach((when) => choose(t, player, when)));
      }

      t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS } });
      t.raise(0, 1000);
      t.call(1);
      t.call(2);
      [0, 1, 2].forEach((player) => maxRuns > 1 && t.cmd(player, { type: 'ritVote', runs: 3 }));
      const chances = spotsOf(t.view(0));
      t.runToResult();

      return { t, chances };
    };

    const [off, on] = [play(false), play(true)];
    assert.equal(off.t.state.hand!.runs, maxRuns);
    assert.ok(off.chances !== null);
    assert.deepEqual(on.chances, off.chances);
    assert.deepEqual(on.t.state.hand!.events, off.t.state.hand!.events);
    assert.deepEqual(on.t.state.hand!.log, off.t.state.hand!.log);
    assert.deepEqual(on.t.state.hand!.result, off.t.state.hand!.result);
    assert.ok(!on.t.state.hand!.events.some((event) => event[0] === 'muck'));
  }
});

/** Pam raises with aces and everyone folds to her. */
function foldedToPam(choose: (t: TestTable) => void, config: Partial<TableConfig> = {}, holes = ACES): TestTable {
  const t = table([1000, 1000, 1000], config);
  choose(t);
  t.deal({ button: 0, holes: { 0: holes } });
  t.raise(0, 60);
  t.fold(1);
  t.fold(2);

  return t;
}

test('everyone folding to a player who chose to show turns both cards up as the hand ends, as pressing Both would, and holds the next deal back no longer', () => {
  const off = foldedToPam(() => {});
  const on = foldedToPam((t) => choose(t, 0, 'foldedTo'));

  assert.deepEqual(on.state.hand!.events.slice(0, -1), off.state.hand!.events);
  assert.deepEqual(on.state.hand!.events.at(-1), ['show', 0, ['As', 'Ah']]);
  assert.equal(on.feedText().at(-1), 'Pam shows A♠ A♥');
  assert.equal(on.state.hand!.deadline, off.state.hand!.deadline);

  // The buttons to show are gone, as nothing is left to show; the other players see the cards
  assert.deepEqual([on.view(0).hand!.canShow, off.view(0).hand!.canShow], [false, true]);
  assert.deepEqual([on.view(1).seats[0]!.cards, off.view(1).seats[0]!.cards], [['As', 'Ah'], [null, null]]);

  // A show by choice: in the record, but no hand shown down
  on.finishHand();
  const facts = handFacts(lastRecord(on));
  assert.deepEqual([facts.ended, facts.players[0]!.cards, facts.players[0]!.shown], ['folds', ['As', 'Ah'], []]);
  assert.deepEqual(lastRecord(on).players[0]!.cards, ['As', 'Ah']);
  assert.equal(on.state.tonight.players[on.ids[0]!]!.best, null);
  assert.equal(on.state.tonight.highHand.best, null);
});

test('a walk is everyone folding to the big blind, who shows by their choice; a hand the blinds chop has no winner and shows nothing', () => {
  const walk = table([1000, 1000, 1000]);
  choose(walk, 2, 'foldedTo');
  walk.deal({ button: 0, holes: { 2: KINGS } });
  walk.fold(0);
  walk.fold(1);
  assert.deepEqual([walk.state.hand!.stage, walk.state.hand!.events.at(-1)], ['done', ['show', 2, ['Ks', 'Kh']]]);

  const chop = table([1000, 1000, 1000], { allowChop: true });
  [1, 2].forEach((player) => (['lost', 'foldedTo'] as const).forEach((when) => choose(chop, player, when)));
  chop.deal({ button: 0 });
  chop.fold(0);
  chop.cmd(1, { type: 'offerChop' });
  chop.cmd(2, { type: 'answerChop', agree: true });
  assert.ok(chop.state.hand!.result!.chopped);
  assert.ok(!chop.state.hand!.events.some((event) => event[0] === 'show' || event[0] === 'muck'));
});

test('seven-deuce: a bounty turns the hand up either way, without a bounty the choice shows it and earns the badge, and a losing one shown earns nothing', () => {
  const sevenDeuce = '7s 2d';
  const badges = (t: TestTable, player: number) => t.state.tonight.players[t.ids[player]!]?.badges ?? {};

  // With a bounty the hand is turned up to collect it, and the choice has nothing left to show
  const bounty = { sevenDeuceBounty: 50 };
  const paidOff = foldedToPam(() => {}, bounty, sevenDeuce);
  const paidOn = foldedToPam((t) => choose(t, 0, 'foldedTo'), bounty, sevenDeuce);
  assert.deepEqual(paidOn.state.hand!.events, paidOff.state.hand!.events);
  assert.equal(paidOn.state.hand!.events.filter((event) => event[0] === 'show').length, 1);
  assert.ok(paidOn.state.hand!.result!.bounty);

  // Without one, the choice shows it as Both would, which the badge counts
  const shown = foldedToPam((t) => choose(t, 0, 'foldedTo'), {}, sevenDeuce);
  const kept = foldedToPam(() => {}, {}, sevenDeuce);
  shown.finishHand();
  kept.finishHand();
  assert.deepEqual([badges(shown, 0), badges(kept, 0)], [{ sevenDeuce: 1 }, {}]);

  // Shown at a showdown it lost, it collects no bounty and earns no badge
  const lost = table([1000, 1000, 1000], bounty);
  choose(lost, 0, 'lost');
  showDown(lost, { 0: sevenDeuce, 1: ACES, 2: KINGS }, 'Qc 9h Jc 3s 4d');
  assert.deepEqual(reveals(lost), ['show 1', 'muck 2', 'show 0']);
  assert.equal(lost.state.hand!.result!.bounty, null);
  lost.finishHand();
  assert.deepEqual(badges(lost, 0), {});
});

test('a player sitting out, away on the clock or leaving their seat when the hand ends still has their choice carried out', () => {
  const holes = { 0: KINGS, 1: ACES, 2: QUEENS };

  // Kim asks to sit out from the next hand while this one is played
  const sittingOut = table([1000, 1000, 1000]);
  choose(sittingOut, 2, 'lost');
  sittingOut.deal({ button: 0, holes, board: BOARD });
  sittingOut.cmd(2, { type: 'sitOut' });
  playDown(sittingOut, holes);
  assert.deepEqual(reveals(sittingOut), ['show 1', 'show 2', 'muck 0']);

  // Kim runs out of time in the big blind, and is checked down from then on
  const away = table([1000, 1000, 1000], { actionSeconds: 30 });
  choose(away, 2, 'lost');
  away.deal({ button: 0, holes, board: BOARD });
  away.call(0);
  away.call(1);
  away.wait(away.state.hand!.deadline! - away.now);
  assert.ok(away.state.seats[2]!.away);
  checkAround(away, [1, 0], 3);
  away.runToResult();
  assert.deepEqual(reveals(away), ['show 1', 'show 2', 'muck 0']);

  // Kim stands up on the flop, and her hand plays on without her
  const leaving = table([1000, 1000, 1000]);
  choose(leaving, 2, 'lost');
  leaving.deal({ button: 0, holes, board: BOARD });
  leaving.call(0);
  leaving.call(1);
  leaving.check(2);
  leaving.cmd(2, { type: 'standUp' });
  assert.ok(leaving.state.seats[2]!.leaving);
  checkAround(leaving, [1, 0], 3);
  leaving.runToResult();
  assert.deepEqual(reveals(leaving), ['show 1', 'show 2', 'muck 0']);
});

test('a choice changed during a hand holds for that hand, since it is read as the hand ends; once the hand is over it turns nothing up', () => {
  const holes = { 0: KINGS, 1: ACES, 2: QUEENS };
  const t = table([1000, 1000, 1000]);
  choose(t, 0, 'lost');
  t.deal({ button: 0, holes, board: BOARD });
  t.call(0);
  t.call(1);
  t.check(2);
  checkAround(t, [1, 2, 0], 2);

  // On the river Kim switches it on and Pam off
  choose(t, 2, 'lost');
  choose(t, 0, 'lost', false);
  checkAround(t, [1, 2, 0], 1);
  t.runToResult();
  assert.deepEqual(reveals(t), ['show 1', 'show 2', 'muck 0']);

  // Switched on after the hand is over, it shows nothing: Pam can still press to show
  choose(t, 0, 'lost');
  choose(t, 0, 'foldedTo');
  assert.deepEqual(reveals(t), ['show 1', 'show 2', 'muck 0']);
  assert.equal(t.view(0).hand!.canShow, true);
});

/** Stu's straight flush beats Kim's four kings, and Pam's junk. Kim shows her quads only if she chose to. */
function quadsLose(chose: boolean, config: Partial<TableConfig> = {}): TestTable {
  const t = table([1000, 1000, 1000], config);

  if (chose) {
    choose(t, 2, 'lost');
  }

  showDown(t, { 0: '3d 4d', 1: 'Qc 2h', 2: 'Ks Kh' }, 'Kc Kd 9c Tc Jc');
  assert.deepEqual(reveals(t), ['show 1', chose ? 'show 2' : 'muck 2', 'muck 0']);
  t.finishHand();

  return t;
}

test('a loser shown by choice is a hand shown down in its facts, as any hand turned up at a showdown is', () => {
  const shown = handFacts(lastRecord(quadsLose(true))).players[2]!;
  assert.deepEqual([shown.cards, shown.shown.map((hand) => hand.name)], [['Ks', 'Kh'], ['Four kings']]);

  const mucked = handFacts(lastRecord(quadsLose(false))).players[2]!;
  assert.deepEqual([mucked.cards, mucked.shown], [[null, null], []]);
});

test('a loser shown by choice is in the history and the replay of the record, where a muck was', () => {
  const shown = lastRecord(quadsLose(true));
  assert.ok(shown.summary.split('\n').includes('Kim shows K♠ K♥ (Four kings)'));
  assert.ok(!shown.summary.includes('Kim mucks'));
  assert.deepEqual(replayHand(shown.events)!.seats[2]!.cards, ['Ks', 'Kh']);

  const mucked = lastRecord(quadsLose(false));
  assert.ok(mucked.summary.split('\n').includes('Kim mucks'));
  assert.deepEqual(replayHand(mucked.events)!.seats[2]!.cards, [null, null]);
});

test('a loser shown by choice counts as the player’s best hand tonight', () => {
  const best = (t: TestTable) => t.state.tonight.players[t.ids[2]!]!.best;

  assert.deepEqual(best(quadsLose(true)), ['Kc', 'Kd', 'Ks', 'Kh', 'Jc']);
  assert.equal(best(quadsLose(false)), null);
});

test('losing quads shown by choice earn Quads and a Cooler, as any quads turned up at a showdown do', () => {
  const badges = (t: TestTable) => t.state.tonight.players[t.ids[2]!]!.badges;

  assert.deepEqual(badges(quadsLose(true)), { quads: 1, cooler: 1 });
  assert.deepEqual(badges(quadsLose(false)), {});
});

test('a loser shown by choice counts toward the high hand: with the holder gone, it is the best hand of anyone seated and collects the bonus', () => {
  for (const chose of [true, false]) {
    const t = quadsLose(chose, { highHandBonus: 20 });
    assert.deepEqual(t.state.tonight.highHand.best?.playerIds, [t.ids[1]]);
    assert.equal(t.ids[2]! in t.state.tonight.highHand.sincePaid, chose);

    t.cmd(1, { type: 'standUp' });
    const before = t.stacks();
    t.cmd(0, { type: 'endNight' });

    assert.equal(t.stacks()[2]! - before[2]!, chose ? 20 : 0);
  }
});

test('the choices are in the chooser’s own view and nobody else’s, a watcher’s included', () => {
  const t = table([1000, 1000, 1000]);
  const watcher = t.ids.push(addMember(t.state, 'Kibitz', t.ctx()).id) - 1;
  const seen = (player: number) => ({ ...t.view(player), version: 0 });
  const before = [0, 2, watcher].map(seen);

  choose(t, 1, 'foldedTo');
  choose(t, 1, 'lost');

  assert.deepEqual(t.view(1).you.autoShow, ['lost', 'foldedTo']);
  assert.deepEqual([0, 2, watcher].map(seen), before);
  assertViewsKeepSecrets(t.state, t.now);
});

test('a choice is set on or off one at a time, by a player with a seat, in any state of the hand, and a malformed one is refused', () => {
  const t = table([1000, 1000, 1000]);
  const watcher = t.ids.push(addMember(t.state, 'Kibitz', t.ctx()).id) - 1;

  assert.throws(() => choose(t, watcher, 'lost'), { message: 'You need a seat for that' });

  for (const bad of [{ when: 'always', on: true }, { when: 'lost', on: 'yes' }, { on: true }]) {
    assert.throws(() => t.cmd(1, { type: 'setAutoShow', ...bad } as unknown as Command), JSON.stringify(bad));
  }

  choose(t, 1, 'foldedTo');
  choose(t, 1, 'foldedTo');
  choose(t, 1, 'lost');
  assert.deepEqual(t.state.seats[1]!.autoShow, ['lost', 'foldedTo']);

  t.deal({ button: 0 });
  choose(t, 1, 'lost', false);
  assert.deepEqual(t.state.seats[1]!.autoShow, ['foldedTo']);
});

test('the choices stay with a seat moved by the host and through a bust and a rebuy, and a player who stands up and sits again starts with none', () => {
  const t = table([1000, 1000, 1000]);
  choose(t, 1, 'lost');
  choose(t, 1, 'foldedTo');

  t.cmd(0, { type: 'moveSeat', playerId: t.ids[1]!, seat: 5 });
  assert.deepEqual(t.state.seats[5]!.autoShow, ['lost', 'foldedTo']);

  t.cmd(0, { type: 'setStack', playerId: t.ids[1]!, stack: 0 });
  t.cmd(1, { type: 'requestRebuy', amount: 500 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  assert.deepEqual([t.state.seats[5]!.stack, t.state.seats[5]!.autoShow], [500, ['lost', 'foldedTo']]);

  t.cmd(1, { type: 'standUp' });
  t.cmd(1, { type: 'requestSeat', seat: 5, buyIn: 500 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  assert.deepEqual(t.state.seats[5]!.autoShow, []);
});
