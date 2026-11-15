/*
 * The layout sweep: every screen at its fullest, on every size the group plays on, held to one question,
 * whether anything a player reads is covered, cut off or off the screen (covered.ts). A check here never
 * names the two things that might collide; it builds a state and looks.
 *
 * Something new on the table gets a row in TABLE_STATES that shows it at its fullest, or goes into the
 * row whose state it belongs to; something new that floats over the page gets a line in ALLOWED_ON_TOP
 * saying what it may hide.
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { TAPS_SETTLE_MS } from '../src/client/tapGuard.ts';
import { BADGES, LIMITS, REACTION_LIFE_MS, REACTIONS_LIVE } from '../src/engine/index.ts';
import type { Bounty, Card, Command, TableConfig, TableView } from '../src/engine/index.ts';
import { HISTORY_LIMIT } from '../src/server/api.ts';

import type { Check } from './checkRunner.ts';
import { SCROLLS, telling, unreadable } from './covered.ts';
import type { Finding } from './covered.ts';
import { answeredTo, opsSent, replayDrawn } from './pageSpies.ts';
import { boxes, Gate, overlap, SCREENS, setStageHeight, STALL_MS, WIDE_ASPECT } from './rig.ts';
import type { Rig, RigTable, ScreenName } from './rig.ts';
import { cameUp, tapsLive, tellingOf, watched, watchTheBar } from './underTheFinger.ts';
import type { Held } from './underTheFinger.ts';

const VIEWER = 'Quigs';
// The widest sixteen letters a name can be, which the sweep makes the host and the holder of the high hand, so the star and the trophy stand beside the name with the least room for them
const WIDEST = 'WWWWWWWWWWWWWWWW';
const NAMES = [VIEWER, WIDEST, 'Ünïcödé Ñandú Ø!', 'Marge Simpson-Jr', 'Stu', 'Big Al', 'Pocket Pam', 'iiiiiiiiiiiiiiii', 'Zed'];

// A pair each, the viewer's the best, so every hand at a showdown has a name and no two cards are dealt twice
const HOLES: Record<number, string> = { 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh', 3: 'Js Jh', 4: 'Ts Th', 5: '9s 9h', 6: '8s 8h', 7: '7s 7h', 8: '6s 6h' };
const THREE_BOARDS = { board: '2c 3d 4c 5d Jc', secondBoard: 'Kd Qc 8d 7c 2d', thirdBoard: 'Ad Tc 9d 4d 3c' };
// A straight on the board for the lowest pairs and a set for the rest: names of every length under the seats
const ONE_BOARD = 'Ac Kc Qc Jd 2s';
// Stacks all different, so everyone all in makes a side pot a player
const STACKS = [3000, 1000, 5000, 300, 20_000, 777, 2500, 12_345, 1200];
const EVEN = STACKS.map(() => 5000);
// The most a stack can be, on a table of dollars and cents: the longest figures a bet, a pot and the bet box ever hold
const BIGGEST = STACKS.map(() => 1_000_000_000);
const CENTS: Partial<TableConfig> = { unit: 'cents', smallBlind: 25, bigBlind: 50 };
// What the first raise of the state with a bet from every seat is to, in cents
const FIRST_RAISE = 1234;
// The most a seat or a button writes out before it shortens an amount to a letter (`shortAmount`): nine characters, 99,999.99
const LONGEST_WRITTEN_OUT = 9_999_999;

const SEAT_COUNTS = [2, 6, 9];

/** The first `seats` players, the widest name hosting from the seat beside the viewer's. */
function players(seats: number, stacks: number[]) {
  const order = [1, 0, ...Array.from({ length: seats - 2 }, (_, nth) => nth + 2)];

  return order.map((seat) => ({ name: NAMES[seat]!, stack: stacks[seat]!, seat }));
}

const holesFor = (seats: number) => Object.fromEntries(Object.entries(HOLES).filter(([seat]) => Number(seat) < seats));

const passive = (view: TableView): Command => ({ type: view.hand!.options!.canCheck ? 'check' : 'call' });

/** Everything in, and `runs` picked by whoever is asked how many times to run it. */
const allInPicking =
  (runs: number) =>
  (view: TableView): Command => {
    const hand = view.hand!;

    if (hand.canVote) {
      return { type: 'ritVote', runs };
    }

    return hand.options!.canRaise ? { type: 'raise', to: hand.options!.maxRaiseTo } : { type: 'call' };
  };

/** A table whose first hand the widest name won at a showdown, so it holds the high hand; handed back between hands with the game paused. */
function tableWithTrophy(rig: Rig, seats: number, stacks: number[], config: Partial<TableConfig> = {}): RigTable {
  const table = rig.table(players(seats, stacks), config);

  table.deal({ button: 0, holes: { ...holesFor(seats), 0: '7d 2h', 1: 'As Ah' }, board: 'Ad 5c 9c Jd 3d' });
  playOut(table, passive);

  return table;
}

// Who misses a big blind in the state that shows blinds owed: the big blind of the hand after the first
const OWES = NAMES[3]!;

/** Plays the hand on the table out with `move` and clears it away, the game paused so that the next hand is the state's to deal. */
function playOut(table: RigTable, move: (view: TableView) => Command): void {
  table.act(WIDEST, { type: 'pause' });
  table.play(move, (view) => view.hand!.stage === 'done');
  table.play(() => null, (view) => view.hand === null);
}

const folding = (view: TableView): Command => ({ type: view.hand!.options!.canCheck ? 'check' : 'fold' });

/** A table of cents with the viewer on the button, last to act: the first to act has raised, and the next is on the clock with the viewer behind them. */
function waitingBehindTheLongestCall(rig: Rig, seats: number): RigTable {
  const table = tableWithTrophy(rig, seats, BIGGEST, { actionSeconds: 30, ...CENTS });

  table.deal({ button: 0, holes: holesFor(seats) });
  table.act(NAMES[3]!, { type: 'raise', to: LONGEST_WRITTEN_OUT });

  return table;
}

/**
 * A table of cents with everything the bar says to a player who waits, each at its longest: the viewer,
 * under the gun, asked to straddle and is passed over for the widest name, who straddles from the button;
 * the night's last hands are counted, and the next hand is a bomb pot on two boards. Every stack is the
 * longest a seat writes out in full, nine characters.
 */
function waitingWithEveryNote(rig: Rig, seats: number): RigTable {
  const button = seats - 3;
  const others = NAMES.filter((name) => name !== VIEWER && name !== WIDEST);
  const seated = Array.from({ length: seats }, (_seat, seat) => (seat === 0 ? VIEWER : seat === button ? WIDEST : others.shift()!));
  const table = rig.table(seated.map((name, seat) => ({ name, stack: LONGEST_WRITTEN_OUT, seat })), { actionSeconds: 30, ...CENTS, allowStraddle: true, allowButtonStraddle: true, bombPotAmount: 999_999, bombPotBoards: 'two' });

  table.act(VIEWER, { type: 'setStraddle', kind: 'straddle', on: true });
  table.act(WIDEST, { type: 'setStraddle', kind: 'button straddle', on: true });
  table.deal({ button, holes: holesFor(seats) });
  table.act(VIEWER, { type: 'setLastHands', hands: LIMITS.lastHands });
  table.act(VIEWER, { type: 'setBombPot', on: true });

  return table;
}

/** Something on the table that stays only a moment, which a look has to catch while it is up. */
interface Fleeting {
  show(rig: Rig, table: RigTable, page: Page): Promise<void>;
  shown(page: Page): Promise<boolean>;
}

/** A table at its fullest in one respect. */
interface TableState {
  /** What it shows, which names its check. */
  shows: string;
  /** How many seats are taken, each a table of its own. */
  seats: number[];
  build(rig: Rig, seats: number): RigTable;
  /** What the viewer's own page does once it is open. */
  onPage?(page: Page): Promise<void>;
  fleeting?: Fleeting;
}

const REACTION_MARKS = `document.querySelectorAll('.seat-reaction:not([hidden])').length`;

/**
 * As many reactions as a table has at once: two things thrown at the viewer, one at the widest name
 * beside them, and a player's own over their seat. At a table of fewer, as many as there are others to make them.
 */
const reactionsFlying: Fleeting = {
  async show(rig, table, page) {
    const others = table.view(VIEWER).seats.flatMap((seat) => (seat && seat.name !== VIEWER ? [seat.name] : []));
    const made: Command[] = [
      { type: 'react', kind: 'chicken', to: table.auth(VIEWER).id },
      { type: 'react', kind: 'tomato', to: table.auth(VIEWER).id },
      { type: 'react', kind: 'beer', to: table.auth(WIDEST).id },
      { type: 'react', kind: 'laugh' },
    ];

    // Past the last ones' time on the table, which is also when each player may react again
    rig.advance(REACTION_LIFE_MS);
    others.slice(0, REACTIONS_LIVE).forEach((name, nth) => table.act(name, made[nth]!));

    await page.waitForFunction(`${REACTION_MARKS} >= ${Math.min(others.length, REACTIONS_LIVE)}`);
  },
  async shown(page) {
    return (await page.evaluate(`${REACTION_MARKS} >= Math.min(document.querySelectorAll('.table .seat:not(.open):not(.me)').length, ${REACTIONS_LIVE})`)) as boolean;
  },
};

const TABLE_STATES = {
  blinds: {
    shows: 'the blinds, every straddle and a missed blind posted, with the action clock running',
    seats: SEAT_COUNTS,
    build(rig, seats) {
      const table = tableWithTrophy(rig, seats, EVEN, { actionSeconds: 30, allowStraddle: true, allowDoubleStraddle: true });

      // Out as the big blind came to her and back by posting what she owes, which she does once the button has passed her
      if (seats > 2) {
        table.act(OWES, { type: 'sitOut' });
        table.dealNext();
        playOut(table, folding);
        table.act(OWES, { type: 'comeIn', post: true });
        table.dealNext();
        playOut(table, folding);
      }

      for (const name of NAMES.slice(0, seats)) {
        table.tryAct(name, { type: 'setStraddle', kind: 'straddle', on: true });
        table.tryAct(name, { type: 'setStraddle', kind: 'double straddle', on: true });
      }

      table.dealNext({ holes: holesFor(seats) });
      assert.ok(seats === 2 || table.view(VIEWER).seats.some((seat) => seat?.lastAction === 'missed big blind'), 'nobody posted a blind they owed');

      return table;
    },
  },
  betsOut: {
    shows: 'a bet out from every seat and the viewer’s own, with the biggest all-in typed into the bet box of a table of cents',
    seats: SEAT_COUNTS,
    build(rig, seats) {
      const table = tableWithTrophy(rig, seats, BIGGEST, { actionSeconds: 30, ...CENTS });
      let viewerHasBet = false;

      table.dealNext({ holes: holesFor(seats) });
      table.play(
        (view, name) => {
          if (name === VIEWER && viewerHasBet) {
            return null;
          }

          viewerHasBet ||= name === VIEWER;

          // The least each time, which leaves everyone chips to raise with when it is the viewer's turn again
          return { type: 'raise', to: Math.max(view.hand!.options!.minRaiseTo, FIRST_RAISE) };
        },
        (view) => view.hand!.toAct === 0 && viewerHasBet,
      );

      return table;
    },
    async onPage(page) {
      await page.locator('.presets button', { hasText: 'All in' }).click();
    },
  },
  choicesAhead: {
    shows: 'the five moves to choose ahead of a turn, one of them set, facing the longest call a table of cents writes',
    // With two seated the action is on one or the other: nobody waits behind a bet
    seats: [6, 9],
    build(rig, seats) {
      const table = waitingBehindTheLongestCall(rig, seats);
      const hand = table.view(VIEWER).hand!;

      table.act(VIEWER, { type: 'preAct', what: 'call', hand: hand.number, street: hand.street, facing: hand.currentBet });

      return table;
    },
  },
  everyNote: {
    shows: 'the bar of a player waiting, with the moves to choose ahead, the hands to come and a straddle passed over, each at its longest',
    seats: [6, 9],
    build: waitingWithEveryNote,
  },
  runsChoice: {
    shows: 'the choice of how many times to run it, with a side pot a player and every hand’s chance',
    seats: SEAT_COUNTS,
    build(rig, seats) {
      const table = tableWithTrophy(rig, seats, STACKS, { maxRuns: 3 });

      table.dealNext({ holes: holesFor(seats), ...THREE_BOARDS });
      table.play(allInPicking(3), (view) => view.hand!.stage === 'ritVote');

      return table;
    },
  },
  thirdBoardRunning: {
    shows: 'three boards as the third is run out, with the pot, the side pots and every hand’s chance on each',
    seats: SEAT_COUNTS,
    build(rig, seats) {
      const table = tableWithTrophy(rig, seats, STACKS, { maxRuns: 3 });

      table.dealNext({ holes: holesFor(seats), ...THREE_BOARDS });
      table.play(allInPicking(3), (view) => view.hand!.stage === 'runout' && view.hand!.boards.length === 3 && view.hand!.boards[2]!.length === 4);

      return table;
    },
  },
  threeBoardsRun: {
    shows: 'three boards run out, with who won what',
    seats: SEAT_COUNTS,
    build(rig, seats) {
      const table = tableWithTrophy(rig, seats, STACKS, { maxRuns: 3 });

      table.dealNext({ holes: holesFor(seats), ...THREE_BOARDS });
      table.play(allInPicking(3), (view) => view.hand!.stage === 'done');

      return table;
    },
  },
  showdown: {
    shows: 'a showdown with the best hand named under every seat',
    seats: SEAT_COUNTS,
    build(rig, seats) {
      const table = tableWithTrophy(rig, seats, STACKS, { maxRuns: 1 });

      table.dealNext({ holes: holesFor(seats), board: ONE_BOARD });
      table.play(allInPicking(1), (view) => view.hand!.stage === 'done');

      return table;
    },
  },
  wonUncalled: {
    shows: 'a hand won with no call: the rabbit hunted, and the offer to show a card',
    seats: SEAT_COUNTS,
    build(rig, seats) {
      const table = tableWithTrophy(rig, seats, STACKS, { rabbitHunting: true });

      table.dealNext({ holes: holesFor(seats), board: ONE_BOARD });
      table.play((_view, name) => (name === VIEWER ? { type: 'raise', to: 60 } : { type: 'fold' }), (view) => view.hand!.stage === 'done');
      table.act(WIDEST, { type: 'huntRabbit', hand: table.view(WIDEST).hand!.number });

      return table;
    },
  },
  chopOffer: {
    shows: 'the offer to chop the blinds',
    seats: [6, 9],
    build(rig, seats) {
      const table = tableWithTrophy(rig, seats, EVEN, { allowChop: true, actionSeconds: 30 });

      // The button so that the viewer is the small blind, whom the offer is put to once everyone else has folded
      table.deal({ button: seats - 1, holes: holesFor(seats) });
      table.play((_view, name) => (name === VIEWER ? null : { type: 'fold' }), (view) => view.hand!.toAct === 0);

      return table;
    },
  },
  reactions: {
    shows: 'as many reactions as a table has at once, two of them thrown at the viewer',
    seats: SEAT_COUNTS,
    build(rig, seats) {
      // No clock on the action, since every look moves the game's time on
      const table = tableWithTrophy(rig, seats, EVEN, { actionSeconds: 0 });

      table.dealNext({ holes: holesFor(seats), board: ONE_BOARD });
      table.play(passive, (view) => view.hand!.boards[0]!.length === 3);

      return table;
    },
    fleeting: reactionsFlying,
  },
} satisfies Record<string, TableState>;

