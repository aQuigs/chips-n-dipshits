import assert from 'node:assert/strict';
import test from 'node:test';

import { isTurnMove, predict } from '../src/client/prediction.ts';
import type { TurnMove } from '../src/client/prediction.ts';
import { applyCommand, EVENT_LIMIT, replayHand, SEAT_COUNT, STRADDLES, STRADDLES_IN_A_ROW, straddlesAllowed, viewFor } from '../src/engine/index.ts';
import type { GameError, HandEvent, Straddle, TableState, TableView } from '../src/engine/index.ts';
import { ACES, KINGS, seededRng, TestTable, withoutTheServersPart } from './helpers.ts';
import { fixedSettings, randomConfig } from './randomConfig.ts';
import { chance, pick, randomStep } from './randomPlay.ts';

/** A player's page at the moment they move: what it showed, what it predicts, and what the engine then makes of the move. */
interface Played {
  seat: number;
  before: TableView;
  predicted: TableView | null;
  after: TableView;
}

/** Whoever is on the clock makes `move` from their own page, naming the decision as the buttons do. */
function play(t: TestTable, move: TurnMove): Played {
  const seat = t.toAct!;
  const player = t.playerIn(seat);
  const before = structuredClone(t.view(player));
  const predicted = predict(before, { ...move, turn: before.hand!.turn });

  t.cmd(player, move);

  return { seat, before, predicted, after: structuredClone(t.view(player)) };
}

/** What a prediction says of the viewer's own seat and of the hand. */
function claims(view: TableView | null) {
  assert.ok(view, 'the move was not predicted');

  const { bet, stack, folded, allIn, lastAction } = view.seats[view.you.seat!]!;
  const { pot, currentBet, toAct, turn, options, deadline } = view.hand!;

  return { bet, stack, folded, allIn, lastAction, pot, currentBet, toAct, turn, options, deadline };
}

/** That the engine did nothing but pass the action on, and the prediction is the view it gave, to the last field the page can know. */
function assertIsWhatTheEngineSays({ predicted, after }: Played, what: string): void {
  assert.ok(predicted, `${what}: the move was not predicted`);
  assert.deepEqual(withoutTheServersPart(predicted), withoutTheServersPart(after), what);
}

const lastEvent = (view: TableView | null): HandEvent | undefined => view?.hand?.events.at(-1);

test('a call in the middle of a street: the chips are in front of the caller, off their stack and in the pot, and the next player is on', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  const played = play(t, { type: 'call' });

  assert.deepEqual(claims(played.predicted), { bet: 20, stack: 980, folded: false, allIn: false, lastAction: 'call', pot: 50, currentBet: 20, toAct: 1, turn: played.before.hand!.turn + 1, options: null, deadline: null });
  assert.deepEqual(lastEvent(played.predicted), ['call', 0, 20, 980]);
  assertIsWhatTheEngineSays(played, 'a call');
});

test('a raise, a bet and a check each read as the engine plays them', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  const raise = play(t, { type: 'raise', to: 60 });
  assert.deepEqual(claims(raise.predicted), { bet: 60, stack: 940, folded: false, allIn: false, lastAction: 'raise', pot: 90, currentBet: 60, toAct: 1, turn: raise.before.hand!.turn + 1, options: null, deadline: null });
  assert.deepEqual(lastEvent(raise.predicted), ['raise', 0, 60, 940]);
  assertIsWhatTheEngineSays(raise, 'a raise');

  t.call(1);
  t.call(2);

  const check = play(t, { type: 'check' });
  assert.equal(check.seat, 1);
  assert.deepEqual(claims(check.predicted), { bet: 0, stack: 940, folded: false, allIn: false, lastAction: 'check', pot: 180, currentBet: 0, toAct: 2, turn: check.before.hand!.turn + 1, options: null, deadline: null });
  assert.deepEqual(lastEvent(check.predicted), ['check', 1]);
  assertIsWhatTheEngineSays(check, 'a check');

  const bet = play(t, { type: 'raise', to: 40 });
  assert.deepEqual(claims(bet.predicted), { bet: 40, stack: 900, folded: false, allIn: false, lastAction: 'bet', pot: 220, currentBet: 40, toAct: 0, turn: bet.before.hand!.turn + 1, options: null, deadline: null });
  assert.deepEqual(lastEvent(bet.predicted), ['bet', 2, 40, 900]);
  assertIsWhatTheEngineSays(bet, 'a bet');
});

