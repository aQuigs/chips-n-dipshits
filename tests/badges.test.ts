import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, BADGES, badgeOf, countHand, earnBadges, handFacts } from '../src/engine/index.ts';
import type { HandFacts, TableState } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { ACES, BOARD, checkAround, handRecords, KINGS, QUEENS, TestTable } from './helpers.ts';
import { assertInvariants } from './invariants.ts';

// On the first board aces beat kings beat queens; on the second a king makes the kings three of a kind
const SECOND = 'Kd 4c 5h 8s Td';

const badgesOf = (t: TestTable, player: number): Record<string, number> => t.state.tonight.players[t.ids[player]!]?.badges ?? {};

/** Plays what `play` does and gives back the ids of the badges `player` earned meanwhile, in the order they are shown. */
function earnedIn(t: TestTable, player: number, play: () => void): string[] {
  const before = { ...badgesOf(t, player) };

  play();

  const after = badgesOf(t, player);

  return BADGES.map((badge) => badge.id).filter((id) => (after[id] ?? 0) > (before[id] ?? 0));
}

/** Seat 0 on the button and seat 2 in the big blind check a hand down to a showdown, the small blind folding. Seat 2 shows first. */
function checkDown(t: TestTable, holes: Record<number, string>, board: string): void {
  t.deal({ button: 0, holes, board });
  t.call(0);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);
  t.finishHand();
}

/** Seat 0 on the button raises to `to`, the small blind folds and seat 2 calls, aces against kings. */
function allIn(t: TestTable, to: number): void {
  t.deal({ button: 0, holes: { 0: ACES, 2: KINGS }, board: BOARD });
  t.raise(0, to);
  t.fold(1);
  t.call(2);
  t.finishHand();
}

/** Heads-up, seat 0 has the button and acts first: they raise and seat 1 folds, or they fold. */
function headsUp(t: TestTable, seat0Wins: boolean): void {
  t.deal({ button: 0 });

  if (seat0Wins) {
    t.raise(0, 60);
    t.fold(1);
  } else {
    t.fold(0);
  }

  t.finishHand();
}

/** Seat 2 goes all in for 100 against aces, loses it all, and buys 100 again. */
function bust(t: TestTable): void {
  allIn(t, 200);
  t.cmd(2, { type: 'requestRebuy', amount: 100 });
  t.cmd(0, { type: 'approve', playerId: t.ids[2]! });
}

/** A bomb pot of 100 on two boards, dealt with the button on seat 0, checked down by everyone in it. */
/** Seat 0's aces all in against seat 2's kings before the flop, run three times on these boards, the small blind folding. */
function runThreeTimes(thirdBoard: string): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { maxRuns: 3 } });
  t.deal({ button: 0, holes: { 0: ACES, 2: KINGS }, board: BOARD, secondBoard: SECOND.replace('Kd', '3d'), thirdBoard });
  t.raise(0, 1000);
  t.fold(1);
  t.call(2);
  t.cmd(0, { type: 'ritVote', runs: 3 });
  t.cmd(2, { type: 'ritVote', runs: 3 });

  return t;
}

function doubleBoard(holes: Record<number, string>, secondBoard: string): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bombPotBoards: 'two' } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, board: BOARD, secondBoard, holes });

  return t;
}

interface Case {
  said: string;
  /** The badges the player the case is about earned in its last hand. */
  earned(): string[];
}

const showdown = (said: string, holes: Record<number, string>, board: string, player: number): Case => ({
  said,
  earned: () => {
    const t = new TestTable({ stacks: [1000, 1000, 1000] });

    return earnedIn(t, player, () => checkDown(t, holes, board));
  },
});

const ROYAL = showdown('a royal flush made with their own ace and king', { 0: 'As Ks', 2: '2c 3d' }, 'Qs Js Ts 2h 3h', 0);
const KING_HIGH = showdown('a straight flush, king high, made with their own king', { 0: 'Ks 9s', 2: '2c 3d' }, 'Qs Js Ts 2h 3h', 0);
const QUADS_WON = showdown('four kings made with a pair of kings, that won', { 0: KINGS, 2: QUEENS }, 'Kd Kc 2s 7d 9h', 0);
// Seat 2 shows four kings first and loses them to seat 0's straight flush, king high, made with the queen of diamonds
const QUADS_LOST = showdown('four kings made with a pair of kings, beaten by a straight flush', { 0: 'Qd 2c', 2: KINGS }, 'Kd Kc 9d Td Jd', 2);
const BOARD_QUADS = (player: number) => showdown('four kings on the board that everyone plays, the ace kicker winning', { 0: 'As 3d', 2: 'Qs 4d' }, 'Ks Kh Kd Kc 2s', player);
const AIR = (player: number) => showdown('ace high against queen high', { 0: 'As Kd', 2: 'Qs 8h' }, BOARD, player);

