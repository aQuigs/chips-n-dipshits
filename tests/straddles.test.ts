/*
 * Straddles: who posts one in a hand and in what order, how a hand with each kind is bet, and what
 * holds of them whatever the table. Hands are really dealt, so what is checked is what the players of
 * a hand post and where its action starts, not only what the plan says.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eligibleSeats, isStraddle, owes, replayHand, SEAT_COUNT, seatsClockwiseAfter, STRADDLES, STRADDLES_IN_A_ROW } from '../src/engine/index.ts';
import type { Rng, Seat, Straddle, TableConfig } from '../src/engine/index.ts';
import { handRecords, options, seededRng, TestTable } from './helpers.ts';
import { assertChipsConserved, assertHandRecordsHold, assertInvariants } from './invariants.ts';
import { chance } from './randomPlay.ts';

const LETTERS: Record<string, Straddle> = { U: 'straddle', D: 'double straddle', B: 'button straddle', M: 'Mississippi straddle' };
const EVERY_KIND = 'UDBM';

const kinds = (letters: string): Straddle[] => [...letters].map((letter) => LETTERS[letter]!);

/** The switches of a table that allows the kinds named by `letters` and no other. */
function allowing(letters: string): Partial<TableConfig> {
  return Object.fromEntries(STRADDLES.map((kind) => [kind.setting, kinds(letters).includes(kind.what)]));
}

function choose(t: TestTable, seat: number, letters: string): void {
  for (const kind of kinds(letters)) {
    t.cmd(t.playerIn(seat), { type: 'setStraddle', kind, on: true });
  }
}

/** One hand looked at: the table it is dealt at, who asked for what, and what then has to be posted. */
interface Case {
  name: string;
  /** How many players, in the first seats. The hand looked at has the button on seat 0 unless `lead` deals hands before it. */
  players: number;
  /** The kinds the table allows, by letter: U under the gun, D double, B button, M Mississippi. */
  on: string;
  /** The kinds each seat asked for, by letter. */
  want: Record<number, string>;
  stacks?: Record<number, number>;
  config?: Partial<TableConfig>;
  /** What happens at the table first. When it deals a hand, the hand looked at follows on from it. */
  lead?: (t: TestTable) => void;
  /** The hand's straddles as `seat what amount`, in the order they are posted. */
  line: string[];
  /** Who asked and was passed over, as `seat why`, with the seat that had the right or the amount they were short of. */
  passed?: string[];
  /** The seats in the order they act before the flop when nobody raises. */
  acts: string;
}

/** Plays a hand with the button on seat 0, during which `seat` sits out, and then hands until the button is due on seat 0 again. */
function roundWithout(t: TestTable, seat: number): void {
  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(seat, { type: 'sitOut' });

  for (let hand = 0; hand < 4; hand++) {
    t.deal();
    t.foldOut();
  }
}

/** The player in `seat` misses both blinds and comes back posting them, into a hand with the button on seat 0. */
const backPosting = (seat: number) => (t: TestTable) => {
  roundWithout(t, seat);
  t.cmd(seat, { type: 'comeIn', post: true });
};

/** A first hand with the button on seat 0, after which the player in `seat` sits out. */
const outAfterOneHand = (seat: number) => (t: TestTable) => {
  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(seat, { type: 'sitOut' });
};

