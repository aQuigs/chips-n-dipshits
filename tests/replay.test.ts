import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPots, handFacts, onTheClock, partStarts, replaySteps, replayView } from '../src/engine/index.ts';
import type { Card, HandEvent, HandRecord, ReplayStep, TableView } from '../src/engine/index.ts';
import { handRecords, TestTable } from './helpers.ts';
import { playedHands } from './playedHands.ts';
import type { PlayedHand } from './playedHands.ts';

// REPLAY_TABLES=400 npm test plays many more hands back than the default
const TABLES = Number(process.env.REPLAY_TABLES ?? 30);
const STEPS_PER_TABLE = 500;

const HANDS = playedHands(TABLES, STEPS_PER_TABLE);

const stepsOf = ({ record, after }: PlayedHand): ReplayStep[] => {
  const steps = replaySteps(record, after.config);
  assert.ok(steps, `hand ${record.number} cannot be played back`);

  return steps;
};

const sum = (amounts: number[]) => amounts.reduce((total, amount) => total + amount, 0);
const seatsOf = (view: TableView) => view.seats.flatMap((seat) => (seat?.inHand ? [seat] : []));

/** Every card named anywhere inside `value`. */
function cardsIn(value: unknown, found = new Set<Card>()): Set<Card> {
  if (typeof value === 'string' && /^[2-9TJQKA][cdhs]$/.test(value)) {
    found.add(value);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach((inner) => cardsIn(inner, found));
  }

  return found;
}

/** The cards a hand's events have turned face up for the table: on a board, in a hand shown, or hunted. */
const cardsSeen = (events: readonly HandEvent[]) => cardsIn(events.filter((event) => event[0] === 'street' || event[0] === 'show' || event[0] === 'hunt'));

test('random play reaches every kind of hand a replay has to tell', () => {
  const kinds = new Set(HANDS.flatMap(({ record }) => record.events.map((event) => event[0])));
  const count = (which: (record: HandRecord) => boolean) => HANDS.filter(({ record }) => which(record)).length;
  const halfShown = count((record) => record.players.some((player) => player.cards.some((card) => card === null) && player.cards.some((card) => card !== null)));

  assert.ok(HANDS.length > 300, `only ${HANDS.length} hands were played`);
  assert.deepEqual([...kinds].sort(), ['bet', 'bounty', 'call', 'check', 'chop', 'chopAnswer', 'chopOffer', 'deal', 'fold', 'hunt', 'muck', 'post', 'raise', 'return', 'runs', 'show', 'start', 'street', 'timeout', 'vote', 'win']);

  for (const [what, hands] of Object.entries({
    'bomb pots': count((record) => record.bombPot !== null),
    'bomb pots on two boards': count((record) => record.bombPot?.boards === 2),
    'hands run twice': count((record) => record.bombPot === null && record.boards.length === 2),
    'hands run three times': count((record) => record.boards.length === 3),
    'hands with side pots': count((record) => record.result.pots.length > 1),
    'hands with a pot split': count((record) => record.result.pots.some((pot) => pot.awards.length > 1 && record.boards.length === 1)),
    'half-shown hands': halfShown,
    'bounties for a hand other than seven-deuce': count((record) => record.result.bounty !== null && record.result.bounty.hand !== '72'),
    'showdowns where one loser shows and another mucks': count((record) => !record.result.uncontested && record.events.some((event) => event[0] === 'muck') && record.result.hands.some((shown) => !record.result.winnings.some((win) => win.seat === shown.seat))),
    'hands shown by whoever everyone folded to': count((record) => record.result.uncontested && record.events.at(-1)![0] === 'show'),
    'moves made for a player who was away': count((record) => record.events.some((event) => (event[0] === 'fold' || event[0] === 'check') && event[2] === true)),
    'pickings the clock ended': count((record) => record.events.some((event) => event[0] === 'runs' && event[2] === 'time')),
    'hands the watcher folded': HANDS.filter(({ record, watcher }) => handFacts(record).players.find((player) => player.playerId === watcher)!.folded).length,
    'hands with someone not dealt in': HANDS.filter(({ bystander }) => bystander !== null).length,
  })) {
    assert.ok(hands > 0, `random play had no ${what}`);
  }
});

test('every hand that kept its events is played back in steps that take each event once, in order, each with something to say', () => {
  for (const hand of HANDS) {
    const { record } = hand;

    if (record.events.length === 0) {
      assert.equal(replaySteps(record, hand.after.config), null, 'a hand with no events has nothing to play back');
      continue;
    }

    const steps = stepsOf(hand);
    const where = `hand ${record.number}`;

    assert.ok(steps[0]!.events > 1, `${where}: the first step is the hand as dealt`);
    assert.equal(steps.at(-1)!.events, record.events.length, `${where}: the last step is not the end of the hand`);
    assert.ok(steps.every((step, at) => at === 0 || step.events > steps[at - 1]!.events), `${where}: the steps do not go forward`);
    assert.ok(steps.every((step) => step.lines.length > 0 && step.lines.every((line) => line.length > 0)), `${where}: a step says nothing`);
    assert.equal(steps[0]!.part, 'Preflop');
    assert.equal(partStarts(steps)[0], 0);
  }
});