/**
 * For every badge, hands that earn it and near misses that do not. Each case plays its hands at a
 * table of its own, through the engine as a game would.
 */
const CASES: Record<string, { earns: Case[]; misses: Case[] }> = {
  royal: {
    earns: [ROYAL],
    misses: [KING_HIGH, showdown('a royal flush on the board, which everyone plays', { 0: '2c 3d', 2: '4c 5d' }, 'As Ks Qs Js Ts', 0)],
  },
  straightFlush: {
    earns: [KING_HIGH, showdown('a straight flush that beat four of a kind', { 0: 'Qd 2c', 2: KINGS }, 'Kd Kc 9d Td Jd', 0)],
    misses: [ROYAL, showdown('a straight flush on the board, which everyone plays', { 0: '2c 3d', 2: '4c 5d' }, '9s Ts Js Qs Ks', 0)],
  },
  quads: {
    earns: [QUADS_WON, QUADS_LOST],
    misses: [BOARD_QUADS(0), showdown('a full house, kings full', { 0: KINGS, 2: QUEENS }, 'Kd 2c 2s 7d 9h', 0)],
  },
  cooler: {
    earns: [QUADS_LOST],
    misses: [QUADS_WON, BOARD_QUADS(2)],
  },
  bigPot: {
    earns: [
      {
        said: 'a pot of 100 big blinds and a half, all in against kings',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000, 1000] });

          return earnedIn(t, 0, () => allIn(t, 1000));
        },
      },
    ],
    misses: [
      {
        said: 'a pot of 99 big blinds',
        earned: () => {
          const t = new TestTable({ stacks: [985, 1000, 1000] });

          return earnedIn(t, 0, () => allIn(t, 985));
        },
      },
    ],
  },
  heater: {
    earns: [
      {
        said: 'three hands won in a row',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000] });
          headsUp(t, true);
          headsUp(t, true);

          return earnedIn(t, 0, () => headsUp(t, true));
        },
      },
      {
        said: 'two wins, a hand the blinds chopped, a win: nobody won the chop, so the run goes on',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000, 1000], config: { allowChop: true } });
          const winsFromTheButton = () => {
            t.deal({ button: 0 });
            t.raise(0, 60);
            t.foldOut();
          };

          winsFromTheButton();
          winsFromTheButton();
          t.deal({ button: 0 });
          t.fold(0);
          t.cmd(1, { type: 'offerChop' });
          t.cmd(2, { type: 'answerChop', agree: true });
          t.finishHand();
          assert.equal(handRecords(t.effects).at(-1)!.result.chopped?.length, 2, 'the blinds did not chop');

          return earnedIn(t, 0, winsFromTheButton);
        },
      },
    ],
    misses: [
      {
        said: 'a win, a fold, a win',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000] });
          headsUp(t, true);
          headsUp(t, false);

          return earnedIn(t, 0, () => headsUp(t, true));
        },
      },
      {
        said: 'a win, a hand sat out, two wins',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000, 1000] });
          const winsFromTheButton = () => {
            t.deal({ button: 0 });
            t.raise(0, 60);
            t.foldOut();
          };

          winsFromTheButton();
          t.cmd(0, { type: 'sitOut' });
          t.deal({ button: 1 });
          t.foldOut();
          t.cmd(0, { type: 'sitIn' });
          winsFromTheButton();

          return earnedIn(t, 0, winsFromTheButton);
        },
      },
    ],
  },
  felted: {
    earns: [
      {
        said: 'aces that took all of the kings',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000, 500] });

          return earnedIn(t, 0, () => allIn(t, 1000));
        },
      },
    ],
    misses: [
      {
        said: 'a player broken by two winners who split the pot',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000, 300] });

          return earnedIn(t, 0, () => {
            t.deal({ button: 0, holes: { 0: 'Ah Ks', 1: 'Ac Kh', 2: QUEENS }, board: 'Ad Kc 2s 7h 9c' });
            t.raise(0, 300);
            t.call(1);
            t.call(2);
            checkAround(t, [1, 0], 3);
            t.finishHand();
          });
        },
      },
      {
        said: 'aces that took some of the kings',
        earned: () => {
          const t = new TestTable({ stacks: [500, 1000, 1000] });

          return earnedIn(t, 0, () => allIn(t, 500));
        },
      },
    ],
  },
  scoop: {
    earns: [
      {
        said: 'aces that won all three boards of a hand run three times',
        earned: () => {
          const t = runThreeTimes('6d 9c Qs 2h 8h');

          return earnedIn(t, 0, () => t.finishHand());
        },
      },
      {
        said: 'aces that won both boards',
        earned: () => {
          const t = doubleBoard({ 0: ACES, 1: QUEENS, 2: KINGS }, 'Jd 4c 5h 8s Td');

          return earnedIn(t, 0, () => {
            checkAround(t, [1, 2, 0], 3);
            t.finishHand();
          });
        },
      },
    ],
    misses: [
      {
        said: 'aces that won one board of two, the kings taking the other',
        earned: () => {
          const t = doubleBoard({ 0: ACES, 1: QUEENS, 2: KINGS }, SECOND);

          return earnedIn(t, 0, () => {
            checkAround(t, [1, 2, 0], 3);
            t.finishHand();
          });
        },
      },
      {
        said: 'aces that won two boards of three, the kings taking the third',
        earned: () => {
          const t = runThreeTimes('Kc 9c Qs 2h 8h');

          return earnedIn(t, 0, () => t.finishHand());
        },
      },
      {
        said: 'every chip of a hand on two boards that everyone folded to',
        earned: () => {
          const t = doubleBoard({ 0: ACES }, SECOND);

          return earnedIn(t, 1, () => {
            t.raise(1, 100);
            t.fold(2);
            t.fold(0);
            t.finishHand();
          });
        },
      },
    ],
  },
  sevenDeuce: {
    earns: [
      showdown('seven-deuce, two pair, that won a showdown', { 0: '7s 2d', 2: 'Ks Qh' }, '7c 2h 9h Jc 3s', 0),
      {
        said: 'seven-deuce that everyone folded to, shown for the bounty',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000, 1000], config: { sevenDeuceBounty: 50 } });

          return earnedIn(t, 0, () => {
            t.deal({ button: 0, holes: { 0: '7s 2d' } });
            t.raise(0, 60);
            t.foldOut();
          });
        },
      },
    ],
    misses: [
      showdown('seven-deuce, a pair of sevens, that lost to kings', { 0: KINGS, 2: '7s 2d' }, '7c 4h 9h Jc 3s', 2),
      showdown('seven-deuce that split the pot playing the board', { 0: '7s 2d', 2: '7c 2h' }, 'As Kd Qh Jc 9s', 0),
      {
        said: 'seven-deuce run three times that won two boards and lost the third, which a main pot of two chips left with nothing',
        earned: () => {
          const t = new TestTable({ stacks: [1, 500], config: { smallBlind: 1, bigBlind: 2, sevenDeuceBounty: 50, maxRuns: 3 } });

          return earnedIn(t, 0, () => {
            t.deal({ button: 0, holes: { 0: '7h 2c', 1: 'Jh Td' }, board: '7d 7s 2h 9c 4d', secondBoard: '7c 2d 5s 8h Ad', thirdBoard: 'Js Kc Qd 5c 3h' });
            while (t.state.hand!.stage === 'betting') {
              t.call(t.toAct!);
            }
            t.cmd(0, { type: 'ritVote', runs: 3 });
            t.cmd(1, { type: 'ritVote', runs: 3 });
            t.finishHand();
          });
        },
      },
      {
        said: 'seven-deuce that everyone folded to and that was never shown, with no bounty',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000, 1000] });

          return earnedIn(t, 0, () => {
            t.deal({ button: 0, holes: { 0: '7s 2d' } });
            t.raise(0, 60);
            t.foldOut();
          });
        },
      },
    ],
  },
  airBall: {
    earns: [AIR(0)],
    misses: [showdown('aces, a pair, that won', { 0: ACES, 2: KINGS }, BOARD, 0), AIR(2)],
  },
  atm: {
    earns: [
      {
        said: 'broke for the third time',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000, 100] });
          bust(t);
          bust(t);

          return earnedIn(t, 2, () => bust(t));
        },
      },
    ],
    misses: [
      {
        said: 'broke twice, and a rebuy',
        earned: () => {
          const t = new TestTable({ stacks: [1000, 1000, 100] });
          bust(t);

          return earnedIn(t, 2, () => bust(t));
        },
      },
    ],
  },
};

