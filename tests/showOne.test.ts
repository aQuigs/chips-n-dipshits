import assert from 'node:assert/strict';
import { test } from 'node:test';

import { halfShownLabel, showOffer, showStillOffered } from '../src/client/showing.ts';
import { spotsOf } from '../src/client/tableChances.ts';
import { addMember, fullyShown, handFacts, prettyCard, replayHand, seededRng } from '../src/engine/index.ts';
import type { Command, Rng, TableView } from '../src/engine/index.ts';
import { ACES, BOARD, handRecords, KINGS, QUEENS, TestTable } from './helpers.ts';
import { assertInvariants } from './invariants.ts';
import { chance, pick, randomStep } from './randomPlay.ts';

/** Three players, the button on seat 0: seats 0 and 1 fold, seat 1 with A♠ K♦, and the big blind on seat 2 wins the blinds. */
function foldedToTheBigBlind(): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });

  t.deal({ button: 0, holes: { 1: 'As Kd', 2: '9c 8c' } });
  t.fold(0);
  t.fold(1);

  return t;
}

const lastEvent = (t: TestTable) => t.state.hand!.events.at(-1);

test('a player who folded shows the card on their left, then the one on their right: each turns up alone, is said, and stays up', () => {
  const t = foldedToTheBigBlind();
  assert.deepEqual([t.state.hand!.stage, t.view(1).hand!.canShow], ['done', true]);

  t.show(1, [0]);
  assert.deepEqual(t.state.hand!.players[1]!.shown, [true, false]);
  assert.deepEqual([t.view(0).seats[1]!.cards, t.view(0).seats[1]!.shown], [['As', null], [true, false]]);
  assert.deepEqual(t.view(1).seats[1]!.cards, ['As', 'Kd'], 'a player sees their own cards as ever');
  assert.equal(t.view(1).hand!.canShow, true, 'the other card is still theirs to show');
  assert.deepEqual(lastEvent(t), ['show', 1, ['As', null]]);
  assert.equal(t.feedText().at(-1), 'P1 shows one card, A♠');

  t.show(1, [1]);
  assert.deepEqual(t.state.hand!.players[1]!.shown, [true, true]);
  assert.deepEqual(t.view(0).seats[1]!.cards, ['As', 'Kd']);
  assert.equal(t.view(1).hand!.canShow, false);
  assert.deepEqual(lastEvent(t), ['show', 1, [null, 'Kd']]);
  assert.equal(t.feedText().at(-1), 'P1 shows the other card, K♦');

  t.finishHand();
  const [record] = handRecords(t.effects);
  assert.deepEqual(record!.players.map((player) => player.cards), [[null, null], ['As', 'Kd'], [null, null]]);
  assert.deepEqual(replayHand(record!.events)!.seats.map((seat) => seat.cards), record!.players.map((player) => player.cards));
});

test('the card on the right alone leaves the left one face down, in the view, the event, the record and the facts', () => {
  const t = foldedToTheBigBlind();

  t.show(1, [1]);
  assert.deepEqual(t.view(2).seats[1]!.cards, [null, 'Kd']);
  assert.deepEqual(lastEvent(t), ['show', 1, [null, 'Kd']]);
  assert.equal(t.feedText().at(-1), 'P1 shows one card, K♦');

  t.finishHand();
  const [record] = handRecords(t.effects);
  assert.deepEqual(record!.players[1]!.cards, [null, 'Kd']);
  assert.deepEqual(handFacts(record!).players[1]!.cards, [null, 'Kd']);
  assert.equal(fullyShown(handFacts(record!).players[1]!.cards), false);
});

test('both at once, named in either order, is one event and one line, as showing them always was', () => {
  for (const places of [[0, 1], [1, 0]]) {
    const t = foldedToTheBigBlind();

    t.show(1, places);
    assert.deepEqual(lastEvent(t), ['show', 1, ['As', 'Kd']]);
    assert.equal(t.feedText().at(-1), 'P1 shows A♠ K♦');
    assert.equal(t.state.hand!.events.filter((event) => event[0] === 'show').length, 1);
  }
});

test('a card shown again, or both after one, turns up nothing more: a request sent twice is harmless', () => {
  const t = foldedToTheBigBlind();

  t.show(1, [0]);
  const [events, lines] = [t.state.hand!.events.length, t.feedText().length];

  t.show(1, [0]);
  assert.deepEqual([t.state.hand!.events.length, t.feedText().length], [events, lines], 'the same card twice');

  t.show(1, [0, 1]);
  assert.deepEqual(lastEvent(t), ['show', 1, [null, 'Kd']], 'both, after one, turns up the other');
  assert.equal(t.feedText().at(-1), 'P1 shows the other card, K♦');

  t.show(1, [1, 0]);
  t.show(1, [1]);
  assert.equal(t.state.hand!.events.filter((event) => event[0] === 'show').length, 2);
});

