/*
 * What the button and the blinds must do whatever happens around them: random tables where players
 * sit out, come back, bust, arrive, leave and are moved between hands, with every hand really dealt
 * and checked for who posted what.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eligibleSeats, owes, SEAT_COUNT, seatsClockwiseAfter } from '../src/engine/index.ts';
import type { BlindSeats, Post, Rng, Seat } from '../src/engine/index.ts';
import { seededRng, TestTable } from './helpers.ts';
import { assertBlindsHold, assertChipsConserved, assertHandRecordsHold, assertInvariants } from './invariants.ts';
import { chance, pick, seated } from './randomPlay.ts';

const TABLES = Number(process.env.SIM_TABLES ?? 60);
const HANDS_PER_TABLE = 60;
const BLINDS: Post[] = ['small blind', 'big blind'];

/** A table of two to ten players in random seats, before its first hand. */
function randomTable(rng: Rng, seed: number): TestTable {
  const players = 2 + rng.int(SEAT_COUNT - 1);
  const t = new TestTable({ stacks: Array.from({ length: players }, () => 2000), seed, config: { missedBlinds: chance(rng, 80) ? 'owed' : 'forgiven', ante: chance(rng, 30) ? 5 : 0 } });

  for (let moves = rng.int(6); moves > 0; moves--) {
    const open = t.state.seats.flatMap((seat, index) => (seat ? [] : [index]));

    if (open.length > 0) {
      t.cmd(0, { type: 'moveSeat', playerId: t.ids[rng.int(players)]!, seat: pick(rng, open)! });
    }
  }

  return t;
}

/** What can happen between two hands. */
const BETWEEN_HANDS: ((t: TestTable, rng: Rng) => void)[] = [
  (t, rng) => t.cmd(t.playerIn(pick(rng, seated(t))!), { type: 'sitOut' }),
  (t, rng) => t.cmd(t.playerIn(pick(rng, seated(t))!), { type: 'sitIn' }),
  (t, rng) => t.cmd(t.playerIn(pick(rng, seated(t))!), { type: 'comeIn', post: chance(rng, 60) }),
  (t, rng) => {
    // Everyone who is out or owes comes back or chooses again, so that tables fill up and missed blinds get posted
    for (const seat of seated(t).filter((index) => t.state.seats[index]!.sittingOut || owes(t.state.seats[index]!))) {
      t.cmd(t.playerIn(seat), { type: 'comeIn', post: chance(rng, 60) });
    }
  },
  (t, rng) => t.cmd(0, { type: 'setStack', playerId: t.state.seats[pick(rng, seated(t))!]!.playerId, stack: chance(rng, 50) ? 0 : chance(rng, 30) ? 1 + rng.int(40) : 2000 }),
  (t, rng) => {
    const open = t.state.seats.flatMap((seat, index) => (seat ? [] : [index]));

    if (open.length > 0 && t.ids.length < 30) {
      t.sitDown(`N${t.ids.length}`, pick(rng, open)!, 2000);
    }
  },
  (t, rng) => {
    // The host stays, so that there is always someone to run the table
    const others = seated(t).filter((seat) => t.state.seats[seat]!.playerId !== t.state.hostId);

    if (others.length > 1) {
      t.cmd(t.playerIn(pick(rng, others)!), { type: 'standUp' });
    }
  },
  (t, rng) => {
    const open = t.state.seats.flatMap((seat, index) => (seat ? [] : [index]));
    const from = pick(rng, seated(t))!;

    if (open.length > 0) {
      t.cmd(0, { type: 'moveSeat', playerId: t.state.seats[from]!.playerId, seat: pick(rng, open)! });
    }
  },
  (t, rng) => {
    if (chance(rng, 20)) {
      t.cmd(0, { type: 'shuffleSeats' });
    }
  },
  (t, rng) => {
    if (chance(rng, 40)) {
      t.cmd(0, { type: 'setBombPot', on: true });
    }
  },
  (t, rng) => {
    if (chance(rng, 15)) {
      t.cmd(0, { type: 'updateConfig', config: { missedBlinds: t.state.config.missedBlinds === 'owed' ? 'forgiven' : 'owed' } });
    }
  },
  (t, rng) => t.cmd(0, { type: 'forgiveBlinds', playerId: t.state.seats[pick(rng, seated(t))!]!.playerId }),
  (t, rng) => t.cmd(t.playerIn(pick(rng, seated(t))!), { type: 'setStraddle', kind: 'straddle', on: chance(rng, 50) }),
];

