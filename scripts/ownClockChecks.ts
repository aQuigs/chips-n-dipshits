/*
 * The checks of the viewer's own clock beside the buttons of their turn: that it is there to be read,
 * that a second going by moves and draws nothing, that it warns at the second the page already warns
 * a screen reader at, and that a turn's buttons lie where they do at a table with no clock. They run
 * with the other browser checks (`screenChecks.ts`).
 */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import type { Page } from 'playwright';

import { clockText } from '../src/client/actionClock.ts';
import { BUZZ_PATTERN } from '../src/client/attentionWays.ts';
import type { TableConfig } from '../src/engine/index.ts';
import { heard, SPOKEN, spoken } from './a11y.ts';
import type { Check } from './checkRunner.ts';
import { NEXT_FRAME, TEXT_SIZES } from './layoutSweep.ts';
import { BUZZ } from './pageSpies.ts';
import { overlap, SCREENS } from './rig.ts';
import type { Box, Rig, RigTable, ScreenName } from './rig.ts';

const VIEWER = 'Quigs';
const LYING = { width: 740, height: 360 };

// The buttons that play a move or answer the turn's question, by their action
const MOVES = ['fold', 'offer-chop', 'check', 'call', 'raise', 'chop-no', 'chop-yes'];
const SLIDER = 'raise-slider';

// The least a slider keeps of its width where a clock stands before it: its thumb still has somewhere to go
const SLIDER_KEEPS = 32;

// How much taller a second line of words makes a move at the largest text
const LINE_OF_WORDS = 8;

/** A screen a turn is looked at on, and which of its three shapes the bar has there: under the table, beside it, or wide under it. */
interface Room {
  name: string;
  size: { width: number; height: number };
  bar: 'under' | 'beside' | 'wide';
  /** A wide bar with no room for four moves beside a clock but on two lines of words, at the larger sizes of text. */
  tight?: true;
}

const ROOMS: Room[] = [
  { name: 'a 360 phone', size: SCREENS.smallPhone, bar: 'under' },
  { name: 'a 375 phone', size: SCREENS.phone, bar: 'under' },
  { name: 'a 390 phone', size: SCREENS.tallPhone, bar: 'under' },
  { name: 'a 360 phone lying', size: LYING, bar: 'beside' },
  // Wide enough that the bet's sizes fit one line at some sizes of text, and leave the clock no room on it
  { name: 'a 430 phone lying', size: { width: 932, height: 430 }, bar: 'beside' },
  { name: 'the desktop', size: SCREENS.desktop, bar: 'wide' },
  // The chat stands beside the table and leaves the bar 580 wide, where the slider has nothing to give
  { name: 'a desktop window 900 wide', size: { width: 900, height: 700 }, bar: 'wide', tight: true },
];

/** Three at 5/10, the viewer first of them. `seconds` is the table's action clock, and 0 a table with none. */
const tableOfThree = (rig: Rig, seconds: number, config: Partial<TableConfig> = {}): RigTable =>
  rig.table(
    [
      { name: VIEWER, stack: 1000 },
      { name: 'Pam', stack: 1000 },
      { name: 'Stu', stack: 5000 },
    ],
    { smallBlind: 5, bigBlind: 10, actionSeconds: seconds, ...config },
  );

/** The kinds of decision a player is on the clock for, each with the viewer on it. */
const TURNS = {
  'a bet to size': (rig: Rig, seconds: number) => {
    const table = tableOfThree(rig, seconds);

    table.deal({ button: 0 });

    return table;
  },
  'four moves, with a chop to offer': (rig: Rig, seconds: number) => {
    const table = tableOfThree(rig, seconds, { allowChop: true });

    // Folded to the viewer in the small blind
    table.deal({ button: 2 });
    table.act('Stu', { type: 'fold' });

    return table;
  },
  'only Fold and Call': (rig: Rig, seconds: number) => {
    const table = tableOfThree(rig, seconds);

    // Stu on the button is first, and has the viewer covered
    table.deal({ button: 2 });
    table.act('Stu', { type: 'raise', to: table.view('Stu').hand!.options!.maxRaiseTo });

    return table;
  },
  'an offer to chop to answer': (rig: Rig, seconds: number) => {
    const table = tableOfThree(rig, seconds, { allowChop: true });

    table.deal({ button: 1 });
    table.act('Pam', { type: 'fold' });
    table.act('Stu', { type: 'offerChop' });

    return table;
  },
} as const;