test('showing waits for the hand to be over, at every point before it: betting, a chop asked, a pick of runs, the runout', () => {
  const refused = (t: TestTable, player: number) => assert.throws(() => t.show(player, [0]), { message: 'You can show your cards once the hand is over' });

  const betting = new TestTable({ stacks: [1000, 1000, 1000] });
  betting.deal({ button: 0 });
  refused(betting, 0);
  betting.fold(0);
  refused(betting, 0);

  const chop = new TestTable({ stacks: [1000, 1000, 1000], config: { allowChop: true } });
  chop.deal({ button: 0 });
  chop.fold(0);
  chop.cmd(1, { type: 'offerChop' });
  assert.equal(chop.state.hand!.stage, 'chop');
  refused(chop, 1);
  refused(chop, 0);

  // All in before the flop: hands turn up whole, and nothing more can be shown until it is over
  const voting = new TestTable({ stacks: [1000, 1000, 1000], config: { maxRuns: 2 } });
  voting.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD });
  voting.raise(0, 1000);
  voting.call(1);
  voting.fold(2);
  assert.equal(voting.state.hand!.stage, 'ritVote');
  refused(voting, 2);
  voting.cmd(0, { type: 'ritVote', runs: 1 });
  assert.equal(voting.state.hand!.stage, 'runout');
  refused(voting, 2);

  voting.runToResult();
  voting.show(2, [1]);
  assert.deepEqual(voting.view(0).seats[2]!.cards, [null, 'Qh']);
});

test('a hand is shown only by those dealt into it, while it is the hand on the table, and only as cards it names rightly', () => {
  const t = foldedToTheBigBlind();
  const watcher = t.ids.push(addMember(t.state, 'Kibitz', t.ctx()).id) - 1;
  const late = t.sitDown('Late', 5);
  const hand = t.state.hand!.number;

  for (const who of [watcher, late]) {
    assert.throws(() => t.cmd(who, { type: 'showCards', hand, cards: [0] }), { message: 'Only a player dealt into the hand can show cards' });
  }

  for (const cards of [[], [2], [-1], [0, 0], [0, 1, 0], [0.5], ['left'], 'both', undefined]) {
    assert.throws(() => t.cmd(1, { type: 'showCards', hand, cards } as unknown as Command), { message: 'Say which of your cards to show' }, JSON.stringify(cards));
  }

  assert.throws(() => t.cmd(1, { type: 'showCards', cards: [0] } as unknown as Command), { message: /^The hand must be a whole number/ });

  // Arriving once the next hand is over too, the request names its hand, so it never shows the cards of the next
  t.finishHand();
  t.deal();
  while (t.state.hand!.stage === 'betting') {
    t.fold(t.playerIn(t.toAct!));
  }

  assert.equal(t.state.hand!.stage, 'done');
  assert.throws(() => t.cmd(1, { type: 'showCards', hand, cards: [0] }), { message: 'That hand is gone, so its cards can no longer be shown' });
  assert.ok(t.state.hand!.players.every((player) => !player.shown.some(Boolean)));

  t.finishHand();
  assert.throws(() => t.cmd(1, { type: 'showCards', hand: t.state.handCount, cards: [0] }), { message: 'That hand is gone, so its cards can no longer be shown' });
});

test('a player who stood up during the hand may still show it, one card or both, as before', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: '7c 2d' } });
  // On the clock, standing up folds to the big blind
  t.cmd(0, { type: 'standUp' });
  t.fold(1);
  assert.equal(t.state.seats[0]!.leaving, true);

  t.show(0, [1]);
  assert.deepEqual(t.view(2).seats[0]!.cards, [null, '2d']);
});

/** Plays the hand on the table to its result with random moves: no side events, so everyone dealt in is still there. */
function playToTheEnd(t: TestTable, rng: Rng): void {
  for (let step = 0; step < 400 && t.state.hand!.stage !== 'done'; step++) {
    const hand = t.state.hand!;
    const voter = hand.stage === 'ritVote' ? hand.players.find((player) => !player.folded && player.ritVote === null) : undefined;

    if (hand.stage === 'betting') {
      const player = t.playerIn(hand.toAct!);
      const options = t.view(player).hand!.options!;
      const roll = rng.int(100);

      if (roll < 30) {
        t.fold(player);
      } else if (roll < 45 && options.canRaise) {
        t.raise(player, chance(rng, 30) ? options.maxRaiseTo : options.minRaiseTo);
      } else if (options.canCheck) {
        t.check(player);
      } else {
        t.call(player);
      }
    } else if (voter) {
      t.cmd(t.playerIn(voter.seat), { type: 'ritVote', runs: 1 + rng.int(hand.maxRuns) });
    } else {
      t.wait(hand.deadline! - t.now);
    }
  }
}

