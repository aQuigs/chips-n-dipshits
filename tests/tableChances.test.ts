import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Move } from '../src/client/motion.ts';
import { SLICE_MS, spotsOf, TableChances } from '../src/client/tableChances.ts';
import type { TableSpots } from '../src/client/tableChances.ts';
import { addMember, chanceFigures, chancesOf, SAMPLED_BOARDS } from '../src/engine/index.ts';
import type { TableView } from '../src/engine/index.ts';
import { ACES, BOARD, cards, KINGS, QUEENS, TestTable } from './helpers.ts';

const SECOND = 'Kd 4c 5h 8s Td';

/** Seats 0 and 1 all in before the flop with aces and kings, seat 2 folded with queens, and someone watching. */
function allInBeforeTheFlop(config = {}): { t: TestTable; watcher: number } {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config });
  const watcher = t.ids.push(addMember(t.state, 'Kibitz', t.ctx()).id) - 1;

  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD, secondBoard: SECOND });
  t.raise(0, 1000);
  t.call(1);
  t.fold(2);

  return { t, watcher };
}

/** Deals the next street of a runout. */
const nextStreet = (t: TestTable) => t.wait(t.state.hand!.deadline! - t.now);

const everyCardOf = (spots: TableSpots) => spots.boards.flatMap((spot) => [...spot.hands.flat(), ...spot.board, ...spot.dead]);

test('a spot is made of what the whole table sees: the same for a player in the hand, one who folded and someone watching', () => {
  const { t, watcher } = allInBeforeTheFlop();

  nextStreet(t);
  assert.deepEqual([t.state.hand!.stage, t.state.hand!.boards], ['runout', [cards('2c 7d 9h')]]);

  const wanted: TableSpots = { seats: [0, 1], boards: [{ hands: [cards(ACES), cards(KINGS)], board: cards('2c 7d 9h'), dead: [] }] };

  for (const viewer of [0, 1, 2, watcher]) {
    assert.deepEqual(spotsOf(t.view(viewer)), wanted, `as seen by ${viewer}`);
  }

  // The player who folded still has their own cards before them, which nobody else can see: they are no part of it
  const folded = t.view(2);
  assert.deepEqual(folded.seats[2]!.cards, cards(QUEENS));
  assert.equal(folded.seats[2]!.shown, false);
  assert.ok(!everyCardOf(spotsOf(folded)!).some((card) => cards(QUEENS).includes(card)));

  // And nothing in it is face down for anyone: every card is on the board or in a hand turned up for the table
  const faceUp = [...t.state.hand!.boards.flat(), ...t.state.hand!.players.filter((player) => player.shown).flatMap((player) => player.cards)];
  assert.ok(everyCardOf(spotsOf(folded)!).every((card) => faceUp.includes(card)));
});

test('there are spots from the moment hands are turned up with cards to come, a vote on running it twice included, and none once the result is in', () => {
  const { t } = allInBeforeTheFlop({ allowRunItTwice: true });

  assert.equal(t.state.hand!.stage, 'ritVote');
  assert.deepEqual(spotsOf(t.view(2))!.boards, [{ hands: [cards(ACES), cards(KINGS)], board: [], dead: [] }]);

  t.runToResult();
  assert.equal(spotsOf(t.view(2)), null);

  // While there is still betting, nothing is face up
  const betting = new TestTable({ stacks: [1000, 1000] });
  betting.deal({ button: 0 });
  assert.equal(spotsOf(betting.view(0)), null);

  // Nor while the blinds settle a chop, or once they have: nobody is all in, and the board has no card and gets none
  const chop = new TestTable({ stacks: [1000, 1000, 1000], config: { allowChop: true } });
  chop.deal({ button: 0 });
  chop.fold(0);
  chop.cmd(1, { type: 'offerChop' });
  assert.deepEqual([chop.state.hand!.stage, spotsOf(chop.view(1))], ['chop', null]);

  chop.cmd(2, { type: 'answerChop', agree: true });
  assert.deepEqual([chop.view(1).hand!.result!.chopped, chop.view(1).hand!.boards, spotsOf(chop.view(1))], [[1, 2], [[]], null]);
});

test('a hand still in that the table cannot see leaves no spot at all, and neither does one hand alone', () => {
  const { t } = allInBeforeTheFlop();
  const view = t.view(0);
  const hidden: TableView = { ...view, seats: view.seats.map((seat) => (seat?.seat === 1 ? { ...seat, shown: false, cards: [null, null] } : seat)) };

  assert.equal(spotsOf(hidden), null);

  // Face up for this viewer alone is not face up
  const mine: TableView = { ...view, seats: view.seats.map((seat) => (seat?.seat === 0 ? { ...seat, shown: false } : seat)) };
  assert.equal(spotsOf(mine), null);
});

