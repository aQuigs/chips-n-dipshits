import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DealtCards, forgetDealt } from '../src/client/dealtCards.ts';
import { REPLAY_SPEEDS, ReplayPlayer, STEP_MS } from '../src/client/replayPlayer.ts';
import type { Ticker } from '../src/client/replayPlayer.ts';
import { replayAfter } from '../src/client/replayTurn.ts';
import { TableNews } from '../src/client/tableChange.ts';
import { turnArrived } from '../src/client/yourTurn.ts';
import { replaySteps } from '../src/engine/index.ts';
import type { HandRecord, ReplayStep, TableView } from '../src/engine/index.ts';
import { HISTORY_LIMIT } from '../src/server/api.ts';
import { handRecords, mapMemory, TestTable } from './helpers.ts';

/** A clock the test moves: what is due happens as the time passes, in the order it comes due. */
class TestTicker implements Ticker {
  now = 0;
  private waiting: { at: number; run: () => void }[] = [];

  after(ms: number, run: () => void): () => void {
    const entry = { at: this.now + ms, run };

    this.waiting.push(entry);

    return () => {
      this.waiting = this.waiting.filter((other) => other !== entry);
    };
  }

  pass(ms: number): void {
    const until = this.now + ms;

    for (;;) {
      const [next] = this.waiting.filter((entry) => entry.at <= until).sort((a, b) => a.at - b.at);
      if (!next) {
        break;
      }

      this.waiting = this.waiting.filter((entry) => entry !== next);
      this.now = next.at;
      next.run();
    }

    this.now = until;
  }

  get pending(): number {
    return this.waiting.length;
  }
}

/** A hand bet on every street and shown down: eighteen steps in five parts. */
function showdown(): { record: HandRecord; steps: ReplayStep[]; t: TestTable } {
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
  t.finishHand();

  const record = handRecords(t.effects)[0]!;

  return { record, steps: replaySteps(record, t.state.config)!, t };
}

function playerOf(at = 0) {
  const { steps } = showdown();
  const ticker = new TestTicker();
  const drawn: number[] = [];
  const player: ReplayPlayer = new ReplayPlayer(steps, ticker, () => drawn.push(player.at), at);

  return { player, ticker, drawn, steps };
}

test('a replay starts on the first step, with nothing before it to go back to, and ends on the last with nothing after', () => {
  const { player, drawn, steps } = playerOf();

  assert.equal(steps.length, 18);
  assert.deepEqual([player.at, player.atStart, player.atEnd, player.playing, player.speed], [0, true, false, false, 1]);
  assert.deepEqual(player.starts, [0, 4, 8, 12, 16]);

  player.back();
  player.previousPart();
  assert.equal(player.at, 0);
  assert.deepEqual(drawn, [], 'a step that is already shown is not drawn again');

  player.seek(17);
  assert.deepEqual([player.at, player.atStart, player.atEnd, player.step], [17, false, true, steps[17]]);

  player.forward();
  player.nextPart();
  assert.equal(player.at, 17);
  assert.deepEqual(drawn, [17]);
});

test('a step goes one way or the other, a street jump to where streets start, and a place off either end to the end', () => {
  const { player } = playerOf();
  const places = (move: () => void, times: number) => Array.from({ length: times }, () => (move(), player.at));

  assert.deepEqual(places(() => player.forward(), 3), [1, 2, 3]);
  assert.deepEqual(places(() => player.back(), 2), [2, 1]);

  // From inside a street to its start, and from a start to the one before
  assert.deepEqual(places(() => player.nextPart(), 6), [4, 8, 12, 16, 17, 17]);
  assert.deepEqual(places(() => player.previousPart(), 6), [16, 12, 8, 4, 0, 0]);
  player.seek(6);
  assert.deepEqual(places(() => player.previousPart(), 2), [4, 0]);

  for (const [asked, shown] of [[-3, 0], [99, 17], [7.4, 7], [Number.NaN, 0]] as const) {
    player.seek(asked);
    assert.equal(player.at, shown);
  }
});