test('at every step the chips in the stacks and in the middle add up to what the players sat down with', () => {
  for (const hand of HANDS.filter(({ record }) => record.events.length > 0)) {
    const { record, after } = hand;
    const total = sum(record.players.map((player) => player.startStack));

    for (const step of stepsOf(hand)) {
      const view = replayView(record, step, after);
      const seats = seatsOf(view);
      const where = `hand ${record.number} after ${step.events} events`;

      assert.equal(sum(seats.map((seat) => seat.stack)) + view.hand!.pot, total, `${where}: chips were made or lost`);
      assert.ok(seats.every((seat) => seat.stack >= 0 && seat.bet >= 0) && view.hand!.pot >= sum(seats.map((seat) => seat.bet)), `${where}: more is in front of the players than in the hand`);

      if (view.hand!.stage !== 'done') {
        assert.equal(sum(view.hand!.pots.map((pot) => pot.amount)), view.hand!.pot, `${where}: the pots do not come to the pot`);
      }
    }
  }
});

test('a step is the same table whichever way it is reached, and playing a hand back leaves its record as it was', () => {
  for (const hand of HANDS.filter(({ record }) => record.events.length > 0)) {
    const { record, after, holes, watcher } = hand;
    const kept = holes.get(record.players.find((player) => player.playerId === watcher)!.seat)!;
    const written = JSON.stringify(record);
    const steps = stepsOf(hand);
    const forward = steps.map((step) => JSON.stringify(replayView(record, step, after, kept)));
    const back = [...steps].reverse().map((step) => JSON.stringify(replayView(record, step, after, kept))).reverse();

    assert.deepEqual(back, forward, `hand ${record.number}: going back shows another table than going forward did`);
    assert.equal(JSON.stringify(record), written, `hand ${record.number}: playing it back changed its record`);
    assert.deepEqual(replaySteps(record, after.config), steps);
  }
});

test('the last step is the hand as its record and its facts say it ended', () => {
  for (const hand of HANDS.filter(({ record }) => record.events.length > 0)) {
    const { record, after } = hand;
    const steps = stepsOf(hand);
    const first = replayView(record, steps[0]!, after);
    const last = replayView(record, steps.at(-1)!, after);
    const facts = handFacts(record);
    const where = `hand ${record.number}`;

    assert.equal(last.hand!.stage, 'done', `${where} does not end`);
    assert.deepEqual(last.hand!.result, record.result, `${where} ends on another result`);
    assert.deepEqual(last.hand!.boards, record.boards, `${where} ends on other boards`);
    assert.deepEqual(seatsOf(last).map((seat) => [seat.seat, seat.playerId, seat.name, seat.stack, seat.cards]), record.players.map((player) => [player.seat, player.playerId, player.name, player.endStack, player.cards]), `${where} ends on other stacks or cards`);
    assert.equal(last.hand!.pot, 0, `${where} leaves chips in the middle`);

    assert.equal(last.hand!.boards.length, facts.boards);
    assert.deepEqual(last.hand!.bombPot, facts.bombPot);
    assert.deepEqual(seatsOf(last).map((seat) => [seat.folded, seat.cards]), facts.players.map((player) => [player.folded, player.cards]), `${where}: the facts say otherwise who folded or what was shown`);

    // What the hand did to each stack, less what the blinds and the antes had already taken when it was dealt
    const dealtWith = new Map(seatsOf(first).map((seat) => [seat.seat, seat.stack]));
    const posted = new Map(record.players.map((player) => [player.seat, player.startStack - dealtWith.get(player.seat)!]));
    assert.deepEqual(seatsOf(last).map((seat) => seat.stack - dealtWith.get(seat.seat)! - posted.get(seat.seat)!), facts.players.map((player) => player.net), `${where}: the facts say otherwise what the hand did to a stack`);

    // The most that was ever in the middle is what the facts say was played for, but for a bet that came back
    const most = Math.max(...steps.map((step) => replayView(record, step, after).hand!.pot));
    assert.ok(most >= facts.pot, `${where}: the facts have a bigger pot than was ever on the table`);
  }
});

