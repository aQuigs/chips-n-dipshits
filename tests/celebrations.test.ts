import assert from 'node:assert/strict';
import test from 'node:test';

import { AFTER_SWEAT_MS, BIG_POT_BIG_BLINDS, bigPotsOf, celebrationMoves, confettiMoves, FACE_DOWN_MS, MOST_SWEAT_MS, NEXT_BOARD_MS, sweatOf } from '../src/client/celebrations.ts';
import type { Sweat } from '../src/client/celebrations.ts';
import { CONFETTI_COLORS, CONFETTI_PIECES, confettiBurst } from '../src/client/confetti.ts';
import { movesSeen } from '../src/client/handMoves.ts';
import { Motion, MOVE_MS } from '../src/client/motion.ts';
import type { MotionPlayer, Move } from '../src/client/motion.ts';
import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import { Suspense } from '../src/client/suspense.ts';
import { TableNews } from '../src/client/tableChange.ts';
import type { TableChange } from '../src/client/tableChange.ts';
import { THEMES } from '../src/client/themes.ts';
import { TIMING } from '../src/engine/index.ts';
import type { TableConfig, TableView } from '../src/engine/index.ts';
import { contrast } from './colorVision.ts';
import { ACES, KINGS, mapMemory, QUEENS, TestTable } from './helpers.ts';
import { rules, themeTokens } from './styleRules.ts';

const BIG_BLIND = 20;
const MARK = BIG_POT_BIG_BLINDS * BIG_BLIND;
const TURNING = MOVE_MS.facedown + MOVE_MS.reveal;

/** How long after the view the last of the sweat's cards is face up. */
const lasting = (sweat: Sweat): number => sweat.turns.at(-1)!.at + TURNING;

/** A page at one seat: each view as it comes, on time, turned into the change its effects are handed. */
class Page {
  private shown: TableView | null = null;
  private readonly news = new TableNews();
  private readonly t: TestTable;
  readonly seat: number;

  constructor(t: TestTable, seat: number) {
    this.t = t;
    this.seat = seat;
  }

  change(now = this.t.now, wentBack = false): TableChange {
    const change = this.news.change(this.shown, structuredClone(this.t.view(this.seat)), now, wentBack);

    this.shown = change.view;

    return change;
  }
}

/** A table whose page at seat 1 has seen the deal. */
function dealt(stacks: number[], holes: Record<number, string>, config: Partial<TableConfig> = {}, board = '2c 7d 9h Jc 3s', secondBoard?: string): { t: TestTable; page: Page } {
  const t = new TestTable({ stacks, config });
  const page = new Page(t, 1);

  page.change();
  t.deal({ button: 0, holes, board, secondBoard });
  page.change();

  return { t, page };
}

/** Plays the hand out to its result, a step of the runout at a time, and the change each step brings the page. */
function runOut(t: TestTable, page: Page): TableChange[] {
  const changes: TableChange[] = [page.change()];

  while (t.state.hand && t.state.hand.stage !== 'done') {
    t.wait(t.state.hand.deadline! - t.now);
    changes.push(page.change());
  }

  return changes;
}

/** Heads-up, everyone all in before the flop, each for `stack`: the changes from the call to the result. */
function allInPreflop(stack: number, holes = { 0: ACES, 1: KINGS }, board?: string): TableChange[] {
  const { t, page } = dealt([stack, stack], holes, {}, board);

  t.raise(0, stack);
  t.call(1);

  return runOut(t, page);
}

const sweats = (changes: TableChange[]) => changes.map((change) => sweatOf(change)?.turns.map(({ board, card }) => `${board}.${card}`) ?? null);
const winsIn = (change: TableChange) => change.events.filter((event) => event[0] === 'win').length;