test('playing shows a step at a time until the last and stops there, and a replay opened where it was left goes on from there', () => {
  const { player, ticker, drawn } = playerOf(14);

  assert.equal(player.at, 14);
  player.toggle();
  assert.deepEqual([player.playing, drawn], [true, [14]]);

  ticker.pass(STEP_MS - 1);
  assert.equal(player.at, 14);
  ticker.pass(1);
  assert.equal(player.at, 15);
  ticker.pass(STEP_MS * 10);
  assert.deepEqual([player.at, player.playing, ticker.pending], [17, false, 0]);
  assert.deepEqual(drawn, [14, 15, 16, 17]);

  // Played from its end, the hand starts over
  player.toggle();
  assert.deepEqual([player.at, player.playing], [0, true]);
  ticker.pass(STEP_MS);
  assert.equal(player.at, 1);
});

test('a pause, a step taken by hand and closing the replay each stop the playing, with nothing left to happen later', () => {
  for (const stop of [(player: ReplayPlayer) => player.toggle(), (player: ReplayPlayer) => player.forward(), (player: ReplayPlayer) => player.seek(9), (player: ReplayPlayer) => player.previousPart(), (player: ReplayPlayer) => player.pause()]) {
    const { player, ticker } = playerOf(3);

    player.toggle();
    ticker.pass(STEP_MS);
    assert.deepEqual([player.at, player.playing], [4, true]);

    stop(player);
    const at = player.at;

    assert.deepEqual([player.playing, ticker.pending], [false, 0]);
    ticker.pass(STEP_MS * 5);
    assert.equal(player.at, at, 'the replay went on by itself after it was stopped');
  }
});

test('each press of the speed takes the next pace and comes round again, and a replay that is playing keeps to the new one from then on', () => {
  const { player, ticker } = playerOf();
  const speeds = REPLAY_SPEEDS.map(() => (player.changeSpeed(), player.speed));

  assert.deepEqual(speeds, [...REPLAY_SPEEDS.slice(1), REPLAY_SPEEDS[0]]);
  assert.ok(!player.playing, 'changing the speed started the replay');
  assert.equal(ticker.pending, 0);

  player.toggle();
  player.changeSpeed();
  assert.equal(player.speed, 2);

  ticker.pass(STEP_MS / 2 - 1);
  assert.equal(player.at, 0);
  ticker.pass(1);
  assert.equal(player.at, 1);
  ticker.pass(STEP_MS);
  assert.equal(player.at, 3, 'two steps in the time of one');

  // Changed while a step is up, the step gets its whole time at the new pace
  ticker.pass(STEP_MS / 4);
  player.changeSpeed();
  assert.equal(player.speed, 4);
  ticker.pass(STEP_MS / 4 - 1);
  assert.equal(player.at, 3);
  ticker.pass(1);
  assert.equal(player.at, 4);
});

test('a hand of one step has nothing to play', () => {
  const { steps } = showdown();
  const ticker = new TestTicker();
  const player = new ReplayPlayer(steps.slice(0, 1), ticker, () => undefined);

  player.toggle();
  assert.deepEqual([player.at, player.playing, player.atStart, player.atEnd, ticker.pending], [0, false, true, true, 0]);
});

/** A view of a hand as the player in `seat` has it. */
function dealtView(t: TestTable, seat: number): TableView {
  return t.view(seat);
}

test('the viewer\'s own cards are kept from every hand they are dealt, for that member alone, and found again by another page of the same browser', () => {
  const memory = mapMemory();
  const dealt = new DealtCards(memory, 'TEST01');
  const t = new TestTable({ stacks: [1000, 1000, 1000] });

  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kh' } });
  const me = dealtView(t, 0);
  dealt.see(me);
  dealt.see(me);

  assert.deepEqual(dealt.of(me.you.id, 1), ['As', 'Ah']);
  assert.equal(dealt.of(me.you.id, 2), null, 'a hand this browser did not see dealt');
  assert.equal(dealt.of(t.view(1).you.id, 1), null, 'another member is shown cards that were not dealt to them');
  assert.deepEqual(Object.keys(memory.kept), ['cnd.dealt.TEST01'], 'kept somewhere else than under its own name');

  assert.deepEqual(new DealtCards(memory, 'TEST01').of(me.you.id, 1), ['As', 'Ah']);
  assert.equal(new DealtCards(memory, 'OTHER1').of(me.you.id, 1), null, 'the cards of one table are found at another');

  // Another member takes over the browser: what was kept for the first is not theirs, and is gone once they are dealt in
  const other = dealtView(t, 1);
  dealt.see(other);
  assert.deepEqual(dealt.of(other.you.id, 1), ['Kd', 'Kh']);
  assert.equal(dealt.of(me.you.id, 1), null);

  forgetDealt({ remove: (key) => void delete memory.kept[key] }, 'TEST01');
  assert.deepEqual(Object.keys(memory.kept), []);
});

