import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextHighHand } from '../src/engine/index.ts';
import type { Command, TableConfig } from '../src/engine/index.ts';
import { ACES, BOARD, cards, KINGS, ledgerEntries, QUEENS, TestTable } from './helpers.ts';
import { assertInvariants, assertLedgerAgrees } from './invariants.ts';

const NAMES = ['Dana', 'Lee', 'Sam', 'Kim', 'Ann'];

function table(stacks: number[], config: Partial<TableConfig> = {}): TestTable {
  return new TestTable({ stacks, config, names: NAMES });
}

/**
 * A hand dealt with the button on seat 0 in which the players given cards call and check it down to a
 * showdown and everyone else folds. The first of them left of the button shows first.
 */
function showDown(t: TestTable, holes: Record<number, string>, board: string, secondBoard?: string): void {
  t.deal({ button: 0, holes, board, secondBoard });

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

  t.finishHand();
}

const highHand = (t: TestTable) => t.state.tonight.highHand;
const holders = (t: TestTable) => highHand(t).best?.playerIds.map((id) => t.ids.indexOf(id)) ?? [];
const nextHolders = (t: TestTable) => nextHighHand(highHand(t))?.playerIds.map((id) => t.ids.indexOf(id)).sort() ?? [];
const lines = (t: TestTable) => t.feedText().filter((line) => /high.hand/.test(line));
const bonusLines = (t: TestTable) => ledgerEntries(t.effects).filter((entry) => entry.kind === 'high hand');

/** What each player has collected of the bonus tonight, by seat. */
const paid = (t: TestTable) => Object.fromEntries(Object.entries(highHand(t).paid).map(([id, amount]) => [t.ids.indexOf(id), amount]));

/** The host's tap on Pay, for the high hand shown in `hand` and collected by the players in `seats`. */
const pay = (t: TestTable, hand: number, seats: number[]): Command => ({ type: 'payHighHand', hand, to: seats.map((seat) => t.ids[seat]!) });

function cmd(t: TestTable, player: number, command: Command): () => void {
  return () => t.cmd(player, command);
}

test('a better hand takes the high hand and the table is told; one as good shown later leaves it where it is', () => {
  const t = table([1000, 1000, 1000]);
  assert.deepEqual(highHand(t), { best: null, sincePaid: {}, paid: {} });

  // Sam shows kings first and loses them to Dana's aces
  showDown(t, { 0: ACES, 2: KINGS }, BOARD);
  assert.deepEqual(highHand(t).best, { playerIds: [t.ids[0]], cards: cards('As Ah Jc 9h 7d'), hand: 1 });
  assert.deepEqual(lines(t), ['Dana takes the high hand with pair of aces']);

  // Sam's own aces, as good to the last kicker, come too late
  showDown(t, { 0: QUEENS, 2: 'Ac Ad' }, BOARD);
  assert.deepEqual([holders(t), highHand(t).best!.hand], [[0], 1]);
  assert.equal(lines(t).length, 1, 'nothing was taken, so nothing is told');

  showDown(t, { 0: QUEENS, 2: 'Jd Js' }, BOARD);
  assert.deepEqual([holders(t), highHand(t).best!.cards], [[2], cards('Jc Jd Js 9h 7d')]);
  assert.equal(lines(t).at(-1), 'Sam takes the high hand with three jacks');
  assertInvariants(t.state, t.now);
});

test('the high hand is the best hand on either board of two, and is the holder’s best hand in Tonight', () => {
  const t = table([1000, 1000, 1000], { bombPotBoards: 'two' });
  t.cmd(0, { type: 'setBombPot', on: true });

  // Aces win the first board; on the second a king gives Sam three kings, and the queens nothing
  showDown(t, { 0: ACES, 1: QUEENS, 2: KINGS }, BOARD, 'Kd 4c 5h 8s Td');

  assert.deepEqual([holders(t), highHand(t).best!.cards], [[2], cards('Kd Ks Kh Td 8s')]);
  const tonight = t.view(1).tonight;
  assert.deepEqual(tonight.highHand.best?.name, 'Three kings');
  assert.deepEqual(tonight.players.find((row) => row.name === 'Sam')!.best, { name: 'Three kings', cards: highHand(t).best!.cards });
});