test('a hand run twice: the second board starts from the cards the two share, with the rest of the first out of its deck', () => {
  const { t } = allInBeforeTheFlop({ allowRunItTwice: true });
  const hands = [cards(ACES), cards(KINGS)];

  t.cmd(0, { type: 'ritVote', agree: true });
  t.cmd(1, { type: 'ritVote', agree: true });
  assert.deepEqual([t.state.hand!.stage, t.state.hand!.runs], ['runout', 2]);

  // While the first board is dealt there is no second on the table
  nextStreet(t);
  assert.deepEqual(spotsOf(t.view(2))!.boards, [{ hands, board: cards('2c 7d 9h'), dead: [] }]);

  nextStreet(t);
  nextStreet(t);
  assert.deepEqual(spotsOf(t.view(2))!.boards, [
    { hands, board: cards(BOARD), dead: [] },
    { hands, board: [], dead: cards(BOARD) },
  ]);

  nextStreet(t);
  assert.deepEqual(spotsOf(t.view(2))!.boards, [
    { hands, board: cards(BOARD), dead: cards('Kd 4c 5h') },
    { hands, board: cards('Kd 4c 5h'), dead: cards(BOARD) },
  ]);
});

test('run twice from the flop: the flop is on both boards and out of the deck once', () => {
  const t = new TestTable({ stacks: [1000, 1000], config: { allowRunItTwice: true } });

  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: BOARD, secondBoard: '8s Td' });
  t.call(0);
  t.check(1);
  t.raise(1, 980);
  t.call(0);
  t.cmd(0, { type: 'ritVote', agree: true });
  t.cmd(1, { type: 'ritVote', agree: true });
  nextStreet(t);
  nextStreet(t);

  const hands = [cards(ACES), cards(KINGS)];
  const spots = spotsOf(t.view(0))!;

  assert.deepEqual(spots.boards, [
    { hands, board: cards(BOARD), dead: [] },
    { hands, board: cards('2c 7d 9h'), dead: cards('Jc 3s') },
  ]);

  // Each is a spot the engine takes: no card is named twice
  spots.boards.forEach((spot) => chancesOf(spot));
});

test('two boards dealt together: each is a spot, with the other’s cards out of its deck', () => {
  const t = new TestTable({ stacks: [100, 100, 1000], config: { bombPotBoards: 'two' } });

  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD, secondBoard: SECOND });

  // Two of the three are all in on the bomb pot, so the hands are turned up on the flop
  const hands = [cards(ACES), cards(KINGS), cards(QUEENS)];
  assert.equal(t.state.hand!.stage, 'runout');
  assert.deepEqual(spotsOf(t.view(1)), {
    seats: [0, 1, 2],
    boards: [
      { hands, board: cards('2c 7d 9h'), dead: cards('Kd 4c 5h') },
      { hands, board: cards('Kd 4c 5h'), dead: cards('2c 7d 9h') },
    ],
  });
});

test('a board card the page still has face down counts for nothing: not on its own board, and not as out of another’s deck', () => {
  const t = new TestTable({ stacks: [100, 100, 1000], config: { bombPotBoards: 'two' } });

  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: BOARD, secondBoard: SECOND });
  nextStreet(t);

  const turn = spotsOf(t.view(1));

  nextStreet(t);

  // The river of both boards lies face down: the table reads as it did on the turn
  const river = t.view(1);
  assert.equal(river.hand!.boards[0]!.length, 5);
  assert.deepEqual(spotsOf({ ...river, hand: { ...river.hand!, stage: 'runout' } }, [{ board: 0, card: 4 }, { board: 1, card: 4 }]), turn);

  // With the first turned over and the second not, the first board is complete and the second has one card more out of its deck
  const half = spotsOf({ ...river, hand: { ...river.hand!, stage: 'runout' } }, [{ board: 1, card: 4 }])!;
  assert.deepEqual([half.boards[0]!.board, half.boards[0]!.dead], [cards(BOARD), cards('Kd 4c 5h 8s')]);
  assert.deepEqual([half.boards[1]!.board, half.boards[1]!.dead], [cards('Kd 4c 5h 8s'), cards(BOARD)]);
});

/** A page's motion and clock, moved by the test: what `TableChances` waits on. */
class Still {
  readonly moved: Move[] = [];
  /** How long each look at the clock takes, which is how long a step of the work is taken to be. */
  stepMs = 0;
  /** How many times the clock was looked at: once to begin a slice, and once after each step of it. */
  looks = 0;
  readonly later: (() => void)[] = [];
  drawn = 0;
  private clock = 0;
  private landing: (() => void)[] = [];
  readonly chances: TableChances;