test('at every step the table is what the live table showed its player then', () => {
  let held = 0;

  for (const hand of HANDS.filter(({ record }) => record.events.length > 0)) {
    const { record, after, seen, holes, watcher } = hand;
    const kept = holes.get(record.players.find((player) => player.playerId === watcher)!.seat)!;
    const steps = stepsOf(hand);

    // A replay may stop more often than the table changed, and never passes over a table that was shown
    const stops = new Set(steps.map((step) => step.events));
    assert.deepEqual([...seen.keys()].filter((count) => !stops.has(count)), [], `hand ${record.number}: the table stood at a place that is no step of the replay`);

    for (const step of steps) {
      const live = seen.get(step.events);
      if (!live?.hand) {
        continue;
      }

      const view = replayView(record, step, after, kept);
      const where = `hand ${record.number} after ${step.events} events`;
      const inHand = new Set(record.players.map((player) => player.seat));
      const drawn = (table: TableView) =>
        table.seats.flatMap((seat) => (seat && inHand.has(seat.seat) ? [{ seat: seat.seat, name: seat.name, stack: seat.stack, bet: seat.bet, folded: seat.folded, allIn: seat.allIn, cards: seat.cards, shown: seat.shown, ritVote: seat.ritVote }] : []));

      held += 1;
      assert.deepEqual(drawn(view), drawn(live), `${where}: the seats are not as they were`);
      assert.equal(view.you.seat, live.you.seat);

      for (const key of ['number', 'stage', 'street', 'boards', 'runs', 'button', 'bigBlind', 'bombPot', 'hunted'] as const) {
        assert.deepEqual(view.hand![key], live.hand[key], `${where}: the hand's ${key} is not as it was`);
      }

      // Once a hand is paid the table draws no pot, and a view goes on saying what was played for
      if (live.hand.stage !== 'done') {
        assert.equal(view.hand!.pot, live.hand.pot, `${where}: the pot is not as it was`);
      }

      assert.equal(onTheClock(view.hand!), onTheClock(live.hand), `${where}: another seat is on the clock`);
      assert.deepEqual(view.hand!.holding?.reads, live.hand.holding?.reads, `${where}: the viewer's own hand reads otherwise`);

      // The label beside a seat says what it last did only while the betting is on
      if (live.hand.stage === 'betting') {
        assert.deepEqual(seatsOf(view).map((seat) => seat.lastAction), live.seats.flatMap((seat) => (seat && inHand.has(seat.seat) ? [seat.lastAction] : [])), `${where}: a seat's last move is not as it was`);
      }

      // The side pots are drawn only once the betting is over, and the result once the hand is
      if (live.hand.stage !== 'betting' && live.hand.stage !== 'done') {
        assert.deepEqual(view.hand!.pots, live.hand.pots, `${where}: the pots are not as they were`);
      }

      // A hand is paid in one go at the table, so what was seen of it once it was over is the whole result
      if (live.hand.stage === 'done') {
        assert.deepEqual(view.hand!.result, live.hand.result, `${where}: the result is not as it was`);
      }
    }
  }

  assert.ok(held > HANDS.length * 3, `only ${held} steps had a live table to be held against`);
});

test('no step shows any viewer a card the table had not seen by then, apart from the viewer\'s own', () => {
  let looked = 0;

  for (const hand of HANDS.filter(({ record }) => record.events.length > 0)) {
    const { record, after, bystander, holes } = hand;
    const steps = stepsOf(hand);
    const everSeen = cardsSeen(record.events);
    const viewers = [...record.players.map((player) => ({ id: player.playerId, name: player.name, seat: player.seat as number | null })), ...(bystander ? [{ ...bystander.you }] : [])];

    for (const viewer of viewers) {
      const table: TableView = { ...(viewer.seat === null ? bystander! : after), you: { ...after.you, id: viewer.id, name: viewer.name, seat: null } };
      const own = record.players.some((player) => player.playerId === viewer.id) ? holes.get(viewer.seat!)! : null;
      // What a browser may hold for this viewer: nothing, their own two cards, or two cards that are not theirs
      const someoneElses = [...holes].find(([seat]) => seat !== viewer.seat)![1];

      for (const kept of [null, own, someoneElses]) {
        for (const step of steps) {
          const view = replayView(record, step, table, kept);
          const seen = cardsSeen(record.events.slice(0, step.events));
          const mayShow = kept === own && own ? new Set([...seen, ...own]) : seen;
          const shows = cardsIn({ ...view, tonight: null });
          const where = `hand ${record.number} after ${step.events} events, to ${viewer.name}`;

          looked += 1;

          // Someone else's cards in the browser are shown only if the record cannot tell they are not the viewer's: never to a viewer who was not dealt in
          if (kept === someoneElses && own && !someoneElses.some((card) => everSeen.has(card))) {
            continue;
          }

          assert.deepEqual([...shows].filter((card) => !mayShow.has(card)), [], `${where}: a card is shown that the table had not seen`);
        }
      }
    }
  }

  assert.ok(looked > 10_000, `only ${looked} views were looked at`);
});

test('what a step says is what the play-by-play said, but for what only a replay tells', () => {
  // Told by a replay alone: each pick as it is made, the rabbit without who hunted it, and each pot of a hand won without a showdown
  const ownWords = (line: string) => / picks (once|twice|three times)$/.test(line) || line.startsWith('Rabbit hunt, ') || / wins [\d.,]+ from (the main pot|side pot \d+)$/.test(line);

  for (const hand of HANDS.filter(({ record }) => record.events.length > 0)) {
    const { record } = hand;
    const told = new Set(record.summary.split('\n'));

    // A hand that outgrew its log has a stretch of it left out
    if (record.summary.includes('… a long stretch of the action is left out …')) {
      continue;
    }

    const lines = stepsOf(hand).flatMap((step) => step.lines);
    assert.deepEqual(lines.filter((line) => !ownWords(line) && !told.has(line)), [], `hand ${record.number}: a step says what the play-by-play did not`);

    // And leaves nothing of the hand out that the play-by-play told
    const replayed = new Set(lines);
    const untold = [...told].filter((line) => !replayed.has(line) && !line.includes(' hunts the rabbit') && line !== 'No small blind this hand' && !/ wins [\d.,]+$/.test(line) && !line.startsWith('Everyone folded to '));
    assert.deepEqual(untold, [], `hand ${record.number}: the play-by-play told what no step says`);
  }
});