/** What a page shows of the viewer's clock, and where everything of their turn lies. */
interface Look {
  /** The clock by the moves: null when there is none. */
  clock: { says: string; named: string; box: Box; cut: boolean; filled: boolean } | null;
  /** The clock at the seat on the clock, whoever's it is. */
  seat: { says: string; filled: boolean; mine: boolean } | null;
  runningOut: boolean;
  table: number;
  /** Every control of the turn, by what tells it apart, with its box. */
  turn: [what: string, box: Box][];
  /** How tall the question the turn asks is, when it asks one. */
  question: number | null;
  buzzes: { pattern: number[]; touched: boolean }[] | null;
  /** Whether everything in the bar is the very element it was when `KEEP` ran. */
  kept: boolean | null;
}

// Run in the page: the look above. A fill is told against a mark given the danger color the way the stylesheet names it
const LOOK = `(() => {
  const app = document.querySelector('#app');
  const box = (element) => {
    const { left, top, right, bottom } = element.getBoundingClientRect();

    return { left, top, right, bottom };
  };
  const mark = app.appendChild(document.createElement('i'));
  mark.style.cssText = 'background: var(--bad); color: var(--bad-ink)';
  const danger = [getComputedStyle(mark).backgroundColor, getComputedStyle(mark).color].join();
  mark.remove();
  const filled = (element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color].join() === danger;
  const clock = document.querySelector('.controls .own-clock');
  const seat = document.querySelector('.seat.acting .status.clock');
  const prompt = document.querySelector('.turn .prompt');
  const bar = [...document.querySelectorAll('.controls *')];

  return {
    clock: clock && { says: clock.querySelector('[data-countdown]').textContent, named: clock.querySelector('.unseen').textContent, box: box(clock), cut: clock.scrollWidth > clock.clientWidth + 1, filled: filled(clock) },
    seat: seat && { says: seat.textContent, filled: filled(seat), mine: seat.closest('.seat').classList.contains('me') },
    runningOut: app.hasAttribute('data-running-out'),
    table: document.querySelector('.stage').getBoundingClientRect().height,
    turn: [...document.querySelectorAll('.turn :is(button, input)')].map((control) => [control.id || control.dataset.action || control.textContent, box(control)]),
    question: prompt && prompt.getBoundingClientRect().height,
    buzzes: window.buzzes ?? null,
    kept: window.keptBar ? window.keptBar.length === bar.length && window.keptBar.every((element, nth) => element === bar[nth]) : null,
  };
})()`;

// Run in the page: remembers every element of the bar as it is now
const KEEP = `window.keptBar = [...document.querySelectorAll('.controls *')]`;

const look = (page: Page) => page.evaluate(LOOK) as Promise<Look>;

/** Moves the rig's clock to `left` whole seconds before the viewer's clock runs out, and waits for each page to show it. */
async function toSecondsLeft(rig: Rig, table: RigTable, left: number, pages: Page[]): Promise<void> {
  rig.advance(table.view(VIEWER).hand!.deadline! - left * 1000 - rig.now());

  for (const page of pages) {
    await page.waitForFunction(`document.querySelector('.seat.acting .status.clock')?.textContent === ${JSON.stringify(clockText(left))}`);
  }
}

async function textSize(page: Page, size: string): Promise<void> {
  await page.evaluate(`document.querySelector('#app').setAttribute('data-text-size', ${JSON.stringify(size)})`);
  // The rows of the bar are fitted again in the frame after their room changed
  await page.evaluate(NEXT_FRAME);
  await page.evaluate(NEXT_FRAME);
}