interface Size {
  name: string;
  width: number;
  height: number;
}

const lying = ({ width, height }: { width: number; height: number }) => ({ width: height, height: width });

const SMALL_STANDING: Size = { name: '360 standing', ...SCREENS.smallPhone };
const STANDING: Size = { name: '375 standing', ...SCREENS.phone };
const LYING: Size = { name: '360 lying', ...lying(SCREENS.smallPhone) };
const PHONES: Size[] = [SMALL_STANDING, STANDING, LYING, { name: '375 lying', ...lying(SCREENS.phone) }];

/**
 * What a phone's page is looked at with, besides as it stands. The last two are for a phone standing and
 * hold its table to a height: the least it still stands at, and the least it is laid out by shares of its
 * height at. The height a phone gives its table by itself depends on the fonts of the machine.
 */
const WITH = ['a toast up', 'the chat open', 'the table just standing', 'the table just too tall for a short one'] as const;

type With = (typeof WITH)[number];

const STANDING_ONLY: readonly With[] = ['the table just standing', 'the table just too tall for a short one'];

// Up to this height a table is laid out as a short one, its rows one under another, and above it by shares of its height: `max-height` in src/client/styles/table.css
const SHORT_TABLE_PX = 350;

// Word of something earned, long enough for two lines on a phone
const TWO_LINE_TOAST = 'You earned 🃏 Rivered and 🔥 Heater, and 🏆 the high hand with a straight flush, queen high';

const toastUp = (up: boolean) => `(() => {
  const toast = document.querySelector('.toast');

  toast.textContent = ${JSON.stringify(TWO_LINE_TOAST)};
  toast.hidden = ${!up};
})()`;

/** Puts the page as `how` says, runs `look`, and puts it back for the next look. A table held to a height is let go by the next change of screen. */
async function lookWith(page: Page, { width }: Size, how: With | null, look: () => Promise<void>): Promise<void> {
  switch (how) {
    case 'a toast up':
      await page.evaluate(toastUp(true));
      await look();
      await page.evaluate(toastUp(false));
      break;
    case 'the chat open':
      await page.locator('.feed-toggle').click();
      await look();
      await page.locator('.feed-toggle').click();
      break;
    case 'the table just standing':
      await setStageHeight(page, Math.ceil(width / WIDE_ASPECT) + 1);
      await look();
      break;
    case 'the table just too tall for a short one':
      // Where a share of the height comes to the least, beside seats no shorter than on a taller table
      await setStageHeight(page, SHORT_TABLE_PX + 1);
      await look();
      break;
    default:
      await look();
  }
}

// The table drawn in the shape its room calls for, which it takes a frame after the room changes, and nothing on it still to come
const SETTLED = `(() => {
  const stage = document.querySelector('.stage');
  const table = stage?.querySelector('.table');

  if (!table || stage.matches('[data-moving], [data-chances-pending]')) {
    return false;
  }

  const room = stage.getBoundingClientRect();

  return table.classList.contains(room.height > 0 && room.width / room.height >= ${WIDE_ASPECT} ? 'wide' : 'tall');
})()`;

const NEXT_FRAME = 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))';

/** Waits until the page has laid itself out for the room it now has. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(NEXT_FRAME);
  await page.waitForFunction(SETTLED);
}

const FLEETING_TRIES = 5;

/** What cannot be read on a table's page once it has settled, looked at again when what the state shows only for a moment had gone by the end of the look. */
async function unreadableOn(page: Page, rig: Rig, table: RigTable, { fleeting }: TableState): Promise<Finding[]> {
  await settled(page);

  if (!fleeting) {
    return unreadable(page);
  }

  // The page takes it down on a timer of its own, so a look that ran long is made again: a few times, never without end
  for (let tries = 0; tries < FLEETING_TRIES; tries++) {
    if (!(await fleeting.shown(page))) {
      await fleeting.show(rig, table, page);
    }

    const findings = await unreadable(page);

    if (await fleeting.shown(page)) {
      return findings;
    }
  }

  throw new Error(`what the state shows for a moment was gone before the page had been looked at, ${FLEETING_TRIES} times over`);
}

// Run in the page: scrolls everything that scrolls to its end, and says whether anything moved
const SCROLL_TO_THE_END = `(() => {
  let moved = false;

  for (const area of document.querySelectorAll(${JSON.stringify(SCROLLS)})) {
    const [down, along] = [area.scrollTop, area.scrollLeft];

    area.scrollTop = area.scrollHeight;
    area.scrollLeft = area.scrollWidth;
    moved ||= area.scrollTop !== down || area.scrollLeft !== along;
  }

  return moved;
})()`;

const pictureName = (said: string) => said.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * A way a page can be set that changes the size of everything read on it, by a class or custom
 * properties on its root, or by the attribute the page itself sets for one of its preferences.
 */
interface PageSetting {
  /** Said of a look made with it; null for the page as it comes. */
  name: string | null;
  rootClass?: string;
  rootStyle?: Record<string, string>;
  /** The attribute a preference is kept in, on the element the page keeps it on: put to `value` for the look, and back to what the page had after it. */
  attribute?: { on: string; name: string; value: string };
}

/**
 * The page as it comes, and as each preference that changes what is read on it sets it: larger text at
 * both its steps, and the theme whose edges and weights are its own. A setting is a line here: every
 * look of the sweep, of the table and of every other screen, is made with it too, and no check changes.
 */
const PAGE_SETTINGS: PageSetting[] = [
  { name: null },
  { name: 'large text', attribute: { on: '#app', name: 'data-text-size', value: 'large' } },
  { name: 'largest text', attribute: { on: '#app', name: 'data-text-size', value: 'largest' } },
  { name: 'High Contrast', attribute: { on: ':root', name: 'data-theme', value: 'contrast' } },
];

// Run in the page: puts a setting on the root, or takes it off again
const setRoot = ({ rootClass, rootStyle = {}, attribute }: PageSetting, on: boolean) => `(() => {
  const root = document.documentElement;

  ${rootClass ? `root.classList.toggle(${JSON.stringify(rootClass)}, ${on});` : ''}

  for (const [name, value] of ${JSON.stringify(Object.entries(rootStyle))}) {
    ${on ? 'root.style.setProperty(name, value)' : 'root.style.removeProperty(name)'};
  }

  const { on: selector, name, value } = ${JSON.stringify(attribute ?? {})};
  const kept = selector && document.querySelector(selector);

  if (kept && ${on}) {
    window.__sweepHad = kept.getAttribute(name);
    kept.setAttribute(name, value);
  } else if (kept && window.__sweepHad === null) {
    kept.removeAttribute(name);
  } else if (kept) {
    kept.setAttribute(name, window.__sweepHad);
  }
})()`;

/** What a sweep found, look by look, and the pictures of the looks that found something. */
class Sweep {
  private readonly found: string[] = [];
  private readonly picturesIn: string;
  private readonly name: string;

  constructor(picturesIn: string, name: string) {
    this.picturesIn = picturesIn;
    this.name = name;
  }

  /** Looks at the page as it stands, once with each way a page can be set, where `where` says which look this is. */
  async look(page: Page, where: string, read: () => Promise<Finding[]> = () => unreadable(page)): Promise<void> {
    for (const setting of PAGE_SETTINGS) {
      const set = setting.rootClass !== undefined || setting.rootStyle !== undefined || setting.attribute !== undefined;

      if (set) {
        await page.evaluate(setRoot(setting, true));
        await page.evaluate(NEXT_FRAME);
      }

      await this.lookOnce(page, [where, setting.name].filter(Boolean).join(', '), read);

      if (set) {
        await page.evaluate(setRoot(setting, false));
        await page.evaluate(NEXT_FRAME);
      }
    }
  }

  private async lookOnce(page: Page, where: string, read: () => Promise<Finding[]>): Promise<void> {
    const findings = await read();

    if (findings.length === 0) {
      return;
    }

    const picture = `${this.picturesIn}covered-${pictureName(`${this.name}-${where}`)}.png`;
    await page.screenshot({ path: picture });

    this.found.push(`${where} (${picture}):`, ...findings.map(telling));
  }

  /** Looks at the page, and again with everything on it that scrolls at its end: the foot of a long list is read too. */
  async lookThrough(page: Page, where: string): Promise<void> {
    await this.look(page, where);

    if (await page.evaluate(SCROLL_TO_THE_END)) {
      await this.look(page, `${where}, scrolled to the end`);
    }
  }

  /** Fails with everything every look found, so one run tells all there is to fix. */
  done(): void {
    assert.equal(this.found.length, 0, `things a player reads cannot be read\n${this.found.join('\n')}`);
  }
}

/** One table on one page, looked at in every way its screen can hold it. */
async function sweepTable(sweep: Sweep, rig: Rig, table: RigTable, state: TableState, seats: number): Promise<void> {
  const look = (page: Page, where: string) => sweep.look(page, `${seats} seats, ${where}`, () => unreadableOn(page, rig, table, state));

  const phone = await table.open(VIEWER, 'smallPhone');
  await state.onPage?.(phone);

  for (const size of PHONES) {
    await phone.setViewportSize(size);

    for (const how of [null, ...WITH.filter((how) => !STANDING_ONLY.includes(how) || size.height > size.width)]) {
      await lookWith(phone, size, how, () => look(phone, [size.name, how].filter(Boolean).join(', ')));
    }
  }

  await phone.close();

  const desktop = await table.open(VIEWER, 'desktop');
  await state.onPage?.(desktop);
  await look(desktop, 'desktop');

  await desktop.evaluate(toastUp(true));
  await look(desktop, 'desktop, a toast up');
  await desktop.close();
}