// Six players with the button on seat 0: the blinds on seats 1 and 2, seat 3 under the gun, seat 5 the cutoff
const CASES: Case[] = [
  { name: 'under the gun: twice the big blind, and the action starts on its left', players: 6, on: 'U', want: { 3: 'U' }, line: ['3 straddle 40'], acts: '4 5 0 1 2 3' },
  { name: 'a player who asked posts nothing from any seat but the one their kind is posted from', players: 6, on: 'U', want: { 0: 'U', 1: 'U', 2: 'U', 4: 'U', 5: 'U' }, line: [], acts: '3 4 5 0 1 2' },
  { name: 'a kind the table allows and nobody asked for is not posted', players: 6, on: EVERY_KIND, want: {}, line: [], acts: '3 4 5 0 1 2' },

  { name: 'double: the next player posts twice the straddle, and the action starts on their left', players: 6, on: 'UD', want: { 3: 'U', 4: 'D' }, line: ['3 straddle 40', '4 double straddle 80'], acts: '5 0 1 2 3 4' },
  { name: 'double: there is no third straddle', players: 6, on: 'UD', want: { 3: 'U', 4: 'D', 5: 'D', 0: 'D' }, line: ['3 straddle 40', '4 double straddle 80'], acts: '5 0 1 2 3 4' },
  { name: 'double: not without a straddle to double', players: 6, on: 'UD', want: { 4: 'D', 5: 'U' }, line: [], acts: '3 4 5 0 1 2' },
  { name: 'double: not by the player whose straddle it would double', players: 6, on: 'UD', want: { 3: 'UD' }, line: ['3 straddle 40'], acts: '4 5 0 1 2 3' },
  { name: 'double: only from the very next player, not one further round', players: 6, on: 'UD', want: { 3: 'U', 5: 'D' }, line: ['3 straddle 40'], acts: '4 5 0 1 2 3' },
  { name: 'double: a player who cannot cover it is passed, and it goes to nobody else', players: 6, on: 'UD', want: { 3: 'U', 4: 'D', 5: 'D' }, stacks: { 4: 79 }, line: ['3 straddle 40'], passed: ['4 short 80'], acts: '4 5 0 1 2 3' },
  { name: 'double: a stack of exactly the double posts it, all in', players: 6, on: 'UD', want: { 3: 'U', 4: 'D' }, stacks: { 4: 80 }, line: ['3 straddle 40', '4 double straddle 80'], acts: '5 0 1 2 3' },
  {
    name: 'double: a seat sitting out is not at the table, so the next player dealt in is the next player',
    players: 6,
    on: 'UD',
    want: { 3: 'U', 5: 'D' },
    lead: (t) => t.cmd(4, { type: 'sitOut' }),
    line: ['3 straddle 40', '5 double straddle 80'],
    acts: '0 1 2 3 5',
  },

  { name: 'button: twice the big blind, the small blind acts first and the button last', players: 6, on: 'B', want: { 0: 'B' }, line: ['0 button straddle 40'], acts: '1 2 3 4 5 0' },
  { name: 'button: only from the button', players: 6, on: 'B', want: { 3: 'B', 4: 'B', 5: 'B' }, line: [], acts: '3 4 5 0 1 2' },
  { name: 'the button has the right before under the gun, and no double follows a straddle from the button', players: 6, on: 'UDB', want: { 3: 'U', 4: 'D', 0: 'B' }, line: ['0 button straddle 40'], passed: ['3 right 0'], acts: '1 2 3 4 5 0' },
  { name: 'a button too short for it is passed, and the straddle under the gun stands', players: 6, on: 'UDB', want: { 3: 'U', 4: 'D', 0: 'B' }, stacks: { 0: 39 }, line: ['3 straddle 40', '4 double straddle 80'], passed: ['0 short 40'], acts: '5 0 1 2 3 4' },

  { name: 'Mississippi from the cutoff: the action starts with the button and goes round to the cutoff', players: 6, on: 'M', want: { 5: 'M' }, line: ['5 Mississippi straddle 40'], acts: '0 1 2 3 4 5' },
  { name: 'Mississippi: the button first, then the players to its right in turn', players: 6, on: 'M', want: { 0: 'M', 5: 'M', 4: 'M', 3: 'M' }, line: ['0 Mississippi straddle 40'], passed: ['5 right 0', '4 right 0', '3 right 0'], acts: '1 2 3 4 5 0' },
  { name: 'Mississippi: the nearest to the button’s right of those who asked', players: 6, on: 'M', want: { 3: 'M', 4: 'M' }, line: ['4 Mississippi straddle 40'], passed: ['3 right 4'], acts: '5 0 1 2 3 4' },
  { name: 'Mississippi: a player too short is passed and the next to the right has it', players: 6, on: 'M', want: { 0: 'M', 5: 'M', 4: 'M' }, stacks: { 0: 30, 5: 39 }, line: ['4 Mississippi straddle 40'], passed: ['0 short 40', '5 short 40'], acts: '5 0 1 2 3 4' },
  { name: 'Mississippi: never from a blind', players: 6, on: 'M', want: { 1: 'M', 2: 'M' }, line: [], acts: '3 4 5 0 1 2' },
  { name: 'Mississippi from the cutoff has the right before a straddle under the gun', players: 6, on: 'UDM', want: { 3: 'U', 4: 'D', 5: 'M' }, line: ['5 Mississippi straddle 40'], passed: ['3 right 5'], acts: '0 1 2 3 4 5' },
  { name: 'a seat two kinds are posted from posts the one listed first: under the gun', players: 6, on: 'UM', want: { 3: 'UM' }, line: ['3 straddle 40'], acts: '4 5 0 1 2 3' },
  { name: 'a seat two kinds are posted from posts the one listed first: the button', players: 6, on: 'BM', want: { 0: 'BM' }, line: ['0 button straddle 40'], acts: '1 2 3 4 5 0' },
  { name: 'a straddle from under the gun is doubled whatever kind it is', players: 6, on: 'DM', want: { 3: 'M', 4: 'D' }, line: ['3 Mississippi straddle 40', '4 double straddle 80'], acts: '5 0 1 2 3 4' },
  { name: 'a Mississippi straddle from anywhere else is not doubled', players: 6, on: 'DM', want: { 5: 'M', 0: 'D' }, line: ['5 Mississippi straddle 40'], acts: '0 1 2 3 4 5' },

  { name: 'with an ante, the straddle is what is left after it: a chip short is passed', players: 6, on: 'U', want: { 3: 'U' }, stacks: { 3: 44 }, config: { ante: 5 }, line: [], passed: ['3 short 40'], acts: '3 4 5 0 1 2' },
  { name: 'with an ante, a stack of exactly both posts both and is all in', players: 6, on: 'U', want: { 3: 'U' }, stacks: { 3: 45 }, config: { ante: 5 }, line: ['3 straddle 40'], acts: '4 5 0 1 2' },
  { name: 'dollars and cents: twice the big blind, and twice that', players: 6, on: 'UD', want: { 3: 'U', 4: 'D' }, config: { unit: 'cents', smallBlind: 25, bigBlind: 50 }, line: ['3 straddle 100', '4 double straddle 200'], acts: '5 0 1 2 3 4' },

  { name: 'a missed blind posted beside it stops nobody else: the straddle and the double go on around it', players: 6, on: 'UD', want: { 3: 'U', 4: 'D' }, lead: backPosting(5), line: ['3 straddle 40', '4 double straddle 80'], acts: '5 0 1 2 3 4' },
  { name: 'a player posting a missed blind does not straddle under the gun', players: 6, on: 'UD', want: { 3: 'U', 4: 'D' }, lead: backPosting(3), line: [], passed: ['3 blind'], acts: '3 4 5 0 1 2' },
  { name: 'a player posting a missed blind does not double, and the double goes to nobody else', players: 6, on: 'UD', want: { 3: 'U', 4: 'D', 5: 'D' }, lead: backPosting(4), line: ['3 straddle 40'], passed: ['4 blind'], acts: '4 5 0 1 2 3' },
  { name: 'a player posting a missed blind has no Mississippi straddle, and the next to the right has it', players: 6, on: 'M', want: { 5: 'M', 4: 'M' }, lead: backPosting(5), line: ['4 Mississippi straddle 40'], passed: ['5 blind'], acts: '5 0 1 2 3 4' },

  // The button is dead on seat 1: the blinds are on seats 2 and 3, seat 4 is under the gun and seat 0 the last before the button
  { name: 'a dead button: nobody has the button straddle', players: 6, on: 'B', want: { 0: 'B', 5: 'B', 4: 'B' }, lead: outAfterOneHand(1), line: [], acts: '4 5 0 2 3' },
  { name: 'a dead button: the last player before it has the first right to the Mississippi', players: 6, on: 'BM', want: { 0: 'BM', 5: 'M' }, lead: outAfterOneHand(1), line: ['0 Mississippi straddle 40'], passed: ['5 right 0'], acts: '2 3 4 5 0' },
  { name: 'a dead button: under the gun and the double are where the blinds put them', players: 6, on: 'UD', want: { 4: 'U', 5: 'D' }, lead: outAfterOneHand(1), line: ['4 straddle 40', '5 double straddle 80'], acts: '0 2 3 4 5' },

  // The small blind is on seat 2, whose player is out: the button is on seat 1, the big blind on seat 3 and seat 4 under the gun
  { name: 'no small blind: under the gun is still the first player after the big blind', players: 6, on: 'UD', want: { 4: 'U', 5: 'D' }, lead: outAfterOneHand(2), line: ['4 straddle 40', '5 double straddle 80'], acts: '0 1 3 4 5' },
  { name: 'no small blind: after a button straddle the big blind acts first', players: 6, on: 'UB', want: { 4: 'U', 1: 'B' }, lead: outAfterOneHand(2), line: ['1 button straddle 40'], passed: ['4 right 1'], acts: '3 4 5 0 1' },

  // Three players: the button is under the gun
  { name: 'three players: the button straddles under the gun', players: 3, on: 'U', want: { 0: 'U' }, line: ['0 straddle 40'], acts: '1 2 0' },
  { name: 'three players: where only the button straddle is allowed, that is what it posts, for the same betting', players: 3, on: 'B', want: { 0: 'B' }, line: ['0 button straddle 40'], acts: '1 2 0' },
  { name: 'three players: the one seat every first straddle is posted from posts the first listed', players: 3, on: EVERY_KIND, want: { 0: EVERY_KIND, 1: EVERY_KIND, 2: EVERY_KIND }, line: ['0 straddle 40'], passed: ['1 blind'], acts: '1 2 0' },
  { name: 'three players: the next player is the small blind, who does not double', players: 3, on: 'UD', want: { 0: 'U', 1: 'D' }, line: ['0 straddle 40'], passed: ['1 blind'], acts: '1 2 0' },

  { name: 'two players: nobody straddles', players: 2, on: EVERY_KIND, want: { 0: EVERY_KIND, 1: EVERY_KIND }, line: [], passed: ['1 two players', '0 two players'], acts: '0 1' },

  // Four players: seat 3 is under the gun and the button is next to it
  { name: 'four players: the button doubles the straddle under the gun', players: 4, on: 'UD', want: { 3: 'U', 0: 'D' }, line: ['3 straddle 40', '0 double straddle 80'], acts: '1 2 3 0' },
  { name: 'four players: a button who asked for both takes the hand with the button straddle', players: 4, on: 'UDB', want: { 3: 'U', 0: 'DB' }, line: ['0 button straddle 40'], passed: ['3 right 0'], acts: '1 2 3 0' },

  { name: 'ten players: the straddle and the double under the gun', players: 10, on: 'UD', want: { 3: 'U', 4: 'D', 5: 'D' }, line: ['3 straddle 40', '4 double straddle 80'], acts: '5 6 7 8 9 0 1 2 3 4' },
  { name: 'ten players: a Mississippi straddle from the middle of the table', players: 10, on: 'UDM', want: { 3: 'U', 4: 'D', 7: 'M' }, line: ['7 Mississippi straddle 40'], passed: ['3 right 7'], acts: '8 9 0 1 2 3 4 5 6 7' },
];