test('every badge has a hand that earns it and a near miss that does not, and each case says so', () => {
  assert.deepEqual(Object.keys(CASES).sort(), BADGES.map((badge) => badge.id).sort(), 'a badge without cases, or cases for a badge that is gone');

  for (const badge of BADGES) {
    const { earns, misses } = CASES[badge.id]!;
    assert.ok(earns.length > 0 && misses.length > 0, `${badge.id} needs a hand that earns it and one that only nearly does`);

    for (const each of earns) {
      assert.ok(each.earned().includes(badge.id), `${badge.id} should be earned by ${each.said}`);
    }

    for (const each of misses) {
      assert.ok(!each.earned().includes(badge.id), `${badge.id} should not be earned by ${each.said}`);
    }
  }
});

test('every badge has an id of its own, a name, a mark and a description', () => {
  assert.equal(new Set(BADGES.map((badge) => badge.id)).size, BADGES.length);
  assert.equal(new Set(BADGES.map((badge) => badge.mark)).size, BADGES.length);

  for (const badge of BADGES) {
    assert.match(badge.id, /^[a-zA-Z]+$/);
    assert.ok(badge.name.length > 0 && badge.name.length <= 16, badge.id);
    assert.ok(badge.description.endsWith('.'), badge.id);
    assert.equal(badgeOf(badge.id), badge);
  }
});