/** A screen that is not the table, at its fullest. */
interface ScreenState {
  shows: string;
  /** What the game has to know before any page opens, set once for every screen looked at. */
  known?(rig: Rig): void;
  /** A walk through it on one screen, stopping to look wherever it is full. */
  walk(rig: Rig, screen: ScreenName, look: (page: Page, where: string) => Promise<void>): Promise<void>;
}

const OTHER_SCREENS: ScreenName[] = ['smallPhone', 'desktop'];

// Forty names of every width, for everyone the game knows
const FORTY = Array.from({ length: 40 }, (_player, nth) => [`${'W'.repeat(13)}${String(nth).padStart(3, '0')}`, `Ünïcödé Ñandú ${String(nth).padStart(2, '0')}`, `你好你好你好你好 ${nth}`, `Player ${nth}`][nth % 4]!);

// One short of as many bounty hands as a table can have, so the last is added on the page
const BOUNTIES: Bounty[] = [['72', 25], ['72s', 100], ['J4s', 50], ['AA', 200], ['T9o', 20], ['K2o', 10], ['QQ', 75]];

const GIF = 'https://media.giphy.com/media/abc123/giphy.gif';

// Run in the page: whether the replay is at the last of its steps
const REPLAY_AT_ITS_END = `(() => {
  const [, step, steps] = document.querySelector('.replay-count')?.textContent.match(/Step (\\d+) of (\\d+)/) ?? [];

  return step !== undefined && step === steps;
})()`;

const openFromMenu = async (page: Page, action: string) => {
  await page.locator('[data-action="menu"]').click();
  await page.locator(`.menu [data-action="${action}"]`).click();
};

const SCREEN_STATES: ScreenState[] = [
  {
    shows: 'the first screen asking who you are, with forty players known',
    known: (rig) => FORTY.forEach((name, nth) => rig.players.add(name, rig.now() + nth)),
    async walk(rig, screen, look) {
      const page = await rig.lobby(screen);
      await page.waitForSelector('.who-list .who-pill');
      await look(page, 'the first screen');
    },
  },
  {
    shows: 'the host’s menu, and the table settings with as many bounty hands as a table can have',
    async walk(rig, screen, look) {
      const table = rig.table(players(2, BIGGEST), { ...CENTS, bounties: BOUNTIES, allowStraddle: true, rabbitHunting: true });
      const page = await table.open(WIDEST, screen);

      await page.locator('[data-action="menu"]').click();
      await page.waitForSelector('.menu [data-action="settings"]');
      await look(page, 'the menu');

      await page.locator('.menu [data-action="settings"]').click();
      await page.locator('[data-action="add-bounty"]').click();
      await page.waitForSelector(`#table-bounties-hand-${BOUNTIES.length}`);
      await look(page, 'the table settings');
    },
  },
  {
    shows: 'Tonight with nine players, the night so far and then its recap',
    async walk(rig, screen, look) {
      const table = tableWithTrophy(rig, 9, STACKS);
      const page = await table.open(VIEWER, screen);

      await openFromMenu(page, 'tonight');
      await page.locator('.tonight-players li:first-child summary').click();
      await look(page, 'Tonight');

      table.act(WIDEST, { type: 'endNight' });
      await page.waitForSelector('.dialog[aria-label="Tonight"] .tonight-crown');
      await look(page, 'the recap');
    },
  },
  {
    shows: 'the Standings with forty players, the biggest numbers and every badge',
    known(rig) {
      const players = FORTY.map((name, nth) => rig.players.add(name, rig.now() + nth));
      const badges = Object.fromEntries(BADGES.map((badge) => [badge.id, 12]));

      rig.results.write([
        {
          tableId: 'BIG',
          tableName: 'W'.repeat(LIMITS.tableNameLength),
          unit: 'chips',
          createdAt: rig.now(),
          version: 1,
          players: players.map((player, nth) => ({ playerId: player.id, name: player.name, net: (nth % 2 === 0 ? 1 : -1) * (333_333_333 - nth), hands: 3333, won: 1111, biggest: 999_999_999, best: ['As', 'Ks', 'Qs', 'Js', 'Ts'] as Card[], badges, highHand: true })),
        },
      ]);
    },
    async walk(rig, screen, look) {
      const page = await rig.lobby(screen);
      await page.locator('[data-action="standings"]').click();
      await page.locator('.standings-players li:first-child summary').click();
      await page.waitForSelector('.standings-players li:first-child .standings-nights li');
      await look(page, 'the Standings');
    },
  },
  {
    shows: 'the hand history, and a hand on three boards played back to its end',
    async walk(rig, screen, look) {
      const table = tableWithTrophy(rig, 9, STACKS, { maxRuns: 3 });

      table.dealNext({ holes: holesFor(9), ...THREE_BOARDS });
      playOut(table, allInPicking(3));

      const page = await table.open(VIEWER, screen);
      const hand = '.history details[data-hand="2"]';

      await openFromMenu(page, 'history');
      await page.locator(`${hand} summary`).click();
      await look(page, 'the history');

      await page.locator(`${hand} [data-action="replay"]`).click();
      await replayDrawn(page);
      await page.keyboard.press('End');
      await page.waitForFunction(REPLAY_AT_ITS_END);
      await replayDrawn(page);
      await look(page, 'the replay');
    },
  },
  {
    shows: 'the chat with a GIF in it, the names offered for an @, and the reaction picker',
    async walk(rig, screen, look) {
      const table = tableWithTrophy(rig, 9, EVEN, { actionSeconds: 0 });

      table.dealNext({ holes: holesFor(9), board: ONE_BOARD });
      table.act(WIDEST, { type: 'chat', text: GIF });
      table.act(WIDEST, { type: 'chat', text: `@${VIEWER} ${'a line long enough to go around the corner '.repeat(3)}` });

      const page = await table.open(VIEWER, screen);
      const namesOffered = async (where: string) => {
        await page.locator('#chat-input').click();
        await page.keyboard.type('nice @');
        await page.waitForSelector('#mention-list li');
        await look(page, where);
        await page.locator('#chat-input').fill('');
      };

      // A desktop has the chat beside the table, always open
      if (screen !== 'desktop') {
        await page.locator('.feed-toggle').click();
      }

      await page.waitForSelector('.entries li[data-gif="shown"]');
      await look(page, 'the chat');
      await namesOffered('the names offered');

      // Lying down, the chat stands beside the table with a few lines over its box: the least room the names ever have
      if (screen !== 'desktop') {
        await page.setViewportSize(LYING);
        await namesOffered('the names offered, the phone lying down');
        await page.setViewportSize(SMALL_STANDING);
      }

      // The viewer's turn, when the bar under the table is at its fullest and a small phone's open chat down to its box
      table.play(passive, (view) => view.hand!.toAct === 0);
      await page.waitForSelector('.turn [data-action="fold"]:enabled');
      await namesOffered('the names offered on the viewer’s turn');

      await page.locator('.feed [data-action="reactions"]').click();
      await page.waitForSelector('.react-panel:not([hidden])');
      await look(page, 'the reaction picker');
    },
  },
];

/**
 * A defect the sweep was written after, kept as a look of its own that says what was wrong: the table
 * and the screen it showed on, and which of what that look finds is the defect.
 */
interface KnownDefect {
  /** What has to hold, which names the check. */
  holds: string;
  /** The state of the sweep it showed in. */
  state: TableState;
  seats: number;
  size: Size;
  with: With | null;
  isIt(finding: Finding): boolean;
}

const VIEWERS_CARDS = /\.seat\.at-bottom\[data-seat="0"\] > \.hole/;

const KNOWN_DEFECTS: KnownDefect[] = [
  {
    holds: 'the pot is clear of the viewer’s own cards while three boards are run out on a 360 phone',
    state: TABLE_STATES.thirdBoardRunning,
    seats: 9,
    size: SMALL_STANDING,
    with: null,
    isIt: ({ what }) => /> \.pot\b/.test(what),
  },
  {
    holds: 'the pot is clear of the viewer’s own cards on a 375 phone with the chat open and their bet out',
    state: TABLE_STATES.betsOut,
    seats: 9,
    size: STANDING,
    with: 'the chat open',
    isIt: ({ what }) => /> \.pot\b/.test(what),
  },
  {
    holds: 'a name keeps a few letters beside the host’s star and the high hand’s trophy',
    state: TABLE_STATES.blinds,
    seats: 9,
    size: SMALL_STANDING,
    with: null,
    isIt: ({ kind, what }) => kind === 'cut off' && /\.plate > \.name/.test(what),
  },
  {
    holds: 'a toast of two lines on a 360 phone is over the top bar and nothing of the table',
    state: TABLE_STATES.blinds,
    seats: 9,
    size: SMALL_STANDING,
    with: 'a toast up',
    isIt: ({ by }) => /\.toast\b/.test(by ?? ''),
  },
  {
    holds: 'a thing thrown at the viewer lands clear of their own cards and of the board',
    state: TABLE_STATES.reactions,
    seats: 9,
    size: SMALL_STANDING,
    with: null,
    isIt: ({ what, by }) => /\.seat-reaction/.test(by ?? '') && (VIEWERS_CARDS.test(what) || /\.board\b/.test(what)),
  },
  {
    holds: 'at nine seats on a 360 phone standing, the name of a hand under a seat is clear of the cards of the seat below, and a seat’s cards of the plate above',
    state: TABLE_STATES.showdown,
    seats: 9,
    size: SMALL_STANDING,
    with: 'the table just standing',
    isIt: ({ what, by }) => /\.seat\.at-middle/.test(what) && /\.seat\.at-middle/.test(by ?? ''),
  },
];

const REPLAY_LAST = '.controls [data-action="replay-last"]';

// Run in the page: how much taller the table is with the bar's replay button taken out of the page, which is then put back.
// Measured on the one page as it stands: from one moment of a hand to the next the bar has other reasons to change
const TABLE_GAINS_WITHOUT_THE_BUTTON = `(() => {
  const table = document.querySelector('.stage');
  const button = document.querySelector('${REPLAY_LAST}');
  const [bar, next] = [button.parentNode, button.nextSibling];
  const withIt = table.getBoundingClientRect().height;

  button.remove();
  const without = table.getBoundingClientRect().height;
  bar.insertBefore(button, next);

  return without - withIt;
})()`;