function dealt({ players, on, want, stacks = {}, config = {}, lead }: Case): TestTable {
  const t = new TestTable({ stacks: Array.from({ length: players }, (_, seat) => stacks[seat] ?? 1000), config: { ...allowing(on), ...config } });

  lead?.(t);
  for (const [seat, letters] of Object.entries(want)) {
    choose(t, Number(seat), letters);
  }

  t.deal(t.state.handCount > 0 ? {} : { button: 0 });

  return t;
}

/** Every forced bet of the hand on the table, as `seat what amount`. */
function posts(t: TestTable): string[] {
  return t.state.hand!.events.flatMap((event) => (event[0] === 'post' ? [`${event[1]} ${event[2]} ${event[3]}`] : []));
}

function passedOver(t: TestTable): string[] {
  return t.state.hand!.passedOver.map((passed) => [passed.seat, passed.why, ...(passed.why === 'right' ? [passed.ahead] : passed.why === 'short' ? [passed.amount] : [])].join(' '));
}

/** Everyone calls, or checks with nothing to call. Gives the seats in the order they acted before the flop, and whether the last of them could check. */
function callAround(t: TestTable): { order: number[]; lastHadTheOption: boolean } {
  const order: number[] = [];
  let lastHadTheOption = false;

  while (t.state.hand?.stage === 'betting' && t.state.hand.street === 'preflop') {
    const seat = t.toAct!;
    const player = t.playerIn(seat);

    order.push(seat);
    lastHadTheOption = options(t, player).canCheck;

    if (lastHadTheOption) {
      t.check(player);
    } else {
      t.call(player);
    }
  }

  return { order, lastHadTheOption };
}