test('only as many hands are kept as the history offers, the newest, and someone watching or not dealt in keeps nothing', () => {
  const memory = mapMemory();
  const dealt = new DealtCards(memory, 'TEST01');
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  const watcher = t.sitDown('Watcher', 5, 1000);

  t.cmd(watcher, { type: 'sitOut' });

  let id = '';
  for (let hand = 1; hand <= HISTORY_LIMIT + 5; hand++) {
    t.deal();
    const view = dealtView(t, 0);

    id = view.you.id;
    dealt.see(view);
    dealt.see(t.view(watcher));
    t.foldOut();
    dealt.see(t.view(0));
  }

  const kept = Array.from({ length: HISTORY_LIMIT + 5 }, (_, nth) => nth + 1).filter((hand) => dealt.of(id, hand) !== null);
  assert.deepEqual(kept, Array.from({ length: HISTORY_LIMIT }, (_, nth) => nth + 6));
  assert.equal(dealt.of(t.view(watcher).you.id, HISTORY_LIMIT + 5), null);
  assert.equal((JSON.parse(memory.get('cnd.dealt.TEST01')!) as { hands: unknown[] }).hands.length, HISTORY_LIMIT);
});

test('a table put back to an earlier hand keeps the cards it deals now, a browser that keeps nothing keeps them for the visit, and what is not a list of hands is nothing kept', () => {
  const memory = mapMemory();
  const dealt = new DealtCards(memory, 'TEST01');
  const t = new TestTable({ stacks: [1000, 1000] });

  t.deal({ button: 0, holes: { 0: 'As Ah' } });
  const first = dealtView(t, 0);
  dealt.see(first);
  t.foldOut();
  t.deal({ holes: { 0: 'Kd Kh' } });
  dealt.see(dealtView(t, 0));
  assert.deepEqual([dealt.of(first.you.id, 1), dealt.of(first.you.id, 2)], [['As', 'Ah'], ['Kd', 'Kh']]);

  // Hand 1 again, with other cards: hand 2 as it was kept is of a night that never happened
  dealt.see({ ...first, seats: first.seats.map((seat, nth) => (nth === 0 ? { ...seat!, cards: ['7c', '2d'] } : seat)) });
  assert.deepEqual([dealt.of(first.you.id, 1), dealt.of(first.you.id, 2)], [['7c', '2d'], null]);

  const refusing = { get: () => { throw new Error('no storage'); }, set: () => { throw new Error('no storage'); } };
  const forVisit = new DealtCards(refusing, 'TEST01');
  forVisit.see(first);
  assert.deepEqual(forVisit.of(first.you.id, 1), ['As', 'Ah']);

  for (const junk of ['', 'null', '[]', '{"player":"x"}', `{"player":"${first.you.id}","hands":[[1,["As"]],["1",["As","Ah"]],[2,["Kd","Kh"]],null]}`]) {
    memory.set('cnd.dealt.TEST01', junk);
    assert.equal(new DealtCards(memory, 'TEST01').of(first.you.id, 1), null, junk);
  }
  assert.deepEqual(new DealtCards(memory, 'TEST01').of(first.you.id, 2), ['Kd', 'Kh'], 'the hands that read are kept');
});