test('a pot is big from the mark on: just under it gets nothing, just at it gets confetti over the winner', () => {
  // All in for half the mark each, so the winner takes it exactly
  const at = allInPreflop(MARK / 2).at(-1)!;
  assert.deepEqual(bigPotsOf(at), [{ seat: 0, amount: MARK }]);

  const confetti = confettiMoves(at, 1);
  assert.deepEqual(confetti.map((move) => [move.name, move.from, move.to]), [['confetti', { at: 'seat', seat: 0 }, { at: 'seat', seat: 0 }]]);

  const under = allInPreflop(MARK / 2 - 10).at(-1)!;
  assert.ok(winsIn(under) > 0);
  assert.deepEqual(bigPotsOf(under), [], 'a pot under the mark got confetti');
  assert.deepEqual(confettiMoves(under, 1), []);
});

test('a split pot is judged by each share, so a pot over the mark split under it gets nothing', () => {
  // The board plays for both
  const board = 'Ac Kc Qc Jc Tc';
  const halves = allInPreflop(MARK, { 0: '2d 3h', 1: '4d 5h' }, board).at(-1)!;
  assert.deepEqual(bigPotsOf(halves).sort((a, b) => a.seat - b.seat), [{ seat: 0, amount: MARK }, { seat: 1, amount: MARK }]);

  const small = allInPreflop(MARK * 0.6, { 0: '2d 3h', 1: '4d 5h' }, board).at(-1)!;
  assert.deepEqual(bigPotsOf(small), [], 'two shares under the mark of a pot over it got confetti');
});

test('with side pots a winner counts every pot they took: the big stack’s side pot gets confetti, the short stack’s main pot does not', () => {
  const short = 300;
  const { t, page } = dealt([short, 1000, 1000], { 0: ACES, 1: KINGS, 2: QUEENS });

  // The button is on seat 0, which acts first with three players
  t.raise(0, short);
  t.raise(1, 1000);
  t.call(2);
  const result = runOut(t, page).at(-1)!;

  assert.deepEqual(bigPotsOf(result), [{ seat: 1, amount: 2 * (1000 - short) }]);
  assert.equal(confettiMoves(result, 1).length, 1);
});

test('a bomb pot’s own chips do not count toward the mark: checked down it gets nothing, played for stacks it does', () => {
  const bomb = 400;
  const config: Partial<TableConfig> = { bombPotAmount: bomb };
  const threeWay = () => {
    const t = new TestTable({ stacks: [1000, 1000, 1000], config });
    const page = new Page(t, 1);

    page.change();
    t.cmd(0, { type: 'setBombPot', on: true });
    t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: QUEENS }, board: '2c 7d 9h Jc 3s' });
    page.change();

    return { t, page };
  };

  // Three bombs make a pot over the mark, which is the bombs and the mark together
  assert.ok(3 * bomb >= MARK);
  let { t, page } = threeWay();
  for (let street = 0; street < 3; street++) {
    for (const seat of [1, 2, 0]) {
      t.check(seat);
    }
  }
  const checked = runOut(t, page).at(-1)!;
  assert.ok(winsIn(checked) > 0);
  assert.deepEqual(bigPotsOf(checked), [], 'a bomb pot checked down got confetti');

  ({ t, page } = threeWay());
  t.raise(1, 1000 - bomb);
  t.fold(2);
  t.call(0);
  const played = runOut(t, page).at(-1)!;
  assert.deepEqual(bigPotsOf(played), [{ seat: 0, amount: 3 * bomb + 2 * (1000 - bomb) }]);
});

test('the sweat is the last card of an all-in runout only, whichever street the money went in on, and never the river of a hand bet to the end', () => {
  // Before the flop: the flop and the turn come as they are, the river is held
  assert.deepEqual(sweats(allInPreflop(1000)), [null, null, null, ['0.4']]);

  // On the flop and on the turn
  for (const streets of [1, 2]) {
    const { t, page } = dealt([1000, 1000], { 0: ACES, 1: KINGS });

    t.call(0);
    t.check(1);
    for (let street = 1; street < streets; street++) {
      t.check(1);
      t.check(0);
    }

    t.raise(1, 1000 - BIG_BLIND);
    t.call(0);
    const changes = runOut(t, page);

    assert.deepEqual(sweats(changes).at(-1), ['0.4'], `all in on street ${streets}`);
    assert.ok(sweats(changes).slice(0, -1).every((sweat) => sweat === null), `all in on street ${streets}: a card before the last was held`);
  }

  // All in on the river leaves no card to come
  const { t, page } = dealt([1000, 1000], { 0: ACES, 1: KINGS });
  t.call(0);
  t.check(1);
  for (let street = 1; street < 4; street++) {
    t.check(1);
    if (street < 3) {
      t.check(0);
    }
  }
  t.raise(0, 1000 - BIG_BLIND);
  t.call(1);
  assert.deepEqual(sweats(runOut(t, page)), [null], 'the river of a hand bet to the end was held');
});