for (const example of CASES) {
  test(`who straddles: ${example.name}`, () => {
    const t = dealt(example);
    const hand = t.state.hand!;
    const { line } = example;

    assert.deepEqual(hand.straddles.map((straddle) => `${straddle.seat} ${straddle.what} ${straddle.amount}`), line);
    assert.deepEqual(passedOver(t), example.passed ?? []);

    // Posted after every blind and ante, in the order of the line
    assert.deepEqual(posts(t).filter((post) => isStraddle(post.split(' ').slice(1, -1).join(' '))), line);
    assert.deepEqual(posts(t).slice(posts(t).length - line.length), line);
    assertInvariants(t.state, t.now);

    const biggest = hand.straddles.at(-1);
    assert.equal(hand.currentBet, biggest?.amount ?? hand.bigBlind);
    assert.equal(hand.minRaise, hand.currentBet, 'a raise is by at least the biggest straddle');

    // Whoever posted the biggest acts last, with the option, unless posting it took their whole stack
    const last = biggest?.seat ?? hand.bbSeat;
    const hasChips = t.state.seats[last]!.stack > 0;
    const { order, lastHadTheOption } = callAround(t);

    assert.equal(order.join(' '), example.acts);
    assert.deepEqual([order.at(-1) === last, lastHadTheOption], [hasChips, hasChips]);
    assertInvariants(t.state, t.now);
  });
}

const SIZES = [2, 3, 4, 6, 10];

/** Every set of kinds a table can allow, by letter. */
const COMBINATIONS = Array.from({ length: 2 ** EVERY_KIND.length }, (_, bits) => [...EVERY_KIND].filter((_letter, nth) => bits & (2 ** nth)).join(''));

/**
 * What one player who asked for everything posts, alone in asking, at a table with the button on seat
 * 0, the blinds on seats 1 and 2 and seat 3 under the gun, where there is a seat 3.
 */
function postedAlone(players: number, seat: number, on: string): string[] {
  const underTheGun = players === 3 ? 0 : 3;

  if (players === 2 || seat === 1 || seat === 2) {
    return [];
  }

  if (seat === underTheGun && on.includes('U')) {
    return [`${seat} straddle 40`];
  }

  if (seat === 0 && on.includes('B')) {
    return [`${seat} button straddle 40`];
  }

  return on.includes('M') ? [`${seat} Mississippi straddle 40`] : [];
}

/** What is posted at the same table when everyone asked for everything. */
function postedByACrowd(players: number, on: string): string[] {
  // Three-handed the one seat without a blind has every right, and the next player is the small blind
  if (players <= 3) {
    return postedAlone(players, 0, on);
  }

  // The button has the first right to a straddle of its own, and nothing doubles one from the button
  if (on.includes('B') || on.includes('M')) {
    return postedAlone(players, 0, on);
  }

  if (!on.includes('U')) {
    return [];
  }

  return ['3 straddle 40', ...(on.includes('D') ? [`${4 % players} double straddle 80`] : [])];
}

test('for every number of players and every set of kinds a table can allow, one player asking from each seat in turn posts what the rules give that seat, and a table where everyone asks has one line', () => {
  assert.equal(COMBINATIONS.length, 16);

  for (const players of SIZES) {
    for (const on of COMBINATIONS) {
      const where = `${players} players, allowing ${on || 'nothing'}`;
      const table = (want: Record<number, string>) => dealt({ name: where, players, on, want, line: [], acts: '' });
      const line = (t: TestTable) => t.state.hand!.straddles.map((straddle) => `${straddle.seat} ${straddle.what} ${straddle.amount}`);

      for (let seat = 0; seat < players; seat++) {
        const alone = table({ [seat]: on });

        assert.deepEqual(line(alone), postedAlone(players, seat, on), `${where}, seat ${seat} asking`);
        assertInvariants(alone.state, alone.now);
      }

      const crowd = table(Object.fromEntries(Array.from({ length: players }, (_, seat) => [seat, on])));
      const expected = postedByACrowd(players, on);

      assert.deepEqual(line(crowd), expected, `${where}, everyone asking`);
      assertInvariants(crowd.state, crowd.now);

      // The action starts left of the last of them, or of the big blind
      const last = expected.length > 0 ? Number(expected.at(-1)!.split(' ')[0]) : players === 2 ? 1 : 2;
      assert.equal(crowd.toAct, (last + 1) % players, `${where}, everyone asking`);
    }
  }
});

/** A hand of six with the button on seat 0, the blinds 10 and 20 on seats 1 and 2, and each kind of straddle in turn. */
const BETTING: { name: string; on: string; want: Record<number, string>; straddler: number; biggest: number; first: number; says: string[]; toCall: Record<number, number> }[] = [
  { name: 'a straddle under the gun', on: 'U', want: { 3: 'U' }, straddler: 3, biggest: 40, first: 4, says: ['P3 posts straddle 40'], toCall: { 4: 40, 5: 40, 0: 40, 1: 30, 2: 20 } },
  {
    name: 'a double straddle',
    on: 'UD',
    want: { 3: 'U', 4: 'D' },
    straddler: 4,
    biggest: 80,
    first: 5,
    says: ['P3 posts straddle 40', 'P4 posts double straddle 80'],
    toCall: { 5: 80, 0: 80, 1: 70, 2: 60, 3: 40 },
  },
  { name: 'a button straddle', on: 'B', want: { 0: 'B' }, straddler: 0, biggest: 40, first: 1, says: ['P0 posts button straddle 40'], toCall: { 1: 30, 2: 20, 3: 40, 4: 40, 5: 40 } },
  { name: 'a Mississippi straddle from the cutoff', on: 'M', want: { 5: 'M' }, straddler: 5, biggest: 40, first: 0, says: ['P5 posts Mississippi straddle 40'], toCall: { 0: 40, 1: 30, 2: 20, 3: 40, 4: 40 } },
];

