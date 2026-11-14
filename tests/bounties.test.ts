import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bountyFor, DEFAULT_CONFIG, validatedConfig } from '../src/engine/index.ts';
import type { Bounty, BountyResult } from '../src/engine/index.ts';
import { cards, checkAround, handRecords, TestTable } from './helpers.ts';
import { assertChipsConserved } from './invariants.ts';

/** One of each kind: the ranks bare, suited only, offsuit only, and a pair. */
const LIST: Bounty[] = [
  ['72', 10],
  ['J4s', 20],
  ['K9o', 30],
  ['QQ', 40],
];

/** Seat 0 on the button raises with `hole`, and both blinds fold. */
function uncalled(hole: string, bounties: Bounty[] = LIST, stacks = [1000, 1000, 1000]): TestTable {
  const t = new TestTable({ stacks, config: { bounties } });
  t.deal({ button: 0, holes: { 0: hole } });
  t.raise(0, 60);
  t.fold(1);
  t.fold(2);

  return t;
}

/** Seat 0 on the button limps with `hole`, the small blind folds, and the big blind checks it down with `against`. */
function shownDown(hole: string, board: string, against = 'Ah Kh', bounties: Bounty[] = LIST): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bounties } });
  t.deal({ button: 0, holes: { 0: hole, 2: against }, board });
  t.call(0);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);

  return t;
}

const paid = (t: TestTable): BountyResult | null => t.state.hand!.result!.bounty;
const bountyEvents = (t: TestTable) => t.state.hand!.events.filter((event) => event[0] === 'bounty');

test('each kind of bounty hand collects its own amount from everyone else dealt in, winning without a call or at a showdown, and the hand is named wherever it is told', () => {
  for (const [hole, board, hand, amount] of [
    ['7h 2c', '7d 7s 2h 9c 4d', '72', 10],
    ['Jd 4d', 'Jh Js 4h 9c 2s', 'J4s', 20],
    ['Kc 9d', 'Kd Ks 9h 3c 2s', 'K9o', 30],
    ['Qc Qd', 'Qs 5c 8d 2h 3s', 'QQ', 40],
  ] as const) {
    const folded = uncalled(hole);
    assert.deepEqual(paid(folded), { seat: 0, hand, payments: [{ seat: 1, amount }, { seat: 2, amount }] }, `${hand} uncalled`);
    assert.deepEqual(folded.stacks(), [1000 + 30 + 2 * amount, 1000 - 10 - amount, 1000 - 20 - amount]);
    assert.deepEqual(bountyEvents(folded), [['bounty', 0, [[1, amount], [2, amount]], hand]]);
    assert.ok(folded.feedText().includes(`P0 collects ${2 * amount} for the ${hand} bounty`), folded.feedText().join(' / '));
    assert.deepEqual(folded.view(1).seats[0]!.cards, cards(hole), 'the hand is shown whenever a bounty is paid');
    assertChipsConserved(folded.state);

    const showdown = shownDown(hole, board);
    assert.deepEqual(paid(showdown), { seat: 0, hand, payments: [{ seat: 1, amount }, { seat: 2, amount }] }, `${hand} at a showdown`);
    assert.deepEqual(showdown.stacks(), [1000 + 30 + 2 * amount, 1000 - 10 - amount, 1000 - 20 - amount]);

    folded.finishHand();
    assert.equal(handRecords(folded.effects)[0]!.result.bounty!.hand, hand, 'the record says which hand the bounty was for');
  }
});

test('a hand put on the list suited only pays nothing held offsuit, and one put on offsuit only nothing held suited', () => {
  const bounties: Bounty[] = [
    ['72o', 10],
    ['J4s', 20],
  ];

  assert.equal(paid(uncalled('7h 2h', bounties)), null);
  assert.equal(paid(uncalled('Jd 4c', bounties)), null);
  assert.equal(paid(uncalled('7h 2c', bounties))!.hand, '72o');
  assert.equal(paid(uncalled('Jd 4d', bounties))!.hand, 'J4s');

  // Shown down and won, but not the hand on the list
  const suited = shownDown('7h 2h', '7d 7s 2c 9c 4d', 'Ah Kh', bounties);
  assert.equal(paid(suited), null);
  assert.ok(!suited.feedText().some((line) => line.includes('bounty')));
});

