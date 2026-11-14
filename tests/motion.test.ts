import assert from 'node:assert/strict';
import test from 'node:test';

import { betSlide, followHand, MOST_MOVE_MS, MOST_VIEW_MS, movesSeen, STEP_GAP_MS } from '../src/client/handMoves.ts';
import { soundsHeard } from '../src/client/handSounds.ts';
import { Motion, motionAbility, MOVE_MS } from '../src/client/motion.ts';
import type { MotionPlayer, Move, Place } from '../src/client/motion.ts';
import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import type { AppPreferences } from '../src/client/prefs.ts';
import { Sounds } from '../src/client/sound.ts';
import { tableChange } from '../src/client/tableChange.ts';
import type { TableChange } from '../src/client/tableChange.ts';
import { replayHand } from '../src/engine/index.ts';
import type { HandEvent, TableView } from '../src/engine/index.ts';
import { mapMemory, seededRng, TestTable } from './helpers.ts';
import { chance, randomStep } from './randomPlay.ts';

/** A viewer's table, moved by a stand-in that writes down what it was asked to do. */
class Eyes {
  /** Each thing asked of the stand-in, in order: 'cancel', or the moves of one `play`. */
  readonly asked: ('cancel' | Move[])[] = [];
  readonly prefs: AppPreferences = new Preferences(PREFERENCES, mapMemory());
  reduced = false;
  inView = true;
  readonly motion: Motion;

  constructor() {
    const player: MotionPlayer = {
      play: (moves) => void this.asked.push([...moves]),
      cancel: () => void this.asked.push('cancel'),
      idle: () => Promise.resolve(),
      dispose: () => undefined,
    };

    this.motion = new Motion(player, this.prefs, { reduced: () => this.reduced, inView: () => this.inView });
  }

  /** What the hand-moves effect plays for a change. */
  see(change: TableChange, seat: number | null): string[] {
    const from = this.asked.length;

    followHand(change, seat, this.motion);

    return this.asked.slice(from).flatMap((asked) => (asked === 'cancel' ? [] : asked.map(told)));
  }
}

/** One seat's page: each view as it arrives, turned into the change the effects are handed. */
class Page {
  shown: TableView | null = null;
  readonly eyes = new Eyes();
  private readonly table: TestTable;
  private readonly seat: number;

  constructor(table: TestTable, seat: number) {
    this.table = table;
    this.seat = seat;
  }

  change(wentBack = false): TableChange {
    const change = tableChange(this.shown, structuredClone(this.table.view(this.seat)), this.table.now, wentBack);

    this.shown = change.view;

    return change;
  }

  arrive(wentBack = false): string[] {
    return this.eyes.see(this.change(wentBack), this.seat);
  }
}

function where(place: Place | undefined): string {
  if (!place) {
    return '';
  }

  switch (place.at) {
    case 'deck':
    case 'pot':
      return place.at;
    case 'board':
      return `board${place.board}.${place.card}`;
    default:
      return `${place.at}${place.seat}`;
  }
}

/** A move in a line: its name, what the chips say, where from and to, and when it starts. */
const told = (move: Move) => `${move.name}${move.amount === undefined ? '' : ` ${move.amount}`} ${where(move.from)}>${where(move.to)} @${move.after}`;

// Three players with the button on seat 0, the blinds in, and two cards each
const DEALT: HandEvent[] = [
  ['start', 1, 0, 10, 20, [[0, 'P0', 1000], [1, 'P1', 1000], [2, 'P2', 1000]]],
  ['post', 1, 'small blind', 10, 990],
  ['post', 2, 'big blind', 20, 980],
  ['deal'],
];

// The same hand with everyone in for 20 and the flop out
const ON_THE_FLOP: HandEvent[] = [...DEALT, ['call', 0, 20, 980], ['call', 1, 10, 980], ['check', 2], ['street', 0, ['As', 'Kd', '2c']]];

/** A table that draws in front of each seat the bet a hand's events leave there. */
function drawn(events: HandEvent[]): TableView {
  const seats: { bet: number }[] = [];

  for (const seat of replayHand(events)?.seats ?? []) {
    seats[seat.seat] = { bet: seat.bet };
  }

  return { hand: { events }, seats } as TableView;
}

