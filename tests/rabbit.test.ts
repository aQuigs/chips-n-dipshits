/*
 * Rabbit hunting: after a hand ends before its boards are out, the cards that would have come. That they
 * are exactly those, who may ask and when, how long the table waits, what a view shows of them, and that
 * nothing which counts a hand ever reads them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { spotsOf } from '../src/client/tableChances.ts';
import { addMember, dealTheRest, freshDeck, handFacts, rabbitToHunt, replayHand, seededRng, tick, TIMING, viewFor } from '../src/engine/index.ts';
import type { Card, HandRecord, TableConfig, TableView } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { handRecords, TestTable } from './helpers.ts';
import { assertBoardsHold, assertEventsRetellTheHand, assertViewsKeepSecrets } from './invariants.ts';
import { pick, randomStep } from './randomPlay.ts';
import { randomConfig } from './randomConfig.ts';

const HUNTING = { rabbitHunting: true };

function copyOf(t: TestTable): TestTable {
  const copy = TestTable.adopt(structuredClone(t.state));

  copy.now = t.now;

  return copy;
}

/** A table whose first hand is dealt from its own shuffle, as any hand is. */
function shuffledTable(seed: number, config: Partial<TableConfig> = {}, players = 3): TestTable {
  const t = new TestTable({ stacks: Array.from({ length: players }, () => 1000), seed, config: { ...HUNTING, ...config } });

  t.cmd(0, { type: 'start' });
  t.wait(TIMING.startDelayMs);
  assert.equal(t.state.hand?.stage, 'betting');

  return t;
}

/** The player on the clock checks if they can and calls if not. */
function passive(t: TestTable): void {
  const player = t.playerIn(t.toAct!);

  if (t.view(player).hand!.options!.canCheck) {
    t.check(player);
  } else {
    t.call(player);
  }
}

/** Plays passively until the first board has `cards` on it, then everyone folds in turn but the last. */
function foldOutAt(t: TestTable, cards: number): void {
  while (t.state.hand!.boards[0]!.length < cards) {
    passive(t);
  }

  while (t.state.hand!.stage === 'betting') {
    t.fold(t.playerIn(t.toAct!));
  }

  assert.equal(t.state.hand!.stage, 'done');
}

function checkDown(t: TestTable): void {
  while (t.state.hand!.stage === 'betting') {
    passive(t);
  }

  t.runToResult();
}

/** Whoever was dealt in first, by seat: a player who may hunt, folded or not. */
const dealtIn = (t: TestTable) => t.playerIn(t.state.hand!.players[0]!.seat);

/** Lets the pause after the hand run out: the hand is cleared, and the next one dealt at once when it can be. */
function clearHand(t: TestTable): void {
  t.now = t.state.hand!.deadline!;
  tick(t.state, t.ctx());
}

function hunt(t: TestTable, player = dealtIn(t)): void {
  t.cmd(player, { type: 'huntRabbit', hand: t.state.hand!.number });
}

/** Folds the hand out once the first board has `cards` on it and hunts it: each board and its hunted cards are the boards of the same hand checked down from there. */
function assertHuntsTheCheckDown(t: TestTable, cards: number, where: string): void {
  const played = copyOf(t);

  foldOutAt(t, cards);
  hunt(t);

  while (played.state.hand!.boards[0]!.length < cards) {
    passive(played);
  }
  checkDown(played);

  const hand = t.state.hand!;
  assert.deepEqual(
    hand.boards.map((board, index) => [...board, ...hand.hunted![index]!]),
    played.state.hand!.boards,
    where,
  );
}

test('the cards hunted are the ones the hand would have dealt, from every street a hand can end on', () => {
  for (let seed = 1; seed <= 30; seed++) {
    for (const cards of [0, 3, 4]) {
      const t = shuffledTable(seed);

      assertHuntsTheCheckDown(t, cards, `seed ${seed}, folded with ${cards} cards out`);
      assert.equal(t.state.hand!.hunted![0]!.length, 5 - cards);
    }
  }
});

test('a double-board bomb pot that ends on the flop or the turn hunts both boards, card for card as they would have come', () => {
  for (let seed = 1; seed <= 20; seed++) {
    for (const cards of [3, 4]) {
      const t = new TestTable({ stacks: [1000, 1000, 1000], seed, config: { ...HUNTING, bombPotBoards: 'two', bombPotAmount: 50 } });

      t.cmd(0, { type: 'setBombPot', on: true });
      t.cmd(0, { type: 'start' });
      t.wait(TIMING.startDelayMs);
      assert.equal(t.state.hand!.runs, 2);

      assertHuntsTheCheckDown(t, cards, `seed ${seed}, ended with ${cards} cards on each board`);
      assert.equal(t.state.hand!.hunted!.length, 2);
    }
  }
});