/**
 * Emoji a phone of any age draws: each in Unicode 6.0 (2010) or before. A phone without an emoji draws
 * a blank box in its place, and beside a name the mark is all there is, so a new badge's mark joins this
 * list only once it is checked to be as old.
 */
const OLD_MARKS = new Set(['💎', '🚽', '🍀', '💰', '🔥', '💀', '🍦', '💩', '🍔', '❄️', '🏧']);

test('every mark is one emoji that every phone has', () => {
  const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

  for (const badge of BADGES) {
    assert.equal([...graphemes.segment(badge.mark)].length, 1, `${badge.id}: ${badge.mark} is more than one mark`);
    assert.ok(OLD_MARKS.has(badge.mark), `${badge.id}: ${badge.mark} is not known to be drawn on every phone`);
  }
});

test('a badge earned is told to the table in the play-by-play, with what earned it', () => {
  const t = new TestTable({ stacks: [1000, 1000, 500], names: ['Dana', 'Lee', 'Sam'] });

  allIn(t, 1000);

  assert.deepEqual(badgesOf(t, 0), { felted: 1 });
  assert.ok(t.feedText().includes("Dana earned 💀 Felted: took Sam's last chip"), t.feedText().join('\n'));
  assert.equal(t.state.feed.at(-1)!.kind, 'dealer');
});

test('a badge is held once and counted each time it is earned again, and a line says how many times', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });

  checkDown(t, { 0: KINGS, 2: QUEENS }, 'Kd Kc 2s 7d 9h');
  checkDown(t, { 0: KINGS, 2: QUEENS }, 'Kd Kc 2s 7d 9h');

  assert.deepEqual(badgesOf(t, 0), { quads: 2 });
  assert.deepEqual(t.view(1).tonight.players.find((row) => row.playerId === t.ids[0])!.badges, [{ id: 'quads', times: 2 }]);
  assert.deepEqual(
    t.feedText().filter((line) => line.includes('earned')),
    ['P0 earned 🍀 Quads: four kings', 'P0 earned 🍀 Quads ×2: four kings'],
  );
});

test('two players earn in one hand, each their own badges, and a player earns several at once', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });

  checkDown(t, { 0: 'Qd 2c', 2: KINGS }, 'Kd Kc 9d Td Jd');

  assert.deepEqual(badgesOf(t, 0), { straightFlush: 1 });
  assert.deepEqual(badgesOf(t, 2), { quads: 1, cooler: 1 });
  assert.deepEqual(
    t.feedText().filter((line) => line.includes('earned')),
    ['P0 earned 🚽 Straight Flush: straight flush, king high', 'P2 earned 🍀 Quads: four kings', 'P2 earned ❄️ Cooler: lost with four kings'],
  );

  const shown = t.view(1).tonight.players.map((row) => [row.name, row.badges.map((badge) => badge.id)]);
  assert.deepEqual(shown.sort(), [['P0', ['straightFlush']], ['P1', []], ['P2', ['quads', 'cooler']]], 'in the order of the list, for everyone');
  assert.deepEqual(t.view(0).tonight, t.view(2).tonight);
});