test('the pots a step shows are the ones the engine builds from what each player has in', () => {
  for (const hand of HANDS.filter(({ record }) => record.events.length > 0).slice(0, 50)) {
    for (const step of stepsOf(hand)) {
      const view = replayView(hand.record, step, hand.after);

      assert.ok(view.hand!.pots.every((pot) => pot.amount > 0 && pot.eligible.length > 0));
      assert.deepEqual(view.hand!.pots.flatMap((pot) => pot.eligible).filter((seat) => view.seats[seat]!.folded), [], 'a folded player is in for a pot');

      // Until the hand is paid, the pots are everything that is in the middle and in front of the players
      if (view.hand!.stage !== 'done') {
        assert.equal(view.hand!.pots.reduce((sum, pot) => sum + pot.amount, 0), view.hand!.pot, `hand ${hand.record.number} after ${step.events} events: the pots do not come to the pot`);
      }
    }
  }
});

/** Plays the hand on the table to the end of its pause and gives back its record. */
function recordOf(t: TestTable): HandRecord {
  t.finishHand();

  return handRecords(t.effects).at(-1)!;
}

/** The steps of the hand a table just played, each as its part and what it says. */
function told(t: TestTable, record = recordOf(t)): [part: string, ...lines: string[]][] {
  return replaySteps(record, t.state.config)!.map((step) => [step.part, ...step.lines]);
}

test('blinds, antes and the deal are one step, a move the clock made is told with the clock, and a pot is paid in one', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: { ante: 5, actionSeconds: 30 } });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: '7c 2d', 3: '9c 8c' }, board: 'Ks 7s 2h 3c 4d' });

  t.raise(3, 60);
  t.call(0);
  t.call(1);
  t.wait(t.state.hand!.deadline! - t.now);
  t.check(1);
  t.raise(3, 100);
  t.fold(0);
  t.call(1);
  t.check(1);
  t.check(3);
  t.check(1);
  t.check(3);

  assert.deepEqual(told(t), [
    ['Preflop', 'Hand #1 · blinds 10/20 · ante 5 · P0 has the button', 'Everyone posts ante 5', 'P1 posts small blind 10', 'P2 posts big blind 20'],
    ['Preflop', 'P3 raises to 60'],
    ['Preflop', 'P0 calls 60'],
    ['Preflop', 'P1 calls 50'],
    ['Preflop', 'P2 ran out of time', 'P2 folds'],
    ['Flop', 'Flop: K♠ 7♠ 2♥'],
    ['Flop', 'P1 checks'],
    ['Flop', 'P3 bets 100'],
    ['Flop', 'P0 folds'],
    ['Flop', 'P1 calls 100'],
    ['Turn', 'Turn: K♠ 7♠ 2♥ 3♣'],
    ['Turn', 'P1 checks'],
    ['Turn', 'P3 checks'],
    ['River', 'River: K♠ 7♠ 2♥ 3♣ 4♦'],
    ['River', 'P1 checks'],
    ['River', 'P3 checks'],
    ['Showdown', 'P1 shows K♦ K♥ (Three kings)', 'P3 mucks'],
    ['Showdown', 'P1 wins 420 with three kings'],
  ]);
});