test('a hand that is two bounties, the ranks bare and the same ranks suited, collects the narrower one once', () => {
  const bounties: Bounty[] = [
    ['72', 10],
    ['72s', 30],
  ];

  const suited = uncalled('7s 2s', bounties);
  assert.deepEqual(paid(suited), { seat: 0, hand: '72s', payments: [{ seat: 1, amount: 30 }, { seat: 2, amount: 30 }] });
  assert.equal(bountyEvents(suited).length, 1);
  assert.deepEqual(suited.stacks(), [1000 + 30 + 60, 1000 - 10 - 30, 1000 - 20 - 30]);

  assert.equal(paid(uncalled('7s 2d', bounties))!.hand, '72');

  // The order of the list does not matter
  assert.deepEqual(bountyFor(cards('7s 2s'), [...bounties].reverse()), ['72s', 30]);
  assert.deepEqual(bountyFor(cards('2d 7s'), [...bounties].reverse()), ['72', 10]);
  assert.equal(bountyFor(cards('7s 3s'), bounties), null);
  assert.equal(bountyFor(cards('7s 2s'), []), null);
});

test('a bounty hand run twice collects only for winning the whole main pot on both boards', () => {
  const runTwice = (second: string): TestTable => {
    const t = new TestTable({ stacks: [500, 500, 1000], config: { bounties: [['J4s', 50]], maxRuns: 2 } });
    t.deal({ button: 0, holes: { 0: 'Jd 4d', 1: 'Ah Kc' }, board: 'Jh Js 4h 9c 2s', secondBoard: second });
    t.raise(0, 500);
    t.call(1);
    t.fold(2);
    t.cmd(0, { type: 'ritVote', runs: 2 });
    t.cmd(1, { type: 'ritVote', runs: 2 });
    t.runToResult();

    return t;
  };

  const both = runTwice('4c 4s Jc 8h 3d');
  assert.deepEqual(paid(both), { seat: 0, hand: 'J4s', payments: [{ seat: 2, amount: 50 }] });
  assertChipsConserved(both.state);

  const one = runTwice('Ac Ad 5s 8h 3d');
  assert.equal(paid(one), null, 'half the main pot is not the whole of it');
});

test('a bounty hand that splits the main pot collects nothing', () => {
  const split = shownDown('Jd 4d', 'Jh Js 4h 9c 2s', 'Jc 4c');
  assert.equal(paid(split), null);
  assert.deepEqual(split.stacks(), [1005, 990, 1005]);
});

test('a bounty is for the main pot: won with a side pot lost it is paid, and won in a side pot alone it is not', () => {
  // Seat 0 all in for less takes the main pot, and seat 1 the side pot the other two made after
  const short = new TestTable({ stacks: [200, 1000, 1000], config: { bounties: [['J4s', 50]] } });
  short.deal({ button: 0, holes: { 0: 'Jd 4d', 1: 'Ah Ad', 2: 'Kc Qc' }, board: 'Jh Js 4h 9c 2s' });
  short.raise(0, 200);
  short.call(1);
  short.call(2);
  short.raise(1, 100);
  short.call(2);
  checkAround(short, [1, 2], 2);

  assert.equal(short.state.hand!.result!.pots.length, 2);
  assert.deepEqual(paid(short), { seat: 0, hand: 'J4s', payments: [{ seat: 1, amount: 50 }, { seat: 2, amount: 50 }] });
  assertChipsConserved(short.state);

  // Seat 0 takes the side pot, and seat 2 all in for less the main one
  const deep = new TestTable({ stacks: [1000, 1000, 200], config: { bounties: [['J4s', 50]] } });
  deep.deal({ button: 0, holes: { 0: 'Jd 4d', 1: 'Kc Qc', 2: 'Ac Ah' }, board: 'As Js 4h 9c 2s' });
  deep.raise(0, 200);
  deep.call(1);
  deep.call(2);
  deep.raise(1, 100);
  deep.call(0);
  checkAround(deep, [1, 0], 2);

  assert.equal(deep.state.hand!.result!.pots.length, 2);
  assert.ok(deep.state.hand!.result!.winnings.some((win) => win.seat === 0 && win.amount > 0));
  assert.equal(paid(deep), null);
});

