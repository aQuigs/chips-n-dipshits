import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handFacts, isSevenDeuce, PAIR, STRAIGHT_FLUSH, THREE_OF_A_KIND, wonAPot } from '../src/engine/index.ts';
import type { HandFacts, PlayerFacts } from '../src/engine/index.ts';
import { ACES, BOARD, cards, checkAround, handRecords, KINGS, QUEENS, TestTable } from './helpers.ts';

// On the first board aces beat kings beat queens; on the second a king makes the kings three of a kind
const SECOND = 'Kd 4c 5h 8s Td';

/**
 * Ends the hand on the table and gives back its facts, having seen that none of them holds a card
 * that was still face down when the hand was taken away.
 */
function factsOf(t: TestTable): HandFacts {
  t.runToResult();

  const hand = t.state.hand!;
  const faceDown = [...hand.deck, ...hand.players.filter((p) => !p.shown).flatMap((p) => p.cards)];

  t.finishHand();

  const facts = handFacts(handRecords(t.effects).at(-1)!);
  const told = JSON.stringify(facts);

  for (const card of faceDown) {
    assert.ok(!told.includes(`"${card}"`), `the facts hold ${card}, which nobody was shown`);
  }

  return facts;
}

const at = (facts: HandFacts, seat: number): PlayerFacts => facts.players.find((p) => p.seat === seat)!;

/** What each player put in, took out and came away with, by seat. */
const chips = (facts: HandFacts) => facts.players.map((p) => [p.putIn, p.tookOut, p.net]);

/** A table whose next hand is a bomb pot of 100 on two boards, dealt with the button on seat 0. */
function doubleBoard(stacks: number[], holes: Record<number, string>, secondBoard = SECOND): TestTable {
  const t = new TestTable({ stacks, config: { bombPotBoards: 'two' } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, board: BOARD, secondBoard, holes });

  return t;
}

test('a showdown: what each player put in and took out, who won the pot, and the hands that were shown, the losing one too', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: ACES, 1: QUEENS, 2: KINGS }, board: BOARD });
  t.call(0);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);

  const facts = factsOf(t);

  assert.deepEqual(
    { number: facts.number, ended: facts.ended, bombPot: facts.bombPot, boards: facts.boards, runTwice: facts.runTwice, bigBlind: facts.bigBlind, pot: facts.pot, potInBigBlinds: facts.potInBigBlinds },
    { number: 1, ended: 'showdown', bombPot: null, boards: 1, runTwice: false, bigBlind: 20, pot: 50, potInBigBlinds: 2.5 },
  );
  assert.deepEqual(facts.players.map((p) => [p.seat, p.playerId, p.name]), [0, 1, 2].map((seat) => [seat, t.ids[seat], `P${seat}`]));
  assert.deepEqual(chips(facts), [[20, 50, 30], [10, 0, -10], [20, 0, -20]]);
  assert.deepEqual(facts.players.map((p) => p.folded), [false, true, false]);
  assert.deepEqual(facts.players.map(wonAPot), [true, false, false]);
  assert.deepEqual(at(facts, 0).wins, [{ pot: 0, board: 0, amount: 50, between: 1 }]);

  // The kings were turned up first and lost: they are a hand shown all the same
  assert.deepEqual(facts.players.map((p) => p.cards), [cards(ACES), null, cards(KINGS)]);
  assert.deepEqual(at(facts, 0).shown, [{ board: 0, rank: at(facts, 0).shown[0]!.rank, category: PAIR, name: 'Pair of aces', cards: cards('As Ah Jc 9h 7d') }]);
  assert.deepEqual(at(facts, 2).shown.map((hand) => [hand.board, hand.name]), [[0, 'Pair of kings']]);
  assert.ok(at(facts, 0).shown[0]!.rank > at(facts, 2).shown[0]!.rank, 'a better hand has the higher rank');
  assert.deepEqual(at(facts, 1).shown, []);

  assert.deepEqual(facts.players.map((p) => [p.busted, p.bustedBy]), [[false, []], [false, []], [false, []]]);
});

test('a hand everyone folds: the winner took the pot without a hand being shown, and a bet that came back uncalled is no part of what was won', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 2: ACES } });
  t.raise(0, 60);
  t.fold(1);
  t.raise(2, 400);
  t.fold(0);

  const facts = factsOf(t);

  assert.equal(facts.ended, 'folds');
  assert.equal(facts.pot, 130, 'the 340 nobody called went back and was never played for');
  assert.deepEqual(chips(facts), [[60, 0, -60], [10, 0, -10], [60, 130, 70]]);
  assert.deepEqual(facts.players.map((p) => p.folded), [true, true, false]);
  assert.deepEqual(at(facts, 2).wins, [{ pot: 0, board: 0, amount: 130, between: 1 }]);
  assert.deepEqual(facts.players.map((p) => [p.cards, p.shown]), [[null, []], [null, []], [null, []]], 'the winner mucked: aces nobody saw are no hand of the night');
});