test('hands turn up together in a step, each pick is one and how the picking came out another, a board run again is a part of its own, and each pot is paid in one', () => {
  const t = new TestTable({ stacks: [300, 1000, 1000], config: { maxRuns: 3 } });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: 'Qc Qs' }, board: 'Ks 7s 2h 3c 4d', secondBoard: 'Ac Qd 8h 5c 6s' });

  t.raise(0, 300);
  t.raise(1, 1000);
  t.call(2);
  t.cmd(0, { type: 'ritVote', runs: 3 });
  t.cmd(1, { type: 'ritVote', runs: 2 });
  t.cmd(2, { type: 'ritVote', runs: 3 });

  const record = recordOf(t);
  const steps = replaySteps(record, t.state.config)!;

  assert.deepEqual(told(t, record), [
    ['Preflop', 'Hand #1 · blinds 10/20 · P0 has the button', 'P1 posts small blind 10', 'P2 posts big blind 20'],
    ['Preflop', 'P0 raises to 300 and is all in'],
    ['Preflop', 'P1 raises to 1,000 and is all in'],
    ['Preflop', 'P2 calls 980 and is all in'],
    ['Preflop', 'P0 shows A♠ A♥', 'P1 shows K♦ K♥', 'P2 shows Q♣ Q♠'],
    ['Preflop', 'P0 picks three times'],
    ['Preflop', 'P1 picks twice'],
    ['Preflop', 'P2 picks three times'],
    ['Preflop', 'P0 picked three times, P1 twice, P2 three times: running it twice'],
    ['Flop', 'First board, Flop: K♠ 7♠ 2♥'],
    ['Turn', 'First board, Turn: K♠ 7♠ 2♥ 3♣'],
    ['River', 'First board, River: K♠ 7♠ 2♥ 3♣ 4♦'],
    ['Second board', 'Second board, Flop: A♣ Q♦ 8♥'],
    ['Second board', 'Second board, Turn: A♣ Q♦ 8♥ 5♣'],
    ['Second board', 'Second board, River: A♣ Q♦ 8♥ 5♣ 6♠'],
    ['Showdown', 'P1 wins 450 from the main pot on the first board with three kings', 'P0 wins 450 from the main pot on the second board with three aces'],
    ['Showdown', 'P1 wins 700 from side pot 1 on the first board with three kings', 'P2 wins 700 from side pot 1 on the second board with three queens'],
  ]);
  assert.deepEqual(partStarts(steps), [0, 9, 10, 11, 12, 15]);

  // While they pick, the table shows who picked what; then the main pot is paid, and the side pot after it
  const views = steps.map((step) => replayView(record, step, t.view(0)));
  assert.deepEqual(views.map((view) => view.hand!.stage), ['betting', 'betting', 'betting', 'betting', 'ritVote', 'ritVote', 'ritVote', 'ritVote', 'runout', 'runout', 'runout', 'runout', 'runout', 'runout', 'runout', 'done', 'done']);
  assert.deepEqual(views.map((view) => onTheClock(view.hand!)), [0, 1, 2, ...Array<null>(14).fill(null)]);
  assert.deepEqual(views[6]!.seats.slice(0, 3).map((seat) => seat!.ritVote), [3, 2, null]);
  assert.deepEqual(views[4]!.hand!.pots, [{ amount: 900, eligible: [0, 1, 2] }, { amount: 1400, eligible: [1, 2] }]);
  assert.deepEqual(views[4]!.seats.slice(0, 3).map((seat) => [seat!.bet, seat!.allIn, seat!.cards]), [[0, true, ['As', 'Ah']], [0, true, ['Kd', 'Kh']], [0, true, ['Qc', 'Qs']]], 'the bets are in the pot from the moment the hands turn up');
  assert.deepEqual(views[15]!.hand!.result!.winnings, [{ seat: 1, amount: 450 }, { seat: 0, amount: 450 }]);
  assert.equal(views[15]!.hand!.pot, 1400, 'the side pot is still in the middle');
  assert.deepEqual(views[16]!.hand!.result, record.result);
});

test('a street dealt to both boards of a bomb pot is one step, and the hand has no part before its flop but the posting', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bombPotBoards: 'two', bombPotAmount: 50 } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: '7c 2d' }, board: 'Ks 7s 2h 3c 4d', secondBoard: 'Ac Qd 8h 5c 6s' });

  for (let street = 0; street < 3; street++) {
    t.check(1);
    t.check(2);
    t.check(0);
  }

  const steps = told(t);

  assert.deepEqual(steps.slice(0, 2), [
    ['Preflop', 'Hand #1 · double-board bomb pot 50 · P0 has the button', 'Everyone posts bomb pot 50'],
    ['Flop', 'First board, Flop: K♠ 7♠ 2♥', 'Second board, Flop: A♣ Q♦ 8♥'],
  ]);
  assert.deepEqual(steps.map(([part]) => part), ['Preflop', 'Flop', 'Flop', 'Flop', 'Flop', 'Turn', 'Turn', 'Turn', 'Turn', 'River', 'River', 'River', 'River', 'Showdown', 'Showdown']);
  assert.deepEqual(steps.at(-1), ['Showdown', 'P1 wins 75 on the first board with three kings', 'P0 wins 75 on the second board with three aces']);
});

