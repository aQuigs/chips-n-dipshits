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

import { BADGES, LIMITS, REACTION_LIFE_MS, REACTIONS_LIVE } from '../src/engine/index.ts';
import type { Bounty, Card, Command, TableConfig, TableView } from '../src/engine/index.ts';

import type { Check } from './checkRunner.ts';
import { SCROLLS, telling, unreadable } from './covered.ts';
import type { Finding } from './covered.ts';
import { replayDrawn } from './pageSpies.ts';
import { SCREENS, setStageHeight, WIDE_ASPECT } from './rig.ts';
import type { Rig, RigTable, ScreenName } from './rig.ts';

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

/** What a phone's page is looked at with, besides as it stands. The last is for a phone standing: its table at the least height it still stands at. */
const WITH = ['a toast up', 'the chat open', 'the table just standing'] as const;

type With = (typeof WITH)[number];

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

/** What a sweep found, look by look, and the pictures of the looks that found something. */
class Sweep {
  private readonly found: string[] = [];
  private readonly picturesIn: string;
  private readonly name: string;

  constructor(picturesIn: string, name: string) {
    this.picturesIn = picturesIn;
    this.name = name;
  }

  /** Looks at the page as it stands, where `where` says which look this is. */
  async look(page: Page, where: string, read: () => Promise<Finding[]> = () => unreadable(page)): Promise<void> {
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

    for (const how of [null, ...WITH.filter((how) => how !== 'the table just standing' || size.height > size.width)]) {
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
  'a seated player out of the hand, or between hands, has the last hand again from the bar under the table, which costs the table none of its height; the button is gone while they play, under a phone’s open chat, beside word of the hands to come, and for a watcher',
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

    const offers = async (number: number, when: string) => {
      await page.waitForSelector(`${REPLAY_LAST}:has-text("Replay hand #${number}")`);
      await settled(page);
      assert.equal(await page.evaluate(TABLE_GAINS_WITHOUT_THE_BUTTON), 0, `the table gave up height to the button, ${when}`);
      await page.screenshot({ path: `${picturesIn}defect-replay-from-the-bar-${pictureName(when)}.png` });

      await page.locator(REPLAY_LAST).click();
      await replayDrawn(page);
      assert.match((await page.locator('.replay-head h2').textContent()) ?? '', new RegExp(`^Hand #${number}(?!\\d)`), `the replay is of another hand than the bar said, ${when}`);
      await page.locator('.replay [data-replay="close"]').click();
      await page.waitForSelector('.replay', { state: 'hidden' });
    };

    table.play((view, name) => (name === VIEWER ? { type: 'fold' } : passive(view)), (view) => view.seats[0]!.folded);
    await offers(1, 'out of the hand');

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

    // A hand goes on record when it is cleared away: with its result still up, the last on record is the one before
    table.play(passive, (view) => view.hand!.stage === 'done');
    await page.waitForSelector('.message.result');
    await offers(1, 'with the result of the hand up');

    table.play(() => null, (view) => view.hand === null);
    await offers(2, 'between hands');

    // Word of the hands to come has the height the button's line came out of
    table.act(WIDEST, { type: 'setLastHands', hands: LIMITS.lastHands });
    await page.waitForSelector('.controls .next-hand');
    assert.equal(await page.locator(REPLAY_LAST).count(), 0, 'the button shares the bar with word of the hands to come, which can need the height for itself');

    const watcher = await table.open('Watcher', 'smallPhone');
    await watcher.waitForSelector('.controls .waiting');
    assert.equal(await watcher.locator(REPLAY_LAST).count(), 0, 'a watcher’s bar, which keeps no height for a turn, grew a line');
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

  return [...defects, replayFromTheBar(picturesIn), ...tables, ...screens];
}