test('a turn arrives with the first view that puts the viewer on the clock for a decision, once for each', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { allowChop: true } });
  t.deal({ button: 0 });

  // Seat 0 is first to act: there when the page opens, which is still an arrival to a page that has seen nothing
  const mine = t.view(0);
  assert.ok(turnArrived(null, mine));
  assert.ok(!turnArrived(mine, t.view(0)), 'the same turn arrives twice');
  assert.ok(!turnArrived(null, t.view(1)), 'someone else\'s turn');

  t.fold(0);
  const folded = t.view(0);
  assert.ok(!turnArrived(mine, folded));

  // The small blind offers a chop, and the answer is the big blind's to give: a turn like any other
  const beforeOffer = t.view(2);
  t.cmd(1, { type: 'offerChop' });
  assert.ok(turnArrived(beforeOffer, t.view(2)));
  assert.ok(!turnArrived(t.view(1), t.view(1)));

  // The action comes back around on the same street: a new decision
  const again = new TestTable({ stacks: [1000, 1000, 1000] });
  again.deal({ button: 0 });
  const first = again.view(0);
  again.call(0);
  const waiting = again.view(0);
  again.raise(1, 100);
  again.call(2);
  assert.ok(turnArrived(waiting, again.view(0)));
  assert.ok(turnArrived(first, again.view(0)), 'a turn that follows another with nothing seen between');
});

test('a replay that is open is set aside when the viewer\'s turn arrives, once and with a word; a turn already theirs leaves it, and it is told of the turn either way', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  const news = new TableNews();
  const toasts: string[] = [];
  const turns: boolean[] = [];
  let open = false;
  let setAside = 0;
  let shown: TableView | null = null;

  const replay = {
    setAside: () => {
      const was = open;

      open = false;
      setAside += was ? 1 : 0;

      return was;
    },
    turn: (mine: boolean) => void turns.push(mine),
  };
  const see = (seat: number) => {
    const change = news.change(shown, structuredClone(t.view(seat)), t.now, false);

    shown = change.view;
    replayAfter(change, replay, (message) => void toasts.push(message));
  };

  // Seat 2 is the big blind: the action is on seat 0, then seat 1, then on them
  t.deal({ button: 0 });
  see(2);
  open = true;
  t.call(0);
  see(2);
  assert.deepEqual([open, setAside, toasts, turns], [true, 0, [], [false, false]]);

  t.call(1);
  see(2);
  assert.deepEqual([open, setAside, toasts.length, turns.at(-1)], [false, 1, 1, true]);
  assert.match(toasts[0]!, /^Your turn\./);

  // Opened again while the turn stands, it is theirs to close: nothing closes it, and nothing more is said
  open = true;
  see(2);
  see(2);
  assert.deepEqual([open, setAside, toasts.length, turns.at(-1)], [true, 1, 1, true]);

  // The turn passes with the replay still open: it is told so, and stays
  t.check(2);
  see(2);
  assert.deepEqual([open, turns.at(-1)], [true, false]);

  // With no replay open a turn says nothing here: the alert is another effect's
  open = false;
  t.check(1);
  see(2);
  assert.deepEqual([setAside, toasts.length, turns.at(-1)], [1, 1, true]);
});

test('a replay is set aside for a pick of how many times to run it too, which is nobody\'s turn but has a clock', () => {
  const t = new TestTable({ stacks: [1000, 1000], config: { maxRuns: 2 } });
  const news = new TableNews();
  const turns: boolean[] = [];
  let setAside = 0;
  let shown: TableView | null = null;

  const replay = { setAside: () => (setAside += 1) > 0, turn: (mine: boolean) => void turns.push(mine) };
  const see = () => {
    const change = news.change(shown, structuredClone(t.view(1)), t.now, false);

    shown = change.view;
    replayAfter(change, replay, () => undefined);
  };

  t.deal({ button: 0 });
  see();
  t.raise(0, 1000);
  see();
  assert.deepEqual([setAside, turns.at(-1)], [1, true], 'the call is the viewer\'s to make');

  // Both all in: each is asked, and the asking is what the replay makes way for
  t.call(1);
  assert.equal(t.state.hand!.stage, 'ritVote');
  see();
  assert.deepEqual([setAside, turns.at(-1)], [2, true]);
  see();
  assert.equal(setAside, 2, 'the same asking set the replay aside again');

  t.cmd(1, { type: 'ritVote', runs: 2 });
  see();
  assert.deepEqual([setAside, turns.at(-1)], [2, false], 'a pick made leaves nothing to wait for');
});