/** The things another player or a watcher can read of a hand: their view, the play-by-play, and once it is over the record and its facts. */
function readableBy(t: TestTable, viewer: number): string[] {
  return [JSON.stringify(t.view(viewer)), ...t.state.feed.map((line) => line.text), ...(t.state.hand?.log ?? [])];
}

test('a card left face down is nowhere another player or a watcher can read: their views, the play-by-play, the record and its facts, over random hands and random choices of what to show', () => {
  const rng = seededRng(77);
  let tried = 0;

  for (let seed = 1; tried < 150 && seed < 1000; seed++) {
    const players = 2 + rng.int(5);
    const t = new TestTable({ stacks: Array.from({ length: players }, () => 200 + rng.int(1500)), seed, config: { maxRuns: (1 + rng.int(3)) as 1 | 2 | 3, sevenDeuceBounty: rng.int(2) * 25 } });
    const watcher = t.ids.push(addMember(t.state, 'Kibitz', t.ctx()).id) - 1;

    t.deal({ button: rng.int(players) });
    playToTheEnd(t, rng);

    const hand = t.state.hand;
    const hidden = hand?.stage === 'done' && hand.number === 1 ? hand.players.filter((player) => !player.shown.some(Boolean)) : [];
    if (hidden.length === 0) {
      continue;
    }

    tried += 1;
    const shower = pick(rng, hidden)!;
    const place = rng.int(2);
    const kept = shower.cards[1 - place]!;
    const showerIndex = t.ids.indexOf(shower.playerId);
    t.show(showerIndex, [place]);

    const others = [...t.ids.keys()].filter((index) => index !== showerIndex);
    const nowhere = (texts: string[], where: string) => {
      for (const text of texts) {
        assert.ok(!text.includes(`"${kept}"`) && !text.includes(prettyCard(kept)), `seed ${seed}: ${kept} is in ${where}: ${text.slice(0, 200)}`);
      }
    };

    for (const viewer of others) {
      nowhere(readableBy(t, viewer), `what ${viewer === watcher ? 'a watcher' : `player ${viewer}`} can read`);
    }

    assert.deepEqual(t.view(others[0]!).seats[shower.seat]!.cards, shower.cards.map((card, nth) => (nth === place ? card : null)));
    assertInvariants(t.state, t.now);

    t.finishHand();
    const record = handRecords(t.effects).find((each) => each.number === 1)!;
    nowhere([JSON.stringify(record), record.summary, JSON.stringify(handFacts(record))], 'the hand record and its facts');
    nowhere([JSON.stringify(t.view(watcher).tonight)], "the night's numbers");
    assert.deepEqual(record.players.find((player) => player.seat === shower.seat)!.cards, shower.cards.map((card, nth) => (nth === place ? card : null)));
  }

  assert.equal(tried, 150, 'too few random hands left a hand to show');
});

/** A table without a bounty where seat 1 wins uncalled with seven-deuce, showing what `show` says, one request after another. */
function sevenDeuceUncalled(show: number[][], bounty = 0): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { sevenDeuceBounty: bounty } });

  t.deal({ button: 0, holes: { 1: '7h 2c' } });
  t.fold(0);
  t.raise(1, 60);
  t.fold(2);
  show.forEach((places) => t.show(1, places));
  t.finishHand();

  return t;
}

const badgesOf = (t: TestTable, player: number) => t.state.tonight.players[t.ids[player]!]?.badges ?? {};

test('seven-deuce won without a call earns its badge only once the table has seen both cards: not the seven alone, not the deuce alone', () => {
  assert.deepEqual(badgesOf(sevenDeuceUncalled([]), 1), {});
  assert.deepEqual(badgesOf(sevenDeuceUncalled([[0]]), 1), {}, 'the seven alone');
  assert.deepEqual(badgesOf(sevenDeuceUncalled([[1]]), 1), {}, 'the deuce alone');
  assert.deepEqual(badgesOf(sevenDeuceUncalled([[0, 1]]), 1), { sevenDeuce: 1 }, 'both');
  assert.deepEqual(badgesOf(sevenDeuceUncalled([[1], [0]]), 1), { sevenDeuce: 1 }, 'one and then the other');

  // With a bounty the hand is turned up whole to collect it, and there is nothing left to show
  const bounty = sevenDeuceUncalled([], 25);
  assert.deepEqual(badgesOf(bounty, 1), { sevenDeuce: 1 });
  assert.deepEqual(handRecords(bounty.effects)[0]!.players[1]!.cards, ['7h', '2c']);
});