/** A hand whose events were `had` going on with `news`, as a view that is on time brings it. */
const going = (had: HandEvent[], news: HandEvent[]) => ({ before: drawn(had), view: drawn([...had, ...news]), events: news }) as TableChange;

/** What seat 0 sees move when a hand whose events were `had` goes on with `news`. */
const seen = (had: HandEvent[], news: HandEvent[], viewer: number | null = 0) => movesSeen(going(had, news), viewer).map(told);

test('each kind of hand event moves what it should, or nothing', () => {
  const cases: [what: string, had: HandEvent[], event: HandEvent, moves: string[]][] = [
    ['the start of a hand', [], DEALT[0]!, []],
    ['a blind', DEALT.slice(0, 1), ['post', 1, 'small blind', 10, 990], ['bet seat1>bet1 @0']],
    ['an ante', DEALT.slice(0, 1), ['post', 1, 'ante', 5, 995, 'contribution'], ['chips seat1>pot @0']],
    ['a big-blind ante', DEALT.slice(0, 3), ['post', 2, 'big blind ante', 20, 960, 'dead'], ['chips seat2>pot @0']],
    ['the deal', DEALT.slice(0, 3), ['deal'], ['deal deck>cards1 @0', 'deal deck>cards2 @60', 'deal deck>cards0 @120']],
    ['a fold', DEALT, ['fold', 1], ['muck cards1>deck @0']],
    ['a check', ON_THE_FLOP, ['check', 1], []],
    ['a call', DEALT, ['call', 1, 10, 980], ['bet seat1>bet1 @0']],
    ['a bet', ON_THE_FLOP, ['bet', 1, 40, 940], ['bet seat1>bet1 @0']],
    ['a raise', DEALT, ['raise', 1, 60, 940], ['bet seat1>bet1 @0']],
    ['a clock run out', DEALT, ['timeout', 1], []],
    ['an uncalled bet going back', [...ON_THE_FLOP, ['bet', 1, 500, 480], ['call', 2, 300, 0], ['fold', 0]], ['return', 1, 200], ['chips 200 bet1>seat1 @0']],
    ['the part of a bomb pot nobody could match going back', [DEALT[0]!, ['post', 0, 'bomb pot', 185, 815, 'contribution'], ['post', 1, 'bomb pot', 57, 943, 'contribution'], ['deal']], ['return', 0, 128], ['chips 128 pot>seat0 @0']],
    ['a blind and part of an ante going back', [DEALT[0]!, ['post', 1, 'ante', 6, 994, 'contribution'], ['post', 1, 'small blind', 3, 991], ['deal']], ['return', 1, 7], ['chips 3 bet1>seat1 @0', 'chips 4 pot>seat1 @0']],
    ['the flop, with the bets before it', ON_THE_FLOP.slice(0, -1), ON_THE_FLOP.at(-1)!, ['chips 20 bet0>pot @0', 'chips 20 bet1>pot @0', 'chips 20 bet2>pot @0', 'board deck>board0.0 @120', 'board deck>board0.1 @180', 'board deck>board0.2 @240']],
    ['the turn after checks', [...ON_THE_FLOP, ['check', 1], ['check', 2], ['check', 0]], ['street', 0, ['9h']], ['board deck>board0.3 @0']],
    ['a vote to run it twice', ON_THE_FLOP, ['vote', 1, true], []],
    ['the bets going in when the rest is run out', [...ON_THE_FLOP, ['bet', 1, 980, 0], ['call', 2, 980, 0], ['fold', 0]], ['runs', 1], ['chips 980 bet1>pot @0', 'chips 980 bet2>pot @0']],
    ['cards turned face up', ON_THE_FLOP, ['show', 1, ['7d', '2s']], ['show >cards1 @0']],
    ['a hand mucked at the showdown', ON_THE_FLOP, ['muck', 1], []],
    ['a pot won', ON_THE_FLOP, ['win', 1, 60, 0, 0], ['chips 60 pot>seat1 @0']],
    ['a pot won with a bet in front', [...DEALT, ['fold', 0], ['fold', 1]], ['win', 2, 30, 0, 0], ['chips 10 bet1>pot @0', 'chips 20 bet2>pot @0', 'chips 30 pot>seat2 @120']],
    ['a bounty', [...ON_THE_FLOP, ['win', 1, 60, 0, 0]], ['bounty', 1, [[0, 50], [2, 50]]], ['chips 50 seat0>seat1 @0', 'chips 50 seat2>seat1 @0']],
  ];

  for (const [what, had, event, moves] of cases) {
    assert.deepEqual(seen(had, [event]), moves, what);
  }
});