test('two players who show as good a hand in the same hand share it', () => {
  const t = table([1000, 1000, 1000]);

  // Both play the straight on the board
  showDown(t, { 0: '2c 3d', 2: '4c 5d' }, 'Ts Jd Qc Kh 9h');

  assert.deepEqual(holders(t), [0, 2]);
  assert.deepEqual(nextHolders(t), [0, 2]);
  assert.equal(lines(t).at(-1), 'Dana and Sam share the high hand with straight, king high');
});

test('a hand mucked, a winner nobody called and cards shown by choice are not shown down, and a hand nobody won changes nothing', () => {
  const t = table([1000, 1000, 1000, 1000], { allowChop: true });

  // Sam shows aces first, and Dana's kings, which cannot win, are mucked
  showDown(t, { 0: KINGS, 2: ACES }, BOARD);
  assert.deepEqual(Object.keys(highHand(t).sincePaid), [t.ids[2]]);

  // Dana wins without a call and turns up quads by choice
  t.deal({ button: 0, holes: { 0: 'Kc Kd' }, board: 'Ks Kh 2c 3d 4h' });
  t.raise(3, 60);
  t.raise(0, 200);
  t.fold(1);
  t.fold(2);
  t.fold(3);
  t.cmd(0, { type: 'showCards' });
  t.finishHand();

  // Folded round to the blinds, who chop
  t.deal({ button: 0 });
  t.fold(3);
  t.fold(0);
  t.cmd(1, { type: 'offerChop' });
  t.cmd(2, { type: 'answerChop', agree: true });
  t.finishHand();

  assert.deepEqual([holders(t), Object.keys(highHand(t).sincePaid)], [[2], [t.ids[2]]]);
  assert.equal(lines(t).length, 1);
});

/** Dana takes the high hand with aces over Sam's kings, and the table plays a bonus of 5. */
function aBonusToPay(stacks = [1000, 1000, 1000, 1000]): TestTable {
  const t = table(stacks, { highHandBonus: 5 });
  showDown(t, { 0: ACES, 2: KINGS }, BOARD);

  return t;
}

test('at the night’s end everyone else seated pays the holder: sitting out, sat down since, or short, who pays what they have', () => {
  const t = aBonusToPay();
  t.cmd(1, { type: 'sitOut' });
  t.cmd(0, { type: 'setStack', playerId: t.ids[3]!, stack: 3 });
  const ann = t.sitDown('Ann', 6, 500);
  const before = t.stacks();

  t.cmd(0, { type: 'endNight' });

  assert.deepEqual(
    t.stacks().map((stack, player) => stack - before[player]!),
    [18, -5, -5, -3, -5],
  );
  assert.deepEqual(highHand(t), { best: { playerIds: [t.ids[0]], cards: cards('As Ah Jc 9h 7d'), hand: 1 }, sincePaid: {}, paid: { [t.ids[0]!]: 18 } });
  assert.equal(lines(t).at(-1), 'Dana collects the high-hand bonus: 5 from everyone else seated, 18 in all');

  // Each payment is two lines of the ledger that name each other, and leave what anyone bought alone
  assert.deepEqual(
    bonusLines(t).map((entry) => [entry.name, entry.amount, 'otherName' in entry && entry.otherName]),
    [
      ['Lee', -5, 'Dana'],
      ['Dana', 5, 'Lee'],
      ['Sam', -5, 'Dana'],
      ['Dana', 5, 'Sam'],
      ['Kim', -3, 'Dana'],
      ['Dana', 3, 'Kim'],
      ['Ann', -5, 'Dana'],
      ['Dana', 5, 'Ann'],
    ],
  );
  assert.equal(t.state.members[ann]!.transferred, 0, 'a bonus is not chips the host transferred');
  assert.deepEqual(
    t.view(0).ledger.map((row) => row.net),
    t.state.members.map((member) => t.state.seats.find((seat) => seat?.playerId === member.id)!.stack + member.cashOut - member.buyIn),
    'the bonus is in each net',
  );
  assertLedgerAgrees(t.state, t.effects);
  assertInvariants(t.state, t.now);
});