test('a hand that ends with a fold has no sweat', () => {
  const { t, page } = dealt([1000, 1000], { 0: ACES, 1: KINGS });

  t.raise(0, 1000);
  t.fold(1);
  const changes = runOut(t, page);

  assert.ok(winsIn(changes.at(-1)!) > 0);
  assert.deepEqual(sweats(changes), [null]);
});

test('a chop is never taken for an all-in runout, though the big blind is all in for the blind: no sweat while asked or once chopped', () => {
  const { t, page } = dealt([1000, 1000, 20, 1000], {}, { allowChop: true, actionSeconds: 30 });
  t.fold(3);
  t.fold(0);

  t.cmd(1, { type: 'offerChop' });
  const asked = page.change();
  t.cmd(2, { type: 'answerChop', agree: true });
  const chopped = page.change();

  assert.equal(asked.view.hand!.stage, 'chop');
  assert.ok(chopped.view.hand!.result!.chopped);
  assert.deepEqual(sweats([asked, chopped]), [null, null]);
});

test('run twice, each board’s last card is turned in the view that brings it: the first alone, the second with the result after it', () => {
  const { t, page } = dealt([1000, 1000], { 0: ACES, 1: KINGS }, { allowRunItTwice: true }, '2c 7d 9h Jc 3s', 'Kd 4c 5h 8s Td');

  t.raise(0, 1000);
  t.call(1);
  t.cmd(0, { type: 'ritVote', agree: true });
  t.cmd(1, { type: 'ritVote', agree: true });
  const changes = runOut(t, page);
  const held = changes.map((change) => sweatOf(change));

  assert.deepEqual(sweats(changes).filter((sweat) => sweat !== null), [['0.4'], ['1.4']]);

  const first = changes[held.findIndex((sweat) => sweat !== null)]!;
  assert.equal(sweatOf(first)!.upTo, first.events.length, 'something came after the first board’s last card');

  const last = changes.at(-1)!;
  const sweat = sweatOf(last)!;
  assert.ok(winsIn(last) > 0 && last.events.slice(0, sweat.upTo).every((event) => event[0] !== 'win'), 'the result is not held until the second board’s card is up');
});

test('on two boards from the deal both last cards come in one view and are turned one after the other, in under two seconds', () => {
  const t = new TestTable({ stacks: [1000, 1000], config: { bombPotBoards: 'two', bombPotAmount: 100 } });
  const page = new Page(t, 1);

  page.change();
  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: '2c 7d 9h Jc 3s', secondBoard: 'Kd 4c 5h 8s Td' });
  page.change();
  t.raise(1, 900);
  t.call(0);

  const last = runOut(t, page).at(-1)!;
  const sweat = sweatOf(last)!;

  assert.deepEqual(sweat.turns, [
    { board: 0, card: 4, at: FACE_DOWN_MS },
    { board: 1, card: 4, at: FACE_DOWN_MS + NEXT_BOARD_MS },
  ]);
  assert.equal(lasting(sweat), FACE_DOWN_MS + NEXT_BOARD_MS + TURNING);
  assert.ok(lasting(sweat) <= MOST_SWEAT_MS);
  assert.deepEqual(last.events.slice(0, sweat.upTo).map((event) => event[0]), ['street', 'street']);

  // Each card lies face down until its turn, and its face comes as the back goes
  assert.deepEqual(
    celebrationMoves(last, 1).filter((move) => move.name !== 'confetti').map((move) => [move.name, move.to, move.after]),
    sweat.turns.flatMap(({ board, card, at }) => [
      ['facedown', { at: 'board', board, card }, at],
      ['reveal', { at: 'board', board, card }, at + MOVE_MS.facedown],
    ]),
  );
});