test('an offer to chop is a step, and its answer another with the chop a yes brings; an answer the big blind never gave puts nobody on the clock', () => {
  const chops = { allowChop: true, actionSeconds: 30 };
  const agreed = new TestTable({ stacks: [1000, 1000, 1000], config: chops });
  agreed.deal({ button: 0 });
  agreed.fold(0);
  agreed.cmd(1, { type: 'offerChop' });
  agreed.cmd(2, { type: 'answerChop', agree: true });

  const record = recordOf(agreed);
  const steps = replaySteps(record, agreed.state.config)!;

  assert.deepEqual(told(agreed, record).slice(1), [
    ['Preflop', 'P0 folds'],
    ['Preflop', 'P1 offers to chop the blinds'],
    ['End', 'P2 agrees to chop', 'P1 and P2 chop the blinds: each takes back their own'],
  ]);

  const stood = (t: TestTable, of: HandRecord) => replaySteps(of, t.state.config)!.map((step) => replayView(of, step, t.view(0))).map((view) => [view.hand!.stage, onTheClock(view.hand!)]);
  const views = steps.map((step) => replayView(record, step, agreed.view(0)));
  assert.deepEqual(stood(agreed, record), [['betting', 0], ['betting', 1], ['chop', 2], ['done', null]]);
  assert.deepEqual([views[2]!.hand!.sbSeat, views[2]!.hand!.bbSeat], [1, 2], 'the table has to know the blinds to say who offered');
  assert.deepEqual(views[3]!.hand!.result, record.result);
  assert.deepEqual(views[3]!.seats.slice(0, 3).map((seat) => [seat!.stack, seat!.bet]), [[1000, 0], [1000, 0], [1000, 0]]);

  const unanswered = new TestTable({ stacks: [1000, 1000, 1000], config: chops });
  unanswered.deal({ button: 0 });
  unanswered.fold(0);
  unanswered.cmd(1, { type: 'offerChop' });
  unanswered.wait(unanswered.state.hand!.deadline! - unanswered.now);
  unanswered.fold(1);

  assert.deepEqual(told(unanswered).slice(2), [
    ['Preflop', 'P1 offers to chop the blinds'],
    ['Preflop', 'P2 ran out of time', 'P2 did not answer, so there is no chop'],
    ['Preflop', 'P1 folds', 'Uncalled bet of 10 returned to P2'],
    ['End', 'P2 wins 20'],
  ]);

  // A big blind who always chops is never asked: the table went from the offer to the chop at once, with nobody on the clock between
  const standing = new TestTable({ stacks: [1000, 1000, 1000], config: chops });
  standing.state.seats[2]!.alwaysChop = true;
  standing.deal({ button: 0 });
  standing.fold(0);
  standing.cmd(1, { type: 'offerChop' });

  const chopped = recordOf(standing);
  assert.deepEqual(told(standing, chopped).slice(2), [
    ['Preflop', 'P1 offers to chop the blinds'],
    ['End', 'P2 agrees to chop', 'P1 and P2 chop the blinds: each takes back their own'],
  ]);
  assert.deepEqual(stood(standing, chopped).slice(2), [['chop', null], ['done', null]]);

  // And one who is away is answered for with a no, which is told as the play-by-play told it
  const away = new TestTable({ stacks: [1000, 1000, 1000], config: chops });
  away.deal({ button: 0 });
  away.state.seats[2]!.away = true;
  away.fold(0);
  away.cmd(1, { type: 'offerChop' });
  away.call(1);

  const refused = recordOf(away);
  assert.deepEqual(told(away, refused).slice(2, 6), [
    ['Preflop', 'P1 offers to chop the blinds'],
    ['Preflop', 'P2 did not answer, so there is no chop'],
    ['Preflop', 'P1 calls 10'],
    ['Preflop', 'P2 checks'],
  ]);
  assert.deepEqual(stood(away, refused).slice(2, 6), [['chop', null], ['betting', 1], ['betting', null], ['betting', null]]);
  assert.ok(refused.summary.includes('P2 did not answer, so there is no chop'));
});

test('a hand whose players were asked how many times to run it and never picked shows them being asked, and says why it ran once', () => {
  const t = new TestTable({ stacks: [300, 1000, 1000], config: { maxRuns: 3 } });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: 'Qc Qs' }, board: '9s 7s 2h 3c 4d' });
  t.raise(0, 300);
  t.raise(1, 1000);
  t.call(2);
  assert.equal(t.state.hand!.stage, 'ritVote');

  const record = recordOf(t);
  const steps = replaySteps(record, t.state.config)!;
  const shown = steps.findIndex((step) => step.lines.some((line) => line.includes(' shows ')));

  assert.deepEqual(steps[shown + 1]!.lines, ['P0, P1 and P2 didn\'t pick in time: running it once']);
  assert.deepEqual([shown, shown + 1].map((at) => replayView(record, steps[at]!, t.view(0)).hand!.stage), ['ritVote', 'runout']);
  assert.ok(record.summary.includes(steps[shown + 1]!.lines[0]!));

  // A player who gives up their seat without picking ends it, and is named as the play-by-play named them
  const left = new TestTable({ stacks: [300, 1000, 1000], config: { maxRuns: 3 } });
  left.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: 'Qc Qs' }, board: '9s 7s 2h 3c 4d' });
  left.raise(0, 300);
  left.raise(1, 1000);
  left.call(2);
  left.cmd(0, { type: 'ritVote', runs: 3 });
  left.cmd(2, { type: 'standUp' });

  const walked = recordOf(left);
  const ended = replaySteps(walked, left.state.config)!.find((step) => step.lines.some((line) => line.includes('running it')))!;
  assert.deepEqual(ended.lines, ['P0 picked three times, P2 left without picking: running it once']);
  assert.ok(walked.summary.includes(ended.lines[0]!));
  assert.deepEqual(walked.events.find((event) => event[0] === 'runs'), ['runs', 1, 'left', 2]);

  // Where the table runs it once there is nothing to ask, and the hands turn up as the rest is run
  const once = new TestTable({ stacks: [300, 1000, 1000], config: { maxRuns: 1 } });
  once.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: 'Qc Qs' }, board: '9s 7s 2h 3c 4d' });
  once.raise(0, 300);
  once.raise(1, 1000);
  once.call(2);

  const unasked = recordOf(once);
  const turned = replaySteps(unasked, once.state.config)!.find((step) => step.lines.some((line) => line.includes(' shows ')))!;
  assert.equal(replayView(unasked, turned, once.view(0)).hand!.stage, 'runout');
  assert.ok(!replaySteps(unasked, once.state.config)!.some((step) => step.lines.some((line) => line.includes('running it'))));
});