test('dealing the rest of a hand run two or three times, from before its first card or after the flop, gives the boards the runout deals', () => {
  for (let seed = 1; seed <= 10; seed++) {
    for (const [runs, cards] of [[3, 0], [2, 3], [3, 4]] as const) {
      const t = shuffledTable(seed, { maxRuns: 3, rabbitHunting: false });

      while (t.state.hand!.boards[0]!.length < cards) {
        passive(t);
      }

      // Everyone all in where they stand, and every pick for as many runs as the case is about
      t.raise(t.playerIn(t.toAct!), t.view(t.playerIn(t.toAct!)).hand!.options!.maxRaiseTo);
      while (t.state.hand!.stage === 'betting') {
        t.call(t.playerIn(t.toAct!));
      }
      for (const player of t.state.hand!.players.filter((p) => !p.folded)) {
        t.cmd(t.playerIn(player.seat), { type: 'ritVote', runs });
      }
      assert.equal(t.state.hand!.stage, 'runout');
      assert.equal(t.state.hand!.runs, runs);

      const rest = structuredClone(t.state.hand!);
      const before = rest.boards.map((board) => [...board]);
      const hunted = dealTheRest(rest);

      t.runToResult();

      assert.deepEqual(before, rest.boards, 'the boards themselves are left as they were');
      assert.deepEqual(
        t.state.hand!.boards,
        hunted.map((cardsHunted, board) => [...(before[board] ?? before[0]!.slice(0, rest.sharedBoardLength)), ...cardsHunted]),
        `seed ${seed}, run ${runs} times from ${cards} cards`,
      );
    }
  }
});

test('a hunt shows the rest to everyone, says so in the play-by-play, and is in the hand record and its events', () => {
  const t = shuffledTable(3);

  foldOutAt(t, 3);
  const hunter = t.playerIn(t.state.hand!.players.find((p) => p.folded)!.seat);
  hunt(t, hunter);

  const hunted = t.state.hand!.hunted!;
  assert.equal(hunted[0]!.length, 2);
  assert.match(t.feedText().at(-1)!, new RegExp(`^${t.state.members[hunter]!.name} hunts the rabbit, cards that did not count: \\S+ \\S+$`));
  assert.deepEqual(t.state.hand!.events.at(-1), ['hunt', hunted]);
  assert.deepEqual(replayHand(t.state.hand!.events)!.hunted, hunted);
  assert.deepEqual(replayHand(t.state.hand!.events)!.boards, t.state.hand!.boards, 'a replay keeps the hunted cards off the board');

  clearHand(t);
  const [record] = handRecords(t.effects);
  assert.deepEqual(record!.events.at(-1), ['hunt', hunted]);
  assert.match(record!.summary, /hunts the rabbit/);
  assert.equal(record!.boards[0]!.length, 3);
  assertEventsRetellTheHand(record!);
});

test('the rabbit can be hunted only at a table that hunts, once a hand somebody won is over with cards still to come', () => {
  const refused = (t: TestTable, message: RegExp, player = dealtIn(t)) => {
    const before = JSON.stringify(t.state);

    assert.throws(() => hunt(t, player), { name: 'GameError', message });
    assert.equal(JSON.stringify(t.state), before);
  };

  const off = shuffledTable(1, { rabbitHunting: false });
  foldOutAt(off, 3);
  assert.equal(off.view(dealtIn(off)).hand!.canHunt, false);
  refused(off, /doesn't hunt the rabbit/);

  const playing = shuffledTable(1);
  passive(playing);
  assert.equal(playing.view(dealtIn(playing)).hand!.canHunt, false);
  refused(playing, /once the hand is over/);

  const shownDown = shuffledTable(1);
  checkDown(shownDown);
  assert.equal(shownDown.state.hand!.result!.uncontested, false);
  assert.equal(shownDown.view(dealtIn(shownDown)).hand!.canHunt, false);
  refused(shownDown, /already out/);

  const chopped = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: { ...HUNTING, allowChop: true } });
  chopped.deal({ button: 0 });
  chopped.fold(3);
  chopped.fold(0);
  chopped.cmd(1, { type: 'offerChop' });
  chopped.cmd(2, { type: 'answerChop', agree: true });
  assert.ok(chopped.state.hand!.result!.chopped);
  assert.equal(chopped.view(1).hand!.canHunt, false);
  refused(chopped, /Nobody won that hand/, 1);

  // The big blind of the last hand left, so this one has no small blind: folded to, the big blind takes back their own and nobody won
  const walk = new TestTable({ stacks: [1000, 1000, 1000], config: HUNTING });
  walk.deal({ button: 0 });
  walk.foldOut();
  walk.cmd(2, { type: 'standUp' });
  walk.deal();
  walk.fold(walk.playerIn(walk.toAct!));
  assert.deepEqual(walk.state.hand!.result!.winnings.map((win) => win.amount), [0]);
  refused(walk, /Nobody won that hand/);
});