test('nothing is celebrated on the first view, a late view or a table that went back', () => {
  const changes = allInPreflop(1000);
  const result = changes.at(-1)!;
  assert.ok(celebrationMoves(result, 1).length > 0);

  const { view } = result;
  const news = new TableNews();
  const first = news.change(null, view, view.now);
  const late = new TableNews().change(changes.at(-2)!.view, view, view.now + 11_000);
  const back = new TableNews().change(changes.at(-2)!.view, view, view.now, true);

  for (const [what, change] of [['first view', first], ['late view', late], ['went back', back]] as const) {
    assert.deepEqual(celebrationMoves(change, 1), [], what);
    assert.equal(sweatOf(change), null, what);
  }
});

test('the viewer’s own big pot and someone else’s are celebrated alike', () => {
  const result = allInPreflop(1000).at(-1)!;
  const kinds = (moves: Move[]) => moves.map((move) => [move.name, move.from, move.to, move.seed]);

  assert.deepEqual(kinds(celebrationMoves(result, 0)), kinds(celebrationMoves(result, 1)));
});

test('confetti is thrown as the winner’s pile lands, from the seed of the hand and the seat, so a check sees the same burst every run', () => {
  const result = allInPreflop(1000).at(-1)!;
  const pile = movesSeen(result, 1).find((move) => move.name === 'chips' && move.from?.at === 'pot')!;
  const [confetti] = confettiMoves(result, 1);

  assert.ok(confetti!.after > pile.after && confetti!.after < pile.after + MOVE_MS.chips, 'thrown before or after the pile lands');
  assert.deepEqual(confettiMoves(allInPreflop(1000).at(-1)!, 1), [confetti]);

  const burst = confettiBurst(confetti!.seed!);
  assert.equal(burst.length, CONFETTI_PIECES);
  assert.deepEqual(confettiBurst(confetti!.seed!), burst);
  assert.notDeepEqual(confettiBurst(confetti!.seed! + 1), burst);

  for (const piece of burst) {
    assert.ok(Math.abs(piece.angle) <= 70 && piece.reach > 0 && piece.reach <= 0.5, `a piece thrown off the table: ${JSON.stringify(piece)}`);
    assert.ok(Number.isInteger(piece.color) && piece.color >= 0 && piece.color < CONFETTI_COLORS);
  }

  // A burst is over a little after a second, whatever the seed
  assert.ok(Math.max(...burst.map((piece) => piece.after)) + MOVE_MS.confetti <= 1300);
});