const byTheMoves: (picturesIn: string) => Check = (picturesIn) => [
  'on the viewer’s turn their seconds left stand by the moves, over them or first in their row, written as a clock there and at every seat, and lie over no control of the turn; as they run down from five minutes to one second nothing of the turn moves or is drawn again, a bet half typed stays in its box with the keyboard, and from ten seconds the clock by the moves and the one at the viewer’s seat are filled with the color of a fold, the phone buzzes once and the screen reader is told once; nobody else’s page shows any of it but the seconds at the seat: on a 360 phone standing and lying and on the desktop',
  async (rig) => {
    const table = TURNS['a bet to size'](rig, 300);
    const spies = `${BUZZ};${SPOKEN}`;
    const standing = await table.open(VIEWER, 'smallPhone', spies);
    const lying = await table.open(VIEWER, 'smallPhone', spies);
    const desktop = await table.open(VIEWER, 'desktop', spies);
    const other = await table.open('Pam', 'smallPhone', spies);
    const mine: [where: string, page: Page][] = [
      ['a 360 phone standing', standing],
      ['a 360 phone lying', lying],
      ['the desktop', desktop],
    ];
    const pages = [standing, lying, desktop, other];
    const whole = Math.ceil((table.view(VIEWER).hand!.deadline! - rig.now()) / 1000);

    await lying.setViewportSize(LYING);

    for (const page of pages) {
      await page.waitForSelector('.seat.acting .status.clock:not(:empty)');
      await table.heardBy(page);
    }

    // The keyboard in the bet's box with half a bet typed, on the phone, where a redraw would take both
    await standing.locator('#raise-amount').fill('4');
    assert.equal(await standing.evaluate('document.activeElement.id'), 'raise-amount');

    const first = new Map<Page, Look>();

    for (const [where, page] of mine) {
      await page.evaluate(NEXT_FRAME);
      await page.evaluate(KEEP);

      const found = await look(page);
      const clock = found.clock;
      const moves = found.turn.filter(([what]) => MOVES.includes(what));

      assert.ok(clock, `${where}: no clock by the moves`);
      assert.deepEqual([clock.says, found.seat?.says, found.seat?.mine], [clockText(whole), clockText(whole), true], `${where}: what the clock by the moves and the one at the seat say`);
      assert.equal(clock.named, 'Your time left: ', `${where}: what a screen reader is told the figure is`);
      assert.ok(!clock.cut, `${where}: the clock’s figure is cut off`);
      assert.equal(moves.length, 3, `${where}: the moves of the turn`);
      assert.ok(moves.every(([, move]) => clock.box.bottom <= move.top + 1 || clock.box.right <= move.left + 1), `${where}: the clock is neither over the moves nor before them in their row: ${JSON.stringify(clock.box)}, and the moves ${JSON.stringify(moves)}`);
      assert.deepEqual(found.turn.filter(([, control]) => overlap(clock.box, control)).map(([what]) => what), [], `${where}: the clock lies over a control of the turn`);
      assert.deepEqual([found.runningOut, clock.filled, found.seat?.filled], [false, false, false], `${where}: the clock warns with five minutes left`);
      first.set(page, found);
    }

    // First on the line over the moves, where a phone standing has the bet's slider give it room
    const [, fold] = first.get(standing)!.turn.find(([what]) => what === 'fold')!;
    assert.ok(Math.abs(first.get(standing)!.clock!.box.left - fold.left) <= 1, 'on a phone standing the clock does not start where the moves do');
    await standing.screenshot({ path: `${picturesIn}check-own-clock-smallPhone.png` });

    /** Nothing of the turn has moved since the first look, the clock least of all, and nothing of the bar was drawn again. */
    const still = async (left: number, runningOut: boolean) => {
      await toSecondsLeft(rig, table, left, pages);

      for (const [where, page] of mine) {
        const [was, found] = [first.get(page)!, await look(page)];
        const when = `${where}, ${clockText(left)} left`;

        assert.equal(found.clock?.says, clockText(left), `${when}: what the clock by the moves says`);
        assert.deepEqual([found.clock?.box, found.turn, found.table], [was.clock!.box, was.turn, was.table], `${when}: the clock, a control of the turn or the table moved or changed size`);
        assert.ok(!found.clock?.cut, `${when}: the clock’s figure is cut off`);
        assert.ok(found.kept, `${when}: the bar was drawn again`);
        assert.deepEqual([found.runningOut, found.clock?.filled, found.seat?.filled], [runningOut, runningOut, runningOut], `${when}: whether the clock by the moves and the one at the seat warn`);
      }
    };

    // Every width the figure takes, and the last second before the warning
    await still(247, false);
    await still(71, false);
    await still(11, false);
    assert.deepEqual((await look(standing)).buzzes, [], 'a buzz before the clock ran down to its warning');

    await still(10, true);
    await standing.waitForFunction('window.buzzes.length > 0');
    await heard(standing, 'alert: 10 seconds left.');
    await lying.screenshot({ path: `${picturesIn}check-own-clock-running-out-lying.png` });
    await desktop.screenshot({ path: `${picturesIn}check-own-clock-running-out-desktop.png` });

    await still(9, true);
    await still(1, true);
    await standing.screenshot({ path: `${picturesIn}check-own-clock-running-out-smallPhone.png` });

    for (const page of [standing, lying]) {
      assert.deepEqual((await look(page)).buzzes, [{ pattern: BUZZ_PATTERN, touched: true }], 'a phone buzzes once as its player’s clock runs down to the warning, and not again');
    }

    assert.deepEqual((await look(desktop)).buzzes, [], 'a computer has nothing to buzz');
    assert.deepEqual((await spoken(standing)).filter((line) => line.includes('seconds left')), ['alert: 10 seconds left.'], 'the screen reader is told of the clock once, and never the figure as it changes');
    assert.deepEqual([await standing.evaluate('document.activeElement.id'), await standing.locator('#raise-amount').inputValue()], ['raise-amount', '4'], 'the bet half typed, or the keyboard in its box, was lost to the clock');

    // Pam's page, whose turn it is not: the seconds at the viewer's seat, written the same way, and nothing more
    const watching = await look(other);

    assert.deepEqual([watching.clock, watching.seat, watching.runningOut, watching.buzzes], [null, { says: clockText(1), filled: false, mine: false }, false, []], 'what someone else’s page shows of the viewer’s clock');
  },
];