test('only a player dealt in may hunt, folded or not; not a watcher, a player sitting the hand out or one who left during it', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000, 1000], config: HUNTING });
  const watcher = watcherAt(t);

  t.cmd(4, { type: 'sitOut' });
  t.deal({ button: 0 });
  t.cmd(3, { type: 'standUp' });

  // Seat 3 left the table during the hand: their turn is folded for them
  while (t.state.hand!.stage === 'betting') {
    t.fold(t.playerIn(t.toAct!));
  }

  const winner = t.state.hand!.result!.winnings[0]!.seat;
  const folded = t.state.hand!.players.find((p) => p.folded && p.seat !== 3)!.seat;

  assert.equal(t.view(winner).hand!.canHunt, true);
  assert.equal(t.view(folded).hand!.canHunt, true);
  for (const [who, player] of [['a watcher', watcher], ['a player sitting out', 4], ['a player who left', 3]] as const) {
    assert.equal(t.view(player).hand!.canHunt, false, who);
    assert.throws(() => hunt(t, player), { name: 'GameError', message: /Only a player dealt into the hand/ }, who);
  }

  hunt(t, folded);
  assert.ok(t.state.hand!.hunted);
});

/** A member who joins the table and takes no seat: a watcher. Gives back what `cmd` names them by. */
function watcherAt(t: TestTable): number {
  return t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id) - 1;
}

test('asking again shows nothing twice and changes nothing, so a request that got no answer can be sent again', () => {
  const t = shuffledTable(4);
  foldOutAt(t, 0);
  const first = t.playerIn(t.state.hand!.result!.winnings[0]!.seat);
  const second = t.playerIn(t.state.hand!.players.find((p) => p.folded)!.seat);

  hunt(t, first);
  const once = JSON.stringify(t.state);

  hunt(t, first);
  hunt(t, second);
  assert.equal(JSON.stringify(t.state), once);
  assert.equal(t.state.hand!.events.filter((event) => event[0] === 'hunt').length, 1);
});

test('once the next hand is dealt, a hunt for the last one is refused, and it never hunts the new one', () => {
  const t = shuffledTable(5);
  foldOutAt(t, 3);
  const last = t.state.hand!.number;

  clearHand(t);
  foldOutAt(t, 3);
  assert.equal(t.state.hand!.number, last + 1);

  assert.throws(() => t.cmd(dealtIn(t), { type: 'huntRabbit', hand: last }), { name: 'GameError', message: /That hand is over, so its rabbit is gone/ });
  assert.equal(t.state.hand!.hunted, null);
});

test('the last hand of the night can be hunted like any other, and the night ends once it is off the table', () => {
  const t = shuffledTable(6);
  t.cmd(0, { type: 'setLastHands', hands: 0, from: t.state.hand!.number });

  foldOutAt(t, 4);
  hunt(t);
  assert.equal(t.state.hand!.hunted![0]!.length, 1);

  clearHand(t);
  assert.equal(t.state.hand, null);
  assert.notEqual(t.state.nightEndedAt, null);
});

test('switched on during a hand, the setting lets that hand be hunted', () => {
  const t = shuffledTable(7, { rabbitHunting: false });
  t.cmd(0, { type: 'updateConfig', config: HUNTING });
  assert.equal(t.feedText().at(-1), 'Rabbit hunting is on: after a hand ends early, anyone dealt in can see the cards that would have come');
  foldOutAt(t, 3);
  assert.equal(t.state.hand!.deadline, t.now + TIMING.uncontestedPauseMs + TIMING.rabbitOfferMs);
  hunt(t);
});