/** The one known defect that was a thing missing, not a thing covered: a way from the table to the hand just played. */
const replayFromTheBar = (picturesIn: string): Check => [
  'a seated player has the hand just played again from the bar under the table: the last on record while they are out of a hand or between hands, and the one whose result is up as soon as it is cleared away, never the one before it; the button costs the table none of its height, and is gone while they play, under a phone’s open chat, beside word of the hands to come, and for a watcher',
  async (rig) => {
    const table = tableWithTrophy(rig, 6, EVEN);
    table.join('Watcher');

    // The second hand, with the viewer in it and waiting on someone else. Paused, so that no third hand is dealt
    // once this one is cleared away
    table.dealNext({ holes: holesFor(6), board: ONE_BOARD });
    table.act(WIDEST, { type: 'pause' });
    const page = await table.open(VIEWER, 'smallPhone');
    await page.waitForSelector('.controls .waiting');
    assert.equal(await page.locator(REPLAY_LAST).count(), 0, 'the bar offers a hand again to a player in the one on the table, where the buttons of their turn go');

    const asksFor = async (number: number, when: string) => {
      await page.waitForSelector(`${REPLAY_LAST}:has-text("Replay hand #${number}")`);
      await settled(page);
      assert.equal(await page.evaluate(TABLE_GAINS_WITHOUT_THE_BUTTON), 0, `the table gave up height to the button, ${when}`);
      await page.screenshot({ path: `${picturesIn}defect-replay-from-the-bar-${pictureName(when)}.png` });

      await page.locator(REPLAY_LAST).click();
    };
    const playsBack = async (number: number, when: string) => {
      await replayDrawn(page);
      assert.match((await page.locator('.replay-head h2').textContent()) ?? '', new RegExp(`^Hand #${number}(?!\\d)`), `the replay is of another hand than the bar said, ${when}`);
      await page.locator('.replay [data-replay="close"]').click();
      await page.waitForSelector('.replay', { state: 'hidden' });
    };

    table.play((view, name) => (name === VIEWER ? { type: 'fold' } : passive(view)), (view) => view.seats[0]!.folded);
    await asksFor(1, 'out of the hand');
    await playsBack(1, 'out of the hand');

    // A phone's open chat has the height the bar kept for a turn, so the button's line would come out of the table's
    await page.locator('.feed-toggle').click();
    await page.waitForSelector(REPLAY_LAST, { state: 'hidden' });
    await page.locator('.feed-toggle').click();
    await page.waitForSelector(REPLAY_LAST, { state: 'visible' });

    // A desktop's bar keeps a lower turn and has shorter buttons
    const desktop = await table.open(VIEWER, 'desktop');
    await desktop.waitForSelector(REPLAY_LAST);
    await settled(desktop);
    assert.equal(await desktop.evaluate(TABLE_GAINS_WITHOUT_THE_BUTTON), 0, 'the table gave up height to the button on the desktop');
    await desktop.close();

    // With its result up the hand on the table is the one just played, and it goes on record only when it is cleared
    // away: asked for now, it plays back by itself then. The last on record meanwhile is the hand before it
    table.play(passive, (view) => view.hand!.stage === 'done');
    await page.waitForSelector('.message.result');
    await asksFor(2, 'with the result of the hand up');

    table.play(() => null, (view) => view.hand === null);
    await playsBack(2, 'asked for with its result up');

    await asksFor(2, 'between hands');
    await playsBack(2, 'between hands');

    // Word of the hands to come has the height the button's line came out of
    table.act(WIDEST, { type: 'setLastHands', hands: LIMITS.lastHands });
    await page.waitForSelector('.controls .next-hand');
    assert.equal(await page.locator(REPLAY_LAST).count(), 0, 'the button shares the bar with word of the hands to come, which can need the height for itself');

    const watcher = await table.open('Watcher', 'smallPhone');
    await watcher.waitForSelector('.controls .waiting');
    assert.equal(await watcher.locator(REPLAY_LAST).count(), 0, 'a watcher’s bar, which keeps no height for a turn, grew a line');
  },
];

// Run in the page: how far the open history is scrolled, and where on the screen the last line of its open hand is
const READERS_PLACE = `(() => {
  const lines = document.querySelector('.history details[open] pre').getBoundingClientRect();

  return { scrolled: document.querySelector('.dialog-body').scrollTop, lastLineAt: Math.round(lines.bottom) };
})()`;

/** The history is what a player opens to look at the hand that just ended, in the seconds before that hand is on record. */
const historyGainsTheHand: Check = [
  'a hand history opened while a hand’s result is still up gains that hand when it is cleared away, without being shut and opened again; the hand its reader had open stays open and the line they were on stays where it was, though the list is full and the new hand pushes the oldest out',
  async (rig) => {
    const table = rig.table(players(3, EVEN), { actionSeconds: 30 });
    const hands = (page: Page) => page.evaluate(`[...document.querySelectorAll('.history details')].map((hand) => hand.dataset.hand + (hand.open ? ' open' : ''))`) as Promise<string[]>;
    const place = (page: Page) => page.evaluate(READERS_PLACE) as Promise<{ scrolled: number; lastLineAt: number }>;
    const [newest, reading] = [HISTORY_LIMIT + 1, HISTORY_LIMIT - 10];

    // As many hands on record as the history holds, and the result of one more up. Paused, so that none is dealt once that one is cleared away
    table.dealNext();
    table.play(folding, (view) => view.hand?.number === newest && view.hand.stage === 'done');
    table.act(WIDEST, { type: 'pause' });

    const page = await table.open(VIEWER, 'smallPhone');
    await page.waitForSelector('.message.result');
    await openFromMenu(page, 'history');
    await page.locator(`.history details[data-hand="${reading}"] summary`).click();
    assert.deepEqual([(await hands(page)).at(0), (await hands(page)).at(-1)], [String(HISTORY_LIMIT), '1'], 'the hand whose result is up is on record already, or the list is not full');

    await page.evaluate(`document.querySelector('.history details[open] summary').scrollIntoView({ block: 'center' })`);
    const before = await place(page);
    assert.ok(before.scrolled > 0, 'the list is too short to scroll, so this shows nothing of the reader’s place');

    table.play(() => null, (view) => view.hand === null);
    await page.waitForSelector(`.history details[data-hand="${newest}"]`);

    const after = await hands(page);
    assert.deepEqual([after.at(0), after.at(-1), after.filter((hand) => hand.endsWith('open'))], [String(newest), '2', [`${reading} open`]]);
    assert.equal((await place(page)).lastLineAt, before.lastLineAt, 'the hand added above moved the line its reader was on');
  },
];

// Run in the page: every mark over a seat that does not stand on the top of that seat's plate, with where each of the two is
const MARKS_OFF_THEIR_SEATS = `[...document.querySelectorAll('.seat-reaction:not([hidden])')].flatMap((mark) => {
  const box = (element) => {
    const { left, top, right, bottom } = element.getBoundingClientRect();

    return { left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(bottom) };
  };
  const plate = document.querySelector('.table .seat[data-seat="' + mark.dataset.seat + '"] .plate');
  const [at, on] = [box(mark), plate && box(plate)];
  const x = (at.left + at.right) / 2;
  const stands = on && x >= on.left && x <= on.right && at.top <= on.top && at.bottom > on.top - (at.bottom - at.top);

  return stands ? [] : [mark.getAttribute('aria-label') + ' is at ' + JSON.stringify(at) + ', and the plate of its seat at ' + JSON.stringify(on)];
})`;

/**
 * The table of a 360 phone held one way up: lying down, or standing at the least height it stands at. Each
 * waits for the page to have laid itself out for the room: standing is two changes of the room, and the
 * table is tall after the first, so its shape alone says nothing of the second.
 */
const PHONE_HELD = {
  lying: async (page: Page) => {
    await page.setViewportSize(LYING);
    await settled(page);
  },
  standing: async (page: Page) => {
    await page.setViewportSize(SMALL_STANDING);
    await setStageHeight(page, Math.ceil(SMALL_STANDING.width / WIDE_ASPECT) + 1);
    await settled(page);
  },
};

/**
 * A mark is placed by where its seat's plate is, and a table that changes shape puts every seat
 * somewhere else. Put back as the room changes, which is before the table is drawn in its new shape,
 * the marks stand where their seats were.
 */
const marksFollowTheTableTurned: Check = [
  'a reaction over a seat and a thing landed on one are over their seats still when the phone is turned on its side, and when it is turned back',
  async (rig) => {
    const table = TABLE_STATES.reactions.build(rig, 9);
    const page = await table.open(VIEWER, 'smallPhone');

    for (const [from, to] of [
      ['standing', 'lying'],
      ['lying', 'standing'],
    ] as const) {
      let off: string[] | null = null;

      // The page takes a mark down on a timer of its own, so a turn that ran long is made again: a few times, never without end
      for (let tries = 0; tries < FLEETING_TRIES && off === null; tries++) {
        await PHONE_HELD[from](page);

        if (!(await reactionsFlying.shown(page))) {
          await reactionsFlying.show(rig, table, page);
        }

        await PHONE_HELD[to](page);
        const found = (await page.evaluate(MARKS_OFF_THEIR_SEATS)) as string[];

        off = (await reactionsFlying.shown(page)) ? found : null;
      }

      assert.ok(off, `the marks were gone before the phone was turned from ${from} to ${to}, ${FLEETING_TRIES} times over`);
      assert.deepEqual(off, [], `turned from ${from} to ${to}`);
    }
  },
];

const AHEAD = '.ahead [data-action^="ahead-"]';

/**
 * Beside a table lying down the open chat goes under the bar, not over it, and gives the side up when
 * the turn comes. Both are for the tap that lands as the action arrives: it must find what plays nothing.
 */
const choicesKeepTheirPlaces: Check = [
  'on a phone lying down, opening the chat leaves the moves to choose ahead where they lay, and when the turn comes every button of it is in sight and none lies where a choice lay',
  async (rig) => {
    const table = waitingBehindTheLongestCall(rig, 9);
    const page = await table.open(VIEWER, 'smallPhone');

    await page.setViewportSize(LYING);
    await page.waitForSelector(AHEAD);
    await settled(page);
    const choices = await boxes(page, AHEAD);
    assert.equal(choices.length, 5, 'the five choices are not all drawn');

    await page.locator('.feed-toggle').click();
    await page.waitForSelector('.feed.open .say');
    await settled(page);
    assert.deepEqual(await boxes(page, AHEAD), choices, 'the choices moved when the chat was opened');

    table.play((_view, name) => (name === VIEWER ? null : { type: 'fold' }), (view) => view.hand!.toAct === 0);
    await page.waitForSelector('.turn [data-action="fold"]:enabled');
    await settled(page);

    const moves = await boxes(page, '.turn .buttons button');
    const { height } = page.viewportSize()!;

    assert.equal(moves.length, 3, 'the buttons of the turn are not all drawn');
    assert.ok(moves.every((move) => move.top >= 0 && move.bottom <= height), `a button of the turn is out of sight with the chat open: ${JSON.stringify(moves)} on a screen ${height} high`);
    assert.ok(!moves.some((move) => choices.some((choice) => overlap(move, choice))), `a button of the turn came up where a choice lay: ${JSON.stringify(moves)}, and the choices ${JSON.stringify(choices)}`);
  },
];

// Run in the page: the lines of words in the bar that its slot's edge cuts through, which read as a fault where a line scrolled away whole does not
const LINES_CUT_BY_THE_BARS_EDGE = `(() => {
  const slot = document.querySelector('.controls-slot').getBoundingClientRect();

  return [...document.querySelectorAll('.controls-slot .waiting > :not(.ahead)')]
    .filter((line) => {
      const box = line.getBoundingClientRect();

      return box.height > 0 && box.top < slot.bottom - 1 && box.bottom > slot.bottom + 1;
    })
    .map((line) => line.textContent);
})()`;

// Run in the page: the buttons of the turn that are not whole on the screen
const MOVES_OUT_OF_SIGHT = `[...document.querySelectorAll('.turn .buttons button')]
  .filter((move) => {
    const box = move.getBoundingClientRect();
    const slot = document.querySelector('.controls-slot').getBoundingClientRect();

    return box.top < slot.top - 1 || box.bottom > Math.min(slot.bottom, innerHeight) + 1;
  })
  .map((move) => move.textContent)`;

// Run in the page: the moves of the turn that a tap somewhere on the chat would reach, where the chat lies over them
const MOVES_REACHED_THROUGH_THE_CHAT = `(() => {
  const chat = document.querySelector('.feed').getBoundingClientRect();
  const reached = new Set();

  for (let x = chat.left + 2; x < chat.right; x += 12) {
    for (let y = chat.top + 2; y < chat.bottom; y += 12) {
      const move = document.elementFromPoint(x, y)?.closest('.turn button');

      if (move) {
        reached.add(move.textContent);
      }
    }
  }

  return [...reached];
})()`;

// Run in the page: whether the chat's list is scrolled to its newest line
const NEWEST_LINE_IN_SIGHT = `(() => {
  const list = document.querySelector('.entries');

  return list.clientHeight > 0 && list.lastElementChild.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1;
})()`;

const UNSENT = 'half a line, not sent';

/**
 * Beside a table lying down there is no room for the chat and a turn's moves at once, and the moves win:
 * the open chat goes down to its bar for the viewer's own turn and comes back by itself. What that must
 * never cost is a line half typed, word that someone named the viewer, or a tap that lands on a move.
 */