for (const { name, on, want, straddler, biggest, first, says, toCall } of BETTING) {
  const six = (config: Partial<TableConfig> = {}) => dealt({ name, players: 6, on, want, config, line: [], acts: '' });
  // Everyone but the straddler, in the order they act
  const others = [1, 2, 3, 4, 5].map((places) => (straddler + places) % 6);
  const posted = (seat: number) => biggest - toCall[seat]!;

  test(`betting with ${name}: every other player has the difference to call, and the straddler acts last with the option`, () => {
    const t = six();
    const hand = t.state.hand!;

    assert.deepEqual([hand.currentBet, hand.minRaise, t.toAct], [biggest, biggest, first]);
    assert.deepEqual(hand.log.filter((line) => line.includes('straddle')), says);
    assert.equal(hand.players.find((player) => player.seat === straddler)!.lastAction, hand.straddles.at(-1)!.what, 'the seat is labeled by what is in front of it');

    while (t.toAct !== straddler) {
      const seat = t.toAct!;

      assert.deepEqual([options(t, seat).canCheck, options(t, seat).callAmount, options(t, seat).minRaiseTo], [false, toCall[seat], 2 * biggest], `seat ${seat}`);
      t.call(seat);
    }

    assert.deepEqual([options(t, straddler).canCheck, options(t, straddler).canRaise, options(t, straddler).minRaiseTo], [true, true, 2 * biggest]);
    t.check(straddler);

    assert.deepEqual([hand.street, hand.minRaise, t.toAct], ['flop', 20, 1], 'after the flop a bet is the big blind again, and the small blind acts first');
    assert.equal(hand.players.reduce((sum, player) => sum + player.committed, 0), 6 * biggest);
    assertInvariants(t.state, t.now);
  });

  test(`betting with ${name}: a raise over it is to twice it at least, and the straddler has the rest to call`, () => {
    const t = six();

    assert.throws(() => t.raise(first, 2 * biggest - 1), { name: 'GameError' });
    t.raise(first, 2 * biggest);

    while (t.toAct !== straddler) {
      t.fold(t.toAct!);
    }

    assert.deepEqual([options(t, straddler).canCheck, options(t, straddler).callAmount, options(t, straddler).minRaiseTo], [false, biggest, 3 * biggest]);
    t.raise(straddler, 3 * biggest);
    assert.deepEqual([t.toAct, options(t, first).callAmount], [first, biggest]);
    assertInvariants(t.state, t.now);
  });

  test(`betting with ${name}: when everyone folds to the straddler, the blinds and the straddles under it are theirs`, () => {
    const t = six();

    while (t.state.hand!.stage === 'betting') {
      t.fold(t.toAct!);
    }

    const won = others.reduce((sum, seat) => sum + posted(seat), 0);
    assert.deepEqual(t.stacks(), [0, 1, 2, 3, 4, 5].map((seat) => (seat === straddler ? 1000 + won : 1000 - posted(seat))));

    t.finishHand();
    assertHandRecordsHold(t.effects);
  });

  test(`betting with ${name}: an ante changes none of it`, () => {
    const t = six({ ante: 5 });
    const hand = t.state.hand!;

    assert.deepEqual([hand.currentBet, hand.minRaise, t.toAct], [biggest, biggest, first]);
    assert.deepEqual(callAround(t).order, [...others, straddler]);
    assert.equal(hand.players.reduce((sum, player) => sum + player.committed, 0), 6 * (biggest + 5));
    assertInvariants(t.state, t.now);
  });

  test(`the events of a hand with ${name} retell it: each straddle a post under its own name, in front of its player`, () => {
    const t = six();
    const hand = t.state.hand!;
    const events = hand.events;

    assert.deepEqual(events.filter((event) => event[0] === 'post').slice(2), hand.straddles.map(({ seat, what, amount }) => ['post', seat, what, amount, 1000 - amount]));

    const afterPosts = replayHand(events, events.findIndex((event) => event[0] === 'deal'))!;
    assert.deepEqual(afterPosts.seats.map((seat) => [seat.seat, seat.bet, seat.stack]), hand.players.map((player) => [player.seat, player.bet, t.state.seats[player.seat]!.stack]));
    assert.deepEqual(afterPosts.seats.map((seat) => seat.bet), [0, 1, 2, 3, 4, 5].map((seat) => (seat === straddler ? biggest : posted(seat))));

    for (const viewer of [0, 3]) {
      assert.deepEqual(t.view(viewer).hand!.events, events, 'every viewer is sent the same events');
      assert.deepEqual(t.view(viewer).hand!.straddles, hand.straddles);
    }

    callAround(t);
    t.foldOut();
    assertHandRecordsHold(t.effects);
    assert.deepEqual(replayHand(handRecords(t.effects)[0]!.events)!.seats.map((seat) => seat.stack), t.stacks());
  });
}