test('switched while a hand with a rabbit is up, the setting gives that hand the pause it would have had: switched off, the hunt is refused and the table waits no longer than one that never hunted', () => {
  const t = shuffledTable(7);
  foldOutAt(t, 3);
  const ended = t.now;

  t.now += 1000;
  t.cmd(0, { type: 'updateConfig', config: { rabbitHunting: false } });
  assert.equal(t.feedText().at(-1), 'Rabbit hunting is off');
  assert.equal(t.state.hand!.deadline, ended + TIMING.uncontestedPauseMs);
  assert.throws(() => hunt(t), { name: 'GameError', message: /doesn't hunt/ });

  t.cmd(0, { type: 'updateConfig', config: HUNTING });
  assert.equal(t.state.hand!.deadline, ended + TIMING.uncontestedPauseMs + TIMING.rabbitOfferMs);
  hunt(t);

  const deadline = t.state.hand!.deadline;
  t.cmd(0, { type: 'updateConfig', config: { rabbitHunting: false } });
  assert.equal(t.state.hand!.deadline, deadline, 'a hunted hand keeps the time to see its cards');
});

test('the pause: unchanged at a table that does not hunt, longer by a fixed time after a hand that can be hunted, and one player holds the next hand up by no more than the time it takes to see the cards', () => {
  const off = shuffledTable(8, { rabbitHunting: false });
  foldOutAt(off, 3);
  assert.equal(off.state.hand!.deadline, off.now + TIMING.uncontestedPauseMs);

  const on = shuffledTable(8);
  foldOutAt(on, 3);
  const deadline = on.now + TIMING.uncontestedPauseMs + TIMING.rabbitOfferMs;
  assert.equal(on.state.hand!.deadline, deadline);

  // Hunted at once, the cards are up for longer than the time to see them, and the table keeps to its deadline
  const early = copyOf(on);
  hunt(early);
  assert.equal(early.state.hand!.deadline, deadline);

  // Hunted at the last moment, the hand stays up the time to see them and no longer
  const late = copyOf(on);
  late.now = deadline - 1;
  hunt(late);
  assert.equal(late.state.hand!.deadline, deadline - 1 + TIMING.rabbitShowMs);

  // A hand with nothing to hunt keeps its own pause at a table that hunts
  const shownDown = shuffledTable(8);
  checkDown(shownDown);
  assert.equal(shownDown.state.hand!.deadline, shownDown.now + TIMING.showdownPauseMs);
});

/** Everything a view shows apart from the hunt itself and the time it takes: what the hunt may change. */
function apartFromTheHunt(view: TableView): unknown {
  const hand = view.hand && { ...view.hand, hunted: null, canHunt: null, events: view.hand.events.filter((event) => event[0] !== 'hunt'), deadline: null };

  return { ...view, version: null, hand, feed: null };
}

/** The play-by-play tells the hunt, and with that line taken out matches the one without it, as far back as the chat keeps both. */
function assertSameStory(hunted: readonly string[], left: readonly string[], where: string): void {
  const at = hunted.map((line) => line.includes('hunts the rabbit')).lastIndexOf(true);
  const told = hunted.filter((_line, index) => index !== at);

  assert.ok(at >= 0, `${where}: the hunt is not told`);
  assert.deepEqual(told, left.slice(-told.length), `${where}: the play-by-play`);
}

/** What a record holds that counts: everything but its play-by-play and its events, which tell of the hunt. */
function counted(record: HandRecord): unknown {
  return { ...record, at: null, summary: null, events: null, facts: { ...handFacts(record), at: null } };
}

test('a hunt changes nothing that counts: every stack, the result, the facts, the night, the high hand, the badges, the hints and the chances are as they would have been', () => {
  let hunts = 0;

  for (let seed = 1; seed <= 25; seed++) {
    const rng = seededRng(seed * 6007);
    const stacks = Array.from({ length: 2 + rng.int(6) }, () => (rng.int(5) === 0 ? 1 + rng.int(40) : 100 + rng.int(1500)));
    const t = new TestTable({ stacks, seed, config: {} });
    const config = { ...randomConfig(rng), ...HUNTING, unit: t.state.config.unit };

    t.cmd(0, { type: 'updateConfig', config });
    t.cmd(0, { type: 'start' });

    for (let step = 0; step < 1500; step++) {
      const hand = t.state.hand;

      if (hand && rabbitToHunt(t.state, hand)) {
        const hunted = copyOf(t);
        const left = copyOf(t);

        hunted.cmd(hunted.playerIn(pick(rng, hand.players.filter((p) => !t.state.seats[p.seat]!.leaving))?.seat ?? hand.players[0]!.seat), { type: 'huntRabbit', hand: hand.number });
        hunts += 1;
        assertBoardsHold(hunted.state);
        assertViewsKeepSecrets(hunted.state, hunted.now);

        for (const member of t.state.members) {
          const [seen, unseen] = [viewFor(hunted.state, member.id, t.now), viewFor(left.state, member.id, t.now)];

          assert.deepEqual(apartFromTheHunt(seen), apartFromTheHunt(unseen), `seed ${seed}, step ${step}: ${member.name}'s view shows more than the hunted cards`);
          assert.deepEqual(seen.hand!.hunted, hunted.state.hand!.hunted, 'every viewer sees the same hunted cards');
          assert.deepEqual(spotsOf(seen), spotsOf(unseen));
        }
        assertSameStory(hunted.feedText(), left.feedText(), `seed ${seed}, step ${step}`);

        // Each played on past the end of the hand, the hunt's own wait included
        const over = hunted.state.hand!.deadline!;
        for (const table of [hunted, left]) {
          table.now = over;
          tick(table.state, table.ctx());
        }

        assert.deepEqual(hunted.stacks(), left.stacks(), `seed ${seed}, step ${step}: the stacks`);
        assert.deepEqual(hunted.state.tonight, left.state.tonight, `seed ${seed}, step ${step}: the night's numbers, high hand and badges`);
        assert.deepEqual(handRecords(hunted.effects).map(counted), handRecords(left.effects).map(counted), `seed ${seed}, step ${step}: the record and its facts`);
        assertSameStory(hunted.feedText(), left.feedText(), `seed ${seed}, step ${step}, after the hand`);
      }

      randomStep(t, rng);
    }
  }

  assert.ok(hunts >= 100, `${hunts} hunts`);
});

test('every viewer sees the same hunted cards, a watcher too, and nothing more of the deck or anyone\'s hand', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: HUNTING });
  const watcher = watcherAt(t);

  t.deal({ button: 0, holes: { 0: 'As Ks', 1: 'Qd Qc', 2: '7h 2c' }, board: 'Ah 9d 4s Kd 3c' });
  t.raise(0, 100);
  t.fold(1);
  t.fold(2);
  hunt(t, 2);

  const views = [0, 1, 2, watcher].map((player) => t.view(player));
  for (const view of views) {
    assert.deepEqual(view.hand!.hunted, [['Ah', '9d', '4s', 'Kd', '3c']]);
    assert.deepEqual(view.hand!.boards, [[]]);
    assert.equal(view.hand!.canHunt, false);
  }

  // The winner's cards, and the folded players', stay face down to everyone else
  assert.deepEqual(views[3]!.seats[0]!.cards, [null, null]);
  assert.deepEqual(views[1]!.seats[2]!.cards, [null, null]);
  assert.equal(views[0]!.hand!.holding!.reads[0]!.plays.length, 0, "the winner's hint reads no hunted card");
  assertViewsKeepSecrets(t.state, t.now);
});