test('the viewer’s own folded cards stay and their own shown cards do not turn, while their own bet slides like anyone’s', () => {
  assert.deepEqual(seen(DEALT, [['fold', 0]]), []);
  assert.deepEqual(seen(ON_THE_FLOP, [['show', 0, ['7d', '2s']]]), []);
  assert.deepEqual(seen(DEALT, [['call', 0, 20, 980]]), [told(betSlide(0))]);

  // Someone only watching sees every fold and every hand turned up
  assert.deepEqual(seen(DEALT, [['fold', 0]], null), ['muck cards0>deck @0']);
  assert.deepEqual(seen(ON_THE_FLOP, [['show', 0, ['7d', '2s']]], null), ['show >cards0 @0']);
});

test('a new hand slides the blinds in as the cards go out, around the table from the button’s left', () => {
  assert.deepEqual(seen([], DEALT), ['bet seat1>bet1 @0', 'bet seat2>bet2 @0', 'deal deck>cards1 @0', 'deal deck>cards2 @60', 'deal deck>cards0 @120']);

  // A full table is dealt no slower than a short one: the last cards leave at the same moment
  const full: HandEvent[] = [['start', 1, 6, 10, 20, Array.from({ length: 10 }, (_, seat): [number, string, number] => [seat, `P${seat}`, 1000])], ['deal']];
  const dealt = movesSeen(going([], full), 0);

  assert.deepEqual(dealt.map((move) => where(move.to)), [7, 8, 9, 0, 1, 2, 3, 4, 5, 6].map((seat) => `cards${seat}`));
  assert.equal(dealt.at(-1)!.after, 240);
  assert.deepEqual(dealt.map((move) => move.after), [...dealt.map((move) => move.after)].sort((a, b) => a - b));
});

test('a bet that is gathered in the same view is seen going to the pot, not sliding in front of its seat first', () => {
  const table = new TestTable({ stacks: [1000, 1000, 1000] });
  const page = new Page(table, 2);

  page.arrive();
  table.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kc', 2: '7h 2s' }, board: '3c 8d Jh Qs 4d' });
  assert.equal(page.arrive().length, 5, 'two blinds and three hands of cards');

  table.call(0);
  assert.deepEqual(page.arrive(), ['bet seat0>bet0 @0']);

  // The small blind's call and the big blind's check close the street in one view
  table.call(1);
  table.check(2);
  assert.deepEqual(page.arrive(), ['chips 20 bet0>pot @0', 'chips 20 bet1>pot @0', 'chips 20 bet2>pot @0', 'board deck>board0.0 @120', 'board deck>board0.1 @180', 'board deck>board0.2 @240']);

  table.check(1);
  table.raise(2, 100);
  assert.deepEqual(page.arrive(), ['bet seat2>bet2 @0'], 'the viewer’s own bet');

  table.fold(0);
  table.fold(1);
  assert.deepEqual(page.arrive(), ['muck cards0>deck @0', 'muck cards1>deck @0', 'chips 100 bet2>seat2 @0', 'chips 60 pot>seat2 @120'], 'both fold, the bet nobody called goes back, and the pot follows it');
});