test('badges stay with a player who left, and someone only watching sees them too', () => {
  const t = new TestTable({ stacks: [1000, 1000, 500] });
  const watcher = t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id) - 1;

  allIn(t, 1000);
  t.cmd(0, { type: 'standUp' });

  const row = t.view(watcher).tonight.players.find((each) => each.playerId === t.ids[0])!;
  assert.equal(row.seated, false);
  assert.deepEqual(row.badges, [{ id: 'felted', times: 1 }]);
});

test('three in a row counts again at six in a row, and broke three times again at six', () => {
  const t = new TestTable({ stacks: [1000, 1000] });

  const heaters = [1, 2, 3, 4, 5, 6].map(() => earnedIn(t, 0, () => headsUp(t, true)).includes('heater'));
  assert.deepEqual(heaters, [false, false, true, false, false, true]);
  assert.equal(badgesOf(t, 0).heater, 2);

  const broke = new TestTable({ stacks: [1000, 1000, 100] });
  const atms = [1, 2, 3, 4, 5, 6].map(() => earnedIn(broke, 2, () => bust(broke)).includes('atm'));
  assert.deepEqual(atms, [false, false, true, false, false, true]);
  assertInvariants(broke.state, broke.now);
});

/** The facts of the hand just played, with the winner's take handed back to everyone as though nobody had won it. */
function nobodyWon(facts: HandFacts): HandFacts {
  return { ...facts, pot: 0, players: facts.players.map((player) => ({ ...player, putIn: 0, tookOut: 0, net: 0, wins: [], busted: false, bustedBy: [] })) };
}

test('a hand nobody won earns nothing and leaves every streak as it was', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });

  checkDown(t, { 0: KINGS, 2: QUEENS }, 'Kd Kc 2s 7d 9h');
  const facts = nobodyWon(handFacts(handRecords(t.effects).at(-1)!));

  const state = t.state;
  const tonight = structuredClone(state.tonight);
  const feed = state.feed.length;
  const counted = countHand(state.tonight, facts);

  earnBadges(state, t.ctx(), facts, counted);

  assert.equal(state.feed.length, feed, 'nothing said');
  assert.deepEqual(
    Object.values(state.tonight.players).map((numbers) => [numbers.streak, numbers.badges]),
    Object.values(tonight.players).map((numbers) => [numbers.streak, numbers.badges]),
  );
});

test('no badge is earned from a card nobody was shown: seven-deuce that won without being turned up earns nothing, turned up by choice it does', () => {
  const play = (show: boolean) => {
    const t = new TestTable({ stacks: [1000, 1000, 1000] });
    t.deal({ button: 0, holes: { 0: '7s 2d' } });
    t.raise(0, 60);
    t.fold(1);
    t.fold(2);

    if (show) {
      t.cmd(0, { type: 'showCards' });
    }

    t.finishHand();

    return { t, facts: handFacts(handRecords(t.effects).at(-1)!) };
  };

  const mucked = play(false);
  const winner = mucked.facts.players.find((player) => player.seat === 0)!;
  assert.equal(winner.cards, null);
  assert.ok(!JSON.stringify(mucked.facts).includes('"7s"'));

  const night = { before: { hands: 0, won: 0, biggest: 0, best: null, rebuys: 0, busts: 0, streak: 0 }, after: { hands: 1, won: 1, biggest: 30, best: null, rebuys: 0, busts: 0, streak: 1 } };
  assert.deepEqual(BADGES.filter((badge) => badge.earned(mucked.facts, winner, night)).map((badge) => badge.id), []);
  assert.deepEqual(badgesOf(mucked.t, 0), {});

  assert.deepEqual(badgesOf(play(true).t, 0), { sevenDeuce: 1 });
});

/** A table as the code before badges saved it: the night's numbers without busts, streaks or badges. */
function savedBefore(t: TestTable): TableState {
  const saved = JSON.parse(JSON.stringify(t.state)) as TableState;

  for (const numbers of Object.values(saved.tonight.players) as Partial<TableState['tonight']['players'][string]>[]) {
    delete numbers.busts;
    delete numbers.streak;
    delete numbers.badges;
  }

  return restoreState(JSON.stringify(saved));
}