test('every color of confetti stands out from every color of every theme’s felt', () => {
  const pieces = rules('celebrations.css');

  for (const theme of THEMES) {
    const tokens = themeTokens(theme.id);
    const resolve = (value: string): string => value.replace(/var\((--[\w-]+)\)/g, (_all, name: string) => resolve(tokens.get(name) ?? assert.fail(`${name} is not set`)));
    const felt = [...resolve(tokens.get('--felt')!).matchAll(/#[0-9a-f]{6}/gi)].map(([color]) => color);

    for (let color = 0; color < CONFETTI_COLORS; color++) {
      const piece = resolve(pieces.get(`.confetti.c${color}`)?.get('background') ?? assert.fail(`confetti color ${color} is not set`));

      for (const ground of felt) {
        // The least a small bright shape needs to stand apart from what is behind it at a glance
        assert.ok(contrast(piece, ground) >= 2, `${theme.name}: confetti ${piece} on felt ${ground} is only ${contrast(piece, ground).toFixed(2)}:1`);
      }
    }
  }
});

test('the hold fits the pause before the next hand at its shortest, and shrinks to fit a shorter one or is left out', () => {
  // The shortest pause a hand that was run out is left on
  const shortest = Math.min(TIMING.showdownPauseMs, TIMING.runTwicePauseMs);
  assert.ok(MOST_SWEAT_MS + AFTER_SWEAT_MS <= shortest);

  const result = allInPreflop(1000).at(-1)!;
  const hand = result.view.hand!;
  const sweat = sweatOf(result)!;
  assert.equal(hand.deadline! - result.view.now, TIMING.showdownPauseMs);
  assert.ok(lasting(sweat) + AFTER_SWEAT_MS <= hand.deadline! - result.view.now);

  const leaving = (pause: number): Sweat | null => sweatOf({ ...result, view: { ...result.view, hand: { ...hand, deadline: result.view.now + pause } } });

  const shrunk = leaving(AFTER_SWEAT_MS + 800)!;
  assert.ok(lasting(shrunk) <= 800 && shrunk.turns[0]!.at < FACE_DOWN_MS, `a hold of ${lasting(shrunk)} ms in a pause that leaves 800`);
  assert.equal(leaving(AFTER_SWEAT_MS + TURNING + 100), null, 'a hold with no beat in it');

  // A view that was slow to reach the page has that much less of the pause left
  const slow = sweatOf({ ...result, now: result.view.now + TIMING.showdownPauseMs - AFTER_SWEAT_MS - 800 })!;
  assert.ok(lasting(slow) <= 800, `a hold of ${lasting(slow)} ms for a view that came with 800 ms of room`);
});

/** A stand-in for the page's motion: it writes down what is played, and says the table is still when told to. */
class Moves implements MotionPlayer {
  readonly played: Move[][] = [];
  private still: (() => void)[] = [];

  play(moves: readonly Move[]): void {
    this.played.push([...moves]);
  }

  cancel(): void {
    this.land();
  }

  idle(): Promise<void> {
    return new Promise((resolve) => this.still.push(resolve));
  }

  seen(): boolean {
    return true;
  }

  dispose(): void {}

  /** Everything in flight lands. */
  land(): void {
    this.still.splice(0).forEach((resolve) => resolve());
  }
}

/** A page with its motion and its hold, as `App` puts them together: each view held back as the hold says, its effects told, then played. */
function holdingPage(prefs: Record<string, string> = {}, reduced = false) {
  const moves = new Moves();
  const motion = new Motion(moves, new Preferences(PREFERENCES, mapMemory(prefs)), { reduced: () => reduced, inView: () => true });
  const told: TableChange[] = [];
  // As the celebrations effect does, for the page at seat 1
  const tell = (change: TableChange) => {
    told.push(change);
    motion.play(celebrationMoves(change, 1));
  };
  const suspense = new Suspense(motion, tell);

  return {
    moves,
    told,
    suspense,
    show(change: TableChange): void {
      tell(suspense.see(change));
      suspense.played();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const names = (moves: Move[][]) => moves.flat().map((move) => move.name);

test('the result is held until the last card is up: the felt and the feed are held, the result is told once the table is still', async () => {
  const changes = allInPreflop(1000);
  const result = changes.at(-1)!;
  const page = holdingPage();

  page.show(result);

  const sweat = sweatOf(result)!;
  const shown = page.suspense.shown(result.view);
  assert.deepEqual(page.suspense.turning, [{ board: 0, card: 4 }]);
  assert.deepEqual(shown.hand!.holding, changes.at(-2)!.view.hand!.holding, 'the hint is not what the viewer held before the river');
  assert.deepEqual(shown.feed, result.view.feed.filter((entry) => entry.seq < result.feed[0]!.seq), 'the river’s line is not held');
  assert.deepEqual(page.told[0]!.events, result.events.slice(0, sweat.upTo));
  assert.deepEqual(page.told[0]!.view.hand!.events.slice(-sweat.upTo), page.told[0]!.events, 'the view told with the cards goes on past them');
  assert.deepEqual(page.told[0]!.feed, []);
  assert.deepEqual(names(page.moves.played), ['facedown', 'reveal']);

  page.moves.land();
  await settle();

  assert.deepEqual(page.suspense.turning, []);
  const later = page.told[1]!;
  assert.deepEqual(later.events, result.events.slice(sweat.upTo));
  assert.deepEqual(later.feed, result.feed);
  assert.ok(winsIn(later) > 0);
  assert.deepEqual(names(page.moves.played.slice(1)), ['confetti']);
});

test('a view with news of the hand ends the hold at once and the held result is never told; one with none keeps it', async () => {
  const { t, page: seat } = dealt([1000, 1000], { 0: ACES, 1: KINGS });
  t.raise(0, 1000);
  t.call(1);
  const changes = runOut(t, seat);
  const page = holdingPage();

  page.show(changes.at(-1)!);
  assert.ok(page.suspense.turning.length > 0);

  // Nothing new: someone says something
  t.cmd(0, { type: 'chat', text: 'come on' });
  page.show(seat.change());
  assert.ok(page.suspense.turning.length > 0, 'a line of chat ended the hold');

  // The next hand is dealt
  t.wait(t.state.hand!.deadline! - t.now);
  page.show(seat.change());
  assert.deepEqual(page.suspense.turning, []);

  page.moves.land();
  await settle();
  assert.ok(page.told.every((change) => winsIn(change) === 0), 'the held result was told after the hand moved on');
});

test('more of the same hand during the hold, as a player showing their cards, ends it and is told after what was held', () => {
  const { t, page: seat } = dealt([1000, 1000, 1000], { 0: ACES, 1: KINGS, 2: QUEENS });
  t.fold(0);
  t.raise(1, 1000);
  t.call(2);
  const result = runOut(t, seat).at(-1)!;
  const page = holdingPage();

  page.show(result);
  const held = page.told[0]!.events.length;

  t.cmd(0, { type: 'showCards' });
  const shown = seat.change();
  page.show(shown);

  assert.deepEqual(page.suspense.turning, []);
  assert.deepEqual(page.told[1]!.events, [...result.events.slice(held), ...shown.events]);
  assert.deepEqual(page.told[1]!.view.hand!.events.slice(-page.told[1]!.events.length), page.told[1]!.events, 'what is told is not the last of the hand’s events');
  assert.deepEqual(page.told[1]!.feed, [...result.feed, ...shown.feed]);
});

test('while held the whole page is drawn from the hand as it stood: no result, nobody offered to show, the stacks, the ledger, the night’s numbers and the hint as before the river', async () => {
  const { t, page: seat } = dealt([1000, 1000, 1000], { 0: ACES, 1: KINGS, 2: QUEENS });
  t.fold(0);
  t.raise(1, 1000);
  t.call(2);
  const changes = runOut(t, seat);
  const [turn, result] = changes.slice(-2) as [TableChange, TableChange];
  const page = holdingPage();

  page.show(result);
  const shown = page.suspense.shown(result.view);

  assert.deepEqual([shown.hand!.stage, shown.hand!.result, shown.hand!.canShow], ['runout', null, false]);
  assert.deepEqual(shown.seats.map((seat) => seat?.stack), turn.view.seats.map((seat) => seat?.stack));
  assert.deepEqual(shown.ledger, turn.view.ledger);
  assert.deepEqual(shown.tonight, turn.view.tonight);
  assert.deepEqual([shown.tonight.upMost, result.view.tonight.upMost], [[], [t.ids[1]]], 'the night’s numbers name the winner while the result is held');
  assert.deepEqual(shown.hand!.holding, turn.view.hand!.holding);
  assert.deepEqual(shown.hand!.boards, result.view.hand!.boards, 'the river is not drawn, for its turn to show');

  page.moves.land();
  await settle();
  assert.equal(page.suspense.shown(result.view), result.view);
});

test('a night that ends on an all-in runout is told to be over only once nothing is held: its end comes in a view with no hand, which ends the hold before any of it is told', async () => {
  const lastHand = () => {
    const { t, page: seat } = dealt([1000, 1000], { 0: ACES, 1: KINGS });
    t.cmd(0, { type: 'setLastHands', hands: 0 });
    t.raise(0, 1000);
    t.call(1);

    const result = runOut(t, seat).at(-1)!;
    const page = holdingPage();
    page.show(result);
    assert.ok(page.suspense.turning.length > 0);

    return { t, seat, page };
  };

  const over = ({ t, seat, page }: ReturnType<typeof lastHand>) => {
    t.wait(t.state.hand!.deadline! - t.now);
    const change = seat.change();
    page.show(change);

    assert.equal(change.nightEnded, true);
    assert.deepEqual(page.suspense.turning, []);
    assert.equal(page.suspense.shown(change.view), change.view, 'the night’s end is drawn from a held view');
    assert.equal(page.told.at(-1), change);
  };

  // The card comes up and the result is told with the night still going; the hand is cleared after that, and the night ends
  const inTime = lastHand();
  inTime.page.moves.land();
  await settle();
  assert.deepEqual(inTime.page.told.map((change) => [winsIn(change) > 0, change.nightEnded, change.view.nightEndedAt]), [[false, false, null], [true, false, null]]);
  over(inTime);

  // The hand is cleared with the card still down, as on a page that stalled: the hold ends there, untold
  const stalled = lastHand();
  over(stalled);
  stalled.page.moves.land();
  await settle();
  assert.equal(stalled.page.told.length, 2, 'the held result was told after the night ended');
});

test('with animations off, or on a device that asks for less motion, nothing is held and nothing is celebrated', () => {
  const result = allInPreflop(1000).at(-1)!;

  for (const page of [holdingPage({ 'cnd.motion': 'off' }), holdingPage({}, true)]) {
    page.show(result);

    assert.deepEqual(page.suspense.turning, []);
    assert.deepEqual(page.told, [result], 'the view was not told whole at once');
    assert.deepEqual(page.moves.played, []);
  }
});

test('badges are earned once the hand is cleared, so none is drawn or told while the last card is down, and a badge that came with a held result would wait for it', async () => {
  // Heads-up for 1000 each: the aces take every chip of a pot of 100 big blinds
  const badgesShown = (view: TableView) => view.tonight.players.flatMap((row) => row.badges.map((badge) => badge.id));
  const changes = allInPreflop(1000);
  const result = changes.at(-1)!;
  const page = holdingPage();

  page.show(result);
  assert.ok(page.suspense.turning.length > 0);
  assert.deepEqual(badgesShown(page.suspense.shown(result.view)), []);
  assert.deepEqual(page.told[0]!.earned, []);

  // As though the result had brought one: it is told with the result, once the card is up
  const fake = { id: 'felted', times: 1 };
  const withBadge = holdingPage();
  withBadge.show({ ...result, earned: [fake] });
  assert.deepEqual(withBadge.told[0]!.earned, []);
  withBadge.moves.land();
  await settle();
  assert.deepEqual(withBadge.told[1]!.earned, [fake]);

  // A hold that ends untold, on a view that came late, still tells the badges it held: they were told nowhere else
  const cutShort = holdingPage();
  cutShort.show({ ...result, earned: [fake] });
  cutShort.show({ ...result, current: false, events: [], feed: [], earned: [] });
  assert.deepEqual(cutShort.told.map((change) => change.earned), [[], [fake]]);
});

test('the badges of a hand are told by the view that clears it, which ends any hold first, to the page that saw the card turned and to one still waiting on it', async () => {
  const played = async (stalled: boolean) => {
    // The page is the winner's: seat 1 calls with aces
    const { t, page: seat } = dealt([1000, 1000], { 0: KINGS, 1: ACES });
    t.raise(0, 1000);
    t.call(1);

    const page = holdingPage();
    page.show(runOut(t, seat).at(-1)!);

    if (!stalled) {
      page.moves.land();
      await settle();
    }

    t.wait(t.state.hand!.deadline! - t.now);
    const cleared = seat.change();
    page.show(cleared);

    assert.deepEqual(page.suspense.turning, []);
    assert.equal(page.suspense.shown(cleared.view), cleared.view);
    assert.deepEqual(page.told.at(-1)!.earned, [{ id: 'bigPot', times: 1 }, { id: 'felted', times: 1 }]);

    page.moves.land();
    await settle();
    assert.equal(page.told.flatMap((change) => change.earned).length, 2, 'told twice');
  };

  await played(false);
  await played(true);
});