test('a bet the page was already drawing, as one shown before the server answered, is not slid again when the hand’s events bring it', () => {
  const table = new TestTable({ stacks: [1000, 1000, 1000] });
  const page = new Page(table, 0);

  page.arrive();
  table.deal({ button: 0 });
  page.arrive();

  // The page draws the viewer's raise at once, and plays its slide itself
  const predicted = structuredClone(page.shown!);
  predicted.seats[0]!.bet = 60;
  predicted.seats[0]!.stack -= 60;
  assert.deepEqual(page.eyes.see(tableChange(page.shown, predicted, table.now), 0), []);
  page.shown = predicted;

  table.raise(0, 60);
  assert.deepEqual(page.arrive(), [], 'the view that confirms it');

  // Anyone else's bet, and the viewer's next one, slide as ever
  table.call(1);
  assert.deepEqual(page.arrive(), ['bet seat1>bet1 @0']);
  table.raise(2, 200);
  page.arrive();
  table.call(0);
  assert.deepEqual(page.arrive(), ['bet seat0>bet0 @0']);
});

test('a split pot, side pots and two boards send one pile to each winner, with all they won, all at once', () => {
  const wins: HandEvent[] = [['win', 1, 40, 0, 0], ['win', 2, 40, 0, 0], ['win', 1, 100, 1, 0], ['win', 2, 35, 0, 1], ['win', 1, 35, 0, 1]];

  assert.deepEqual(seen(ON_THE_FLOP, wins), ['chips 175 pot>seat1 @0', 'chips 75 pot>seat2 @0']);
});

test('a bomb pot sends a bare chip from every seat to the pot as the cards go out, then both flops of two boards land together', () => {
  const posts: HandEvent[] = [0, 1, 2].map((seat) => ['post', seat, 'bomb pot', 100, 900, 'contribution']);
  const bombPot: HandEvent[] = [[...DEALT[0]!, 0, 'everyone', { amount: 100, boards: 2 }] as unknown as HandEvent, ...posts, ['deal'], ['street', 0, ['As', 'Kd', '2c']], ['street', 1, ['9h', '9s', '3d']]];

  assert.deepEqual(seen([], bombPot), [
    'chips seat0>pot @0',
    'chips seat1>pot @0',
    'chips seat2>pot @0',
    'deal deck>cards1 @0',
    'deal deck>cards2 @60',
    'deal deck>cards0 @120',
    'board deck>board0.0 @120',
    'board deck>board0.1 @180',
    'board deck>board0.2 @240',
    'board deck>board1.0 @120',
    'board deck>board1.1 @180',
    'board deck>board1.2 @240',
  ]);
});

test('a hand run twice lands each street where it belongs, the second board’s cards after those both boards share', () => {
  const table = new TestTable({ stacks: [1000, 1000], config: { allowRunItTwice: true } });
  const page = new Page(table, 1);

  table.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kc' }, board: '3c 8d Jh Qs 4d', secondBoard: '2c 5h' });
  page.arrive();
  table.call(0);
  table.check(1);
  page.arrive();
  table.raise(1, 980);
  assert.deepEqual(page.arrive(), ['bet seat1>bet1 @0']);
  // The bets go to the pot when the betting ends, which the hand's events only say once the vote is over
  table.call(0);
  assert.deepEqual(page.arrive(), ['show >cards0 @0', 'chips 980 bet0>pot @120', 'chips 980 bet1>pot @120']);
  table.cmd(0, { type: 'ritVote', agree: true });
  assert.deepEqual(page.arrive(), []);
  table.cmd(1, { type: 'ritVote', agree: true });
  assert.deepEqual(page.arrive(), [], 'and they are not gathered a second time');

  const landed: string[][] = [];
  for (let step = 0; step < 10 && table.state.hand!.stage !== 'done'; step++) {
    table.wait(table.state.hand!.deadline! - table.now);
    landed.push(page.arrive());
  }

  assert.deepEqual(landed.slice(0, 3), [['board deck>board0.3 @0'], ['board deck>board0.4 @0'], ['board deck>board1.3 @0']]);
  assert.equal(landed[3]![0], 'board deck>board1.4 @0');
  assert.deepEqual(landed[3]!.slice(1).map((move) => move.replace(/\d+ /, '')), ['chips pot>seat0 @120'], 'both boards’ shares in one pile');
});