test('a player with less than a bounty pays what they have, and one with nothing pays nothing', () => {
  const t = uncalled('Jd 4d', [['J4s', 50]], [1000, 1000, 30]);

  assert.deepEqual(paid(t)!.payments, [
    { seat: 1, amount: 50 },
    { seat: 2, amount: 10 },
  ]);
  assert.deepEqual(t.stacks(), [1000 + 30 + 60, 1000 - 10 - 50, 0]);
});

test('a chopped hand pays no bounty, whatever the small blind holds', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: { allowChop: true, bounties: [['J4s', 50]] } });
  t.deal({ button: 0, holes: { 1: 'Jd 4d' } });
  t.fold(3);
  t.fold(0);
  t.cmd(1, { type: 'offerChop' });
  t.cmd(2, { type: 'answerChop', agree: true });

  assert.equal(paid(t), null);
  assert.deepEqual(t.stacks(), [1000, 1000, 1000, 1000]);
});

test('a hand is played for the bounties it was dealt under: a list changed during it waits for the next hand', () => {
  const play = (dealtUnder: Bounty[], changedTo: Bounty[]): TestTable => {
    const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bounties: dealtUnder } });
    t.deal({ button: 0, holes: { 0: 'Jd 4d' } });
    t.cmd(0, { type: 'updateConfig', config: { bounties: changedTo } });
    t.raise(0, 60);
    t.fold(1);
    t.fold(2);

    return t;
  };

  const added = play([], [['J4s', 100]]);
  assert.equal(paid(added), null);
  assert.ok(added.feedText().includes('The bounties are J4s for 100 from the next hand'));

  const removed = play([['J4s', 50]], []);
  assert.equal(paid(removed)!.payments[0]!.amount, 50);
  assert.ok(removed.feedText().includes('The bounties are off from the next hand'));

  const raised = play([['J4s', 50], ['72', 10]], [['J4s', 200]]);
  assert.equal(paid(raised)!.payments[0]!.amount, 50);
  assert.deepEqual(raised.view(0).hand!.holding!.bounty, ['J4s', 50], 'the hint goes by the hand in play');
  assert.ok(raised.feedText().includes('The bounties are J4s for 200 from the next hand'));

  raised.finishHand();
  raised.deal();
  assert.deepEqual(raised.state.hand!.bounties, [['J4s', 200]]);
});

test('a bounty hand is pointed out to its holder with its amount, and to nobody else', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bounties: LIST } });
  t.deal({ button: 0, holes: { 0: 'Jd 4d', 1: 'Jc 4h', 2: 'Qh Qd' } });

  assert.deepEqual(t.view(0).hand!.holding, { reads: [{ name: 'Jack-four suited', plays: [] }], bounty: ['J4s', 20] });
  assert.equal(t.view(1).hand!.holding!.bounty, null);
  assert.deepEqual(t.view(2).hand!.holding!.bounty, ['QQ', 40]);
  assert.ok(!JSON.stringify(t.view(1).hand).includes('"J4s"'), 'another player is told what someone else holds');
});