test('paid in dollars and cents, the bonus is split between those who share the hand to the cent, the odd cents going round from the button from one payer to the next', () => {
  const t = table([10_000, 10_000, 10_000, 10_000, 10_000], { unit: 'cents', smallBlind: 25, bigBlind: 50, highHandBonus: 25 });
  showDown(t, { 0: '2c 3d', 2: '4c 5d' }, 'Ts Jd Qc Kh 9h');
  const before = t.stacks();

  t.cmd(0, { type: 'endNight' });

  // Three payers' odd cents: Sam, on the button's left, gets the first and the third, Dana the second
  assert.deepEqual(
    t.stacks().map((stack, player) => stack - before[player]!),
    [37, -25, 38, -25, -25],
  );
  assert.deepEqual(paid(t), { 0: 37, 2: 38 });
  assert.equal(lines(t).at(-1), 'Sam and Dana share the high-hand bonus: 0.25 from everyone else seated, 0.75 in all');
  assertLedgerAgrees(t.state, t.effects);
});

test('a holder who has left collects nothing: the best hand of anyone seated does, and the high hand of the night stays theirs', () => {
  const t = aBonusToPay();
  t.cmd(0, { type: 'standUp' });
  const before = t.stacks();

  // Sam's kings lost, and are the best hand of anyone still seated
  t.cmd(0, { type: 'endNight' });

  assert.deepEqual(
    t.stacks().map((stack, player) => stack - before[player]!),
    [0, -5, 10, -5],
  );
  assert.deepEqual([holders(t), paid(t)], [[0], { 2: 10 }]);
  assert.equal(lines(t).at(-1), 'Dana has left, so the high-hand bonus goes to Sam, the best hand of anyone seated: 5 from everyone else seated, 10 in all');
});

test('with no bonus nothing moves at the night’s end and the high hand stays unpaid, to be paid once a bonus is set', () => {
  const t = aBonusToPay();
  t.cmd(0, { type: 'updateConfig', config: { highHandBonus: 0 } });
  const before = t.stacks();

  t.cmd(0, { type: 'endNight' });
  assert.deepEqual(t.stacks(), before);
  assert.deepEqual([holders(t), paid(t), nextHolders(t)], [[0], {}, [0]]);
  assert.throws(cmd(t, 0, pay(t, 1, [0])), { name: 'GameError', message: 'There is no high-hand bonus: it is set in the table settings' });

  // Over a night played on and ended again, the bonus set since is paid for it
  t.cmd(0, { type: 'playOn' });
  t.cmd(0, { type: 'updateConfig', config: { highHandBonus: 5 } });
  t.cmd(0, { type: 'endNight' });
  assert.deepEqual(paid(t), { 0: 15 });
});