test('a move made for a player who is away is a step with nobody on the clock before it', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.state.seats[0]!.away = true;
  t.raise(3, 60);
  t.fold(1);
  t.fold(2);

  const record = recordOf(t);
  const steps = replaySteps(record, t.state.config)!;

  assert.deepEqual(steps.slice(1, 3).map((step) => step.lines), [['P3 raises to 60'], ['P0 folds']]);
  assert.deepEqual(steps.slice(0, 3).map((step) => onTheClock(replayView(record, step, t.view(1)).hand!)), [3, null, 1]);
});

test('the bounty, each card turned up after the hand and the rabbit are a step each, after the pot', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bounties: [['72', 50]], rabbitHunting: true } });
  t.deal({ button: 0, holes: { 0: '7h 2c', 1: 'Kd Kh', 2: 'Qc Qs' }, board: 'Ks 7s 2h 3c 4d' });

  t.raise(0, 60);
  t.fold(1);
  t.fold(2);
  t.show(1, [1]);
  t.show(1, [0]);
  t.cmd(2, { type: 'huntRabbit', hand: 1 });

  const record = recordOf(t);
  const steps = replaySteps(record, t.state.config)!;

  assert.deepEqual(told(t, record).slice(1), [
    ['Preflop', 'P0 raises to 60'],
    ['Preflop', 'P1 folds'],
    ['Preflop', 'P2 folds', 'Uncalled bet of 40 returned to P0'],
    ['End', 'P0 wins 50'],
    ['End', 'P0 shows 7♥ 2♣'],
    ['End', 'P0 collects 100 for the 72 bounty'],
    ['End', 'P1 shows one card, K♥'],
    ['End', 'P1 shows the other card, K♦'],
    ['End', 'Rabbit hunt, cards that did not count: K♠ 7♠ 2♥ 3♣ 4♦'],
  ]);

  const views = steps.map((step) => replayView(record, step, t.view(2)));
  assert.deepEqual(views.map((view) => view.hand!.result?.bounty ?? null), [null, null, null, null, null, null, record.result.bounty, record.result.bounty, record.result.bounty, record.result.bounty]);
  assert.deepEqual(views.map((view) => view.seats[1]!.cards), [...Array<null[]>(7).fill([null, null]), [null, 'Kh'], ['Kd', 'Kh'], ['Kd', 'Kh']]);
  assert.deepEqual(views.map((view) => view.hand!.hunted), [...Array<null>(9).fill(null), [['Ks', '7s', '2h', '3c', '4d']]]);
  assert.deepEqual(views.map((view) => view.seats[0]!.stack), [1000, 940, 940, 980, 1030, 1030, 1130, 1130, 1130, 1130]);
});

test('a bounty is told for the hand it was paid for, in the play-by-play\'s own words', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bounties: [['J4s', 50], ['72', 25]] } });
  t.deal({ button: 0, holes: { 0: 'Jd 4d', 1: 'Kd Kh', 2: 'Qc Qs' }, board: '9s 7s 2h 3c 5d' });
  t.raise(0, 60);
  t.fold(1);
  t.fold(2);

  const record = recordOf(t);
  const steps = replaySteps(record, t.state.config)!;

  assert.deepEqual(told(t, record).slice(-3), [['End', 'P0 wins 50'], ['End', 'P0 shows J♦ 4♦'], ['End', 'P0 collects 100 for the J4s bounty']]);
  assert.ok(record.summary.split('\n').includes(steps.at(-1)!.lines[0]!));

  const views = steps.slice(-2).map((step) => replayView(record, step, t.view(1)));
  assert.deepEqual(views.map((view) => view.hand!.result!.bounty), [null, { seat: 0, hand: 'J4s', payments: [{ seat: 1, amount: 50 }, { seat: 2, amount: 50 }] }]);
  assert.deepEqual(views.map((view) => view.seats.slice(0, 3).map((seat) => seat!.stack)), [[1030, 990, 980], [1130, 940, 930]]);
});