  constructor() {
    const motion = {
      play: (moves: readonly Move[]) => void this.moved.push(...moves),
      cancel: () => undefined,
      idle: () => new Promise<void>((resolve) => void this.landing.push(resolve)),
      seen: () => true,
    };
    const pace = {
      now: () => {
        this.looks += 1;

        return (this.clock += this.stepMs);
      },
      later: (run: () => void) => void this.later.push(run),
    };

    this.chances = new TableChances(motion, pace, () => (this.drawn += 1));
  }

  /** The table shows these spots, and whatever that set moving is on its way. */
  show(spots: TableSpots | null): void {
    this.chances.follow(spots);
    this.chances.played();
  }

  /** Everything that was moving has landed. */
  async land(): Promise<void> {
    this.landing.splice(0).forEach((landed) => landed());
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** The page gets round to what it put off, until nothing is left. Gives back how many steps each slice of the work took. */
  catchUp(): number[] {
    const steps: number[] = [];

    while (this.later.length > 0) {
      const looks = this.looks;

      this.later.shift()!();
      steps.push(this.looks - looks - 1);
    }

    return steps;
  }

  get texts(): (string[] | null)[] | null {
    return this.chances.shown?.boards.map((board) => board?.map((figure) => figure.text) ?? null) ?? null;
  }
}

const HANDS = [cards(ACES), cards(KINGS)];
const FLOP: TableSpots = { seats: [0, 1], boards: [{ hands: HANDS, board: cards('2c 7d 9h'), dead: [] }] };
const TURN: TableSpots = { seats: [0, 1], boards: [{ hands: HANDS, board: cards('2c 7d 9h Jc'), dead: [] }] };
const textsOf = (spots: TableSpots) => spots.boards.map((spot) => chanceFigures(chancesOf(spot)).map((figure) => figure.text));

test('figures show once the table is still, and until a card has landed the hands read as they did before it', async () => {
  const page = new Still();

  page.show(FLOP);
  assert.deepEqual([page.texts, page.chances.pending], [[null], true], 'hands just turned up have no figure before they are seen');

  await page.land();
  assert.deepEqual([page.texts, page.chances.pending], [textsOf(FLOP), false]);
  assert.deepEqual(page.texts, [['92', '8']]);

  // The turn is on the table and on its way down: the figures are the flop's until it lands
  page.show(TURN);
  assert.deepEqual([page.texts, page.chances.pending], [textsOf(FLOP), true]);

  await page.land();
  assert.deepEqual([page.texts, page.chances.pending], [textsOf(TURN), false]);
  assert.deepEqual(page.texts, [['95', '5']]);

  // The result is in: no hands are against each other any more
  page.show(null);
  assert.deepEqual([page.chances.shown, page.chances.pending], [null, false]);
});

test('a table that moved on before it was still never shows what it passed', async () => {
  const page = new Still();

  page.show(FLOP);
  page.show(TURN);
  await page.land();

  assert.deepEqual(page.texts, textsOf(TURN));
  assert.equal(page.drawn, 1, 'the page is drawn again once, for the turn');
});

test('a spot is worked out once, however often the table is drawn or polled with it', async () => {
  const page = new Still();

  page.show(FLOP);
  await page.land();

  const looks = page.looks;
  const drawn = page.drawn;

  for (let poll = 0; poll < 5; poll++) {
    page.show({ seats: [...FLOP.seats], boards: FLOP.boards.map((spot) => ({ ...spot })) });
    await page.land();
  }

  assert.deepEqual([page.looks, page.drawn], [looks, drawn], 'the same spots again cost nothing and draw nothing');

  // Back on a spot it had, as when a river held face down leaves the table reading as on the turn
  page.show(TURN);
  await page.land();
  const afterTurn = page.looks;

  page.show(FLOP);
  await page.land();
  assert.deepEqual(page.texts, textsOf(FLOP));
  assert.equal(page.looks - afterTurn, 1, 'a spot worked out for these hands is not worked out again: one look at the clock, and nothing to do');
});

test('the work is done in slices no longer than a tap can wait, and the hands say so until it is done', async () => {
  const page = new Still();
  const before: TableSpots = { seats: [0, 1], boards: [{ hands: HANDS, board: [], dead: [] }] };

  // Every board of the sample takes a millisecond
  page.stepMs = 1;
  page.show(before);

  assert.equal(page.looks, SLICE_MS + 1, 'the first slice stops when its time is up');
  assert.equal(page.later.length, 1, 'and the rest is put off');

  await page.land();
  assert.deepEqual([page.texts, page.chances.pending], [[null], true], 'still, and not worked out yet: nothing is shown for the board');

  const slices = page.catchUp();
  assert.ok(slices.every((steps) => steps <= SLICE_MS), 'no slice goes on after its time is up');
  assert.ok(SLICE_MS + slices.reduce((sum, steps) => sum + steps, 0) >= SAMPLED_BOARDS, 'and between them they deal every board of the sample');

  // Worked out, and written the next time nothing on the table is moving, so that drawing it cuts no move short
  assert.deepEqual([page.texts, page.chances.pending, page.drawn], [[null], true, 1]);
  await page.land();
  assert.deepEqual([page.texts, page.chances.pending], [textsOf(before), false]);
  assert.deepEqual(page.texts, [['~83', '~17']]);
});

test('a spot the table stopped showing is dropped where it was, and the one it shows now is worked out', async () => {
  const page = new Still();
  const before: TableSpots = { seats: [0, 1], boards: [{ hands: HANDS, board: [], dead: [] }] };

  page.stepMs = 1;
  page.show(before);
  await page.land();
  page.later.shift()!();

  // The flop comes before the estimate is done
  page.stepMs = 0;
  page.show(FLOP);
  assert.equal(page.texts![0], null, 'the hands have shown nothing yet, and show nothing of a spot that is gone');

  await page.land();
  assert.deepEqual(page.texts, textsOf(FLOP));

  const looks = page.looks;
  page.catchUp();
  assert.ok(page.looks - looks <= 2, 'nothing more is done for the spot before the flop');
});

test('two boards are worked out one after the other, and each shows when it is ready', async () => {
  const page = new Still();
  const second = { hands: HANDS, board: [], dead: cards(BOARD) };
  const twice: TableSpots = { seats: [0, 1], boards: [{ hands: HANDS, board: cards(BOARD), dead: [] }, second] };

  page.show({ seats: [0, 1], boards: [{ hands: HANDS, board: cards('2c 7d 9h Jc'), dead: [] }] });
  await page.land();

  // The first board's last card, and the second board laid beside it
  page.stepMs = 1;
  page.show(twice);
  await page.land();
  assert.deepEqual([page.texts, page.chances.pending], [[['100', '0'], null], true], 'the board that is won reads so while the other is worked out');

  page.catchUp();
  await page.land();
  assert.deepEqual([page.texts, page.chances.pending], [[['100', '0'], textsOf({ seats: [0, 1], boards: [second] })[0]], false]);
});

test('other hands start from nothing: no figure of the last ones is carried over', async () => {
  const page = new Still();

  page.show(FLOP);
  await page.land();

  page.show({ seats: [3, 5], boards: [{ hands: [cards('Qs Qh'), cards('Jd Jc')], board: cards('2c 7d 9h'), dead: [] }] });
  assert.deepEqual([page.chances.shown, page.chances.pending], [{ seats: [3, 5], boards: [null] }, true]);
});

test('a spot that cannot be worked out leaves the seats without chances and holds nothing up', async () => {
  const page = new Still();
  const complained: unknown[] = [];
  const error = console.error;

  console.error = (...said) => void complained.push(said);

  try {
    page.show({ seats: [0, 1], boards: [{ hands: [cards('As Ah'), cards('As Kh')], board: [], dead: [] }] });
    await page.land();
  } finally {
    console.error = error;
  }

  assert.equal(complained.length, 1);
  assert.deepEqual([page.chances.shown, page.chances.pending], [null, false], 'no figure, and no mark of one still to come');
});

test('with two boards, one that cannot be worked out takes the other’s figures off as well', async () => {
  const page = new Still();
  const complained: unknown[] = [];
  const error = console.error;

  console.error = (...said) => void complained.push(said);

  try {
    // The second board names a card the hands hold
    page.show({ seats: [0, 1], boards: [{ hands: HANDS, board: cards(BOARD), dead: [] }, { hands: HANDS, board: cards('As 4c 5h'), dead: [] }] });
    await page.land();
  } finally {
    console.error = error;
  }

  assert.equal(complained.length, 1);
  assert.deepEqual([page.chances.shown, page.chances.pending], [null, false]);
});

test('every page at a table shows the same figures: what a player, a player who folded and a watcher work out is one answer', () => {
  const { t, watcher } = allInBeforeTheFlop();
  const read = (viewer: number) => textsOf(spotsOf(t.view(viewer))!);

  // Before the flop, where the figures are an estimate, and on each street after
  const streets: (string[] | undefined)[] = [];

  for (let street = 0; street < 3; street++) {
    assert.deepEqual([read(1), read(2), read(watcher)], [read(0), read(0), read(0)]);
    streets.push(read(watcher)[0]);
    nextStreet(t);
  }

  assert.deepEqual(streets, [['~83', '~17'], ['92', '8'], ['95', '5']]);
});