test('a table saved with a hunt showing reads back with it showing, and one saved before there were hunts reads back with none', () => {
  const t = shuffledTable(9);
  foldOutAt(t, 3);
  hunt(t);

  const read = restoreState(JSON.stringify(t.state));
  assert.deepEqual(read, t.state);
  assert.deepEqual(viewFor(read, t.ids[0]!, t.now).hand!.hunted, t.state.hand!.hunted);

  const older = structuredClone(t.state) as unknown as { hand: { hunted?: Card[][] | null }; config: Partial<TableConfig> };
  delete older.hand.hunted;
  delete older.config.rabbitHunting;

  const upgraded = restoreState(JSON.stringify(older));
  assert.equal(upgraded.hand!.hunted, null);
  assert.equal(upgraded.config.rabbitHunting, false);
});

test('no card is anywhere twice: the hands, the boards, the hunted cards and the deck make one deck', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const t = shuffledTable(seed, {}, 2 + (seed % 8));

    foldOutAt(t, [0, 3, 4][seed % 3]!);
    hunt(t);

    const hand = t.state.hand!;
    const everywhere = [...hand.players.flatMap((p) => p.cards), ...hand.boards.flat(), ...hand.hunted!.flat(), ...hand.deck];
    assert.deepEqual([...everywhere].sort(), freshDeck().sort());
  }
});