test('a loser who shows by choice turns up with the hands shown down, beside one who mucks, and a winner everyone folded to shows after the pot', () => {
  const shownDown = new TestTable({ stacks: [1000, 1000, 1000] });
  shownDown.cmd(1, { type: 'setAutoShow', when: 'lost', on: true });
  shownDown.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: 'Qc Qs' }, board: '9s 7s 2h 3c 4d' });
  shownDown.call(0);
  shownDown.call(1);
  shownDown.check(2);

  for (let street = 0; street < 3; street++) {
    shownDown.check(1);
    shownDown.check(2);
    shownDown.check(0);
  }

  const record = recordOf(shownDown);
  const steps = replaySteps(record, shownDown.state.config)!;

  assert.deepEqual(told(shownDown, record).slice(-2), [
    ['Showdown', 'P1 shows K♦ K♥ (Pair of kings)', 'P2 mucks', 'P0 shows A♠ A♥ (Pair of aces)'],
    ['Showdown', 'P0 wins 60 with pair of aces'],
  ]);

  // To a seat that saw none of them dealt: the two hands turned up, and the mucked one face down to the end
  const cards = steps.slice(-3).map((step) => replayView(record, step, shownDown.view(2)).seats.slice(0, 3).map((seat) => seat!.cards));
  assert.deepEqual(cards, [[[null, null], [null, null], [null, null]], [['As', 'Ah'], ['Kd', 'Kh'], [null, null]], [['As', 'Ah'], ['Kd', 'Kh'], [null, null]]]);

  const foldedTo = new TestTable({ stacks: [1000, 1000, 1000] });
  foldedTo.cmd(0, { type: 'setAutoShow', when: 'foldedTo', on: true });
  foldedTo.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: 'Qc Qs' }, board: '9s 7s 2h 3c 4d' });
  foldedTo.raise(0, 60);
  foldedTo.fold(1);
  foldedTo.fold(2);

  assert.deepEqual(told(foldedTo).slice(-2), [['End', 'P0 wins 50'], ['End', 'P0 shows A♠ A♥']]);
});

test('the viewer\'s own cards are theirs from the deal when the browser kept them, and face down until shown when it did not', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh', 2: 'Qc Qs' }, board: '9s 7s 2h 3c 4d' });
  t.call(0);
  t.call(1);
  t.check(2);
  for (let street = 0; street < 3; street++) {
    t.check(1);
    t.check(2);
    t.check(0);
  }

  const record = recordOf(t);
  const steps = replaySteps(record, t.state.config)!;
  const mine = (viewer: number, kept: Card[] | null) => steps.map((step) => replayView(record, step, t.view(viewer), kept)).map((view) => view.seats[viewer]!.cards!.join(' '));

  assert.ok(mine(0, ['As', 'Ah']).every((cards) => cards === 'As Ah'));
  assert.deepEqual(new Set(mine(0, null).slice(0, -2)), new Set([' ']), 'a hand this browser did not see is face down until the table sees it');
  assert.deepEqual(mine(0, null).slice(-2), ['As Ah', 'As Ah']);

  // The hint under the viewer's cards reads them against the board as it was at each step
  const kept = steps.map((step) => replayView(record, step, t.view(0), ['As', 'Ah']).hand!.holding!.reads[0]!.name);
  assert.deepEqual([kept[0], kept.at(-1)], ['Pocket aces', 'Pair of aces']);
  assert.equal(replayView(record, steps[0]!, t.view(0)).hand!.holding, null);

  // Cards that cannot be this hand's are no use: one of them is on the board, or the table saw the viewer hold another
  assert.ok(mine(0, ['9s', 'Ah']).slice(0, -2).every((cards) => cards === ' '));
  assert.ok(mine(0, ['Ad', 'Ac']).slice(0, -2).every((cards) => cards === ' '));
  assert.ok(mine(0, ['As']).slice(0, -2).every((cards) => cards === ' '));

  // A seat that folds keeps its place at the table, and nobody may do anything in a replay
  const view = replayView(record, steps[3]!, t.view(1), ['Kd', 'Kh']);
  assert.deepEqual([view.you.seat, view.you.role, view.hand!.options, view.hand!.deadline, view.hand!.canShow, view.hand!.canHunt, view.requests.length], [1, 'member', null, null, false, false, 0]);
});

test('a record whose events do not end where it says the hand did is not played back, and neither is one with none', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });
  t.fold(0);

  const record = recordOf(t);
  const table = t.state.config;

  assert.ok(replaySteps(record, table));
  assert.equal(replaySteps({ ...record, events: [] }, table), null);
  assert.equal(replaySteps({ ...record, events: record.events.slice(1) }, table), null, 'events that do not start with the hand');
  assert.equal(replaySteps({ ...record, events: record.events.slice(0, -1) }, table), null, 'events that stop short of the end');
  assert.equal(replaySteps({ ...record, players: record.players.map((player) => ({ ...player, endStack: player.endStack + 1 })) }, table), null);
  assert.equal(replaySteps({ ...record, boards: [['As', 'Ks', 'Qs']] }, table), null);
  assert.equal(replaySteps({ ...record, events: [...record.events, ['fold', 7]] }, table), null, 'an event for a seat nobody was dealt in at');
  assert.equal(replaySteps({ ...record, events: [...record.events, ['shrug', 0] as unknown as HandEvent] }, table)?.length, replaySteps(record, table)!.length, 'an event of a kind this code does not know is passed over');
});