const chatMakesWayForTheTurn = (picturesIn: string): Check => [
  'beside a table lying down the open chat goes down to its bar for the viewer’s turn and comes back after it: a line half typed keeps it open until it is sent or left, and is still in the box afterwards; a line naming the viewer is marked on the bar until the chat is back; and when it goes down every move is in sight and none takes a tap where the chat’s box and Send lay',
  async (rig) => {
    const table = waitingBehindTheLongestCall(rig, 9);
    const page = await table.open(VIEWER, 'smallPhone');
    const chatShows = (shows: boolean) => page.waitForSelector('.feed.open .feed-body', { state: shows ? 'visible' : 'hidden' });
    const wholeTurnInSight = async (when: string) => assert.deepEqual(await page.evaluate(MOVES_OUT_OF_SIGHT), [], `a move of the turn is out of sight ${when}`);
    const picture = (of: string) => page.screenshot({ path: `${picturesIn}defect-the-chat-beside-a-table-lying-down-${pictureName(of)}.png` });

    await page.setViewportSize(LYING);
    await page.locator('.feed-toggle').click();
    await chatShows(true);
    await settled(page);
    assert.deepEqual(await page.evaluate(LINES_CUT_BY_THE_BARS_EDGE), [], 'the chat’s edge cuts through a line of the bar above it');
    await picture('open while waiting');

    // Typing as the turn comes: the box is not taken from under the line, and a tap anywhere on the chat is the chat's
    await page.locator('#chat-input').fill(UNSENT);
    table.play(others({ type: 'fold' }), viewersTurn);
    await page.waitForSelector('.turn [data-action="call"]:enabled');
    await chatShows(true);
    await settled(page);
    assert.equal(await page.evaluate(`document.activeElement.id`), 'chat-input', 'the turn took the keyboard out of the chat’s box');
    assert.deepEqual(await page.evaluate(MOVES_REACHED_THROUGH_THE_CHAT), [], 'a tap on the chat reaches a move of the turn under it');
    await picture('kept open by a line half typed');

    // Leaving the box lets the chat go down, and the turn has the side to itself
    await page.evaluate(`document.activeElement.blur()`);
    await chatShows(false);
    await settled(page);
    await wholeTurnInSight('once the chat’s box was left');
    assert.ok(await page.locator('.feed-toggle .latest').isVisible(), 'the chat’s bar does not show its newest line while the chat is down');
    assert.ok(await page.locator('.feed-toggle .named-you').isHidden(), 'the chat’s bar says a line names the viewer when none does');

    // A line that names the viewer leaves its mark on the bar, which a later line does not take away
    table.act(WIDEST, { type: 'chat', text: `@${VIEWER} are you there` });
    await page.waitForSelector('.feed-toggle .named-you');
    table.act(WIDEST, { type: 'chat', text: 'take your time' });
    await page.waitForSelector('.feed-toggle .latest:has-text("take your time")');
    await settled(page);
    assert.ok(await page.locator('.feed-toggle .named-you').isVisible(), 'a later line took the mark of the one that names the viewer off the chat’s bar');
    assert.deepEqual(await unreadable(page), [], 'the turn beside the chat’s bar with its mark');
    await picture('down for the turn');

    // The move made, the chat is back without a tap, with the line that was never sent
    table.act(VIEWER, { type: 'call' });
    await chatShows(true);
    await page.waitForSelector('.feed-toggle .named-you', { state: 'hidden' });
    await settled(page);
    assert.equal(await page.locator('#chat-input').inputValue(), UNSENT, 'the line half typed was lost while the chat was down');
    assert.ok(await page.evaluate(NEWEST_LINE_IN_SIGHT), 'the chat came back somewhere above the lines that arrived while it was down');
    await picture('back after the move');

    // The next turn comes with the keyboard in the box again, and this time the line is sent
    await page.locator('#chat-input').focus();
    table.play((view, name) => (name === VIEWER ? null : passive(view)), viewersTurn);
    await page.waitForSelector('.turn [data-action="check"]:enabled');
    await chatShows(true);
    await settled(page);
    await watchTheBar(page);

    // Sent with a tap on Send, which takes the keyboard from the box as it lands: the chat must not go down under the tap
    await answeredTo(page, 'chat', () => page.locator('.say [type="submit"]').tap());
    await chatShows(false);
    await settled(page);
    await wholeTurnInSight('once the line was sent');
    assert.deepEqual((await cameUp(page)).flatMap(tellingOf), [], 'as the chat went down a control of the bar took a tap where one of the chat’s lay');
    assert.ok(table.view(VIEWER).feed.some((entry) => entry.text === UNSENT), 'the line was not sent');
  },
];

/**
 * Where keys play the moves, a chat that went down with the keyboard in its box would hand the next
 * letter typed to the table, and F folds. There the keyboard in the box keeps the chat open by itself.
 */
const keyboardInTheBoxKeepsTheChat: Check = [
  'beside a table lying down on a device with a keyboard, the keyboard in the chat’s box keeps the chat open through the viewer’s turn, before a letter is typed and after a line is sent, so a letter typed is never a move’s key; leaving the box lets the chat go down, and every move is in sight',
  async (rig) => {
    const table = waitingBehindTheLongestCall(rig, 9);
    const page = await table.open(VIEWER, 'desktop');
    const chatShows = (shows: boolean) => page.waitForSelector('.feed.open .feed-body', { state: shows ? 'visible' : 'hidden' });
    const inTheBox = async (when: string) => assert.ok(await page.evaluate(`document.activeElement.closest('.say') !== null`), `the keyboard was taken out of the chat’s box ${when}`);

    await page.setViewportSize(LYING);
    await page.locator('.feed-toggle').click();
    await chatShows(true);
    await page.locator('#chat-input').focus();

    table.play(others({ type: 'fold' }), viewersTurn);
    await page.waitForSelector('.turn [data-action="call"]:enabled');
    await settled(page);
    await chatShows(true);
    await inTheBox('as the turn came');

    // F is the key that folds
    await page.keyboard.press('f');
    assert.equal(await page.locator('#chat-input').inputValue(), 'f', 'a letter typed did not go into the chat’s box');

    // Sent with a click on Send, which has the keyboard from then on: the chat must not go down under the click, or after it
    await answeredTo(page, 'chat', () => page.locator('.say [type="submit"]').click());
    await page.waitForFunction(`document.querySelector('#chat-input').value === ''`);
    await settled(page);
    await chatShows(true);
    await inTheBox('once the line was sent');
    assert.ok(table.view(VIEWER).feed.some((entry) => entry.text === 'f'), 'the line was not sent');

    await page.evaluate(`document.activeElement.blur()`);
    await chatShows(false);
    await settled(page);
    assert.deepEqual(await page.evaluate(MOVES_OUT_OF_SIGHT), [], 'a move of the turn is out of sight once the chat’s box was left');
    assert.ok(viewersTurn(table.view(VIEWER)), 'the viewer’s turn was played by what they typed');
  },
];

/** A moment the game draws a part of the page anew, by itself: what a finger already on its way down lands on then is the question. */
interface Arrival {
  /** What happens, in words. */
  when: string;
  /** The table a moment before. */
  build(rig: Rig): RigTable;
  /** What brings it. */
  step(table: RigTable): void;
  /** On the page once it has come: a selector, worked out from the table as the step left it where nothing else tells this drawing from the one before. */
  then: string | ((table: RigTable) => string);
  /** The pages hear nothing until the step is all done, so one drawing gives way straight to the next: a slow phone, or a move that got no answer and is found by a later poll. */
  inOneView?: boolean;
  /** What commits for good among what comes up, by what it says: on every screen it takes no tap for the whole settle time from when it is drawn, whatever lay there. */
  forGood?: string;
  /** What the player has open on the page when it comes. */
  open?(page: Page): Promise<void>;
  /** What the table does first, with every page open and before anything is watched, that each page answers by itself: `shows` is on a page that has. */
  first?: { step(table: RigTable): void; shows: string };
  /** What is gone from the page once it has come. */
  gone?: string;
  /** Moves it uncovers, by what they say, each of which is held back on some screen: a wrong tap there is a move. */
  uncovers?: string[];
  /** What it draws anew is a list with a row to a player, each button named for its player: a button that comes up where the same button of another player lay is another control, whatever the page knows it by. */
  rowToAPlayer?: boolean;
  /** Controls, by what they say, that lie where they lay through it: held back on no screen, since nothing came up under a finger there. */
  staysPut?: string[];
}

const TABLE_OF_SIX = 6;
const others = (move: Command) => (_view: TableView, name: string) => (name === VIEWER ? null : move);
const viewersTurn = (view: TableView) => view.hand!.toAct === 0;

/** A hand with the viewer in the big blind, last to act before the flop; `raising` is what the first to act raises to. */
function inTheBigBlind(rig: Rig, config: Partial<TableConfig>, raising?: (view: TableView) => number): RigTable {
  const table = tableWithTrophy(rig, TABLE_OF_SIX, EVEN, { actionSeconds: 30, ...config });

  table.deal({ button: TABLE_OF_SIX - 2, holes: holesFor(TABLE_OF_SIX) });

  if (raising) {
    table.act(WIDEST, { type: 'raise', to: raising(table.view(WIDEST)) });
    table.play(others({ type: 'fold' }), viewersTurn);
  }

  return table;
}

/** The viewer on the button with a raise to them, the two blinds still to act behind. */
function facingTheLongestCall(rig: Rig): RigTable {
  const table = waitingBehindTheLongestCall(rig, TABLE_OF_SIX);

  table.play(others({ type: 'fold' }), viewersTurn);

  return table;
}

/** The viewer has raised from the big blind and waits: when the rest fold, the hand is theirs with both cards face down. */
function raisedFromTheBigBlind(rig: Rig): RigTable {
  const table = inTheBigBlind(rig, { rabbitHunting: true }, () => 60);

  table.act(VIEWER, { type: 'raise', to: 200 });

  return table;
}

const everyoneFolds = (table: RigTable) => table.play(others({ type: 'fold' }), (view) => view.hand!.stage === 'done');

/** The viewer's call, a raise from the next to act and a fold from everyone after: the action is back on the viewer for another decision. */
function callAndIsRaised(table: RigTable): void {
  let raised = false;

  table.act(VIEWER, { type: 'call' });
  table.play((view, name) => {
    if (name === VIEWER) {
      return null;
    }

    if (raised) {
      return { type: 'fold' };
    }

    raised = true;

    return { type: 'raise', to: view.hand!.options!.minRaiseTo };
  }, viewersTurn);
}

/** A table between hands with the viewer a co-host, who has the players' requests to answer and their seats to move. */
function viewerRunsTheTable(rig: Rig): RigTable {
  const table = tableWithTrophy(rig, TABLE_OF_SIX, EVEN);

  table.act(WIDEST, { type: 'setCohost', playerId: table.auth(VIEWER).id, on: true });

  return table;
}

const [FIRST_ASKING, NEXT_ASKING] = ['Alice', 'Bob'];

/** Someone new to the table asks for an open seat. */
function asksForASeat(table: RigTable, name: string, seat: number): void {
  table.join(name);
  table.act(name, { type: 'requestSeat', seat, buyIn: EVEN[0]! });
}

const REQUESTS = '.dialog-body > section:first-child > .rows > li';
// Seat 3 of the table of six, whose row is the third of six and goes to the end when they are moved to the last seat
const MOVED = NAMES[2]!;
const LAST_SEAT = 8;

// The mark a move's button carries for the decision it answers: decisionOf in src/client/render/controls.ts
const decisionMark = (table: RigTable) => `${table.view(VIEWER).hand!.number}.${table.view(VIEWER).hand!.turn}`;

const RECAP = '.dialog[aria-label="Tonight"] .tonight-crown';

/**
 * Every way a part of the page is known to change by itself with controls on it. Something new that
 * comes up by itself, in the bar, a dialog or a banner, gets a row here.
 */