/** The table as a hand finds it, kept to hold the hand to afterward. */
interface Before {
  blinds: BlindSeats | null;
  ready: number[];
  seats: (Seat | null)[];
}

/** The last hand that had blinds, for the next one to be held to. */
interface LastBlinds {
  button: number;
  headsUp: boolean;
  bbSeat: number;
  bigBlindPlayer: string;
  sbSeat: number;
  /** Null for a hand nobody posted the small blind in. */
  smallBlindPlayer: string | null;
}

function postsOf(t: TestTable): Map<number, Post[]> {
  const posts = new Map<number, Post[]>();

  for (const event of t.state.hand!.events) {
    if (event[0] === 'post') {
      posts.set(event[1], [...(posts.get(event[1]) ?? []), event[2]]);
    }
  }

  return posts;
}

/** Holds the hand just dealt to the rule, given the table it was dealt from. */
function assertHandFollowsTheRule(t: TestTable, before: Before, last: LastBlinds | null, moved: boolean): void {
  const hand = t.state.hand!;
  const dealtIn = hand.players.map((player) => player.seat);
  const posts = postsOf(t);
  const where = `hand ${hand.number}`;

  assert.ok(dealtIn.length >= 2, `${where}: dealt to fewer than two players`);

  if (hand.bombPot) {
    assert.deepEqual(dealtIn, before.ready, `${where}: a bomb pot left out someone there to play`);
    assert.deepEqual(t.state.blinds, before.blinds, `${where}: a bomb pot moved the blinds`);
    assert.deepEqual(t.state.seats.map((seat) => seat && [seat.owesBigBlind, seat.owesSmallBlind]), before.seats.map((seat) => seat && [seat.owesBigBlind, seat.owesSmallBlind]), `${where}: a bomb pot changed what is owed`);
    return;
  }

  // Nobody posts more than one blind of the hand's own, and a missed one only when they owed it and said they would post it
  for (const [seat, posted] of posts) {
    const was = before.seats[seat]!;

    assert.ok(posted.filter((what) => BLINDS.includes(what)).length <= 1, `${where}: seat ${seat} posted ${posted.join(' and ')}`);
    assert.ok(!posted.includes('missed big blind') || (was.owesBigBlind && was.postsOwed && !posted.includes('big blind')), `${where}: seat ${seat} posted a missed big blind it did not owe or choose to post`);
    assert.ok(!posted.includes('dead small blind') || (was.owesSmallBlind && was.postsOwed), `${where}: seat ${seat} posted a small blind it did not owe or choose to post`);
  }

  // A stack the ante took whole has nothing left to post a blind with
  const allIn = (seat: number) => hand.players.find((player) => player.seat === seat)!.allIn;
  assert.ok(posts.get(hand.bbSeat)?.includes('big blind') || allIn(hand.bbSeat), `${where}: nobody posted the big blind`);
  assert.ok(dealtIn.every((seat) => !owes(t.state.seats[seat]!)), `${where}: a player in the hand still owes`);
  assert.ok(before.ready.every((seat) => dealtIn.includes(seat) || owes(before.seats[seat]!)), `${where}: a player who owed nothing was left out`);

  if (t.state.config.missedBlinds === 'forgiven') {
    assert.deepEqual(dealtIn, before.ready, `${where}: someone was left out at a table that forgives missed blinds`);
  }

  // A new game: nothing to go on from, so everyone is in
  if (!before.blinds) {
    assert.deepEqual(dealtIn, before.ready, `${where}: a new game left someone out`);
    return;
  }

  // The big blind goes to the next player there, and the small blind is on the seat the big blind had
  assert.equal(hand.bbSeat, seatsClockwiseAfter(before.ready, before.blinds.big)[0], `${where}: the big blind skipped a player or stayed`);
  assert.equal(hand.sbSeat, before.blinds.big, `${where}: the small blind is not where the big blind was`);
  assert.ok(!dealtIn.includes(hand.sbSeat) || posts.get(hand.sbSeat)?.includes('small blind') || allIn(hand.sbSeat), `${where}: the player on the small blind's seat did not post it`);
  assert.ok([...posts].every(([seat, posted]) => !posted.includes('small blind') || seat === hand.sbSeat), `${where}: the small blind was posted from another seat`);

  // A player who owed is in the hand only as the big blind, or by posting all of it that their stack reached
  const letIn = before.ready.filter((seat) => owes(before.seats[seat]!) && seat !== hand.bbSeat && dealtIn.includes(seat));
  const everyoneWaiting = before.ready.every((seat) => seat === hand.bbSeat || (owes(before.seats[seat]!) && !dealtIn.includes(seat)) || letIn.includes(seat));

  for (const seat of letIn) {
    const was = before.seats[seat]!;
    const posted = posts.get(seat) ?? [];
    const paid = was.postsOwed && (!was.owesBigBlind || posted.includes('missed big blind') || allIn(seat)) && (!was.owesSmallBlind || posted.includes('dead small blind') || allIn(seat));

    assert.ok(paid || (everyoneWaiting && dealtIn.length === before.ready.length), `${where}: seat ${seat} was dealt in owing, without posting and without the big blind`);
  }

  // A player who has kept their seat never posts the big blind twice running. One who got up and sat down again left of it does, as any newcomer there would
  if (last && before.seats[last.bbSeat]?.playerId === last.bigBlindPlayer) {
    assert.notEqual(t.state.seats[hand.bbSeat]!.playerId, last.bigBlindPlayer, `${where}: the same player posts the big blind twice running`);
  }

  // Nor the small blind, which only a move of the two blinds onto one seat could bring about
  if (last?.smallBlindPlayer && before.seats[last.sbSeat]?.playerId === last.smallBlindPlayer) {
    assert.ok(!posts.get(last.sbSeat)?.includes('small blind'), `${where}: the same player posts the small blind twice running`);
  }

  // The button moves every hand, but for the hand after a heads-up one, when it is due on the seat the small blind had it on
  if (last && !moved) {
    assert.ok(hand.button !== last.button || last.headsUp, `${where}: the button stayed on seat ${hand.button}`);
  }

  // Nobody is dealt in behind the button and ahead of the blinds, whether a player has the button or it is dead
  const [firstAfterButton] = seatsClockwiseAfter(dealtIn, hand.button);
  assert.ok(firstAfterButton === hand.sbSeat || firstAfterButton === hand.bbSeat, `${where}: seat ${firstAfterButton} is dealt in between the button and the blinds`);
}