test('a view that brings more than fits its budget is shown by how it ended', () => {
  // Folds and hands turned up by turns, so each is a step of its own, then the pot
  const burst: HandEvent[] = [];
  for (let round = 0; round < 6; round++) {
    burst.push(['fold', 1], ['show', 2, ['7d', '2s']]);
  }
  burst.push(['win', 2, 60, 0, 0]);

  const moves = movesSeen(going(ON_THE_FLOP, burst), 0);
  const steps = [...new Set(moves.map((move) => move.after))];

  assert.equal(moves.at(-1)!.name, 'chips', 'the pot going to its winner is what the view ended on');
  assert.ok(steps.length < 13 && steps.length >= 4, `${steps.length} steps of 13 were kept`);
  assert.deepEqual(steps, steps.map((_, nth) => nth * STEP_GAP_MS), 'what is kept starts at once');
  assert.ok(Math.max(...moves.map((move) => move.after + MOVE_MS[move.name])) <= MOST_VIEW_MS);

  // One step more would not have fitted
  assert.ok(steps.length * STEP_GAP_MS + MOVE_MS.chips > MOST_VIEW_MS, 'a step was dropped that had room');
});

test('no move is longer than a move may be, and steps come at the gap sounds come at', () => {
  for (const [name, ms] of Object.entries(MOVE_MS)) {
    assert.ok(ms <= MOST_MOVE_MS, `${name} takes ${ms} ms`);
  }

  // A second thing seen in a view starts when the second thing heard does
  const table = new TestTable({ stacks: [1000, 1000, 1000] });
  const page = new Page(table, 2);

  page.arrive();
  table.cmd(0, { type: 'setBombPot', on: true });
  table.deal({ button: 0 });

  const change = page.change();
  const heard: { sound: string; delay: number }[] = [];
  const sounds = new Sounds({ play: (sound, _volume, delay) => void heard.push({ sound, delay }) }, page.eyes.prefs, { now: () => 0, inView: () => true });

  soundsHeard(change.events, 2).forEach((sound) => sounds.play(sound));

  const moves = movesSeen(change, 2);
  const startOf = (name: string) => Math.min(...moves.filter((move) => move.name === name).map((move) => move.after));

  assert.deepEqual(heard.map((played) => played.sound), ['deal', 'street']);
  assert.equal(startOf('deal'), heard[0]!.delay * 1000, 'the deal is seen when it is heard');
  assert.equal(startOf('board'), heard[1]!.delay * 1000, 'the flop is seen when it is heard');
});

test('nothing moves on the first view, on a table that went back, or for what happened while the viewer was away', () => {
  const table = new TestTable({ stacks: [1000, 1000] });
  const page = new Page(table, 1);
  const saved = structuredClone(table.state);

  table.deal({ button: 0 });
  table.raise(0, 60);
  assert.deepEqual(page.arrive(), [], 'the page opened mid-hand');

  table.state = saved;
  table.deal({ button: 0 });
  table.call(0);
  table.check(1);
  assert.deepEqual(page.arrive(true), [], 'the table went back');

  table.check(1);
  table.check(0);
  table.wait(60_000);

  const late = page.change();
  assert.equal(late.current, false);
  assert.deepEqual(page.eyes.see(late, 1), [], 'the turn reached a page that had been asleep for a minute');

  assert.deepEqual(page.eyes.asked, [], 'and nothing in flight was touched');
});

test('bets that went to the pot while the viewer was away are not seen going there', () => {
  const table = new TestTable({ stacks: [1000, 1000], config: { allowRunItTwice: true } });
  const page = new Page(table, 1);

  table.deal({ button: 0 });
  page.arrive();
  table.raise(0, 1000);
  page.arrive();

  // The call ends the betting and starts the vote, and reaches a page that slept through it
  table.call(1);
  table.wait(11_000);

  const late = page.change();
  assert.equal(late.current, false);
  assert.equal(late.view.hand!.stage, 'ritVote');
  assert.deepEqual(page.eyes.see(late, 1), []);
});