test('the list is checked when it is sent: each hand in the one form it is kept in, each amount as the table plays them, no hand twice, and no more than the most', () => {
  const cents = { ...DEFAULT_CONFIG, unit: 'cents' as const };
  const sent = (bounties: unknown, table = DEFAULT_CONFIG) => validatedConfig({ bounties }, table).bounties;

  assert.deepEqual(sent([['27', 10], ['j4S', 5], ['10 9o', 1]]), [['72', 10], ['J4s', 5], ['T9o', 1]]);
  assert.deepEqual(sent([]), []);
  assert.deepEqual(sent([['72', 250]], cents), [['72', 250]]);

  assert.throws(() => sent([['72', 0]]), { name: 'GameError', message: 'The 72 bounty must be a whole number from 1 to 1,000,000,000' });
  assert.throws(() => sent([['72', 2.5]]), { message: 'The 72 bounty must be a whole number from 1 to 1,000,000,000' });
  assert.throws(() => sent([['72', 0]], cents), { message: 'The 72 bounty must be an amount to the cent from 0.01 to 10,000,000.00' });
  assert.throws(() => sent([['7x', 10]]), /“7x” isn't a hand/);
  assert.throws(() => sent([['72', 10], ['27', 20]]), { name: 'GameError', message: '72 is on the list of bounties twice: give it one amount' });
  assert.throws(() => sent('72'), { message: 'The bounties must be a list of hands and amounts' });
  assert.throws(() => sent([['72']]), { message: 'Each bounty must be a hand and an amount' });
  assert.throws(() => sent([{ hand: '72', amount: 10 }]), { message: 'Each bounty must be a hand and an amount' });

  const most = ['72', '72s', 'J4s', 'AA', 'KK', 'T9o', '32', '83'].map((hand): Bounty => [hand, 10]);
  assert.equal(sent(most).length, 8);
  assert.throws(() => sent([...most, ['94', 10]]), { name: 'GameError', message: 'A table can have at most 8 bounty hands' });
});

test('the host or a co-host sets the bounties, and a player is refused', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });

  t.cmd(0, { type: 'updateConfig', config: { bounties: [['J4s', 50]] } });
  assert.deepEqual(t.state.config.bounties, [['J4s', 50]]);

  t.cmd(1, { type: 'updateConfig', config: { bounties: [['72', 10], ['J4s', 50]] } });
  assert.deepEqual(t.state.config.bounties, [['72', 10], ['J4s', 50]]);
  assert.ok(t.feedText().includes('The bounties are 72 for 10 and J4s for 50'));

  assert.throws(() => t.cmd(2, { type: 'updateConfig', config: { bounties: [] } }), { name: 'GameError' });
  assert.deepEqual(t.state.config.bounties, [['72', 10], ['J4s', 50]]);

  const said = t.feedText().length;
  t.cmd(0, { type: 'updateConfig', config: { bounties: [['27', 10], ['J4s', 50]] } });
  assert.equal(t.feedText().length, said, 'the same list written another way is no change');
});

test('a bounty hand folded to is turned up once to collect, whether or not its player chose to show, and a card shown after it turns up nothing more', () => {
  const chose = (on: boolean): TestTable => {
    const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bounties: [['J4s', 50]] } });
    if (on) {
      t.cmd(0, { type: 'setAutoShow', when: 'foldedTo', on: true });
    }
    t.deal({ button: 0, holes: { 0: 'Jd 4d', 1: '9c 8c' } });
    t.raise(0, 60);
    t.fold(1);
    t.fold(2);

    return t;
  };

  const off = chose(false);
  const on = chose(true);
  assert.deepEqual(on.state.hand!.events, off.state.hand!.events);
  assert.equal(on.state.hand!.events.filter((event) => event[0] === 'show').length, 1);
  assert.equal(paid(on)!.hand, 'J4s');

  // The winner has nothing left to show, and a player who folded shows one card beside it
  const events = on.state.hand!.events.length;
  on.show(0, [0]);
  assert.equal(on.state.hand!.events.length, events);
  on.show(1, [1]);
  assert.deepEqual(on.state.hand!.events.at(-1), ['show', 1, [null, '8c']]);

  on.finishHand();
  const record = handRecords(on.effects)[0]!;
  assert.deepEqual(record.players.map((player) => player.cards), [cards('Jd 4d'), [null, '8c'], [null, null]]);
  assert.equal(record.result.bounty!.hand, 'J4s');
});

test('Seven-Deuce is earned for seven-deuce alone, whatever hand a bounty is on, and a bounty on another hand still counts toward Heater', () => {
  const badgesOf = (t: TestTable, player: number) => t.state.tonight.players[t.ids[player]!]?.badges ?? {};

  const jackFour = uncalled('Jd 4d');
  jackFour.finishHand();
  assert.deepEqual(badgesOf(jackFour, 0), {});

  const suited = uncalled('7s 2s', [['72s', 30]]);
  suited.finishHand();
  assert.deepEqual(badgesOf(suited, 0), { sevenDeuce: 1 });

  // Seat 2, due the small blind, sits out, so the big blind is posted alone and comes back: the bounty is all the hand brings in
  const lone = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: { bounties: [['J4s', 50]] } });
  lone.deal({ button: 0 });
  lone.foldOut();
  lone.cmd(2, { type: 'sitOut' });
  lone.deal({ holes: { 3: 'Jd 4d' } });
  lone.fold(0);
  lone.fold(1);
  lone.finishHand();

  assert.equal(handRecords(lone.effects).at(-1)!.result.bounty?.hand, 'J4s');
  assert.equal(lone.state.tonight.players[lone.ids[3]!]!.streak, 1);
  assert.deepEqual(badgesOf(lone, 3), {});
});