test('whatever happens between hands, the blinds go round by the rule and nobody is charged a blind they did not owe or choose', () => {
  const reached = { hands: 0, missedBigBlinds: 0, deadSmallBlinds: 0, waiting: 0, deadButtons: 0, noSmallBlind: 0, everyoneWaiting: 0 };

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 104729);
    const t = randomTable(rng, seed);
    let last: LastBlinds | null = null;
    let moved = false;

    for (let dealt = 0; dealt < HANDS_PER_TABLE; dealt++) {
      for (let events = rng.int(4); events > 0; events--) {
        const blindsBefore = JSON.stringify(t.state.blinds);

        pick(rng, BETWEEN_HANDS)!(t, rng);

        // A move that takes the button or a blind along, and a shuffle, break the line from the hand before
        moved ||= JSON.stringify(t.state.blinds) !== blindsBefore;
      }

      // Every player's view and the saved table are the slow part of the whole check, so it is made on a sample of hands
      assertBlindsHold(t.state);
      if (chance(rng, 10)) {
        assertInvariants(t.state, t.now);
      }

      if (eligibleSeats(t.state).length < 2) {
        continue;
      }

      const before: Before = JSON.parse(JSON.stringify({ blinds: t.state.blinds, ready: eligibleSeats(t.state), seats: t.state.seats }));
      t.deal();
      assertChipsConserved(t.state);

      const hand = t.state.hand!;
      assertHandFollowsTheRule(t, before, last, moved);

      if (!hand.bombPot) {
        const posts = [...postsOf(t).values()].flat();
        const dealtIn = hand.players.map((player) => player.seat);

        reached.hands += 1;
        reached.missedBigBlinds += posts.includes('missed big blind') ? 1 : 0;
        reached.deadSmallBlinds += posts.includes('dead small blind') ? 1 : 0;
        reached.waiting += before.ready.length > dealtIn.length ? 1 : 0;
        reached.deadButtons += dealtIn.includes(hand.button) ? 0 : 1;
        reached.noSmallBlind += posts.includes('small blind') ? 0 : 1;
        reached.everyoneWaiting += before.blinds && before.ready.some((seat) => owes(before.seats[seat]!) && seat !== hand.bbSeat && !before.seats[seat]!.postsOwed && dealtIn.includes(seat)) ? 1 : 0;

        last = {
          button: hand.button,
          headsUp: hand.button === hand.sbSeat,
          bbSeat: hand.bbSeat,
          bigBlindPlayer: t.state.seats[hand.bbSeat]!.playerId,
          sbSeat: hand.sbSeat,
          smallBlindPlayer: posts.includes('small blind') ? t.state.seats[hand.sbSeat]!.playerId : null,
        };
        moved = false;
      }

      t.foldOut();
      assertChipsConserved(t.state);
    }

    assertHandRecordsHold(t.effects);
  }

  // The run only proves something if it reached the hands the rule is about
  const said = JSON.stringify(reached);
  assert.ok(reached.hands >= TABLES * 30, said);
  assert.ok(reached.missedBigBlinds >= TABLES / 2 && reached.deadSmallBlinds >= TABLES / 2 && reached.waiting >= TABLES * 3, said);
  assert.ok(reached.deadButtons >= TABLES && reached.noSmallBlind >= TABLES && reached.everyoneWaiting >= TABLES / 12, said);
});