test('a card shown by choice makes no hand shown down: no badge for a hand, no best hand, no high hand, and the result and the hint are as they were', () => {
  // Seat 1 bets the river with a king on a board of three kings, and is not called
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 1: 'Kd 2c' }, board: 'Ks Kh Kc 9d 4h' });
  t.call(0);
  t.call(1);
  t.check(2);
  for (let street = 0; street < 2; street++) {
    t.check(1);
    t.check(2);
    t.check(0);
  }
  t.raise(1, 100);
  t.fold(2);
  t.fold(0);

  const before = t.view(1);
  t.show(1, [0]);
  const after = t.view(1);

  assert.deepEqual(after.hand!.result, before.hand!.result, 'the result');
  assert.deepEqual(after.hand!.holding, before.hand!.holding, 'the hint under their own cards');
  assert.deepEqual(after.hand!.result!.hands, []);

  t.finishHand();
  const facts = handFacts(handRecords(t.effects)[0]!);
  assert.deepEqual([facts.players[1]!.cards, facts.players[1]!.shown], [['Kd', null], []]);
  assert.deepEqual(badgesOf(t, 1), {}, 'four kings shown a card at a time by choice earn no Quads');
  assert.equal(t.state.tonight.players[t.ids[1]!]!.best, null);
  assert.equal(t.state.tonight.highHand.best, null);
});

test('a live hand with one card face up makes no spot to work out a chance from', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD });
  t.raise(0, 1000);
  t.call(1);
  t.fold(2);

  const view = t.view(2);
  assert.notEqual(spotsOf(view), null);

  const halfShown: TableView = { ...view, seats: view.seats.map((seat) => (seat?.seat === 1 ? { ...seat, shown: [true, false], cards: [seat.cards![0]!, null] } : seat)) };
  assert.equal(spotsOf(halfShown), null);
});

test('the page offers the cards still face down of the hand that is over, and sends a show again only while it still offers it', () => {
  const t = foldedToTheBigBlind();
  const watcher = t.ids.push(addMember(t.state, 'Kibitz', t.ctx()).id) - 1;

  assert.deepEqual(showOffer(t.view(1)), { hand: 1, places: [0, 1] });
  assert.deepEqual(showOffer(t.view(2)), { hand: 1, places: [0, 1] }, 'the winner, nobody having called');
  assert.equal(showOffer(t.view(watcher)), null);

  assert.equal(showStillOffered(t.view(1), 1, [0]), true, 'not yet shown: worth sending again');

  t.show(1, [0]);
  assert.equal(showStillOffered(t.view(1), 1, [0]), false, 'shown: the answer came by another way');
  assert.deepEqual(showOffer(t.view(1)), { hand: 1, places: [1] });
  assert.equal(showStillOffered(t.view(1), 1, [0, 1]), true, 'one of them is still face down');

  t.finishHand();
  assert.equal(showStillOffered(t.view(1), 1, [0, 1]), false, 'the hand is gone');
  assert.equal(showStillOffered(null, 1, [0, 1]), false);

  t.deal();
  while (t.state.hand!.stage === 'betting') {
    t.fold(t.playerIn(t.toAct!));
  }

  const dealtIn = t.state.hand!.players.map((player) => t.ids.indexOf(player.playerId));
  for (const player of dealtIn) {
    assert.equal(showStillOffered(t.view(player), 1, [0, 1]), false, 'the next hand is over too, and it is not the hand the request was for');
  }
});

test('what a screen reader is told of a seat with one card up and one down, and of one with both or none', () => {
  const t = foldedToTheBigBlind();
  const seat = () => t.view(0).seats[1]!;

  assert.equal(halfShownLabel(seat()), null);
  t.show(1, [1]);
  assert.equal(halfShownLabel(seat()), 'P1 shows the king of diamonds; the other card is face down');
  t.show(1, [0]);
  assert.equal(halfShownLabel(seat()), null);
});

test('over random games the cards shown by choice are kept card by card and never turned down again', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const t = new TestTable({ stacks: [800, 1200, 1000, 600], seed, config: { maxRuns: 2 } });
    const rng = seededRng(seed);
    let shown = new Map<string, boolean[]>();

    t.cmd(0, { type: 'start' });
    for (let step = 0; step < 1500; step++) {
      const number = t.state.hand?.number;
      randomStep(t, rng);

      if (t.state.hand?.number !== number) {
        shown = new Map();
      }

      for (const player of t.state.hand?.players ?? []) {
        const had = shown.get(player.playerId);

        assert.equal(player.shown.length, player.cards.length);
        assert.ok(!had || had.every((up, nth) => !up || player.shown[nth]), `seed ${seed}: a card was turned face down again`);
        shown.set(player.playerId, [...player.shown]);
      }
    }
  }
});