test('a fold in the middle of a hand: the cards are folded with no hint under them, and no chip moves', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: ACES } });

  const played = play(t, { type: 'fold' });

  assert.ok(played.before.hand!.holding, 'the viewer had a hint before folding');
  assert.equal(played.predicted!.hand!.holding, null);
  assert.deepEqual(played.predicted!.seats[0]!.cards, ['As', 'Ah'], 'their own cards stay for them to look at');
  assert.deepEqual(claims(played.predicted), { bet: 0, stack: 1000, folded: true, allIn: false, lastAction: 'fold', pot: 30, currentBet: 20, toAct: 1, turn: played.before.hand!.turn + 1, options: null, deadline: null });
  assertIsWhatTheEngineSays(played, 'a fold');
});

test('a fold that ends the hand shows the fold and nothing of who won', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });

  const { before, predicted, after } = play(t, { type: 'fold' });

  assert.equal(after.hand!.stage, 'done', 'the engine ended the hand');
  assert.deepEqual(claims(predicted), { bet: 10, stack: 990, folded: true, allIn: false, lastAction: 'fold', pot: 30, currentBet: 20, toAct: null, turn: before.hand!.turn, options: null, deadline: null });
  assert.equal(predicted!.hand!.stage, 'betting');
  assert.equal(predicted!.hand!.result, null);
  assert.deepEqual(predicted!.seats[1], before.seats[1], 'the winner’s seat says nothing yet');
});

test('a check that closes the street shows the check and no next card, and names nobody', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, board: '2c 7d 9h Jc 3s' });
  t.call(0);
  t.call(1);
  t.check(2);
  t.check(1);
  t.check(2);

  const { before, predicted, after } = play(t, { type: 'check' });

  assert.deepEqual(after.hand!.boards, [['2c', '7d', '9h', 'Jc']], 'the engine dealt the turn');
  assert.deepEqual(predicted!.hand!.boards, [['2c', '7d', '9h']]);
  assert.equal(predicted!.hand!.street, 'flop');
  assert.deepEqual(claims(predicted), { bet: 0, stack: 980, folded: false, allIn: false, lastAction: 'check', pot: 60, currentBet: 0, toAct: null, turn: before.hand!.turn, options: null, deadline: null });
});

test('the big blind’s check that brings the flop and their own turn again shows only the check', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });
  t.call(0);

  const { before, predicted, after } = play(t, { type: 'check' });

  assert.equal(after.hand!.toAct, 1, 'the big blind is first to act on the flop');
  assert.equal(after.hand!.turn, before.hand!.turn + 1);
  assert.equal(claims(predicted).toAct, null);
  assert.equal(claims(predicted).turn, before.hand!.turn, 'the decision the page shows is still the one that was answered');
  assert.deepEqual(predicted!.hand!.boards, [[]]);
});

test('a call that closes the street leaves the chips in front of the caller until the server gathers them', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });
  t.call(0);
  t.check(1);
  t.raise(1, 100);

  const { before, predicted, after } = play(t, { type: 'call' });

  assert.equal(after.seats[0]!.bet, 0, 'the engine took the bets to the pot');
  assert.deepEqual(claims(predicted), { bet: 100, stack: 880, folded: false, allIn: false, lastAction: 'call', pot: 240, currentBet: 100, toAct: null, turn: before.hand!.turn, options: null, deadline: null });
  assert.equal(after.hand!.pot, 240);
});

test('all in for less than the call: what the stack has goes in, and no more', () => {
  const t = new TestTable({ stacks: [1000, 1000, 30] });
  t.deal({ button: 0 });
  t.raise(0, 100);
  t.fold(1);

  const { before, predicted, after } = play(t, { type: 'call' });

  assert.equal(before.hand!.options!.callAmount, 10);
  assert.deepEqual(claims(predicted), { bet: 30, stack: 0, folded: false, allIn: true, lastAction: 'call', pot: 140, currentBet: 100, toAct: null, turn: before.hand!.turn, options: null, deadline: null });
  assert.deepEqual(lastEvent(predicted), ['call', 2, 10, 0]);
  assert.equal(after.seats[0]!.stack, 970, 'the engine gave back what nobody could call, which the page does not guess at');
  assert.equal(predicted!.seats[0]!.stack, 900);
});