const warnsOnAShortClock: Check = [
  'a twelve-second clock warns at five seconds, with its color and one buzz, and not at six; a player who switched the buzz off gets the color alone; and once the move is made the clock by the moves is gone and nothing warns',
  async (rig) => {
    const table = TURNS['a bet to size'](rig, 12);
    const page = await table.open(VIEWER, 'smallPhone', BUZZ);
    const quiet = await table.open(VIEWER, 'smallPhone', `${BUZZ};localStorage.setItem('cnd.buzz', 'off')`);
    const pages = [page, quiet];

    for (const one of pages) {
      await one.waitForSelector('.turn .own-clock');
      await table.heardBy(one);
    }

    await toSecondsLeft(rig, table, 6, pages);

    for (const one of pages) {
      const found = await look(one);

      assert.deepEqual([found.clock?.says, found.runningOut, found.clock?.filled, found.buzzes], ['0:06', false, false, []], 'a second before the warning of a short clock');
    }

    await toSecondsLeft(rig, table, 5, pages);
    await page.waitForFunction('window.buzzes.length > 0');

    for (const one of pages) {
      const found = await look(one);

      assert.deepEqual([found.clock?.says, found.runningOut, found.clock?.filled, found.seat?.filled], ['0:05', true, true, true], 'at the warning of a short clock');
    }

    await toSecondsLeft(rig, table, 4, pages);
    assert.deepEqual((await look(page)).buzzes, [{ pattern: BUZZ_PATTERN, touched: true }]);
    assert.deepEqual((await look(quiet)).buzzes, [], 'a buzz with the buzz switched off');

    // The move made, the next player is on a clock of their own, which is no warning to the viewer
    table.act(VIEWER, { type: 'call' });

    for (const one of pages) {
      await one.waitForSelector('.turn', { state: 'detached' });
      await one.waitForSelector('#app:not([data-running-out])');

      const found = await look(one);

      assert.deepEqual([found.clock, found.seat?.mine, found.seat?.filled], [null, false, false], 'after the move');
    }
  },
];