test('a straddle is all of it or none: a player a chip short posts no part of one, and one with exactly the amount is all in with nothing to add', () => {
  const short = dealt({ name: 'short', players: 6, on: 'B', want: { 0: 'B' }, stacks: { 0: 39 }, line: [], acts: '' });
  assert.deepEqual([short.state.hand!.straddles, passedOver(short), short.state.seats[0]!.stack], [[], ['0 short 40'], 39]);

  const exact = dealt({ name: 'exact', players: 6, on: 'B', want: { 0: 'B' }, stacks: { 0: 40 }, line: [], acts: '' });
  const hand = exact.state.hand!;
  assert.deepEqual([hand.straddles, hand.players[0]!.allIn, exact.toAct], [[{ seat: 0, what: 'button straddle', amount: 40 }], true, 1]);

  // Nobody raises, and the betting ends with the big blind: there is nobody after them left to act
  assert.deepEqual(callAround(exact), { order: [1, 2, 3, 4, 5], lastHadTheOption: false });
  assertInvariants(exact.state, exact.now);
});

test('a double straddler all in from posting it can win what each player matched of it, and the rest is a side pot between the others', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000, 80, 1000], config: allowing('UD') });
  choose(t, 3, 'U');
  choose(t, 4, 'D');
  t.deal({ button: 0, holes: { 3: 'Qs Qh', 4: 'As Ah', 5: 'Ks Kh' }, board: '2c 7d 9h Jc 3s' });

  assert.deepEqual([t.state.hand!.players[4]!.allIn, t.toAct], [true, 5]);
  t.call(5);
  t.fold(0);
  t.fold(1);
  t.fold(2);

  // The straddler under the gun closes the betting: the player whose double they call has nothing left to raise with
  assert.equal(options(t, 3).callAmount, 40);
  t.call(3);
  assert.equal(t.state.hand!.street, 'flop');

  t.raise(3, 100);
  t.call(5);
  for (let street = 0; street < 2; street++) {
    t.check(3);
    t.check(5);
  }

  t.finishHand();

  const [record] = handRecords(t.effects);
  assert.deepEqual(record!.result.pots.map((pot) => pot.amount), [270, 200]);
  assert.deepEqual(t.stacks(), [1000, 990, 980, 820, 270, 1020]);
  assertHandRecordsHold(t.effects);
});

test('a straddler who gets up in the middle of the hand leaves it as it was dealt, and the next hand is dealt without them', () => {
  const t = dealt({ name: 'leaving', players: 6, on: 'UDB', want: { 3: 'U', 4: 'D', 0: 'B' }, line: [], acts: '' });

  t.cmd(0, { type: 'standUp' });
  assert.deepEqual(t.state.hand!.straddles, [{ seat: 0, what: 'button straddle', amount: 40 }]);
  assert.deepEqual(t.view(3).hand!.passedOver, { seat: 3, why: 'right', ahead: 0 });
  assertInvariants(t.state, t.now);

  // Everyone folds to the straddle, which the player who left wins and takes with them
  t.foldOut();
  assert.equal(t.state.seats[0], null);
  assert.deepEqual(t.stacks(), [0, 990, 980, 1000, 1000, 1000]);
  assertHandRecordsHold(t.effects);

  // Five are dealt in. Seat 3, who asked to straddle under the gun, has the big blind, and seat 4 asked only to double
  t.deal();
  assert.deepEqual([t.state.hand!.button, t.state.hand!.players.length, t.state.hand!.straddles, t.state.hand!.passedOver], [1, 5, [], []]);
  assertInvariants(t.state, t.now);
});

test('a bomb pot has no straddle of any kind, and nobody is told they were passed over for one', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000, 1000, 1000], config: allowing(EVERY_KIND) });
  for (let seat = 0; seat < 6; seat++) {
    choose(t, seat, EVERY_KIND);
  }

  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0 });
  assert.deepEqual([t.state.hand!.straddles, t.state.hand!.passedOver, posts(t).filter((post) => !post.includes('bomb pot'))], [[], [], []]);
  t.foldOut();

  // The players still want theirs, and the next hand with blinds has it
  t.deal();
  assert.deepEqual(t.state.hand!.straddles.map((straddle) => straddle.what), ['button straddle']);
});

test('a player chooses each kind for themselves, only of the kinds the table allows, and keeps the choice from hand to hand', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: allowing('UB') });

  assert.throws(() => t.cmd(1, { type: 'setStraddle', kind: 'double straddle', on: true }), { name: 'GameError', message: 'The double straddle is turned off at this table' });
  assert.throws(() => t.cmd(1, { type: 'setStraddle', kind: 'Mississippi straddle', on: true }), { message: 'The Mississippi straddle is turned off at this table' });
  assert.throws(() => t.cmd(1, { type: 'setStraddle', kind: 'triple', on: true } as never), { name: 'GameError', message: 'That is no kind of straddle' });
  assert.throws(() => t.cmd(1, { type: 'setStraddle', on: true } as never), { name: 'GameError', message: 'That is no kind of straddle' });
  assert.throws(() => t.cmd(1, { type: 'setStraddle', kind: 'toString', on: true } as never), { name: 'GameError' });

  // Switching off one that is not allowed is not refused: it is off already
  t.cmd(1, { type: 'setStraddle', kind: 'double straddle', on: false });

  t.cmd(1, { type: 'setStraddle', kind: 'button straddle', on: true });
  t.cmd(1, { type: 'setStraddle', kind: 'straddle', on: true });
  t.cmd(1, { type: 'setStraddle', kind: 'straddle', on: true });
  assert.deepEqual(t.state.seats[1]!.straddles, ['straddle', 'button straddle'], 'in the order they are listed, each once');
  assert.deepEqual(t.view(2).seats[1]!.straddles, ['straddle', 'button straddle']);

  // Seat 1 has the button, and is under the gun in the next hand: four-handed that is the seat on the button's right
  t.deal({ button: 1 });
  assert.deepEqual(t.state.hand!.straddles, [{ seat: 1, what: 'button straddle', amount: 40 }]);
  t.foldOut();

  const posted: string[] = [];
  for (let hand = 0; hand < 3; hand++) {
    t.deal();
    posted.push(t.state.hand!.straddles.map((straddle) => `${straddle.seat} ${straddle.what}`).join());
    t.foldOut();
  }

  assert.deepEqual(posted, ['1 straddle', '', '']);

  t.cmd(1, { type: 'setStraddle', kind: 'button straddle', on: false });
  assert.deepEqual(t.state.seats[1]!.straddles, ['straddle']);
});