test('cards a winner turns up by choice after everyone folded are theirs to be seen, and make no hand shown down', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 2: ACES } });
  t.fold(0);
  t.fold(1);
  t.cmd(2, { type: 'showCards' });

  const facts = factsOf(t);

  assert.deepEqual(chips(facts), [[0, 0, 0], [10, 0, -10], [10, 20, 10]], 'a walk: the big blind takes the small blind');
  assert.equal(wonAPot(at(facts, 2)), true);
  assert.deepEqual(at(facts, 2).cards, cards(ACES));
  assert.deepEqual(at(facts, 2).shown, []);
});

test('a big blind everyone folds to with nothing else in the pot gets it back and wins nothing', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.foldOut();

  // The next big blind is seat 0, and the small blind would come from seat 2, who steps out
  t.cmd(2, { type: 'sitOut' });
  t.deal();
  assert.deepEqual(t.state.hand!.players.map((p) => p.seat), [0, 1]);
  t.fold(1);

  const facts = factsOf(t);

  assert.equal(facts.pot, 0);
  assert.deepEqual(chips(facts), [[0, 0, 0], [0, 0, 0]]);
  assert.deepEqual(facts.players.map(wonAPot), [false, false]);
  assert.deepEqual(facts.players.map((p) => p.folded), [false, true]);
});

test('a split pot: both players won a share, each what they were paid', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { smallBlind: 5, bigBlind: 20 } });
  t.deal({ button: 0, holes: { 0: 'As Kd', 2: 'Ac Kh' }, board: BOARD });
  t.call(0);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);

  const facts = factsOf(t);

  assert.equal(facts.pot, 45);
  assert.deepEqual(at(facts, 0).wins, [{ pot: 0, board: 0, amount: 22, between: 2 }]);
  assert.deepEqual(at(facts, 2).wins, [{ pot: 0, board: 0, amount: 23, between: 2 }]);
  assert.deepEqual(facts.players.map(wonAPot), [true, false, true]);
  assert.deepEqual(chips(facts), [[20, 22, 2], [5, 0, -5], [20, 23, 3]]);
});

test('side pots: a short stack wins the main pot and the next best hand the side pot, each named by its pot', () => {
  const t = new TestTable({ stacks: [100, 300, 500] });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD });
  t.raise(0, 100);
  t.raise(1, 300);
  t.call(2);

  const facts = factsOf(t);

  assert.equal(facts.pot, 700);
  assert.equal(facts.potInBigBlinds, 35);
  assert.deepEqual(at(facts, 0).wins, [{ pot: 0, board: 0, amount: 300, between: 1 }]);
  assert.deepEqual(at(facts, 1).wins, [{ pot: 1, board: 0, amount: 400, between: 1 }]);
  assert.deepEqual(at(facts, 2).wins, []);
  assert.deepEqual(chips(facts), [[100, 300, 200], [300, 400, 100], [300, 0, -300]]);
  assert.deepEqual(facts.players.map((p) => p.busted), [false, false, false], 'the loser had chips behind');
});

test('a bust: the player left with nothing was felted by everyone paid from a pot they were all in for', () => {
  const t = new TestTable({ stacks: [100, 300, 300] });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD });
  t.raise(0, 100);
  t.raise(1, 300);
  t.call(2);

  const facts = factsOf(t);

  assert.deepEqual(facts.players.map((p) => [p.busted, p.bustedBy]), [[false, []], [false, []], [true, [0, 1]]]);
  assert.deepEqual(at(facts, 2).shown.map((hand) => hand.name), ['Pair of queens'], 'all in, so the hand was face up');

  // Only the pots they were in for count: the side pot above a short stack held none of its chips
  const short = new TestTable({ stacks: [100, 100, 300, 300] });
  short.deal({ button: 0, holes: { 0: QUEENS, 1: ACES, 2: KINGS, 3: 'Ts Th' }, board: BOARD });
  short.raise(3, 300);
  short.call(0);
  short.call(1);
  short.call(2);

  const felted = factsOf(short);

  assert.deepEqual(felted.players.map((p) => p.wins.map((win) => [win.pot, win.amount])), [[], [[0, 400]], [[1, 400]], []]);
  assert.deepEqual(felted.players.map((p) => [p.busted, p.bustedBy]), [[true, [1]], [false, []], [false, []], [true, [1, 2]]]);
});