/**
 * Holds a turn drawn with a clock to the same turn drawn with none, on one screen at one size of text:
 * the clock is there to be read, lies over nothing, and costs nothing but width where something had it
 * to give.
 */
function heldToNoClock(where: string, room: Room, text: string, found: Look, plain: Look): void {
  const clock = found.clock;
  const was = new Map(plain.turn);
  const moves = found.turn.filter(([what]) => MOVES.includes(what));
  const slider = found.turn.find(([what]) => what === SLIDER)?.[1];
  const asks = found.question !== null;
  /*
   * The one thing a clock is let move: on a wide bar the chat narrows, four moves beside it take a
   * second line of words at the larger sizes of text, as a bet of a few hundred makes them with no
   * clock. Their row is taller by that line, and the row over it and the table's foot are that much
   * higher. Everything is held to where it would lie had nothing risen.
   */
  const rise = plain.table - found.table;
  const mayRise = room.tight === true && moves.length > 3 && text !== 'standard';
  const unrisen = ({ left, top, right, bottom }: Box): Box => ({ left, top: top + rise, right, bottom: bottom + rise });
  const elsewhere = (some: [string, Box][]) => some.filter(([what, box]) => !isDeepStrictEqual(unrisen(box), was.get(what))).map(([what]) => what);

  assert.ok(clock && !clock.cut, `${where}: the clock by the moves is missing or cut off`);
  assert.deepEqual([plain.clock, plain.runningOut, plain.seat], [null, false, null], `${where}: a table with no clock shows one`);
  assert.ok(mayRise ? rise >= 0 && rise <= LINE_OF_WORDS : rise === 0, `${where}: the table is ${found.table} tall, and with no clock ${plain.table}`);
  assert.deepEqual(found.turn.map(([what]) => what), plain.turn.map(([what]) => what), `${where}: the controls of the turn, with a clock and with none`);
  assert.deepEqual(found.turn.filter(([, control]) => overlap(clock.box, control)).map(([what]) => what), [], `${where}: the clock lies over a control of the turn`);
  assert.deepEqual(moves.filter(([, move]) => move.top < 0 || move.left < 0 || move.bottom > room.size.height || move.right > room.size.width).map(([what]) => what), [], `${where}: a move of the turn is out of sight`);
  assert.equal(found.question, plain.question, `${where}: how tall the turn’s question is, with a clock and with none`);

  // The bet's sizes and its box lie where they do with no clock. So does the slider, but for the width it gives a clock that stands before it
  assert.deepEqual(elsewhere(found.turn.filter(([what]) => !MOVES.includes(what) && what !== SLIDER)), [], `${where}: a size of the bet or its box lies elsewhere than with no clock`);

  if (slider) {
    const plainSlider = was.get(SLIDER)!;
    const [width, plainWidth] = [slider.right - slider.left, plainSlider.right - plainSlider.left];
    const { top, right, bottom } = unrisen(slider);

    assert.deepEqual([top, right, bottom], [plainSlider.top, plainSlider.right, plainSlider.bottom], `${where}: the slider lies elsewhere than with no clock`);
    assert.ok(room.bar === 'wide' ? slider.left === plainSlider.left : slider.left >= plainSlider.left, `${where}: the slider starts at ${slider.left}, and with no clock at ${plainSlider.left}`);
    assert.ok(width >= Math.min(plainWidth, SLIDER_KEEPS), `${where}: the slider is ${width} wide beside the clock, and ${plainWidth} with none`);
  }

  // In the row of the moves, first: on a wide screen, and under a phone's table where the turn asks a question, whose two answers have the width
  if (room.bar === 'wide' || (asks && room.bar === 'under')) {
    const [[, first], [last, ends]] = [moves[0]!, moves.at(-1)!];
    const heights = (some: [string, Box][], risen: number) => some.map(([what, { top, bottom }]) => [what, top + risen, bottom]);

    assert.ok(clock.box.right <= first.left && clock.box.top >= first.top && clock.box.bottom <= first.bottom, `${where}: the clock is not before the moves in their row: ${JSON.stringify(clock.box)}, and the first of them ${JSON.stringify(first)}`);
    // To the pixel: the moves share what the clock leaves in equal parts, which are not whole pixels
    assert.ok(Math.abs(ends.right - was.get(last)!.right) < 0.5, `${where}: the row of the moves ends at ${ends.right}, and with no clock at ${was.get(last)!.right}`);
    assert.deepEqual(heights(moves, rise), heights(plain.turn.filter(([what]) => MOVES.includes(what)), 0), `${where}: how high the moves lie, with a clock and with none`);
  } else if (!asks) {
    assert.deepEqual(elsewhere(moves), [], `${where}: a move lies elsewhere than with no clock`);
  }

  if (!slider && !asks && room.bar !== 'wide') {
    const [, fold] = moves.find(([what]) => what === 'fold')!;

    assert.ok(Math.abs(clock.box.left - fold.left) <= 1 && clock.box.bottom <= fold.top, `${where}: with no bet to size the clock is not right over Fold`);
  }
}