test('a kind the host switches off is dropped from every player’s choice, the others are kept, and the table is told what is allowed', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: allowing(EVERY_KIND) });
  choose(t, 1, EVERY_KIND);
  choose(t, 3, 'UM');
  t.deal({ button: 0 });
  const hand = JSON.stringify(t.state.hand);

  t.cmd(0, { type: 'updateConfig', config: { allowMississippiStraddle: false, allowStraddle: false } });
  assert.deepEqual([t.state.seats[1]!.straddles, t.state.seats[3]!.straddles], [['double straddle', 'button straddle'], []]);
  assert.equal(t.feedText().at(-1), 'Straddles allowed from the next hand: Double straddle, Button straddle');
  assert.equal(JSON.stringify(t.state.hand), hand, 'the hand in play keeps the straddles it was dealt with');

  // Allowed again, a kind starts from nobody posting it
  t.cmd(0, { type: 'updateConfig', config: { allowStraddle: true } });
  assert.deepEqual(t.state.seats[3]!.straddles, []);
  assert.equal(t.feedText().at(-1), 'Straddles allowed from the next hand: Straddle under the gun, Double straddle, Button straddle');

  t.cmd(0, { type: 'updateConfig', config: { name: 'Another name' } });
  assert.equal(t.feedText().filter((line) => line.startsWith('Straddles allowed')).length, 2, 'a change to another setting says nothing of straddles');

  t.foldOut();
  t.cmd(0, { type: 'updateConfig', config: allowing('') });
  assert.equal(t.feedText().at(-1), 'No straddles are allowed');
  assert.deepEqual(t.state.seats[1]!.straddles, []);
});

test('only the player passed over is told so, and why; nobody else’s view says who asked for what this hand', () => {
  const t = dealt({ name: 'told', players: 6, on: 'UDB', want: { 3: 'U', 4: 'D', 0: 'B' }, line: [], acts: '' });

  assert.deepEqual(t.view(3).hand!.passedOver, { seat: 3, why: 'right', ahead: 0 });
  for (const viewer of [0, 1, 2, 4, 5]) {
    assert.equal(t.view(viewer).hand!.passedOver, null, `seat ${viewer}`);
  }
});

const TABLES = Number(process.env.SIM_TABLES ?? 60);
const HANDS_PER_TABLE = 40;

const pick = <T>(rng: Rng, from: readonly T[]) => from[rng.int(from.length)]!;
const seated = (t: TestTable) => t.state.seats.flatMap((seat, index) => (seat ? [index] : []));

// A double is posted only where nothing has the right before the straddle under the gun, so many tables allow just those two
const ALLOWED = ['U', 'UD', 'UD', 'UD', 'UDB', 'UDM', 'B', 'M', 'BM', EVERY_KIND, EVERY_KIND, ''];
const EXACT_STACKS = [40, 45, 80, 85];

/** What can happen between two hands of a random table. */
const BETWEEN_HANDS: ((t: TestTable, rng: Rng) => void)[] = [
  (t, rng) => t.cmd(t.playerIn(pick(rng, seated(t))), { type: 'sitOut' }),
  (t, rng) => {
    for (const seat of seated(t).filter((index) => t.state.seats[index]!.sittingOut || owes(t.state.seats[index]!))) {
      t.cmd(t.playerIn(seat), { type: 'comeIn', post: chance(rng, 70) });
    }
  },
  (t, rng) => {
    // Often a stack that a straddle, a double or one of them with the ante takes whole or leaves a chip short
    const stack = chance(rng, 40) ? pick(rng, EXACT_STACKS) - rng.int(2) : chance(rng, 50) ? 1 + rng.int(200) : 2000;

    t.cmd(0, { type: 'setStack', playerId: t.state.seats[pick(rng, seated(t))]!.playerId, stack });
  },
  (t, rng) => {
    // Everyone makes up their mind at once: one player in ten would hardly ever be where their straddle is posted from
    for (const seat of seated(t)) {
      for (const kind of STRADDLES.filter((entry) => t.state.config[entry.setting])) {
        t.cmd(t.playerIn(seat), { type: 'setStraddle', kind: kind.what, on: chance(rng, 60) });
      }
    }
  },
  (t, rng) => t.cmd(0, { type: 'updateConfig', config: allowing(pick(rng, ALLOWED)) }),
  (t, rng) => {
    if (chance(rng, 30)) {
      t.cmd(0, { type: 'setBombPot', on: true });
    }
  },
  (t, rng) => {
    const open = t.state.seats.flatMap((seat, index) => (seat ? [] : [index]));

    if (open.length > 0 && chance(rng, 50)) {
      t.cmd(0, { type: 'moveSeat', playerId: t.state.seats[pick(rng, seated(t))]!.playerId, seat: pick(rng, open) });
    }
  },
];