test('paid out early by the host or a co-host, between hands, the high hand is paid once; the next starts from nothing and is paid when the night ends', () => {
  const t = aBonusToPay();
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });

  assert.throws(cmd(t, 3, pay(t, 1, [0])), { message: 'Only the host or a co-host can do that' });
  assert.throws(cmd(t, 1, pay(t, 0, [0])), { message: 'The high hand has changed since you looked, so have another look before paying it' });

  t.cmd(1, pay(t, 1, [0]));
  assert.equal(lines(t).at(-1), 'Co-host Lee paid out the high hand. Dana collects the high-hand bonus: 5 from everyone else seated, 15 in all');
  assert.equal(nextHighHand(highHand(t)), null);
  assert.throws(cmd(t, 1, pay(t, 1, [0])), { message: 'No hand has been shown down since the high hand was paid' });

  // Not during a hand, when the chips are in play
  t.deal({ button: 0 });
  assert.throws(cmd(t, 0, pay(t, 1, [0])), { message: 'The high hand is paid between hands. Pause the game, and once this hand is over it can be paid' });
  t.foldOut();

  // A lesser hand is the next to be paid; the night's high hand stays as it was paid
  showDown(t, { 0: '4h 5h', 3: QUEENS }, BOARD);
  assert.deepEqual([holders(t), nextHolders(t)], [[0], [3]]);
  assert.equal(lines(t).at(-1), 'Kim takes the high hand with pair of queens');

  const before = t.stacks();
  t.cmd(0, { type: 'endNight' });
  assert.deepEqual(
    t.stacks().map((stack, player) => stack - before[player]!),
    [-5, -5, -5, 15],
  );
  assert.deepEqual(paid(t), { 0: 15, 3: 15 }, 'what each collected tonight');

  // Played on and ended again with nothing shown down since, nobody pays
  t.cmd(0, { type: 'playOn' });
  t.cmd(0, { type: 'endNight' });
  assert.equal(bonusLines(t).length, 12);
  assertLedgerAgrees(t.state, t.effects);
  assertInvariants(t.state, t.now);
});

test('with nobody else able to pay, the high hand is not paid and stays the next to be', () => {
  const t = aBonusToPay([1000, 1000, 1000]);
  t.cmd(0, { type: 'setStack', playerId: t.ids[1]!, stack: 0 });
  t.cmd(0, { type: 'setStack', playerId: t.ids[2]!, stack: 0 });

  assert.throws(cmd(t, 0, pay(t, 1, [0])), { message: 'Nobody else seated has chips to pay it' });
  t.cmd(0, { type: 'endNight' });
  assert.deepEqual([bonusLines(t).length, nextHolders(t), paid(t)], [0, [0], {}]);
});

test('everyone at the table sees the high hand the same way, watchers too, and who would collect it now', () => {
  const t = aBonusToPay();
  t.cmd(0, { type: 'standUp' });

  // Dana is only watching now
  const seen = [0, 1, 2, 3].map((player) => t.view(player).tonight.highHand);
  assert.ok(seen.every((view) => JSON.stringify(view) === JSON.stringify(seen[0])));
  assert.deepEqual(seen[0], {
    best: { playerIds: [t.ids[0]], name: 'Pair of aces', cards: cards('As Ah Jc 9h 7d'), hand: 1 },
    next: { playerIds: [t.ids[0]], name: 'Pair of aces', cards: cards('As Ah Jc 9h 7d'), hand: 1 },
    due: { hand: 1, playerIds: [t.ids[2]], total: 10 },
    paid: [],
  });
});

test('the host pays what they were shown, or nothing: a payout whose collector has changed since is refused, and one due to a hand other than the night\'s is paid', () => {
  const t = table([1000, 1000, 1000, 1000], { highHandBonus: 5 });
  showDown(t, { 0: ACES, 1: '8s 4h' }, BOARD);
  showDown(t, { 2: KINGS, 3: '8s 4h' }, BOARD);

  // Shown Dana's aces as the high hand, the host taps Pay once she has left: Sam's kings, from a later hand, are due now
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });
  t.cmd(0, { type: 'standUp' });
  assert.throws(cmd(t, 1, pay(t, 1, [0])), { message: 'The high hand has changed since you looked, so have another look before paying it' });
  assert.throws(cmd(t, 1, pay(t, 2, [0])), { message: 'The high hand has changed since you looked, so have another look before paying it' });
  assert.deepEqual(t.view(1).tonight.highHand.due, { hand: 2, playerIds: [t.ids[2]], total: 10 });

  const before = t.stacks();
  t.cmd(1, pay(t, 2, [2]));
  assert.deepEqual(
    t.stacks().map((stack, player) => stack - before[player]!),
    [0, -5, 10, -5],
  );
  assert.equal(lines(t).at(-1), 'Co-host Lee paid out the high hand. Dana has left, so the high-hand bonus goes to Sam, the best hand of anyone seated: 5 from everyone else seated, 10 in all');
  assertLedgerAgrees(t.state, t.effects);
  assertInvariants(t.state, t.now);
});