test('a raise that is the whole stack is all in', () => {
  const t = new TestTable({ stacks: [300, 1000, 1000] });
  t.deal({ button: 0 });

  const played = play(t, { type: 'raise', to: 300 });

  assert.deepEqual(claims(played.predicted), { bet: 300, stack: 0, folded: false, allIn: true, lastAction: 'raise', pot: 330, currentBet: 300, toAct: 1, turn: played.before.hand!.turn + 1, options: null, deadline: null });
  assertIsWhatTheEngineSays(played, 'an all-in raise');
});

test('with an ante in the pot the total counts it, and the stack is short by ante and call both', () => {
  for (const anteFrom of ['everyone', 'bigBlind'] as const) {
    const t = new TestTable({ stacks: [1000, 1000, 1000], config: { ante: 5, anteFrom } });
    t.deal({ button: 0 });

    const played = play(t, { type: 'call' });
    const antes = anteFrom === 'everyone' ? 15 : 5;

    assert.equal(played.before.hand!.pot, 30 + antes);
    assert.equal(claims(played.predicted).pot, 50 + antes, anteFrom);
    assert.equal(claims(played.predicted).stack, anteFrom === 'everyone' ? 975 : 980, anteFrom);
    assertIsWhatTheEngineSays(played, `a call over an ante from ${anteFrom}`);
  }
});

test('on two boards a bet shows as on one, and a call that ends the street adds a card to neither', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bombPotAmount: 100, bombPotBoards: 'two' } });
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, board: '2c 7d 9h Jc 3s', secondBoard: 'Kd 4c 5h 8s Qd' });

  const bet = play(t, { type: 'raise', to: 50 });
  assert.equal(bet.seat, 1);
  assert.equal(claims(bet.predicted).pot, 350);
  assert.deepEqual(lastEvent(bet.predicted), ['bet', 1, 50, 850]);
  assertIsWhatTheEngineSays(bet, 'a bet on two boards');

  t.call(2);

  const { predicted, after } = play(t, { type: 'call' });
  assert.deepEqual(after.hand!.boards.map((board) => board.length), [4, 4], 'the engine dealt the turn of both');
  assert.deepEqual(predicted!.hand!.boards, [['2c', '7d', '9h'], ['Kd', '4c', '5h']]);
  assert.deepEqual([claims(predicted).bet, claims(predicted).pot, claims(predicted).toAct], [50, 450, null]);
});

test('nobody is named when the next player is one the server acts for', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });
  t.cmd(1, { type: 'standUp' });

  const { before, predicted, after } = play(t, { type: 'call' });

  assert.equal(before.seats[1]!.leaving, true);
  assert.equal(after.seats[1]!.folded, true, 'the engine folded the player who is leaving');
  assert.equal(after.hand!.toAct, 2);
  assert.equal(claims(predicted).toAct, null);
  assert.equal(predicted!.seats[1]!.folded, false, 'what the server does for another player is not guessed at');
});

test('a move the view does not offer is not predicted', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  const mine = structuredClone(t.view(0));
  const { turn, options } = mine.hand!;

  assert.ok(predict(mine, { type: 'call', turn }));
  assert.equal(predict(mine, { type: 'call', turn: turn - 1 }), null, 'a move for an earlier decision');
  assert.equal(predict(mine, { type: 'check', turn }), null, 'a check facing a bet');
  assert.equal(predict(mine, { type: 'raise', to: options!.minRaiseTo - 1, turn }), null, 'a raise under the least');
  assert.equal(predict(mine, { type: 'raise', to: options!.maxRaiseTo + 1, turn }), null, 'a raise over the stack');
  assert.equal(predict(mine, { type: 'raise', to: options!.minRaiseTo + 0.5, turn }), null, 'a raise that is no whole amount');

  assert.equal(predict(structuredClone(t.view(1)), { type: 'call', turn }), null, 'a move out of turn');

  t.call(0);
  t.call(1);
  assert.equal(predict(structuredClone(t.view(2)), { type: 'call', turn: t.view(2).hand!.turn }), null, 'a call with nothing to call');

  const watcher = { ...mine, you: { ...mine.you, seat: null } };
  assert.equal(predict(watcher, { type: 'fold' }), null, 'a move by someone only watching');

  assert.equal(isTurnMove({ type: 'raise', to: 40 }), true);
  assert.equal(isTurnMove({ type: 'ritVote', agree: true }), false, 'a vote on running it twice answers no decision of a turn');
  assert.equal(isTurnMove({ type: 'chat', text: 'hi' }), false);
});