test('whatever the table: chips are conserved, a hand has one line of straddles, the action goes round once from the left of the biggest live post to its player, and nobody straddles on a blind or in a bomb pot', () => {
  const reached = { hands: 0, bombPots: 0, passedOver: 0, withMissedBlinds: 0, deadButtons: 0, allInStraddlers: 0, cutShort: 0 };
  const posts = new Map<Straddle, number>(STRADDLES.map((kind) => [kind.what, 0]));

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 611953);
    const players = 2 + rng.int(SEAT_COUNT - 1);
    const config: Partial<TableConfig> = { ...allowing(pick(rng, ALLOWED)), ante: chance(rng, 30) ? 5 : 0, anteFrom: chance(rng, 50) ? 'everyone' : 'bigBlind' };
    const t = new TestTable({ stacks: Array.from({ length: players }, () => 2000), seed, config });

    for (let dealtSoFar = 0; dealtSoFar < HANDS_PER_TABLE; dealtSoFar++) {
      for (let events = 1 + rng.int(4); events > 0; events--) {
        pick(rng, BETWEEN_HANDS)(t, rng);
      }

      if (chance(rng, 10)) {
        assertInvariants(t.state, t.now);
      }

      if (eligibleSeats(t.state).length < 2) {
        continue;
      }

      const before: { config: TableConfig; seats: (Seat | null)[] } = JSON.parse(JSON.stringify({ config: t.state.config, seats: t.state.seats }));
      t.deal();
      assertChipsConserved(t.state);
      assertInvariants(t.state, t.now);

      const hand = t.state.hand!;
      const where = `table ${seed}, hand ${hand.number}`;
      const dealtIn = hand.players.map((player) => player.seat);
      const posted = hand.events.flatMap((event) => (event[0] === 'post' ? [event] : []));
      const withABlind = new Set(posted.filter((post) => !isStraddle(post[2]) && post[2] !== 'ante').map((post) => post[1]));

      reached.hands += 1;
      reached.bombPots += hand.bombPot ? 1 : 0;
      reached.passedOver += hand.passedOver.length > 0 ? 1 : 0;
      reached.withMissedBlinds += hand.straddles.length > 0 && posted.some((post) => post[2] === 'missed big blind') ? 1 : 0;
      reached.deadButtons += hand.straddles.length > 0 && !dealtIn.includes(hand.button) ? 1 : 0;

      for (const { seat, what, amount } of hand.straddles) {
        const was = before.seats[seat]!;
        const kind = STRADDLES.find((entry) => entry.what === what)!;

        posts.set(what, posts.get(what)! + 1);
        reached.allInStraddlers += t.state.seats[seat]!.stack === 0 ? 1 : 0;

        assert.ok(before.config[kind.setting], `${where}: a ${what} at a table that does not allow it`);
        assert.ok(was.straddles.includes(what), `${where}: seat ${seat} posts a ${what} it did not ask for`);
        assert.ok(!withABlind.has(seat), `${where}: seat ${seat} straddles on top of a blind`);
        assert.equal(hand.players.find((player) => player.seat === seat)!.bet, amount, `${where}: a straddle posted short`);
      }

      assert.ok(hand.straddles.length <= STRADDLES_IN_A_ROW && (!hand.bombPot || hand.straddles.length === 0), where);

      if (hand.stage === 'betting' && !hand.bombPot) {
        // Of the bets in front of the players, the biggest that was asked for, and the last of those when two are alike
        const biggest = hand.straddles.at(-1)?.seat ?? hand.bbSeat;
        const round = [...seatsClockwiseAfter(dealtIn, biggest).filter((seat) => seat !== biggest), biggest].filter((seat) => t.state.seats[seat]!.stack > 0);
        const hasChips = t.state.seats[biggest]!.stack > 0;

        assert.equal(hand.currentBet, hand.straddles.at(-1)?.amount ?? hand.bigBlind, where);

        if (chance(rng, 50)) {
          const { order, lastHadTheOption } = callAround(t);

          // Once everyone else is all in, the betting is over before it gets round: there is nobody left to bet against
          if (order.length < round.length) {
            reached.cutShort += 1;
            assert.deepEqual(order, round.slice(0, order.length), `${where}: the action did not go round from the left of seat ${biggest}`);
            assert.ok(hand.players.filter((player) => !player.folded && !player.allIn).length <= 1, `${where}: the betting ended with players still to act`);
          } else {
            assert.deepEqual(order, round, `${where}: the action did not go round once from the left of seat ${biggest}`);
            assert.equal(lastHadTheOption, hasChips, `${where}: the player with the biggest bet in front of them did not have the option`);
          }
        } else {
          assert.equal(t.toAct, round[0], `${where}: the action does not start left of seat ${biggest}`);
        }
      }

      if (t.state.hand) {
        t.foldOut();
      }

      assertChipsConserved(t.state);
    }

    assertHandRecordsHold(t.effects);
  }

  // The run only proves something if it reached the hands the rules are about
  const said = JSON.stringify({ ...reached, ...Object.fromEntries(posts) });
  assert.ok(reached.hands >= TABLES * 25 && reached.bombPots >= TABLES && reached.passedOver >= TABLES * 2, said);
  assert.ok(STRADDLES.every((kind) => posts.get(kind.what)! >= TABLES), said);
  assert.ok(reached.withMissedBlinds >= TABLES / 4 && reached.deadButtons >= TABLES / 4 && reached.allInStraddlers >= TABLES / 20, said);
});