const ARRIVALS: Arrival[] = [
  {
    when: 'the turn comes with a raise to call',
    build: (rig) => waitingBehindTheLongestCall(rig, TABLE_OF_SIX),
    step: (table) => table.play(others({ type: 'fold' }), viewersTurn),
    then: '.turn [data-action="call"]:enabled',
  },
  {
    when: 'the turn comes with nothing to call',
    build: (rig) => inTheBigBlind(rig, {}),
    step: (table) => table.play(others({ type: 'call' }), viewersTurn),
    then: '.turn [data-action="check"]:enabled',
  },
  {
    when: 'the viewer has called and the hand goes on',
    build: facingTheLongestCall,
    step: (table) => table.act(VIEWER, { type: 'call' }),
    then: '.controls .waiting',
  },
  {
    when: 'the viewer has folded and the hand goes on',
    build: facingTheLongestCall,
    step: (table) => table.act(VIEWER, { type: 'fold' }),
    then: '.controls .waiting',
  },
  {
    when: 'the viewer’s fold ends the hand',
    build: (rig) => inTheBigBlind(rig, { rabbitHunting: true }, () => 60),
    step: (table) => table.act(VIEWER, { type: 'fold' }),
    then: '.message.result',
  },
  {
    when: 'the viewer has called all in and is asked how many times to run it',
    build: (rig) => inTheBigBlind(rig, { maxRuns: 3 }, (view) => view.hand!.options!.maxRaiseTo),
    step: (table) => table.act(VIEWER, { type: 'call' }),
    then: '.controls [data-action^="rit-"]',
    forGood: 'Twice',
  },
  {
    when: 'everyone folds to the viewer’s raise while they wait, and the offer to show a card comes',
    build: raisedFromTheBigBlind,
    step: everyoneFolds,
    then: '.controls [data-action="show-card"]',
    forGood: 'Show ',
  },
  {
    when: 'the viewer’s turn is on screen, their call is made away from this page (their other device, the clock, a choice made ahead) and a raise behind it comes in the same view: one decision gives way straight to the next',
    build: facingTheLongestCall,
    step: callAndIsRaised,
    then: (table) => `.turn [data-action="call"][data-keep="${decisionMark(table)}"]`,
    inOneView: true,
  },
  {
    when: 'the night is ended between hands and its recap opens by itself over the table',
    build: (rig) => tableWithTrophy(rig, TABLE_OF_SIX, EVEN),
    step: (table) => table.act(WIDEST, { type: 'endNight' }),
    then: RECAP,
  },
  {
    when: 'the recap that opened by itself when the night ended goes by itself as the night is played on, in the view that deals a hand with the viewer first to act',
    build: (rig) => tableWithTrophy(rig, TABLE_OF_SIX, EVEN, { actionSeconds: 30 }),
    first: { step: (table) => table.act(WIDEST, { type: 'endNight' }), shows: RECAP },
    step(table) {
      table.act(WIDEST, { type: 'playOn' });
      table.deal({ button: TABLE_OF_SIX - 3, holes: holesFor(TABLE_OF_SIX) });
    },
    then: '.turn [data-action="call"]:enabled',
    inOneView: true,
    gone: '.dialog[aria-label="Tonight"]',
    uncovers: ['Fold', 'Call'],
  },
  {
    when: 'a replay opened from the hand history is set aside as the action reaches the viewer, and closes by itself with the history over the turn’s buttons',
    build: (rig) => waitingBehindTheLongestCall(rig, TABLE_OF_SIX),
    async open(page) {
      await openFromMenu(page, 'history');
      await page.locator('.history details[data-hand="1"] summary').click();
      await page.locator('.history details[data-hand="1"] [data-action="replay"]').click();
      await replayDrawn(page);
    },
    step: (table) => table.play(others({ type: 'fold' }), viewersTurn),
    then: '.turn [data-action="call"]:enabled',
    gone: '.replay',
    uncovers: ['Fold', 'Call'],
  },
  {
    when: 'a replay opened from the bar, with no dialog under it, is set aside as a hand is dealt with the viewer first to act',
    build: (rig) => tableWithTrophy(rig, TABLE_OF_SIX, EVEN, { actionSeconds: 30 }),
    async open(page) {
      // Under a phone's open chat the bar has no such button, and there the turn comes as it does anywhere
      if (await page.locator(REPLAY_LAST).isVisible()) {
        await page.locator(REPLAY_LAST).click();
        await replayDrawn(page);
      }
    },
    step: (table) => table.deal({ button: TABLE_OF_SIX - 3, holes: holesFor(TABLE_OF_SIX) }),
    then: '.turn [data-action="call"]:enabled',
    gone: '.replay',
    uncovers: ['Fold', 'Call'],
  },
  {
    when: 'the night’s numbers, open over a full table and scrolled to their end by a reader, are drawn anew where the reader has them as a hand ends',
    build: (rig) => waitingBehindTheLongestCall(rig, 9),
    async open(page) {
      await openFromMenu(page, 'tonight');
      await page.locator('.dialog-body summary').last().scrollIntoViewIfNeeded();

      // Nine players' rows are more than a phone lying down shows at once: there the dialog is drawn anew out of the place it is first drawn in
      if (page.viewportSize()!.height <= LYING.height) {
        assert.ok(((await page.evaluate(`document.querySelector('.dialog-body').scrollTop`)) as number) > 0, 'the night’s numbers are too short to scroll beside a table lying down');
      }
    },
    step: (table) => table.play(folding, (view) => view.hand!.stage === 'done'),
    then: '.message.result',
  },
  {
    when: 'the first of two requests for a seat is withdrawn with the list of players open, and the other’s Approve and Deny move up to where its own lay',
    build(rig) {
      const table = viewerRunsTheTable(rig);

      asksForASeat(table, FIRST_ASKING, 6);
      asksForASeat(table, NEXT_ASKING, 7);

      return table;
    },
    open: (page) => openFromMenu(page, 'players'),
    step: (table) => table.act(FIRST_ASKING, { type: 'cancelRequest' }),
    then: `${REQUESTS}:only-child`,
    rowToAPlayer: true,
  },
  {
    when: 'a request for a seat comes in with the list of players open, and every seated player’s buttons move down under it',
    build: viewerRunsTheTable,
    open: (page) => openFromMenu(page, 'players'),
    step: (table) => asksForASeat(table, FIRST_ASKING, 6),
    then: '.dialog [data-action="deny"]',
    rowToAPlayer: true,
  },
  {
    when: 'a player is moved to the last seat with the list of players open, and the rows after theirs move up',
    build: viewerRunsTheTable,
    open: (page) => openFromMenu(page, 'players'),
    step: (table) => table.act(WIDEST, { type: 'moveSeat', playerId: table.auth(MOVED).id, seat: LAST_SEAT }),
    then: `.dialog-body .rows > li:last-child:has-text("seat ${LAST_SEAT + 1}")`,
    rowToAPlayer: true,
  },
  {
    when: 'someone whose name comes first joins the table with Mute players open, and every switch moves down a row',
    build: (rig) => tableWithTrophy(rig, TABLE_OF_SIX, EVEN),
    open: (page) => openFromMenu(page, 'mute'),
    step: (table) => table.join('Aaron'),
    then: '.dialog .rows > li:first-child:has-text("Aaron")',
    rowToAPlayer: true,
  },
  {
    when: 'a hand ends with the night’s numbers open and two players change places in them, under a leader who stays where they were',
    build: (rig) => waitingBehindTheLongestCall(rig, TABLE_OF_SIX),
    open: (page) => openFromMenu(page, 'tonight'),
    step: (table) => table.play(folding, (view) => view.hand!.stage === 'done'),
    then: '.message.result',
    staysPut: [WIDEST],
  },
];

// A hold is timed from when the watch first sees its button held, which is before the page is free again and the
// hold's time begins: it is never seen short, but for what two readings of a clock round off
const CLOCK_ROUNDS_MS = 5;

/**
 * The hold each button was let go from for good. A bar drawn again while a button is held hands the rest
 * of the time on to the new button, which is seen held once more: only the last of them runs to the end.
 */
const ranOut = (held: Held[]): Held[] => held.filter((one, at) => held.slice(at + 1).every((later) => (later.is ?? later.what) !== (one.is ?? one.what)));

/** The holds that were let go and taken up again by the same button inside one hold's time, with how long the button took a tap in between. */
const letGoBetween = (held: Held[]): { hold: Held; live: number }[] =>
  held.flatMap((hold, at) => {
    const next = held.slice(at + 1).find((later) => (later.is ?? later.what) === (hold.is ?? hold.what));
    const live = next && hold.lasted !== null ? next.from - (hold.from + hold.lasted) : 0;

    return live > CLOCK_ROUNDS_MS && live < TAPS_SETTLE_MS ? [{ hold, live }] : [];
  });

const letGoEarly = (held: Held[]): string[] => [
  ...ranOut(held)
    .filter((one) => one.sinceFirst !== null && one.sinceFirst < TAPS_SETTLE_MS - CLOCK_ROUNDS_MS)
    .map((one) => `  ${one.what} was let go ${Math.round(one.sinceFirst ?? 0)} ms after it first came up`),
  ...letGoBetween(held).map(({ hold, live }) => `  ${hold.what} took a tap for ${Math.round(live)} ms in the middle of its hold`),
];

/**
 * The checks of what comes up under a finger, one for each arrival, on every screen with the chat shut
 * and open: a control that comes up where a different control lay must not be what a tap made in that
 * moment reaches, and such a tap must do nothing at all. The page is tapped on every control it holds
 * back, the moment it does (underTheFinger.ts).
 */
export const underTheFinger = (): Check[] =>
  ARRIVALS.map((arrival): Check => [
    `no control takes a tap where another control lay the moment before: ${arrival.when}, on a 360 and a 375 phone standing and lying, the chat shut and open, and on the desktop`,
    async (rig) => {
      const table = arrival.build(rig);
      const screens = [...PHONES.flatMap((size) => [{ size, chat: false }, { size, chat: true }]), { size: null, chat: false }];

      const opened = await Promise.all(
        screens.map(async ({ size, chat }) => {
          const page = await table.open(VIEWER, size ? 'smallPhone' : 'desktop');

          if (size) {
            await page.setViewportSize(size);
          }

          await page.waitForSelector('.controls-slot .controls');

          if (chat) {
            await page.locator('.feed-toggle').click();
            await page.waitForSelector('.feed.open');
          }

          await settled(page);
          await arrival.open?.(page);

          return { page, size, chat };
        }),
      );

      if (arrival.first) {
        const { step, shows } = arrival.first;

        step(table);
        await Promise.all(opened.map(({ page }) => page.waitForSelector(shows).then(() => settled(page))));
      }

      const pages = await Promise.all(
        opened.map(async ({ page, size, chat }) => {
          const sent = opsSent(page);
          const polls = arrival.inOneView ? await Gate.on(page, 'polls') : null;

          await watchTheBar(page, arrival.rowToAPlayer);
          await polls?.close('requests');

          return { page, sent, polls, where: `${size?.name ?? 'desktop'}${chat ? ', the chat open' : ''}` };
        }),
      );

      if (arrival.gone) {
        const there = await Promise.all(pages.map(({ page }) => page.locator(arrival.gone!).isVisible()));

        assert.ok(there.some(Boolean), `what is to go (${arrival.gone}) was on no screen to begin with: the arrival no longer shows what it is here for`);
      }

      arrival.step(table);
      await Promise.all(pages.map(({ polls }) => polls?.open()));

      const then = typeof arrival.then === 'string' ? arrival.then : arrival.then(table);
      const wrong: string[] = [];
      let cameUpAnywhere = 0;
      let heldForGood = 0;

      const heldSomewhere = new Set<string>();

      for (const { page, sent, where } of pages) {
        if (arrival.gone) {
          await page.waitForSelector(arrival.gone, { state: 'hidden' });
        }

        await page.waitForSelector(then);
        await settled(page);

        const { found, held, liveAtOnce } = await watched(page);
        const here = found.flatMap(tellingOf);
        const forGood = arrival.forGood;

        cameUpAnywhere += found.length;
        held.forEach((one) => heldSomewhere.add(one.what));

        if (sent.includes('act')) {
          here.push('  a tap on a control that was held back reached the table all the same');
        }

        here.push(...held.filter((one) => one.sameLetGo === false).map((one) => `  ${one.what} is not the control it was once let go`));
        here.push(...held.filter((one) => (arrival.staysPut ?? []).some((says) => one.what.includes(says))).map((one) => `  ${one.what} took no tap for a moment, and lies where it lay`));

        if (forGood !== undefined) {
          const commits = held.filter((one) => one.what.includes(forGood));

          heldForGood += commits.length;
          here.push(...liveAtOnce.filter((said) => said.includes(forGood)).map((said) => `  ${said} took a tap the moment it came up`));
          here.push(...letGoEarly(commits));
        }

        wrong.push(...(here.length > 0 ? [`${where}:`, ...here] : []));
      }

      assert.equal(wrong.length, 0, `a tap lands on what it was not aimed at\n${wrong.join('\n')}`);
      assert.ok(cameUpAnywhere > 0, 'nothing came up where another control lay, on any screen: the arrival no longer shows what it is here for');
      assert.ok(arrival.forGood === undefined || heldForGood > 0, `“${arrival.forGood}” was held back on no screen: the arrival no longer shows what it is here for`);

      for (const move of arrival.uncovers ?? []) {
        assert.ok([...heldSomewhere].some((what) => what.includes(move)), `${move} was uncovered and held back on no screen: ${[...heldSomewhere].join(', ')}`);
      }
    },
  ]);

/** A tap of the player's own that brings another control up where the tapped one lay. The button tapped is switched off until the table answers, and is still what the second tap of two is on its way to. */
interface OwnTap {
  when: string;
  build(rig: Rig): RigTable;
  /** The button tapped. */
  tap: string;
  /** What the tap sends the table. */
  sends: Command['type'];
  /** On the page once the table has answered. */
  then: string;
}