test('a hand whose events are not kept gets none from a prediction, and one at the limit loses them as the engine’s does', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  const kept = structuredClone(t.view(0));
  const unkept = { ...kept, hand: { ...kept.hand!, events: [] } };
  const full = { ...kept, hand: { ...kept.hand!, events: Array.from({ length: EVENT_LIMIT }, () => kept.hand!.events[0]!) } };
  const call: TurnMove = { type: 'call', turn: kept.hand!.turn };

  assert.equal(predict(kept, call)!.hand!.events.length, kept.hand!.events.length + 1);
  assert.deepEqual(predict(unkept, call)!.hand!.events, []);
  assert.equal(claims(predict(unkept, call)).bet, 20, 'the move itself is shown all the same');
  assert.deepEqual(predict(full, call)!.hand!.events, []);
});

test('a prediction leaves the view it was made from as it was', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: KINGS } });

  const view = structuredClone(t.view(0));
  const kept = structuredClone(view);

  predict(view, { type: 'raise', to: 60, turn: view.hand!.turn });
  assert.deepEqual(view, kept);
});

// PREDICT_TABLES=500 npm test holds the prediction to many more random tables than the default
const TABLES = Number(process.env.PREDICT_TABLES ?? 20);
const STEPS_PER_TABLE = 400;

/** The fields of a view a prediction may change, taken from `from` and laid over `onto`. */
function withClaimsOf(onto: TableView, from: TableView): TableView {
  const seat = onto.you.seat!;
  const { stack, bet, folded, allIn, lastAction } = from.seats[seat]!;
  const { pot, currentBet, toAct, turn, deadline, options, holding, events } = from.hand!;

  return {
    ...onto,
    seats: onto.seats.map((other, index) => (index === seat ? { ...other!, stack, bet, folded, allIn, lastAction } : other)),
    hand: { ...onto.hand!, pot, currentBet, toAct, turn, deadline, options, holding, events },
  };
}

/** Every move worth trying for the player a view is for, legal and not. */
function movesFor(view: TableView, pick: (most: number) => number): TurnMove[] {
  const { minRaiseTo, maxRaiseTo } = view.hand!.options!;

  return [
    { type: 'fold' },
    { type: 'check' },
    { type: 'call' },
    { type: 'raise', to: minRaiseTo },
    { type: 'raise', to: maxRaiseTo },
    { type: 'raise', to: minRaiseTo + pick(Math.max(0, maxRaiseTo - minRaiseTo) + 1) },
    { type: 'raise', to: minRaiseTo - 1 },
    { type: 'raise', to: maxRaiseTo + 1 },
  ];
}