test('a table saved before badges loads with none, counts busts and streaks from then on, and earns them', () => {
  const old = new TestTable({ stacks: [1000, 1000, 1000] });
  old.deal({ button: 0 });
  old.foldOut();
  old.deal({ button: 0 });

  const t = TestTable.adopt(savedBefore(old));
  assert.ok(Object.values(t.state.tonight.players).every((numbers) => numbers.busts === 0 && numbers.streak === 0 && Object.keys(numbers.badges).length === 0));
  assert.ok(t.view(0).tonight.players.every((row) => row.badges.length === 0));

  t.foldOut();
  checkDown(t, { 0: KINGS, 2: QUEENS }, 'Kd Kc 2s 7d 9h');

  assert.deepEqual(badgesOf(t, 0), { quads: 1 });
  assertInvariants(t.state, t.now);
});

test('a badge saved by a later version that this code does not know is kept and not shown', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  checkDown(t, { 0: KINGS, 2: QUEENS }, 'Kd Kc 2s 7d 9h');
  t.state.tonight.players[t.ids[0]!]!.badges.fromTheFuture = 1;

  assert.deepEqual(t.view(0).tonight.players.find((row) => row.playerId === t.ids[0])!.badges, [{ id: 'quads', times: 1 }]);
});

/**
 * Seat 0 is all in for 100 on the button, called by both blinds. Seat 1 bets the flop, seat 2 calls; seat 1 bets
 * the turn and seat 2 folds, which leaves a side pot of seat 2's chips that only seat 1 is in for.
 */
function sidePotNobodyContested(holes: Record<number, string>, board: string): TestTable {
  const t = new TestTable({ stacks: [100, 1000, 1000] });
  t.deal({ button: 0, holes, board });
  t.raise(0, 100);
  t.call(1);
  t.call(2);
  t.raise(1, 50);
  t.call(2);
  t.raise(1, 50);
  t.fold(2);
  t.finishHand();

  return t;
}

test('a side pot nobody else was in for is no win at a showdown: ace high that lost the main pot is no Nothing Burger, and quads that lost it are a Cooler', () => {
  const air = sidePotNobodyContested({ 0: '8s 8h', 1: 'As Kd', 2: 'Qs Qh' }, '2c 7d 9h Jc 3s');
  assert.ok(air.state.tonight.players[air.ids[1]!]!.won > 0, 'the side pot was not paid');
  assert.ok(!('airBall' in badgesOf(air, 1)), JSON.stringify(badgesOf(air, 1)));

  const quads = sidePotNobodyContested({ 0: 'Qd 2c', 1: KINGS, 2: '3c 4c' }, 'Kd Kc 9d Td Jd');
  assert.deepEqual(badgesOf(quads, 1), { quads: 1, cooler: 1 });
});

test('a hand the blinds chop the moment it folds to them, both on Always chop, earns nothing and leaves every run as it was', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { allowChop: true } });
  t.cmd(1, { type: 'setAlwaysChop', on: true });
  t.cmd(2, { type: 'setAlwaysChop', on: true });

  // Seat 1 wins two from the button, then is the small blind of a hand that chops
  for (let hand = 0; hand < 2; hand++) {
    t.deal({ button: 1 });
    t.raise(1, 60);
    t.foldOut();
  }

  const before = structuredClone(t.state.tonight.players);
  t.deal({ button: 0 });
  t.fold(0);
  assert.deepEqual(t.state.hand!.result!.chopped, [1, 2]);
  t.finishHand();

  assert.deepEqual(Object.values(t.state.tonight.players).map(({ badges, streak }) => [badges, streak]), Object.values(before).map(({ badges, streak }) => [badges, streak]));
  assert.ok(!t.feedText().some((line) => line.includes(' earned ')), 'a line was told for the chop');
});

test('a big blind folded to with seven-deuce and nothing in the pot wins the hand on the bounty alone: it earns the badge and counts toward a run', () => {
  // As in tests/missedBlinds.test.ts: seat 2, due the small blind, sits out, so the big blind is posted alone and comes back
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: { sevenDeuceBounty: 50 } });
  t.deal({ button: 0 });
  t.foldOut();

  t.cmd(2, { type: 'sitOut' });
  t.deal({ holes: { 3: '7s 2h' } });
  t.fold(0);
  t.fold(1);
  t.finishHand();

  assert.equal(handRecords(t.effects).at(-1)!.result.bounty?.seat, 3);
  assert.deepEqual(badgesOf(t, 3), { sevenDeuce: 1 });
  assert.equal(t.state.tonight.players[t.ids[3]!]!.streak, 1);
});