const OWN_TAPS: OwnTap[] = [
  {
    when: 'one of two cards is shown and the offer of the other moves into its place',
    build(rig) {
      const table = raisedFromTheBigBlind(rig);

      everyoneFolds(table);

      return table;
    },
    tap: '.controls [data-action="show-card"][data-place="0"]',
    sends: 'showCards',
    then: '.show-cards:not(:has([data-place="0"])) [data-place="1"]',
  },
  {
    when: 'a player sitting out says they are back and the switch to sit out comes up in its place',
    build(rig) {
      const table = tableWithTrophy(rig, TABLE_OF_SIX, EVEN);

      table.act(VIEWER, { type: 'sitOut' });

      return table;
    },
    tap: '.controls [data-action="sit-in"]',
    sends: 'sitIn',
    then: '.controls [data-action="sit-out"]',
  },
];

const secondTapFindsNothingNew = OWN_TAPS.map((own): Check => [
  `the second tap of two lands on nothing the first one brought up: ${own.when}, on a 360 phone standing and lying`,
  async (rig) => {
    for (const size of [SMALL_STANDING, LYING]) {
      const table = own.build(rig);
      const page = await table.open(VIEWER, 'smallPhone');

      await page.setViewportSize(size);
      await page.waitForSelector(own.tap);
      await settled(page);

      const sent = opsSent(page);

      await watchTheBar(page);
      await answeredTo(page, own.sends, () => page.locator(own.tap).tap());
      await page.waitForSelector(own.then);

      const { found } = await watched(page);

      assert.ok(found.length > 0, `${size.name}: nothing came up where the tapped button lay: the tap no longer shows what it is here for`);
      assert.deepEqual(found.flatMap(tellingOf), [], `${size.name}: a second tap lands on what the first one brought up`);
      assert.equal(sent.filter((op) => op === 'act').length, 1, `${size.name}: the table was sent something other than the one tap`);
      await page.close();
    }
  },
]);

/** A tap of the player's own whose answer brings up a button that commits for good. */
interface CommitsAfter {
  what: string;
  build(rig: Rig): RigTable;
  tap: string;
  /** The requests the tap makes, held at a gate. */
  asks: 'moves' | 'shows';
  then: string;
  /** The button that commits, by what it says. */
  commits: string;
}

// How much longer than a hold lasts the answer is kept back
const KEPT_PAST_A_HOLD_MS = 100;

const COMMITS_AFTER: CommitsAfter[] = [
  {
    what: 'the vote on how many times to run it, after a call all in',
    build: (rig) => inTheBigBlind(rig, { maxRuns: 3 }, (view) => view.hand!.options!.maxRaiseTo),
    tap: '.turn [data-action="call"]',
    asks: 'moves',
    then: '.controls [data-action^="rit-"]',
    commits: 'Twice',
  },
  {
    what: 'the offer of the other card, after one is shown',
    build(rig) {
      const table = raisedFromTheBigBlind(rig);

      everyoneFolds(table);

      return table;
    },
    tap: '.controls [data-action="show-card"][data-place="0"]',
    asks: 'shows',
    then: '.show-cards:not(:has([data-place="0"])) [data-place="1"]',
    commits: 'Show ',
  },
];

/**
 * The deployed server takes a second or two to answer, far longer than a hold lasts. A hold counted from
 * the tap that led to a button would be over before the button was drawn: here the answer is kept back
 * for longer than a hold, the one wait of a length of time in these checks, and the button still waits
 * its whole time from when it is drawn.
 */
const commitsWaitFromWhenTheyAreDrawn: Check = [
  `a button whose tap cannot be taken back takes no tap for ${TAPS_SETTLE_MS} ms from when it is drawn, however long the answer that brought it took: ${COMMITS_AFTER.map((one) => one.what).join(', and ')}`,
  async (rig) => {
    for (const { what, build, tap, asks, then, commits } of COMMITS_AFTER) {
      const table = build(rig);
      const page = await table.open(VIEWER, 'smallPhone');

      await page.setViewportSize(SMALL_STANDING);
      await page.waitForSelector(`${tap}:enabled`);
      await settled(page);

      const answers = await Gate.on(page, asks);
      const polls = await Gate.on(page, 'polls');

      await watchTheBar(page);
      await answers.close('answers');
      await polls.close('requests');
      await page.locator(tap).tap();
      await answers.holding();
      await page.evaluate(`new Promise((done) => setTimeout(done, ${TAPS_SETTLE_MS + KEPT_PAST_A_HOLD_MS}))`);
      await answers.open();
      await polls.open();
      await page.waitForSelector(then);

      const { found, held, liveAtOnce } = await watched(page);
      const waited = held.filter((one) => one.what.includes(commits));

      assert.deepEqual(liveAtOnce.filter((said) => said.includes(commits)), [], `${what}: it took a tap the moment it was drawn`);
      assert.ok(waited.length > 0, `${what}: it was not held back: ${JSON.stringify(held)}`);
      assert.deepEqual(letGoEarly(waited), [], `${what}: it was let go before its time`);
      assert.deepEqual(found.flatMap(tellingOf), [], `${what}: a tap lands on what it was not aimed at`);
      await page.close();
    }
  },
];

// Run in the page: taps where the first request's Approve lies, the moment the banners are next drawn anew
const TAP_THE_FIRST_APPROVE_AS_THE_BANNERS_CHANGE = `(() => {
  const box = document.querySelector('.banners [data-action="approve"]').getBoundingClientRect();

  new MutationObserver((_changes, watch) => {
    watch.disconnect();
    document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2)?.click();
  }).observe(document.querySelector('.banners'), { childList: true, subtree: true });
})()`;

/**
 * Rows of one kind are the hard case: every row has an Approve, and the next row's moves up into the
 * place of one that goes. Each says whose it is, or the page takes one for the other and a host's tap
 * seats a player they never meant to.
 */
const aRowThatMovesUpIsHeld: Check = [
  'a host reaching for one player’s Approve as that request goes does not approve the next player’s, whose row has moved up under the tap, on a 360 phone and the desktop',
  async (rig) => {
    for (const screen of ['smallPhone', 'desktop'] as const) {
      const table = tableWithTrophy(rig, TABLE_OF_SIX, EVEN);

      table.join('Alice');
      table.join('Bob');
      table.act('Alice', { type: 'requestSeat', seat: TABLE_OF_SIX, buyIn: 1000 });
      table.act('Bob', { type: 'requestSeat', seat: TABLE_OF_SIX + 1, buyIn: 1000 });

      const page = await table.open(WIDEST, screen);
      const sent = opsSent(page);

      await page.waitForFunction(`document.querySelectorAll('.banners [data-action="approve"]').length === 2`);
      await settled(page);
      await page.evaluate(TAP_THE_FIRST_APPROVE_AS_THE_BANNERS_CHANGE);

      table.act('Alice', { type: 'cancelRequest' });
      await page.waitForFunction(`document.querySelectorAll('.banners [data-action="approve"]').length === 1`);
      await tapsLive(page);

      assert.ok(!sent.includes('act'), `${screen}: the tap for Alice’s Approve was taken by the row that moved up`);
      assert.ok(!table.view(WIDEST).seats.some((seat) => seat?.name === 'Bob'), `${screen}: Bob was seated by a tap meant for Alice’s request`);
      await page.close();
    }
  },
];

// How many times the bar is drawn again while one of its buttons is held, and how late a hold may end on a busy machine
const REDRAWS_IN_A_HOLD = 12;
const LET_GO_LATE_MS = 250;

/** A button that is held back as it comes up. */
interface HeldAsItComes {
  what: string;
  size: (typeof PHONES)[number];
  build(rig: Rig): RigTable;
  step(table: RigTable): void;
  then: string;
  /** The button, by what it says. */
  held: string;
}

const HELD_AS_THEY_COME: HeldAsItComes[] = [
  {
    what: 'Raise, which comes up where a switch lay beside a table lying down',
    size: LYING,
    build: (rig) => waitingBehindTheLongestCall(rig, TABLE_OF_SIX),
    step: (table) => table.play(others({ type: 'fold' }), viewersTurn),
    then: '.turn [data-action="call"]:enabled',
    held: 'Raise',
  },
  {
    what: 'the offer to show a card, which commits for good',
    size: SMALL_STANDING,
    build: raisedFromTheBigBlind,
    step: everyoneFolds,
    then: '.controls [data-action="show-card"]',
    held: 'Show ',
  },
];

const heldAsTheyCome = HELD_AS_THEY_COME.map((one) => one.what).join('; ');

/** Opens the viewer's page as they wait, at the size the button is held at. */
async function waitingAt({ build, size }: HeldAsItComes, rig: Rig): Promise<{ table: RigTable; page: Page }> {
  const table = build(rig);
  const page = await table.open(VIEWER, 'smallPhone');

  await page.setViewportSize(size);
  await page.waitForSelector('.controls .waiting');
  await settled(page);

  return { table, page };
}

// How long a slow phone may take over drawing what a view brought: most of a hold
const DRAWING_TAKES_MS = 250;

// Run in the page, before the watch begins so that the watch first sees a hold once this is over: keeps the page busy,
// in the task that draws what `selector` finds, for as long as a slow phone takes to lay such a drawing out
const BUSY_AS_IT_DRAWS = `(({ selector, busy }) => {
  new MutationObserver((_changes, watch) => {
    if (document.querySelector(selector)) {
      watch.disconnect();

      for (const until = performance.now() + busy; performance.now() < until; ) {}

      window.__keptBusy = true;
    }
  }).observe(document.body, { childList: true, subtree: true });
})`;

/**
 * A hold lasts as long as it takes to see that the page has changed, so its time begins when the page is
 * free to show the change and to take a tap, not when the drawing began. A slow phone, or a machine
 * running these checks four at a time, takes a good part of a hold to lay out what a hand's end
 * brought: counted from before that, a hold is over almost as soon as its button can be tapped.
 */
const aHoldRunsFromWhenThePageIsFree: Check = [
  `a button held back takes no tap for ${TAPS_SETTLE_MS} ms from when the page is free again, though drawing what brought it kept the page busy for ${DRAWING_TAKES_MS} ms: ${heldAsTheyCome}`,
  async (rig) => {
    for (const one of HELD_AS_THEY_COME) {
      const { table, page } = await waitingAt(one, rig);

      await page.evaluate(`${BUSY_AS_IT_DRAWS}(${JSON.stringify({ selector: one.then, busy: DRAWING_TAKES_MS })})`);
      await watchTheBar(page);

      one.step(table);
      await page.waitForSelector(one.then);

      const ones = (await watched(page)).held.filter((hold) => hold.what.includes(one.held));

      assert.ok(await page.evaluate('window.__keptBusy === true'), `${one.what}: the page was not kept busy as it drew: the check no longer shows what it is here for`);
      assert.ok(ones.length > 0, `${one.what}: it was not held back`);
      assert.deepEqual(letGoEarly(ones), [], `${one.what}: it was let go before its time, counted from when the page was free to take a tap`);
      await page.close();
    }
  },
];

/**
 * A hold has one clock, started when its control first came up. A bar drawn again meanwhile, as it is
 * when a hand's end reaches a busy page in two views, hands the hold on to the new button with the rest
 * of its time: it must neither start over, which under steady news would hold a button for good, nor
 * end early, nor be left on something nobody lets go of.
 */