test('once the table settles, an orbit charges everyone in it each blind once and gives each the button once', () => {
  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 15485863);
    const t = randomTable(rng, seed);

    // Some hands with everything happening between them, to leave the button and the blinds wherever they fall
    for (let dealt = 0; dealt < 12; dealt++) {
      for (let events = rng.int(4); events > 0; events--) {
        pick(rng, BETWEEN_HANDS)!(t, rng);
      }

      if (eligibleSeats(t.state).length >= 2) {
        t.deal();
        t.foldOut();
      }
    }

    // Then nobody comes or goes. Stacks are made deep, since a blind a player cannot cover is not the whole of one
    t.cmd(0, { type: 'setBombPot', on: false });
    t.cmd(0, { type: 'updateConfig', config: { bombPotEvery: 0 } });
    for (const seat of seated(t)) {
      t.cmd(0, { type: 'setStack', playerId: t.state.seats[seat]!.playerId, stack: t.state.seats[seat]!.stack > 0 ? 5000 : 0 });
    }

    const players = eligibleSeats(t.state);
    if (players.length < 2) {
      continue;
    }

    // Long enough for the big blind to reach everyone waiting for it, and for the button to pass anyone posting
    for (let settling = 0; settling < players.length + 2; settling++) {
      t.deal();
      t.foldOut();
    }

    const count = () => new Map(players.map((seat) => [seat, 0]));
    const posted = { 'small blind': count(), 'big blind': count(), button: count() };

    for (let hand = 0; hand < players.length; hand++) {
      t.deal();
      assert.deepEqual(t.state.hand!.players.map((player) => player.seat), players, `table ${seed}: someone there to play is still left out`);

      for (const [seat, whats] of postsOf(t)) {
        for (const what of whats) {
          assert.ok(what !== 'missed big blind' && what !== 'dead small blind', `table ${seed}: seat ${seat} posted ${what} in a settled game`);

          if (what === 'small blind' || what === 'big blind') {
            posted[what].set(seat, posted[what].get(seat)! + 1);
          }
        }
      }

      posted.button.set(t.state.hand!.button, (posted.button.get(t.state.hand!.button) ?? 0) + 1);
      t.foldOut();
    }

    for (const [what, counts] of Object.entries(posted)) {
      assert.deepEqual([...counts], players.map((seat) => [seat, 1]), `table ${seed}, ${players.length} players: ${what} by seat over one orbit`);
    }
  }
});