test('nothing moves on a page out of sight, with the switch off, or on a device that asks for less motion', () => {
  const table = new TestTable({ stacks: [1000, 1000] });
  const page = new Page(table, 1);
  const { eyes } = page;

  page.arrive();
  table.deal({ button: 0 });

  eyes.inView = false;
  assert.deepEqual(page.arrive(), [], 'out of sight');
  eyes.inView = true;

  table.raise(0, 60);
  eyes.prefs.set('motion', false);
  assert.deepEqual(page.arrive(), [], 'switched off');
  eyes.prefs.set('motion', true);

  table.call(1);
  eyes.reduced = true;
  assert.deepEqual(page.arrive(), [], 'less motion');
  assert.equal(motionAbility({ reduced: () => true, inView: () => true }), 'blocked', 'and the switch says it cannot be turned on');
  eyes.reduced = false;
  assert.equal(motionAbility({ reduced: () => false, inView: () => true }), 'yes');

  table.check(1);
  assert.deepEqual(page.arrive(), [], 'a check');
  table.raise(0, 40);
  assert.deepEqual(page.arrive(), ['bet seat0>bet0 @0'], 'and with everything back as a new player has it, the next bet slides');
});

test('a view that moves the hand on ends what the last one set moving before it plays its own', () => {
  const table = new TestTable({ stacks: [1000, 1000] });
  const page = new Page(table, 1);

  page.arrive();
  table.deal({ button: 0 });
  page.arrive();
  table.raise(0, 60);
  page.arrive();

  assert.deepEqual(page.eyes.asked.map((asked) => (asked === 'cancel' ? asked : 'play')), ['cancel', 'play', 'cancel', 'play']);

  // A line of chat moves nothing on the table, and leaves what is in flight alone
  table.cmd(0, { type: 'chat', text: 'call' });
  page.arrive();
  assert.equal(page.eyes.asked.length, 4);
});

test('an event this page does not know moves nothing, and does not stop the rest being seen', () => {
  const unknown = [['bombPot', 3, 40]] as unknown as HandEvent[];

  assert.deepEqual(seen(DEALT, unknown), []);
  assert.deepEqual(seen(DEALT, [...unknown, ['call', 1, 10, 980]]), ['bet seat1>bet1 @0']);
});

test('whatever random play brings, in views of one event or many, stays in budget and moves only what the table draws', () => {
  let views = 0;
  let moved = 0;

  for (let seed = 1; seed <= 12; seed++) {
    const rng = seededRng(seed * 104_729);
    const players = 2 + rng.int(9);
    const table = new TestTable({ stacks: Array.from({ length: players }, () => 200 + rng.int(1800)), seed, config: { allowRunItTwice: true, sevenDeuceBounty: 20, ante: seed % 3 === 0 ? 5 : 0, bombPotAmount: 50, bombPotEvery: seed % 4 === 0 ? 3 : 0 } });
    const page = new Page(table, 0);

    table.cmd(0, { type: 'start' });

    for (let step = 0; step < 400; step++) {
      randomStep(table, rng);

      // Most views bring one thing, and now and then a slow one brings several
      if (chance(rng, 25)) {
        continue;
      }

      const change = page.change();
      const moves = movesSeen(change, change.view.you.seat);
      const { view } = change;

      views += 1;
      moved += moves.length;

      for (const move of moves) {
        const says = `${told(move)} after ${change.events.map((event) => event[0]).join(', ')}`;
        const seat = 'seat' in move.to ? view.seats[move.to.seat] : null;

        assert.ok(move.after + MOVE_MS[move.name] <= MOST_VIEW_MS, `over budget: ${says}`);

        if (move.name === 'bet') {
          assert.ok(seat && seat.bet > 0, `no bet is drawn to slide: ${says}`);
        } else if (move.name === 'deal' || move.name === 'show') {
          assert.ok(seat?.cards, `no cards are drawn there: ${says}`);
        } else if (move.name === 'board' && move.to.at === 'board') {
          assert.ok(move.to.card < (view.hand!.boards[move.to.board]?.length ?? 0), `no card is drawn there: ${says}`);
        } else if (move.name === 'chips') {
          assert.ok(move.amount === undefined || move.amount > 0, `an empty pile: ${says}`);
        }
      }
    }
  }

  assert.ok(views > 2000 && moved > 3000, `${views} views moved ${moved} things`);
});