/** One check for each kind of turn: together they are a few hundred looks, and each kind is held on its own. */
const turnsHeldToNoClock: Check[] = Object.entries(TURNS).map(([kind, build]) => [
  `${kind}: the turn with a clock is the turn with none but for the clock, which lies over nothing, at every size of text: under a phone’s table every control and the table lie exactly where they did, the bet’s slider or a question’s two answers giving the clock its width; beside a table lying down the clock stands at the end of the bet’s sizes or before its slider and moves nothing else, with every move in sight; on a wide screen it is first in the row of the moves, and the sizes, the slider and the box lie where they did; on a window the chat narrows too, where four moves beside it may take one more line of words and lift the row over them by no more`,
  async (rig) => {
    const [timed, untimed] = [build(rig, 30), build(rig, 0)];
    const open = async (table: RigTable, screen: ScreenName) => {
      const page = await table.open(VIEWER, screen);

      await page.waitForSelector('.controls .turn');

      return page;
    };
    // A finger's screens and a mouse's: the bar's small buttons are as tall as the pointer needs
    const phones = [await open(timed, 'smallPhone'), await open(untimed, 'smallPhone')] as const;
    const desktops = [await open(timed, 'desktop'), await open(untimed, 'desktop')] as const;

    for (const room of ROOMS) {
      const [withClock, without] = room.bar === 'wide' ? desktops : phones;

      await withClock.setViewportSize(room.size);
      await without.setViewportSize(room.size);

      for (const text of TEXT_SIZES) {
        await textSize(withClock, text);
        await textSize(without, text);

        heldToNoClock(`${room.name}, ${text} text`, room, text, await look(withClock), await look(without));
      }
    }
  },
]);

/** The checks of the viewer's own clock. Pictures go into `picturesIn`, a folder ending in a slash. */
export function ownClockChecks(picturesIn: string): Check[] {
  return [byTheMoves(picturesIn), warnsOnAShortClock, ...turnsHeldToNoClock];
}