const aHoldRunsOutOnTime: Check = [
  `a button held back is let go ${TAPS_SETTLE_MS} ms after it first came up, neither sooner nor later, though its bar is drawn again and again meanwhile, and a second after the last drawing nothing on the page is held: ${heldAsTheyCome}`,
  async (rig) => {
    for (const one of HELD_AS_THEY_COME) {
      const { table, page } = await waitingAt(one, rig);

      await watchTheBar(page);
      one.step(table);
      await page.waitForSelector(one.then);

      // The viewer's own switch, thrown from their other device, draws the bar anew each time with every button where it was
      for (let nth = 0; nth < REDRAWS_IN_A_HOLD; nth += 1) {
        table.act(VIEWER, { type: 'setStraddle', kind: 'straddle', on: nth % 2 === 0 });
        await page.waitForSelector(`.controls [data-action="straddle"][aria-checked="${nth % 2 === 0}"]`);
      }

      const ones = (await watched(page)).held.filter((hold) => hold.what.includes(one.held));
      const last = ranOut(ones);
      const drawnAgain = ones.filter((hold) => !last.includes(hold));

      assert.ok(ones.length > 0, `${one.what}: it was not held back`);
      // A stalled page hears of the switch too late to be drawn again inside the hold
      assert.ok(STALL_MS > 0 || drawnAgain.length > 0, `${one.what}: the bar was not drawn again while it was held: the check no longer shows what it is here for`);
      assert.deepEqual(letGoEarly(ones), [], `${one.what}: it was let go before its time`);
      assert.deepEqual(last.filter((hold) => hold.sinceFirst !== null && hold.sinceFirst > TAPS_SETTLE_MS + LET_GO_LATE_MS), [], `${one.what}: it was held longer than its time from when it first came up`);

      // Had the time begun anew with each drawing, the button drawn last would have waited the whole of it by itself
      if (drawnAgain.length > 0) {
        assert.deepEqual(last.filter((hold) => hold.lasted !== null && hold.lasted >= TAPS_SETTLE_MS - CLOCK_ROUNDS_MS), [], `${one.what}: drawn again while held, it began its time anew`);
      }

      await page.evaluate(`new Promise((done) => setTimeout(done, 1000))`);
      assert.equal(await page.evaluate(`document.querySelectorAll('.taps-settling').length`), 0, `${one.what}: a second after the last drawing something on the page is still held`);
      await page.close();
    }
  },
];

// How late a timer may come in a tab that is not in front
const HIDDEN_TIMERS_MS = 1000;

// Run in the page: timers as a tab in the background has them, none sooner than the next whole second
const TIMERS_AS_WHEN_HIDDEN = `(() => {
  const real = window.setTimeout;

  window.setTimeout = (run, wait = 0, ...given) => real(run, Math.ceil((performance.now() + wait) / ${HIDDEN_TIMERS_MS}) * ${HIDDEN_TIMERS_MS} - performance.now(), ...given);
})()`;

/**
 * A page goes on drawing in a tab that is not in front, and its timers are slowed to one a second, not
 * stopped. A hold begun there must still end by itself: a player who comes back to the tab must not find
 * a button that takes no tap. The checks' browser cannot hide a page, so the page is given such timers.
 */
const aPageInTheBackgroundLetsGo: Check = [
  `a button held back by a page in the background, where a timer comes once a second, is let go all the same, and not before its time: ${HELD_AS_THEY_COME[0]!.what}`,
  async (rig) => {
    const [one] = HELD_AS_THEY_COME;
    const { table, page } = await waitingAt(one!, rig);

    await watchTheBar(page);
    await page.evaluate(TIMERS_AS_WHEN_HIDDEN);

    one!.step(table);
    await page.waitForSelector(one!.then);

    const ones = (await watched(page)).held.filter((hold) => hold.what.includes(one!.held));

    assert.ok(ones.length > 0, `${one!.what}: it was not held back`);
    assert.deepEqual(letGoEarly(ones), [], `${one!.what}: it was let go before its time`);
    // One slowed timer begins the hold's time and a second ends it
    assert.deepEqual(ranOut(ones).filter((hold) => hold.sinceFirst === null || hold.sinceFirst > 2 * HIDDEN_TIMERS_MS + TAPS_SETTLE_MS + LET_GO_LATE_MS), [], `${one!.what}: it was not let go in the time two slowed timers take`);
    await page.close();
  },
];

/**
 * The other side of the same rule: a tap is held back only where a different control lay, and only for
 * a moment. A player who is ready when their turn comes must not be slowed, so the moves that come up
 * over the words of the bar, as all of them do on a phone standing and on the desktop, are live at once,
 * and a bar drawn again with the same buttons in the same places holds nothing back.
 */
const onlyWhatCameUpOverAnotherIsHeld: Check = [
  `a turn’s Fold and Call take a tap the moment they come up over the bar’s words, on a 360 phone standing and on the desktop, and a bar drawn again on that turn with the same buttons in the same places holds nothing back; beside a table lying down the Raise that comes up where a switch lay takes no tap for ${TAPS_SETTLE_MS} ms and then does`,
  async (rig) => {
    const [arrival] = ARRIVALS;
    const table = arrival!.build(rig);

    const pages = await Promise.all(
      [SMALL_STANDING, LYING, null].map(async (size) => {
        const page = await table.open(VIEWER, size ? 'smallPhone' : 'desktop');

        if (size) {
          await page.setViewportSize(size);
        }

        await page.waitForSelector('.controls .waiting');
        await settled(page);
        await watchTheBar(page);

        return { page, lying: size === LYING, where: size?.name ?? 'desktop' };
      }),
    );

    arrival!.step(table);

    for (const { page, lying, where } of pages) {
      await page.waitForSelector(arrival!.then as string);

      const { held, liveAtOnce } = await watched(page);

      if (lying) {
        const raise = held.filter((one) => one.what.includes('Raise'));

        assert.ok(raise.length > 0, `${where}: Raise came up where “Sit out next hand” lay and was not held back: ${JSON.stringify(held)}`);
        assert.deepEqual(letGoEarly(raise), [], `${where}: Raise was let go before the moment was over`);
        continue;
      }

      assert.deepEqual(held.filter((one) => /Fold|Call|Raise/.test(one.what)), [], `${where}: a move of the turn was held back with no other control under it`);

      for (const move of ['Fold', 'Call']) {
        assert.ok(liveAtOnce.some((said) => said.includes(move)), `${where}: ${move} did not take a tap the moment it came up: ${JSON.stringify(liveAtOnce)}`);
      }
    }

    // The viewer's own switch draws the bar again on their turn, every button where it was
    const heldBefore = await Promise.all(pages.map(async ({ page }) => (await watched(page)).held.length));

    table.act(VIEWER, { type: 'setStraddle', kind: 'straddle', on: true });

    for (const [nth, { page, where }] of pages.entries()) {
      await page.waitForSelector('.controls [data-action="straddle"][aria-checked="true"]');
      assert.equal((await watched(page)).held.length, heldBefore[nth], `${where}: a button was held back when the bar was drawn again with every button where it was`);
    }
  },
];

// Run in the page: puts a box over the pot that a tap passes through, as a landed throw or a toast is, and says what a tap on it reaches
const COVER_THE_POT = `(() => {
  const pot = document.querySelector('.pot').getBoundingClientRect();
  const cover = document.createElement('div');

  cover.className = 'stand-in-for-a-decoration';
  cover.style.cssText = 'position: fixed; z-index: 99999; pointer-events: none; background: rgb(0, 0, 0); left: ' + pot.left + 'px; top: ' + pot.top + 'px; width: ' + pot.width + 'px; height: ' + pot.height + 'px';
  document.body.append(cover);

  return document.elementFromPoint(pot.left + pot.width / 2, pot.top + pot.height / 2) === cover;
})()`;

/**
 * The look, held to what it claims. Asking the page what is on top at a point leaves out everything a
 * tap passes through, and the things most likely to lie on what is read are exactly those: a landed
 * throw, a reaction's mark, a toast. The look makes every element take the tap while it looks.
 */
const lookSeesWhatATapPassesThrough: Check = [
  'the look finds the pot unreadable under a box that taps pass through',
  async (rig) => {
    const table = tableWithTrophy(rig, TABLE_OF_SIX, EVEN);

    table.dealNext({ holes: holesFor(TABLE_OF_SIX) });
    const page = await table.open(VIEWER, 'desktop');
    await page.waitForSelector('.pot');
    await settled(page);
    assert.deepEqual(await unreadable(page), [], 'the table is not clear to begin with');

    assert.equal(await page.evaluate(COVER_THE_POT), false, 'a tap on the box reaches the box, so it is no stand-in for what a tap passes through');

    const found = await unreadable(page);
    assert.ok(found.some((one) => one.kind === 'covered' && one.what.includes('.pot') && one.by?.includes('stand-in-for-a-decoration')), `the pot under the box was not found: ${JSON.stringify(found)}`);
  },
];

const STAGE_HEIGHT = `document.querySelector('.stage').getBoundingClientRect().height`;

/** The bar that waits has more to say than the bar of a turn, and must not be the taller for it: the table would jump as the turn came. */
const barKeepsTheTurnsHeight = (picturesIn: string): Check => [
  'the bar of a player waiting with the moves to choose ahead, word of the hands to come and of a straddle passed over, each at its longest, is as tall as the bar of their turn, on a 360 phone and the desktop',
  async (rig) => {
    const table = waitingWithEveryNote(rig, 9);
    const pages = [await table.open(VIEWER, 'smallPhone'), await table.open(VIEWER, 'desktop')];
    const waiting: number[] = [];

    for (const page of pages) {
      await page.waitForSelector('.waiting.choosing .straddle-note');
      assert.equal(await page.locator('.waiting.choosing .straddle-note .named').count(), 1, 'the straddle was passed over for another reason than a player’s right, so the note names nobody');
      assert.equal(await page.locator('.waiting.choosing .next-hand span').count(), 2, 'the bar does not say both how many hands are left and that the next is a bomb pot');
      await settled(page);
      waiting.push((await page.evaluate(STAGE_HEIGHT)) as number);
    }

    await pages[0]!.screenshot({ path: `${picturesIn}defect-the-bar-of-a-player-waiting-with-every-note.png` });
    table.play((_view, name) => (name === VIEWER ? null : { type: 'call' }), (view) => view.hand!.toAct === 0);

    for (const [nth, page] of pages.entries()) {
      await page.waitForSelector('.turn [data-action="fold"]:enabled');
      await settled(page);
      assert.equal(await page.evaluate(STAGE_HEIGHT), waiting[nth], `the table changed height as the turn came, ${nth === 0 ? 'on a 360 phone' : 'on the desktop'}`);
    }
  },
];

/** The checks of the sweep. Pictures of what a look finds, and of the state each known defect showed in, go into `picturesIn`, a folder ending in a slash. */
export function layoutSweep(picturesIn: string): Check[] {
  const tables = Object.values<TableState>(TABLE_STATES).map((state): Check => [
    `nothing a player reads is covered: ${state.shows}, at ${state.seats.join(', ').replace(/, (\d+)$/, ' and $1')} seats, on a 360 and a 375 phone standing and lying and on the desktop`,
    async (rig) => {
      const sweep = new Sweep(picturesIn, state.shows.slice(0, 40));

      for (const seats of state.seats) {
        await sweepTable(sweep, rig, state.build(rig, seats), state, seats).catch((error: unknown) => {
          throw new Error(`at ${seats} seats`, { cause: error });
        });
      }

      sweep.done();
    },
  ]);

  const screens = SCREEN_STATES.map((state): Check => [
    `nothing a player reads is covered: ${state.shows}, on a 360 phone and the desktop`,
    async (rig) => {
      const sweep = new Sweep(picturesIn, state.shows.slice(0, 40));

      state.known?.(rig);

      for (const screen of OTHER_SCREENS) {
        await state.walk(rig, screen, (page, where) => sweep.lookThrough(page, `${where}, ${screen === 'desktop' ? 'desktop' : 'a 360 phone'}`));
      }

      sweep.done();
    },
  ]);

  const defects = KNOWN_DEFECTS.map((defect): Check => [
    defect.holds,
    async (rig) => {
      const state: TableState = defect.state;
      const table = state.build(rig, defect.seats);
      const page = await table.open(VIEWER, 'smallPhone');
      let found: Finding[] = [];

      await state.onPage?.(page);
      await page.setViewportSize(defect.size);
      await lookWith(page, defect.size, defect.with, async () => {
        found = (await unreadableOn(page, rig, table, state)).filter(defect.isIt);
        await page.screenshot({ path: `${picturesIn}defect-${pictureName(defect.holds.slice(0, 60))}.png` });
      });

      assert.deepEqual(found, []);
    },
  ]);

  return [...defects, replayFromTheBar(picturesIn), historyGainsTheHand, barKeepsTheTurnsHeight(picturesIn), choicesKeepTheirPlaces, chatMakesWayForTheTurn(picturesIn), keyboardInTheBoxKeepsTheChat, lookSeesWhatATapPassesThrough, ...underTheFinger(), ...secondTapFindsNothingNew, commitsWaitFromWhenTheyAreDrawn, aRowThatMovesUpIsHeld, aHoldRunsFromWhenThePageIsFree, aHoldRunsOutOnTime, aPageInTheBackgroundLetsGo, onlyWhatCameUpOverAnotherIsHeld, marksFollowTheTableTurned, ...tables, ...screens];
}