test('run twice with a winner on each board: the hand was run twice, each won their board, and each showed a hand on both', () => {
  const t = new TestTable({ stacks: [500, 500, 500], config: { smallBlind: 5, bigBlind: 20, allowRunItTwice: true } });
  t.deal({ button: 0, holes: { 0: ACES, 2: KINGS }, board: BOARD, secondBoard: SECOND });
  t.raise(0, 500);
  t.fold(1);
  t.call(2);
  t.cmd(0, { type: 'ritVote', agree: true });
  t.cmd(2, { type: 'ritVote', agree: true });

  const facts = factsOf(t);

  assert.deepEqual([facts.boards, facts.runTwice, facts.bombPot, facts.ended], [2, true, null, 'showdown']);
  assert.deepEqual(at(facts, 0).wins, [{ pot: 0, board: 0, amount: 503, between: 1 }]);
  assert.deepEqual(at(facts, 2).wins, [{ pot: 0, board: 1, amount: 502, between: 1 }]);
  assert.deepEqual(facts.players.map(wonAPot), [true, false, true]);
  assert.deepEqual(at(facts, 0).shown.map((hand) => [hand.board, hand.name]), [[0, 'Pair of aces'], [1, 'Pair of aces']]);
  assert.deepEqual(at(facts, 2).shown.map((hand) => [hand.board, hand.name, hand.category]), [[0, 'Pair of kings', PAIR], [1, 'Three kings', THREE_OF_A_KIND]]);
  assert.deepEqual(facts.players.map((p) => p.busted), [false, false, false]);
});

test('a double-board bomb pot: scooped, one player is paid on both boards; with a tie on one, that board is split', () => {
  const scooped = doubleBoard([1000, 1000, 1000], { 0: ACES, 1: QUEENS, 2: '8c 6d' });
  scooped.check(1);
  scooped.fold(2);
  scooped.raise(0, 100);
  scooped.call(1);
  checkAround(scooped, [1, 0], 2);

  const scoop = factsOf(scooped);

  assert.deepEqual([scoop.boards, scoop.runTwice, scoop.bombPot], [2, false, { amount: 100, boards: 2 }]);
  assert.equal(scoop.pot, 500);
  assert.deepEqual(at(scoop, 0).wins, [{ pot: 0, board: 0, amount: 250, between: 1 }, { pot: 0, board: 1, amount: 250, between: 1 }]);
  assert.deepEqual(chips(scoop), [[200, 500, 300], [200, 0, -200], [100, 0, -100]]);

  // Everyone plays the second board, a royal flush
  const tied = doubleBoard([1000, 1000, 1000], { 0: 'Ad Ac', 1: 'Kd Kc', 2: '8c 6d' }, 'As Ks Qs Js Ts');
  tied.check(1);
  tied.fold(2);
  checkAround(tied, [0], 1);
  checkAround(tied, [1, 0], 2);

  const split = factsOf(tied);

  assert.deepEqual(at(split, 0).wins, [{ pot: 0, board: 0, amount: 150, between: 1 }, { pot: 0, board: 1, amount: 75, between: 2 }]);
  assert.deepEqual(at(split, 1).wins, [{ pot: 0, board: 1, amount: 75, between: 2 }]);
  assert.deepEqual(at(split, 1).shown.map((hand) => [hand.board, hand.name, hand.category]), [[0, 'Pair of kings', PAIR], [1, 'Royal flush', STRAIGHT_FLUSH]]);
  assert.equal(at(split, 0).shown[1]!.rank, at(split, 1).shown[1]!.rank, 'the same hand ranks the same whoever shows it');
});

test('won with seven-deuce: the cards are a fact when the bounty turned them up, and the bounty is told apart from the pot', () => {
  const t = new TestTable({ stacks: [1000, 1000, 50], config: { sevenDeuceBounty: 50 } });
  t.deal({ button: 0, holes: { 0: '7h 2c' } });
  t.raise(0, 60);
  t.fold(1);
  t.fold(2);

  const facts = factsOf(t);
  const winner = at(facts, 0);

  assert.ok(wonAPot(winner) && winner.cards !== null && isSevenDeuce(winner.cards));
  assert.deepEqual(facts.players.map((p) => [p.putIn, p.tookOut, p.bounty, p.net]), [[20, 50, 80, 110], [10, 0, -50, -60], [20, 0, -30, -50]]);
  assert.equal(facts.pot, 50, 'the bounty is paid on top, and is no part of the pot');

  // The big blind folded with 30 behind and the bounty took it: felted by whoever collected
  assert.deepEqual(facts.players.map((p) => [p.folded, p.busted, p.bustedBy]), [[false, false, []], [true, false, []], [true, true, [0]]]);

  // With no bounty to turn it up, seven-deuce that wins unseen is nobody's business
  const quiet = new TestTable({ stacks: [1000, 1000, 1000] });
  quiet.deal({ button: 0, holes: { 0: '7h 2c' } });
  quiet.raise(0, 60);
  quiet.fold(1);
  quiet.fold(2);

  assert.equal(at(factsOf(quiet), 0).cards, null);
});

test('a hand mucked at the showdown is not folded and not shown: its cards are no fact at all', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: ACES, 1: QUEENS, 2: KINGS }, board: BOARD });
  t.call(0);
  t.call(1);
  t.check(2);
  checkAround(t, [1, 2, 0], 2);
  t.check(1);
  t.raise(2, 40);
  t.call(0);
  t.call(1);

  const facts = factsOf(t);
  const mucked = at(facts, 1);

  assert.deepEqual([mucked.folded, mucked.cards, mucked.shown, mucked.net], [false, null, [], -60]);
  assert.deepEqual(facts.players.map((p) => p.shown.map((hand) => hand.name)), [['Pair of aces'], [], ['Pair of kings']]);
});