test('for whoever is to act on random tables, every move the page predicts is the move the engine plays, and it predicts every move the engine allows', (t) => {
  const reached = { moves: 0, refused: 0, passedOn: 0, endedStreet: 0, endedHand: 0, runOut: 0, serverActedForNext: 0, allInForLess: 0, allIn: 0, withAnte: 0, withMissedBlind: 0, inBombPot: 0, onTwoBoards: 0, withSidePots: 0, inCents: 0, unfollowed: 0 };

  // Moves made before the flop of a hand with each kind of straddle posted: by anyone, and by a blind, who acts before the straddler there
  const straddled: Record<Straddle, number> = { straddle: 0, 'double straddle': 0, 'button straddle': 0, 'Mississippi straddle': 0 };
  const blindFacing: Record<Straddle, number> = { ...straddled };

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 104_729);
    const players = 2 + rng.int(SEAT_COUNT - 1);
    const stacks = Array.from({ length: players }, () => (chance(rng, 25) ? 1 + rng.int(60) : 100 + rng.int(1900)));
    const config = randomConfig(rng);
    const table = new TestTable({ stacks, seed, config: fixedSettings(config) });

    table.cmd(0, { type: 'updateConfig', config });
    table.cmd(0, { type: 'start' });

    for (let step = 0; step < STEPS_PER_TABLE; step++) {
      const hand = table.state.hand;

      // Random play hardly ever leaves a straddle on until it is its player's to post, so now and then everyone asks for
      // every kind the table allows, or only for those from under the gun: a straddle from elsewhere leaves no room for a double
      if (chance(rng, 15)) {
        const wanted = chance(rng, 50) ? STRADDLES.slice(0, STRADDLES_IN_A_ROW) : STRADDLES;

        for (const kind of straddlesAllowed(table.state.config)) {
          table.state.seats.forEach((seat) => seat && table.cmd(table.ids.indexOf(seat.playerId), { type: 'setStraddle', kind: kind.what, on: wanted.includes(kind) }));
        }
      }

      // A player the clock caught out stays in the hand, away, and the server plays their turns for them. Random play
      // seldom leaves one there, so now and then one of the others in the hand is as the clock would have left them
      const absent = hand?.stage === 'betting' && chance(rng, 5) ? pick(rng, hand.players.filter((p) => !p.folded && !p.allIn && p.seat !== hand.toAct)) : undefined;
      if (absent) {
        table.state.seats[absent.seat]!.away = true;
      }

      if (hand?.stage === 'betting') {
        // What the page reads off a seat's label is what the engine keeps of it having acted
        for (const player of hand.players.filter((p) => !p.folded)) {
          assert.equal(['check', 'call', 'bet', 'raise'].includes(player.lastAction ?? ''), player.hasActed, `seat ${player.seat} is labeled ${player.lastAction} and has ${player.hasActed ? '' : 'not '}acted`);
        }

        const playerId = table.state.seats[hand.toAct!]!.playerId;
        const before = structuredClone(viewFor(table.state, playerId, table.now));
        const posts = hand.events.flatMap((event) => (event[0] === 'post' ? [event[2]] : []));

        for (const move of movesFor(before, (most) => rng.int(most))) {
          const where: string = `table ${seed}, step ${step}, seat ${hand.toAct} plays ${JSON.stringify(move)}`;
          const sent: TurnMove = { ...move, turn: before.hand!.turn };
          const predicted = predict(before, sent);
          const state: TableState = structuredClone(table.state);
          let refusal: string | null = null;

          try {
            applyCommand(state, { now: table.now, rng: seededRng(1), effects: [] }, playerId, sent);
          } catch (error) {
            assert.equal((error as GameError).name, 'GameError', `${where}: ${(error as Error).stack}`);
            refusal = (error as GameError).message;
          }

          assert.equal(predicted === null, refusal !== null, `${where}: the page ${predicted ? 'predicted' : 'did not predict'} a move the engine ${refusal ? `refused (${refusal})` : 'played'}`);
          reached.refused += refusal ? 1 : 0;

          if (!predicted) {
            continue;
          }

          const after = viewFor(state, playerId, table.now);
          const seat = before.you.seat!;
          const [mine, mineAfter] = [predicted.seats[seat]!, after.seats[seat]!];
          const had = before.hand!.events.length;
          const followed = had > 0 && had < EVENT_LIMIT;

          // It changes what it claims to know, and nothing else
          assert.deepEqual(predicted, withClaimsOf(before, predicted), `${where}: the prediction changed more than it claims to know`);
          assert.deepEqual([predicted.hand!.options, predicted.hand!.deadline], [null, null], where);

          // The move is the next thing the hand's events tell, and leaves the table as the prediction has it
          if (followed) {
            assert.deepEqual(predicted.hand!.events.at(-1), after.hand!.events[had], `${where}: the move as an event`);

            const moved = replayHand(after.hand!.events, had + 1)!;
            const onTheTable = moved.pot + moved.seats.reduce((sum, player) => sum + player.bet, 0);
            const replayed = moved.seats.find((player) => player.seat === seat)!;

            assert.deepEqual([mine.bet, mine.stack, mine.folded, predicted.hand!.pot], [replayed.bet, replayed.stack, replayed.folded, onTheTable], `${where}: the seat and the pot as the move leaves them`);
          } else {
            assert.deepEqual(predicted.hand!.events, after.hand!.events.slice(0, had + 1), `${where}: the events of a hand that keeps none`);
          }

          assert.equal(mine.allIn, mine.stack === 0, where);
          assert.equal(mine.lastAction, mineAfter.folded || after.hand!.street === before.hand!.street ? mineAfter.lastAction : mine.lastAction, `${where}: the label of the move`);

          // When the engine did no more than pass the action on, the prediction is its view; when the move set
          // anything else off, the prediction names nobody and shows none of it
          const othersAsBefore = after.seats.every((other, index) => index === seat || JSON.stringify(other) === JSON.stringify(before.seats[index]));
          const passedOn = after.hand!.stage === 'betting' && after.hand!.street === before.hand!.street && after.hand!.turn === before.hand!.turn + 1 && othersAsBefore;

          if (passedOn) {
            assert.deepEqual(withoutTheServersPart(predicted), withoutTheServersPart(after), `${where}: the action only passed on`);
            assert.notEqual(predicted.hand!.toAct, null, where);
          } else {
            assert.deepEqual([predicted.hand!.toAct, predicted.hand!.turn], [null, before.hand!.turn], `${where}: the move set something off, and the page named who is next`);
            assert.deepEqual(predicted.hand!.boards, before.hand!.boards, where);
          }

          reached.moves += 1;
          reached.passedOn += passedOn ? 1 : 0;
          reached.endedStreet += after.hand!.stage === 'betting' && after.hand!.street !== before.hand!.street ? 1 : 0;
          reached.endedHand += after.hand!.stage === 'done' ? 1 : 0;
          reached.runOut += after.hand!.stage === 'runout' || after.hand!.stage === 'ritVote' ? 1 : 0;
          reached.serverActedForNext += after.hand!.stage === 'betting' && after.hand!.street === before.hand!.street && !othersAsBefore ? 1 : 0;
          reached.allInForLess += sent.type === 'call' && mine.allIn && mine.bet < before.hand!.currentBet ? 1 : 0;
          reached.allIn += mine.allIn ? 1 : 0;
          reached.withAnte += posts.some((post) => post === 'ante' || post === 'big blind ante') ? 1 : 0;

          if (before.hand!.street === 'preflop') {
            const blind = seat === before.hand!.sbSeat || seat === before.hand!.bbSeat;

            for (const { what } of before.hand!.straddles) {
              straddled[what] += 1;
              blindFacing[what] += blind ? 1 : 0;
            }
          }

          reached.withMissedBlind += posts.some((post) => post === 'missed big blind' || post === 'dead small blind') ? 1 : 0;
          reached.inBombPot += before.hand!.bombPot ? 1 : 0;
          reached.onTwoBoards += before.hand!.runs > 1 ? 1 : 0;
          reached.withSidePots += before.hand!.pots.length > 1 ? 1 : 0;
          reached.inCents += before.config.unit === 'cents' ? 1 : 0;
          reached.unfollowed += followed ? 0 : 1;
        }
      }

      randomStep(table, rng);
    }
  }

  // The run only proves something if it reached every kind of table and every way a move can end
  const told = JSON.stringify({ ...reached, straddled, blindFacing });
  t.diagnostic(told);
  assert.ok(reached.moves >= TABLES * 300 && reached.refused >= TABLES * 200, told);
  assert.ok(reached.passedOn >= TABLES * 100 && reached.endedStreet >= TABLES * 20 && reached.endedHand >= TABLES * 20 && reached.runOut >= TABLES * 5, told);
  assert.ok(reached.serverActedForNext >= TABLES / 4 && reached.allInForLess >= TABLES && reached.allIn >= TABLES * 20, told);
  assert.ok(reached.withAnte >= TABLES * 50 && reached.withMissedBlind >= TABLES / 2 && reached.withSidePots >= TABLES * 5, told);
  // Every kind of straddle, and the blinds who face it: where the action starts and what a raise must be differ for each
  assert.ok(STRADDLES.every((kind) => straddled[kind.what] >= TABLES && blindFacing[kind.what] >= TABLES / 4), told);
  assert.ok(reached.inBombPot >= TABLES * 10 && reached.onTwoBoards >= TABLES * 5 && reached.inCents >= TABLES * 50, told);
});
