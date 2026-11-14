/*
 * Checks, in real browsers, that the screens hold up where play testing found them breaking: on small
 * phones, with long chat, with the largest stacks, with a result too long for the felt, and under the
 * keyboard; and that a table playing dollars and cents shows and takes every amount in dollars.
 * Each check sets its table up on the rig, so the cards and the seats are the same every run.
 * Pictures of what was checked are left in screenshots/.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Page } from 'playwright';

import { BUZZ_PATTERN } from '../src/client/attentionWays.ts';
import { MOST_MOVE_MS, MOST_VIEW_MS, STEP_GAP_MS } from '../src/client/handMoves.ts';
import { KEYS_SETTLE_MS } from '../src/client/hotkeys.ts';
import { RECIPES } from '../src/client/soundRecipes.ts';
import { THEMES } from '../src/client/themes.ts';
import { shortAmount } from '../src/engine/amounts.ts';
import { DEFAULT_CONFIG, LIMITS, presetSettings } from '../src/engine/index.ts';
import type { Command, TableConfig, TableView } from '../src/engine/index.ts';
import { contrast } from '../tests/colorVision.ts';
import { boxes, overlap, Rig, SCREENS, setStageHeight, squeezed, textBoxes } from './rig.ts';
import type { Box, RigPlayer, RigTable, ScreenName } from './rig.ts';
import { complaints, MOTION, NOTICES, SPOTS, TITLES } from './pageSpies.ts';
import type { Flight, Spots } from './pageSpies.ts';
import { STAND_IN_HOST } from './standInHost.ts';

const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));

const LONG_NAMES = ['Quigs', 'WWWWWWWWWWWWWWWW', 'Ünïcödé Ñandú Ø!', 'Marge Simpson-Jr', 'Stu', 'Big Al', 'Pocket Pam', 'iiiiiiiiiiiiiiii', 'Zed', '你好你好你好你好'];
const MIXED_STACKS = [1000, 1_000_000_000, 1500, 12_345, 999_999, 50_000, 700, 1500, 100_000_000, 400];

const tenPlayers = (): RigPlayer[] => LONG_NAMES.map((name, index) => ({ name, stack: MIXED_STACKS[index]! }));

/** Checks or calls, whatever the decision. */
const passive = (view: TableView): Command => ({ type: view.hand!.options!.canCheck ? 'check' : 'call' });

/** Puts everything in, and says yes to running it twice. */
const allIn = (view: TableView): Command => {
  const hand = view.hand!;
  if (hand.canVote) {
    return { type: 'ritVote', agree: true };
  }

  return hand.options!.canRaise ? { type: 'raise', to: hand.options!.maxRaiseTo } : { type: 'call' };
};

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}check-${name}.png` });
}

function assertOnScreen(found: Box[], screen: ScreenName, what: string): void {
  const { width, height } = SCREENS[screen];

  assert.ok(found.length > 0, `${what}: nothing to look at`);
  for (const box of found) {
    assert.ok(box.left >= -1 && box.right <= width + 1 && box.top >= -1 && box.bottom <= height + 1, `${what} runs off the screen: ${JSON.stringify(box)} on ${width}x${height}`);
  }
}

function assertApart(these: Box[], those: Box[], what: string): void {
  for (const a of these) {
    for (const b of those) {
      assert.ok(!overlap(a, b), `${what}: ${JSON.stringify(a)} is drawn over ${JSON.stringify(b)}`);
    }
  }
}

/** Every bet on the table can be read: none is drawn over the board, the pot, another bet or what a seat says. */
async function assertBetsApart(page: Page): Promise<void> {
  const bets = await boxes(page, '.bet');

  assertApart(bets, await textBoxes(page, '.plate .stack, .plate .status'), 'a bet and what a seat says');
  assertApart(bets, await boxes(page, '.board .card, .pot'), 'a bet and the middle of the table');
  assertApart(await boxes(page, '.pot'), await boxes(page, '.seat .plate'), 'the pot and a seat');
  bets.forEach((bet, index) => assertApart([bet], bets.slice(index + 1), 'two bets'));
}

/** Taps on a touch screen and clicks on the desktop, as the rig opens every screen but the desktop as a touch one. */
const pressOn = (page: Page, screen: ScreenName) => (selector: string) => (screen === 'desktop' ? page.click(selector) : page.tap(selector));

const text = async (page: Page, selector: string) => ((await page.locator(selector).first().textContent()) ?? '').trim();

// Run in the page: writes down each sound it plays, since a check cannot listen. A sound starts with its
// own gain going to the speakers, at the volume it is played at, and then the notes and noise it is made of.
// A headless browser allows sound without a touch, so the check holds the page to the rule itself
const LISTEN = `(() => {
  window.played = [];
  window.contexts = [];

  // Each audio context, and whether the visitor's gesture was under way when it was set up, as a browser insists
  const Audio = AudioContext;
  window.AudioContext = class extends Audio {
    constructor(...args) {
      super(...args);
      window.contexts.push({ audio: this, inGesture: navigator.userActivation.isActive });
    }
  };

  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    if (target instanceof AudioDestinationNode) {
      window.played.push({ gain: this.gain.value, voices: [], starts: [], frame: window.frame });
    }

    return connect.call(this, target, ...rest);
  };

  for (const kind of [OscillatorNode, AudioBufferSourceNode]) {
    const start = kind.prototype.start;
    kind.prototype.start = function (...args) {
      window.played.at(-1).voices.push(this instanceof OscillatorNode ? 'tone ' + this.frequency.value : 'noise');
      window.played.at(-1).starts.push(args[0] ?? this.context.currentTime);

      return start.apply(this, args);
    };
  }
})()`;

const voicesOf = (voices: string[]) => [...voices].sort().join(', ');

const SOUND_BY_VOICES = new Map(Object.entries(RECIPES).map(([sound, voices]) => [voicesOf(voices.map((voice) => ('tone' in voice ? `tone ${voice.tone}` : 'noise'))), sound]));
assert.equal(SOUND_BY_VOICES.size, Object.keys(RECIPES).length, 'two sounds are made of the same notes, so a check cannot tell them apart');

/** What the page has played since `from`, each sound by name, at the volume it was played at. */
async function played(page: Page, from = 0): Promise<{ sound: string; gain: number }[]> {
  const sounds = (await page.evaluate('window.played')) as { gain: number; voices: string[] }[];

  // The page keeps a gain to single precision
  const rounded = (gain: number) => Math.round(gain * 1000) / 1000;

  return sounds.slice(from).map(({ gain, voices }) => ({ sound: SOUND_BY_VOICES.get(voicesOf(voices)) ?? `something else: ${voices.join(', ')}`, gain: rounded(gain) }));
}

const playedNames = async (page: Page, from = 0) => (await played(page, from)).map((sound) => sound.sound);

/** When each sound the page has played starts, in seconds on the page's audio clock. */
const playedAt = async (page: Page) => ((await page.evaluate('window.played.map((sound) => Math.min(...sound.starts))')) as number[]);

/** The color a token stands for in the page's theme, as the browser writes a computed color. */
const tokenColor = (page: Page, token: string) =>
  page.evaluate(`(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(${token})';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  })()`) as Promise<string>;

const style = (page: Page, selector: string, property: string, pseudo = '') =>
  page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}), ${JSON.stringify(pseudo)})[${JSON.stringify(property)}]`) as Promise<string>;

/** The colors the cards on the table are drawn in, one card of each suit. */
async function suitColors(page: Page): Promise<Record<string, string>> {
  const colors: Record<string, string> = {};

  for (const suit of ['s', 'h', 'd', 'c']) {
    colors[suit] = await style(page, `.table .card.suit-${suit}`, 'color');
  }

  return colors;
}

const FACE_DOWN = '.seat:not(.me) .card.back';

const CENTS = { unit: 'cents', smallBlind: 25, bigBlind: 50 } as const;
const PHONE_AND_DESKTOP = ['phone', 'desktop'] as const;

// How much wider than tall a table must be to lie down: WIDE_ASPECT in src/client/app.ts
const WIDE_ASPECT = 1.15;

// The least height at which a phone's table stands up
const JUST_STANDING = Math.ceil(SCREENS.phone.width / WIDE_ASPECT) + 1;

/**
 * Pins the table's shape for a check about what sits on its seats: a phone's standing up at the least
 * height it does so, where its seats come closest, and a desktop's lying down.
 */
async function standOrLie(page: Page, screen: ScreenName): Promise<void> {
  if (screen !== 'desktop') {
    await setStageHeight(page, JUST_STANDING);
  }

  await page.waitForSelector(screen === 'desktop' ? '.table.wide' : '.table.tall');
}

const TO_THE_CENT = 'This table plays to the cent, so an amount has at most two decimals';

const texts = (page: Page, selector: string) => page.locator(selector).allInnerTexts();

/**
 * A table of whole chips where everyone antes and one of dollars and cents where the big blind antes
 * for the table, with what six players who each sat down with `stack` see when the first hand is dealt.
 */
const ANTE_TABLES = [
  {
    name: 'chips',
    config: { ante: 5 } as Partial<TableConfig>,
    stack: 1000,
    blinds: '10/20',
    stakes: '10/20 · ante 5',
    pot: '60',
    bets: ['10', '20'],
    stacks: ['995', '985', '975', '995', '995', '995'],
    lines: ['Hand #123 · blinds 10/20 · ante 5 · Quigs has the button', 'Everyone posts ante 5', 'WWWWWWWWWWWWWWWW posts small blind 10', 'Ünïcödé Ñandú Ø! posts big blind 20'],
    noAnte: '0',
    typed: '5',
    shown: '5',
    said: 'The ante is 5, paid by everyone',
  },
  {
    name: 'cents',
    config: { ...CENTS, ante: 50, anteFrom: 'bigBlind' } as Partial<TableConfig>,
    stack: 10_000,
    blinds: '0.25/0.50',
    stakes: '0.25/0.50 · BB ante 0.50',
    pot: '1.25',
    bets: ['0.25', '0.50'],
    stacks: ['100.00', '99.75', '99.00', '100.00', '100.00', '100.00'],
    lines: [
      'Hand #123 · blinds 0.25/0.50 · BB ante 0.50 · Quigs has the button',
      'WWWWWWWWWWWWWWWW posts small blind 0.25',
      'Ünïcödé Ñandú Ø! posts big blind 0.50',
      'Ünïcödé Ñandú Ø! posts big blind ante 0.50',
    ],
    noAnte: '0.00',
    typed: '.5',
    shown: '0.50',
    said: 'The ante is 0.50, paid by the big blind for the table',
  },
];

/**
 * A table of whole chips and one of dollars and cents, each playing an ante that a bomb pot takes the
 * place of, with what six players see when the host calls a bomb pot and it is dealt: five who sat down
 * with `stack` and Marge, in seat 3, who sat down with `short` and cannot cover it.
 */
const BOMB_POT_TABLES = [
  {
    name: 'chips',
    config: { ante: 5 } as Partial<TableConfig>,
    stack: 1000,
    short: 30,
    amount: '100',
    pot: '530',
    stacks: ['900', '900', '900', '0', '900', '900'],
    lines: ['Hand #123 · bomb pot 100 · Quigs has the button', 'Marge Simpson-Jr posts bomb pot 30 and is all in', 'Everyone else posts bomb pot 100', 'Flop: 2♣ 7♦ 9♥'],
    bet: '20',
    typed: '250',
    shown: '250',
  },
  {
    name: 'cents',
    config: { ...CENTS, ante: 50, anteFrom: 'bigBlind' } as Partial<TableConfig>,
    stack: 10_000,
    short: 75,
    amount: '2.50',
    pot: '13.25',
    stacks: ['97.50', '97.50', '97.50', '0.00', '97.50', '97.50'],
    lines: ['Hand #123 · bomb pot 2.50 · Quigs has the button', 'Marge Simpson-Jr posts bomb pot 0.75 and is all in', 'Everyone else posts bomb pot 2.50', 'Flop: 2♣ 7♦ 9♥'],
    bet: '0.50',
    typed: '7.5',
    shown: '7.50',
  },
];

const nextIsBombPot = (amount: string) => `Next hand is a bomb pot: ${amount} each`;

/** What the bar says about the hands to come is whole, on the screen and clear of the table and the buttons. */
async function assertNextHandsFit(page: Page, screen: ScreenName, who: string): Promise<void> {
  assert.deepEqual(await squeezed(page, '.controls .waiting, .controls .next-hand span'), [], `what the ${who} is told about the hands to come is cut off`);
  assertOnScreen(await boxes(page, '.controls .next-hand span, .seat .plate'), screen, `the ${who}'s table and what is said under it`);
  assertApart(await boxes(page, '.controls .next-hand span'), await boxes(page, '.stage, .controls .extras'), 'word of the hands to come and what is around it');
}

/*
 * Three double-board bomb pots at a table of BOMB_POT_TABLES, every card fixed, played one after the
 * other with a bet on the first flop and checks from there. Each is named for how its pots are won.
 */
const DOUBLE_BOARD_HANDS = {
  // Marge's deuces make three on the first board, where Quigs has two pair, and his king is best on the second
  sidePot: { holes: { 0: 'Ks 7d', 1: 'Qc Qd', 2: 'Jc Jd', 3: '2d 2h', 4: 'Ac 3c', 5: '6c 6d' }, board: 'Kh 7s 2c 9d 4h', secondBoard: 'Kd 9c 8h Ts 3s' },
  // Aces make three on the first board and kings on the second
  oneEach: { holes: { 0: 'Qc 2d', 1: 'As Ad', 2: 'Ks Kc', 3: '6c 6d', 4: '5c 5d', 5: 'Jc 4d' }, board: 'Ah 7s 2c 9d 4h', secondBoard: 'Kd 9c 8h Ts 3s' },
  // Aces make three on both, with Marge out of chips
  both: { holes: { 0: 'Qc 2d', 1: 'As Ad', 2: 'Ks Kc', 4: '5c 5d', 5: 'Jc 4d' }, board: 'Ah 7s 2c 9d 4h', secondBoard: 'Ac 9c 8h Ts 3s' },
};

/** What the felt says of each of DOUBLE_BOARD_HANDS, by the name of the table. The odd cent of a pot is on the first board. */
const DOUBLE_BOARD_RESULTS: Record<string, Record<keyof typeof DOUBLE_BOARD_HANDS, string[]>> = {
  chips: {
    sidePot: ['Board 1: Marge Simpson-Jr +90, Quigs +225', 'Board 2: Quigs wins 315 with pair of kings'],
    oneEach: ['Board 1: WWWWWWWWWWWWWWWW wins 295 with three aces', 'Board 2: Ünïcödé Ñandú Ø! wins 295 with three kings'],
    both: ['Board 1: WWWWWWWWWWWWWWWW wins 250 with three aces', 'Board 2: WWWWWWWWWWWWWWWW wins 250 with three aces'],
  },
  cents: {
    sidePot: ['Board 1: Marge Simpson-Jr +2.25, Quigs +5.63', 'Board 2: Quigs wins 7.87 with pair of kings'],
    oneEach: ['Board 1: WWWWWWWWWWWWWWWW wins 7.38 with three aces', 'Board 2: Ünïcödé Ñandú Ø! wins 7.37 with three kings'],
    both: ['Board 1: WWWWWWWWWWWWWWWW wins 6.25 with three aces', 'Board 2: WWWWWWWWWWWWWWWW wins 6.25 with three aces'],
  },
};

/**
 * A table of whole chips and one of dollars and cents for the checks of missed blinds, with the blinds
 * as each writes them: the big blind, the small blind, the two together, the smallest raise over the
 * big blind, and the pot of a hand where one player posted both blinds they missed beside the hand's own.
 */
const MISSED_BLIND_TABLES = [
  { name: 'chips', config: {} as Partial<TableConfig>, stack: 1000, blinds: '10/20', big: '20', small: '10', both: '30', raiseTo: '40', pot: '60' },
  { name: 'cents', config: { ...CENTS } as Partial<TableConfig>, stack: 10_000, blinds: '0.25/0.50', big: '0.50', small: '0.25', both: '0.75', raiseTo: '1.00', pot: '1.50' },
];

const MARGE = 'Marge Simpson-Jr';

/** Folds, or checks where that is free, so a hand nobody raises goes to the big blind or to a showdown. */
const folding = (view: TableView): Command => ({ type: view.hand!.options!.canCheck ? 'check' : 'fold' });

/** Ends the hand on the table without a bet, with the game paused so that the next hand is the check's to deal. */
function playOut(table: RigTable): void {
  table.act('Quigs', { type: 'pause' });
  table.play(folding, (view) => view.hand === null);
}

/**
 * Six players, of whom Marge, in seat 3, sat out as the big blind came to her and so owes both blinds.
 * Handed back between hands with the game paused. The button is due on seat 2 next and the big blind on
 * seat 5, with Marge between them, where nobody comes in by posting. The hand after next is hand 123.
 */
function blindsOwed(rig: Rig, kind: (typeof MISSED_BLIND_TABLES)[number]): RigTable {
  const table = rig.table(
    LONG_NAMES.slice(0, 6).map((name) => ({ name, stack: kind.stack })),
    kind.config,
  );

  table.alter((state) => {
    state.handCount = 119;
  });
  table.deal({ button: 0 });
  playOut(table);
  table.act(MARGE, { type: 'sitOut' });
  table.dealNext();
  playOut(table);

  return table;
}

/** Opens or closes the play-by-play on a phone, where it is folded away; a desktop has it beside the table. */
async function toggleFeed(page: Page, screen: ScreenName): Promise<void> {
  if (screen !== 'desktop') {
    await page.tap('.feed-toggle');
  }
}

/** The bar under the table has room for what it says to a player who owes and for its buttons, and no seat's status is cut off. */
async function assertOwedBarFits(page: Page, screen: ScreenName): Promise<void> {
  assert.deepEqual(await squeezed(page, '.controls .waiting, .controls .owed-note, .controls .extras button, .seat .plate .status'), [], 'what the bar or a seat says is cut off');
  assertOnScreen(await boxes(page, '.controls .owed-note, .controls .extras button, .controls .extras .toggle, .seat .plate'), screen, 'the table and the bar under it');
  assertApart(await boxes(page, '.controls .waiting'), await boxes(page, '.stage, .controls .extras'), 'what the bar says and what is around it');
}

const stacksBySeat = (page: Page, seats: number) => Promise.all(Array.from({ length: seats }, (_, seat) => text(page, `.seat[data-seat="${seat}"] .stack`)));

async function openLedger(page: Page, screen: ScreenName): Promise<void> {
  const press = pressOn(page, screen);

  await press('[data-action="menu"]');
  await press('.menu [data-action="ledger"]');
  await page.waitForSelector('.ledger');
}

const ledgerRows = async (page: Page) => (await texts(page, '.ledger tbody tr')).map((row) => row.split(/\s*\t\s*/));

async function assertNoSidewaysScroll(page: Page): Promise<void> {
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'the page scrolls sideways');
}

/** What the browser would tell someone about a field it won't accept; empty when the field is fine. */
const complaintOf = (page: Page, selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).validationMessage`) as Promise<string>;

/** Whether the key hint on a button is drawn. */
const hintShown = async (page: Page, selector: string) => (await style(page, selector, 'content', '::after')) !== 'none';

/** Lets the buttons just drawn settle, so a key pressed next is taken. */
const settle = (page: Page) => page.waitForTimeout(KEYS_SETTLE_MS + 100);

/** The moves a page sends, in order, as the server receives them. */
function movesSent(page: Page): string[] {
  const sent: string[] = [];

  page.on('request', (request) => {
    const body = JSON.parse(request.postData() ?? '{}') as { op?: string; command?: { type: string; agree?: boolean } };

    if (body.op === 'act' && body.command && ['fold', 'check', 'call', 'raise', 'ritVote'].includes(body.command.type)) {
      sent.push(body.command.type === 'ritVote' ? `ritVote ${body.command.agree}` : body.command.type);
    }
  });

  return sent;
}

const HINT = '.seat.me .hint';

/** Waits for whatever is moving on the table to land where it will sit. On a still table, as the rig keeps its pages, nothing is. */
const dealt = (page: Page) => page.waitForSelector('.stage:not([data-moving])');

/** The cards on the table the hand hint picks out as making the viewer's hand, and the ones it says do not. */
const marking = (page: Page) =>
  page.evaluate(`({
    plays: [...document.querySelectorAll('.table .card.plays')].map((card) => card.dataset.card).sort(),
    idle: [...document.querySelectorAll('.table .card.idle')].map((card) => card.dataset.card).sort(),
  })`) as Promise<{ plays: string[]; idle: string[] }>;

const sortedCards = (text: string) => text.split(' ').sort();

/** Waits for the hint to name a hand and the cards to land, so the page shows the street the check moved the table to. */
async function hintSays(page: Page, ...names: string[]): Promise<void> {
  await page.waitForFunction(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(`${HINT} .name`)})].map((name) => name.textContent)) === ${JSON.stringify(JSON.stringify(names))}`);
  await dealt(page);
}

/** That the hint is whole, inside the table's part of the screen and clear of everything else on the table, and the seat's own text is not squeezed by it. */
async function assertHintFits(page: Page): Promise<void> {
  // The text, not the pill around it: the seats beside are drawn over the pill's ends
  const hint = await textBoxes(page, `${HINT} .read`);
  const [stage] = await boxes(page, '.stage');

  assert.ok(hint.length > 0, 'the hand hint: nothing to look at');
  for (const box of hint) {
    assert.ok(box.left >= stage!.left - 1 && box.right <= stage!.right + 1 && box.top >= stage!.top - 1 && box.bottom <= stage!.bottom + 1, `the hand hint runs off the table: ${JSON.stringify(box)} in ${JSON.stringify(stage)}`);
  }

  assert.deepEqual(await squeezed(page, `${HINT}, ${HINT} .read, .seat.me .plate .name span, .plate .stack`), [], 'the hint, or the seat it is under, is cut off');
  assertApart(hint, await boxes(page, '.board .card, .seat:not(.me) .plate, .seat:not(.me) .hole .card, .bet, .pot'), 'the hand hint and the table');

  // The hint makes the viewer's seat taller and the lift raises cards, so both are checked against the middle of the table
  assertApart(await boxes(page, '.seat.me .hole .card'), await boxes(page, '.board .card, .pot, .message.result > div'), 'the viewer\'s cards and the middle of the table');
  await assertBetsApart(page);
}

/**
 * Runs `look` on a phone's table standing up and lying down, which one it is being left to how the
 * buttons under it wrap: standing at the least height it stands at, lying at the most, and, while
 * someone can act and the buttons for it take room, lying at a short one.
 */
async function inEveryShape(page: Page, look: (shape: string) => Promise<void>, { buttonsUp = true } = {}): Promise<void> {
  const { width } = page.viewportSize()!;
  const shapes: [string, number][] = [
    ['tall', Math.ceil(width / WIDE_ASPECT) + 1],
    ['wide', Math.floor(width / WIDE_ASPECT) - 1],
  ];

  // The shortest a phone's table gets with a turn's buttons under it, measured on a 360 and a 375 phone in each font
  if (buttonsUp) {
    shapes.push(['wide', Math.round(width * 0.78)]);
  }

  for (const [shape, height] of shapes) {
    await setStageHeight(page, height);
    await page.waitForSelector(`.table.${shape}`);
    await dealt(page);
    await look(`${shape}-${height}`);
  }
}

/** `inEveryShape` on a phone; on a desktop, whose table always lies down, one look. */
const inShapesOf = (page: Page, screen: ScreenName, look: (shape: string) => Promise<void>, options?: { buttonsUp?: boolean }) =>
  screen === 'desktop' ? look('wide') : inEveryShape(page, look, options);

/** That the playing cards stand apart from the rest by where they sit, which reads the same in any theme or deck, and the rest are faded. */
async function assertMarked(page: Page): Promise<void> {
  const faded = await page.evaluate(`[...document.querySelectorAll('.table .card.idle')].every((card) => Number(getComputedStyle(card).opacity) < 1)`);
  assert.equal(faded, true, 'a card that does not play is not faded');

  for (const where of ['.board[data-run="0"]', '.board[data-run="1"]', '.seat.me .hole']) {
    const [playing] = await boxes(page, `${where} .card.plays`);
    const [resting] = await boxes(page, `${where} .card.idle`);

    if (playing && resting) {
      assert.ok(resting.top - playing.top >= 3, `in ${where} a card that plays sits only ${resting.top - playing.top}px above one that does not`);
    }
  }
}

/** Sets the viewer's own choices as if made on an earlier visit, and loads the page again with them. */
async function choose(page: Page, prefs: Record<string, string>): Promise<void> {
  await page.evaluate(`Object.entries(${JSON.stringify(prefs)}).forEach(([key, value]) => localStorage.setItem('cnd.' + key, value))`);
  await page.reload();
  await page.waitForSelector('.stage .table');
  await page.evaluate('document.fonts.ready.then(() => undefined)');
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

// Run in the page as it waits for the flash: catches it as it starts and holds it at its brightest, in `window.flash`
const PAUSE_FLASH = `(() => {
  const flash = document.querySelector('.stage')?.getAnimations().find((animation) => animation.animationName === 'attention-flash');
  if (flash) {
    flash.pause();
    flash.currentTime = 60;
    window.flash = flash;
  }
  return !!flash;
})()`;

// Run in the page: what is drawn on top at the middle of each card, bet and button on the table, which a flash must leave as it was
const ON_TOP = `[...document.querySelectorAll('.table .card, .bet, .turn button')]
  .map((element) => element.getBoundingClientRect())
  .filter((box) => box.width > 0)
  .map((box) => document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.outerHTML.slice(0, 80) ?? 'nothing')`;

// Run in the page: lets a check put the page out of sight and back, as another tab does, which a headless browser can't
const SIGHT = `(() => {
  let hidden = false;
  Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true });
  window.outOfSight = (out) => {
    hidden = out;
    document.dispatchEvent(new Event('visibilitychange'));
  };
})()`;

// Run in the page: every buzz asked for, and whether the page had been touched by then
const BUZZ = `(() => {
  window.buzzes = [];
  Object.defineProperty(Navigator.prototype, 'vibrate', {
    value: (pattern) => {
      window.buzzes.push({ pattern, touched: navigator.userActivation.hasBeenActive });
      return true;
    },
    configurable: true,
  });
})()`;

const middle = (box: Box) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });

/** Whether one thing lies with its middle on the middle of another. */
const over = (a: Box, b: Box) => Math.hypot(middle(a).x - middle(b).x, middle(a).y - middle(b).y) <= 1.5;

function assertOver(found: Box, wanted: Box | undefined, what: string): void {
  assert.ok(wanted && over(found, wanted), `${what}: its middle is at ${JSON.stringify(middle(found))}, not ${JSON.stringify(wanted && middle(wanted))}`);
}

/** Whether two measures are the same to the browser: what one layout gives twice. */
const same = (a: number, b: number) => Math.abs(a - b) < 0.05;

/** What the page has set moving since it was last asked, once all of it has landed. Moves held in the air are let go first. */
async function flown(page: Page): Promise<Flight[]> {
  await page.evaluate('window.land()');
  await dealt(page);

  const flights = (await page.evaluate('window.flights.splice(0)')) as Flight[];

  for (const flight of flights) {
    assert.deepEqual(flight.properties.filter((property) => property !== 'transform' && property !== 'opacity'), [], `a ${flight.what} is moved by more than transform and opacity`);
    assert.ok(flight.duration <= MOST_MOVE_MS, `a ${flight.what} takes ${flight.duration} ms to move`);
    assert.ok(flight.delay + flight.duration <= MOST_VIEW_MS, `a ${flight.what} is still moving ${flight.delay + flight.duration} ms after the view`);
  }

  return flights;
}

/** The table's part of a page as it is drawn: its markup, and the box of every element of it in the order they are drawn. */
interface Drawn {
  markup: string;
  boxes: Box[];
}

// Run in the page
const DRAWN = `(() => {
  const stage = document.querySelector('.stage');

  return {
    markup: stage.outerHTML,
    boxes: [...stage.querySelectorAll('*')].map((element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();

      return { left, top, right, bottom };
    }),
  };
})()`;

const sameBox = (a: Box, b: Box | undefined) => b !== undefined && (['left', 'top', 'right', 'bottom'] as const).every((edge) => same(a[edge], b[edge]));

/**
 * That a page whose motion has landed is, to the last attribute and the last box, what a page that
 * never moved shows of the same table. Answers with what the still page shows.
 */
async function assertAsStill(moving: Page, still: Page, when: string): Promise<Drawn> {
  await dealt(moving);

  const moved = (await moving.evaluate(DRAWN)) as Drawn;
  const stood = (await still.evaluate(DRAWN)) as Drawn;

  assert.equal(moved.markup, stood.markup, `${when}: the table that moved is not the table that stood still`);
  moved.boxes.forEach((box, index) => assert.ok(sameBox(box, stood.boxes[index]), `${when}: something lies at ${JSON.stringify(box)} that the still table has at ${JSON.stringify(stood.boxes[index])}`));

  return stood;
}

/** Waits for a page to show the table as the server has it for a viewer: whose turn it is, the cards out, the bets, the folds and the result. */
async function caughtUp(page: Page, view: TableView): Promise<void> {
  const hand = view.hand;
  const seats = view.seats.filter((seat) => seat !== null);
  const wanted = [
    hand?.stage === 'betting' ? hand.toAct : null,
    hand?.boards.flat().length ?? 0,
    seats.filter((seat) => seat.bet > 0).length,
    seats.filter((seat) => seat.folded).length,
    hand?.stage === 'done',
  ];

  await page.waitForFunction(`JSON.stringify([
    document.querySelector('.seat.acting') ? Number(document.querySelector('.seat.acting').dataset.seat) : null,
    document.querySelectorAll('.board .card[data-card]').length,
    document.querySelectorAll('.bet[data-bet]').length,
    document.querySelectorAll('.seat.folded').length,
    document.querySelector('.message.result') !== null,
  ]) === ${JSON.stringify(JSON.stringify(wanted))}`);
}

interface MotionLayout {
  name: string;
  screen: ScreenName;
  /** The height a phone's table is held at, which makes it stand or lie. */
  height?: number;
  /** Moves play out in their own time on a processor this many times slower. On the others they are held where they start and let go, so no check waits on them. */
  slower?: number;
  config?: Partial<TableConfig>;
}

const MOTION_LAYOUTS: MotionLayout[] = [
  { name: 'phone-standing', screen: 'phone', height: JUST_STANDING },
  { name: 'phone-lying', screen: 'phone', height: Math.floor(SCREENS.phone.width / WIDE_ASPECT) - 1 },
  { name: 'desktop', screen: 'desktop', config: CENTS },
  { name: 'phone-slow', screen: 'phone', height: JUST_STANDING, slower: 4 },
];

const MOTION_PLAYERS: RigPlayer[] = ['Quigs', 'Stu', 'Pam', 'Al'].map((name) => ({ name, stack: 10_000 }));

/** What a step of a hand set moving, and where things lay on the still table before it and after. */
interface Seen {
  flights: Flight[];
  before: Spots;
  after: Spots;
}

/** A table watched twice by one of its players, on the same screen: on a page that moves, which writes its moves down, and on one that stands still to measure the first against. */
interface Watched {
  moving: Page;
  still: Page;
  /** Does something to the table, waits for both pages to show it and for the moving one to land, and checks that it landed as the still one stands. */
  step(what: string, act: () => unknown): Promise<Seen>;
}

async function watch(table: RigTable, name: string, layout: MotionLayout, holdAt: number | null = 0): Promise<Watched> {
  const moving = await table.open(name, layout.screen, MOTION, { moving: true });
  const still = await table.open(name, layout.screen);

  // A phone's table is held at one height for the whole hand, whatever the buttons under it come to: its shape is the check's to choose
  if (layout.height) {
    for (const page of [moving, still]) {
      await page.setViewportSize({ width: SCREENS[layout.screen].width, height: layout.height + 600 });
      // And at a width that is no whole number of pixels, as a zoomed browser gives it, which is where a rounded measure shows
      await page.addStyleTag({ content: `.stage { align-self: start; width: calc(100% - 0.4px); height: ${layout.height}px; }` });
      await page.waitForSelector(layout.height >= JUST_STANDING ? '.table.tall' : '.table.wide');
    }
  }

  if (layout.slower) {
    const session = await moving.context().newCDPSession(moving);
    await session.send('Emulation.setCPUThrottlingRate', { rate: layout.slower });
  } else {
    await moving.evaluate(`window.holdAt = ${holdAt}`);
  }

  return {
    moving,
    still,
    step: async (what, act) => {
      const before = (await still.evaluate(SPOTS)) as Spots;

      act();

      const view = table.view(name);
      await Promise.all([caughtUp(moving, view), caughtUp(still, view)]);

      const flights = await flown(moving);
      const stood = await assertAsStill(moving, still, `${layout.name}, ${what}`);

      // What the table draws ends its move exactly where the still table has it
      for (const flight of flights.filter((flight) => !flight.standIn)) {
        assert.ok(sameBox(flight.to, stood.boxes[flight.index]), `${layout.name}, ${what}: a ${flight.what} lands at ${JSON.stringify(flight.to)}, and rests at ${JSON.stringify(stood.boxes[flight.index])}`);
      }

      return { flights, before, after: (await still.evaluate(SPOTS)) as Spots };
    },
  };
}

/**
 * That folded cards leave from the place their seat keeps for cards, drawn as they were. A seat that
 * says it folded has grown a line, so that place is not quite where the cards lay a moment ago.
 */
function assertLeavesSeat(flight: Flight, { before, after }: Seen, seat: number, what: string): void {
  const [cards, hole] = [before.cards[seat]!, after.holes[seat]!];
  const fits = same(flight.from.top, hole.top) && same(flight.from.bottom, hole.bottom) && same(middle(flight.from).x, middle(hole).x);

  assert.ok(fits && same(flight.from.right - flight.from.left, cards.right - cards.left), `${what}: the folded cards start at ${JSON.stringify(flight.from)}, their place is ${JSON.stringify(hole)} and they lay at ${JSON.stringify(cards)}`);
  assertOver(flight.to, after.felt, `${what}: the folded cards go to the middle of the table`);
}

/** That a card of a board comes down onto its own place from just above it. */
function assertDrops(card: Flight, what: string): void {
  assert.ok(same(middle(card.from).x, middle(card.to).x) && card.from.top < card.to.top && card.from.bottom > card.to.top, `${what} drops onto its place from just above it`);
}

/** The flights of one kind, in the order the page set them off. */
const flightsOf = (seen: Seen, what: Flight['what'], standIn: boolean) => seen.flights.filter((flight) => flight.what === what && flight.standIn === standIn);

type Check = [name: string, run: (rig: Rig) => Promise<void>];

/** The presets are the whole rig's, and the lobby of every check after the one that saved them would offer them. */
const forgetPresets = (rig: Rig) => rig.presets.list().forEach((preset) => rig.presets.delete(preset.name));

const CHECKS: Check[] = [
  [
    'a long chat line leaves Send on the screen',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Pam', stack: 1000 },
      ]);
      table.act('Pam', { type: 'chat', text: 'that river was criminal and you all know it, Pam, I really cannot believe that card came out' });
      table.act('Pam', { type: 'chat', text: `https://example.com/${'a'.repeat(80)}` });

      const page = await table.open('Quigs', 'tallPhone');
      assertOnScreen(await boxes(page, '.feed-toggle'), 'tallPhone', 'the closed chat bar');

      await page.tap('.feed-toggle');
      assertOnScreen(await boxes(page, '.say button, .say input'), 'tallPhone', 'the chat box and Send');
      await assertNoSidewaysScroll(page);
      await shot(page, 'long-chat-phone');
    },
  ],
  [
    'an open chat leaves the table to look at',
    async (rig) => {
      const table = rig.table(tenPlayers().slice(0, 6));
      table.deal({ button: 0 });

      const page = await table.open('Quigs', 'phone');
      await page.tap('.feed-toggle');

      const [stage] = await boxes(page, '.stage');
      assert.ok(stage && stage.bottom - stage.top >= 180, `the table is squeezed to ${stage ? stage.bottom - stage.top : 0}px`);

      // Nothing on the table is drawn outside the table's own part of the screen
      for (const seat of await boxes(page, '.seat .plate')) {
        assert.ok(seat.top >= stage.top - 1 && seat.bottom <= stage.bottom + 1, `a seat is drawn outside the table: ${JSON.stringify(seat)}`);
      }

      assertOnScreen(await boxes(page, '.say button'), 'phone', 'Send');
      await shot(page, 'chat-open-phone');
    },
  ],
  [
    'ten players and the largest stacks fit a small phone',
    async (rig) => {
      const table = rig.table(tenPlayers());
      table.deal({ button: 0 });
      table.play(passive, (view) => view.hand!.toAct === 0);

      const page = await table.open('Quigs', 'smallPhone');
      assertOnScreen(await boxes(page, '.seat .plate'), 'smallPhone', 'a seat');
      assertOnScreen(await boxes(page, '.dealer-button'), 'smallPhone', 'the dealer button');
      assert.deepEqual(await squeezed(page, '.plate .stack'), [], 'a stack is cut off, so the amount reads wrong');
      assert.equal(await text(page, '.seat[data-seat="1"] .stack'), '999.99M');
      await shot(page, 'ten-players-small-phone');
    },
  ],
  [
    'the biggest all-in fits its button and its box',
    async (rig) => {
      // The raises are a five-figure one, the everyday case, and two that are shortened: what a move costs is rounded up, so the button never says less than it takes
      const kinds = [
        { config: {}, name: 'biggest-all-in-phone', allIn: 'All in 1B', box: '1000000000', raises: { '12345': 'Raise to 12,345', '12340001': 'Raise to 12.35M', '999999999': 'Raise to 1B' } },
        { config: CENTS, name: 'cents-biggest-all-in-phone', allIn: 'All in 10M', box: '10000000.00', raises: { '12,345.67': 'Raise to 12,345.67', '123400.01': 'Raise to 123.41K', '9999999.99': 'Raise to 10M' } },
      ];

      for (const { config, name, allIn, box, raises } of kinds) {
        const table = rig.table(
          [
            { name: 'Quigs', stack: 1_000_000_000 },
            { name: 'Stu', stack: 1_000_000_000 },
            { name: 'Pam', stack: 5000 },
          ],
          config,
        );
        table.deal({ button: 0 });

        const page = await table.open('Quigs', 'phone');
        await page.tap('.presets button:has-text("All in")');

        assert.equal(await text(page, '.turn [data-action="raise"]'), allIn);
        assert.deepEqual(await squeezed(page, '.turn .btn, #raise-amount'), [], 'a move button or the amount box is cut off');
        assert.equal(await page.inputValue('#raise-amount'), box);
        await shot(page, name);

        for (const [typed, button] of Object.entries(raises)) {
          await page.fill('#raise-amount', typed);
          assert.equal(await text(page, '.turn [data-action="raise"]'), button);
          assert.deepEqual(await squeezed(page, '.turn .btn'), []);
        }
      }
    },
  ],
  [
    'the result of a hand run twice with side pots can be read on a phone',
    async (rig) => {
      const stacks = [1000, 5000, 20_000, 300, 1_000_000, 777];
      const table = rig.table(
        LONG_NAMES.slice(0, 6).map((name, index) => ({ name, stack: stacks[index]! })),
        { allowRunItTwice: true },
      );
      table.deal({
        button: 0,
        holes: { 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh', 3: 'Js Jh', 4: 'Ts Th', 5: '9s 9h' },
        board: '2c 7d 8c 3s 4d',
        secondBoard: 'Kd Kc 5h 6h 2d',
      });

      const page = await table.open('Quigs', 'phone');
      table.play(allIn, (view) => view.hand!.stage === 'runout');

      // While the first board is still coming, the second already has its place
      await page.waitForSelector('.board.later');
      assert.equal(await page.locator('.board').count(), 2);

      table.play(allIn, (view) => view.hand!.stage === 'done');
      await page.waitForSelector('.message.result');

      const lines = await page.locator('.message.result > div').allInnerTexts();
      assert.ok(lines.length <= 3, `the felt carries ${lines.length} result lines: ${lines.join(' / ')}`);
      assert.equal(await page.locator('.board .card[data-card]').count(), 10);
      assert.equal(await page.locator('.pot').count(), 0, 'the pot stays up with the result, which already says who won what');

      const seats = await boxes(page, '.seat .plate, .seat .hole .card');
      assertApart(await boxes(page, '.board .card'), seats, 'a board card and a seat');
      assertApart(await boxes(page, '.message.result > div'), seats, 'a result line and a seat');
      await shot(page, 'run-twice-result-phone');
    },
  ],
  [
    'the seat on the clock shows the seconds left',
    async (rig) => {
      const table = rig.table(
        [
          { name: 'Quigs', stack: 1000 },
          { name: 'Stu', stack: 1000 },
          { name: 'Pam', stack: 1000 },
        ],
        { actionSeconds: 30 },
      );
      table.deal({ button: 0 });

      const page = await table.open('Stu', 'phone');
      await page.waitForFunction(`Number(document.querySelector('.seat.acting .status.clock')?.textContent) > 0`);

      const seconds = Number(await text(page, '.seat.acting .status.clock'));
      assert.ok(seconds >= 20 && seconds <= 33, `the clock shows ${seconds}`);
      await shot(page, 'clock-phone');
    },
  ],
  [
    'a player who is leaving is told so, and offered nothing that would not count',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
        { name: 'Pam', stack: 1000 },
      ]);
      // Pam loses at the showdown, so her cards stay face down unless she turns them over
      table.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Ks Kh', 2: '7c 2d' }, board: '3s 4d 9h Jc Qd' });

      const page = await table.open('Pam', 'phone');
      table.act('Pam', { type: 'standUp' });

      await page.waitForSelector('.controls .waiting:has-text("You leave your seat when this hand ends")');
      assert.equal(await page.locator('.controls [data-action="rebuy"], .controls [data-action="sit-out"], .controls [data-action="sit-in"]').count(), 0);

      // Showing the hand they are leaving on is the one thing still theirs to do
      table.play(passive, (view) => view.hand!.stage === 'done');
      await page.tap('.controls [data-action="show"]');
      await page.waitForSelector('.seat.me .hole .card[data-card]');
      assert.equal(table.view('Quigs').seats.find((seat) => seat?.name === 'Pam')!.shown, true);
    },
  ],
  [
    'losing the race for a seat puts a player back to choosing one',
    async (rig) => {
      const table = rig.table([{ name: 'Quigs', stack: 1000 }]);
      table.join('Ann');
      table.join('Bob');

      const page = await table.open('Bob', 'phone');
      table.act('Ann', { type: 'requestSeat', seat: 4, buyIn: 500 });
      table.act('Bob', { type: 'requestSeat', seat: 4, buyIn: 500 });
      await page.waitForSelector('.controls .waiting:has-text("Asked the host for seat 5")');

      table.act('Quigs', { type: 'approve', playerId: table.auth('Ann').id });
      await page.waitForSelector('.controls .waiting:has-text("You are watching")');
      assert.ok((await page.locator('[data-sit]').count()) > 0, 'Bob is offered the open seats again');
      assert.match(await text(page, '.feed-toggle .latest'), /Seat 5 is taken, so Bob needs to pick another/);
    },
  ],
  [
    'a dialog keeps the keyboard, and a refused save keeps what was typed',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
      ]);
      const page = await table.open('Quigs', 'desktop');
      const focusInDialog = `!!document.activeElement.closest('.dialog')`;

      await page.focus('[data-action="menu"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.dialog');
      assert.equal(await page.evaluate(focusInDialog), true, 'opening the menu leaves the keyboard on the page behind it');
      assert.equal(await page.evaluate(`[...document.querySelectorAll('.app > *:not(.overlay)')].every((element) => element.inert)`), true, 'the page behind the menu can still be reached');

      await page.focus('.menu [data-action="settings"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#table-small-blind');
      assert.equal(await page.evaluate(focusInDialog), true, 'the keyboard was lost when one dialog replaced another');

      // Between the dialog's last control and its first, Tab passes through the browser's own controls, where the page has no focus
      let landedInDialog = 0;
      for (let press = 0; press < 30; press++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(`document.activeElement === document.body || ${focusInDialog}`), true, `Tab number ${press + 1} reached the page behind the dialog`);
        landedInDialog += (await page.evaluate(focusInDialog)) ? 1 : 0;
      }
      assert.ok(landedInDialog >= 20, `only ${landedInDialog} of 30 Tabs landed on something in the dialog`);

      await page.fill('#table-small-blind', '50');
      await page.fill('#table-big-blind', '10');
      await page.click('[data-action="save-settings"]');
      await page.waitForSelector('.toast:has-text("big blind")');
      assert.equal(await page.inputValue('#table-small-blind'), '50', 'a refused save threw away what was typed');
      await shot(page, 'refused-save-desktop');

      await page.fill('#table-big-blind', '100');
      await page.click('[data-action="save-settings"]');
      await page.waitForSelector('.dialog', { state: 'detached' });
      assert.equal(table.view('Quigs').config.bigBlind, 100);

      await page.click('[data-action="menu"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.dialog', { state: 'detached' });
      assert.equal(await page.evaluate(`document.activeElement.dataset.action`), 'menu', 'closing a dialog loses the keyboard');
      assert.equal(await page.evaluate(`[...document.querySelectorAll('.app > *')].some((element) => element.inert)`), false, 'the page stays out of reach after the dialog is gone');
    },
  ],
  [
    'the Preferences dialog fits a phone and a desktop, keeps the keyboard, and its sound switch and volume are kept and obeyed',
    async (rig) => {
      for (const screen of ['phone', 'desktop'] as const) {
        const table = rig.table([
          { name: 'Quigs', stack: 1000 },
          { name: 'Stu', stack: 1000 },
        ]);
        const page = await table.open('Quigs', screen, LISTEN);
        const press = pressOn(page, screen);
        const chimes = async () => (await playedNames(page)).filter((sound) => sound === 'turn').length;
        const myTurnOn = (street: string) => (view: TableView) => view.hand!.street === street && view.hand!.toAct === 0;

        // Heads-up the button acts first, so the deal puts the action on this page
        table.deal({ button: 0 });
        await page.waitForSelector('.turn [data-action="fold"]:enabled');
        await page.waitForFunction('window.played.length === 2');
        assert.deepEqual(await played(page), [{ sound: 'deal', gain: 0.25 }, { sound: 'turn', gain: 0.25 }], 'the deal and the chime, at the volume a player starts with');

        table.act('Stu', { type: 'chat', text: 'your go' });
        await page.waitForSelector('.entries li:has-text("your go")', { state: 'attached' });
        assert.equal(await chimes(), 1, 'a view that leaves the action where it was chimes again');

        await press('[data-action="menu"]');
        assert.equal(await page.locator('.menu [data-action="sound"]').count(), 0, 'the menu still has its own sound entry');

        if (screen === 'desktop') {
          await page.focus('.menu [data-action="preferences"]');
          await page.keyboard.press('Enter');
        } else {
          await press('.menu [data-action="preferences"]');
        }

        await page.waitForSelector('#pref-sound[aria-checked="true"]');
        assert.equal(await page.evaluate(`!!document.activeElement.closest('.dialog')`), true, 'opening Preferences leaves the keyboard on the page behind it');
        assertOnScreen(await boxes(page, '.dialog, #pref-sound, #pref-volume'), screen, 'the Preferences dialog');
        assert.deepEqual(await squeezed(page, '.dialog h2, #pref-sound, label[for="pref-volume"] > *'), [], 'a preference is cut off');
        assert.match(await text(page, '#pref-sound'), /^Sound/);
        assert.match(await text(page, 'label[for="pref-volume"]'), /^Volume/);
        assertApart(await boxes(page, '#pref-volume'), await textBoxes(page, 'label[for="pref-volume"] > span, label[for="pref-volume"] > small, #pref-sound'), 'the volume slider and the words around it');
        await shot(page, `preferences-${screen}`);

        if (screen === 'desktop') {
          await page.focus('#pref-sound');
          await page.keyboard.press('Space');
          assert.equal(await page.evaluate('document.activeElement.id'), 'pref-sound', 'flipping the switch loses the keyboard');

          for (let tab = 0; tab < 6; tab++) {
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(`document.activeElement === document.body || !!document.activeElement.closest('.dialog')`), true, `Tab number ${tab + 1} reached the page behind the dialog`);
          }
        } else {
          await press('#pref-sound');
        }

        await page.waitForSelector('#pref-sound[aria-checked="false"]');
        assert.equal(await page.evaluate(`localStorage.getItem('cnd.sound')`), 'off');
        await press('[data-action="close"]');

        table.play(passive, myTurnOn('flop'));
        await page.waitForSelector('.board .card[data-card]');
        await page.waitForSelector('.turn [data-action="check"]:enabled');
        assert.equal(await chimes(), 1, 'the chime plays with the sound switched off');

        // A reload is no touch, so the page is touched before the action comes round to it again
        await page.reload();
        await page.waitForSelector('.turn [data-action="check"]:enabled');
        await press('.pot');
        table.play(passive, myTurnOn('turn'));
        await page.waitForSelector('.board .card[data-card]:nth-child(4)');
        await page.waitForSelector('.turn [data-action="check"]:enabled');
        assert.deepEqual(await played(page), [], 'the sound came back on with a reload');

        await press('[data-action="menu"]');
        await press('.menu [data-action="preferences"]');
        assert.equal(await page.getAttribute('#pref-sound', 'aria-checked'), 'false', 'the switch forgot it was off');
        await press('#pref-sound');
        await page.waitForSelector('#pref-sound[aria-checked="true"]');
        await press('[data-action="close"]');

        table.play(passive, myTurnOn('river'));
        await page.waitForSelector('.board .card[data-card]:nth-child(5)');
        await page.waitForSelector('.turn [data-action="check"]:enabled');
        assert.equal(await chimes(), 1, 'switched back on, the chime stays silent');

        await page.context().close();
      }
    },
  ],
  [
    'a bet, a check, a fold, a street and a win each sound on another player’s page, and nothing plays for what was missed or before a touch',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
        { name: 'Pam', stack: 1000 },
      ]);

      // Three-handed the button acts first before the flop, and Pam, in the big blind, acts first after it
      table.deal({ button: 0, holes: { 0: 'Ah Kd', 1: 'Qs Qh', 2: '7c 2d' }, board: '3s 4c Jd 9h Qd' });
      table.act('Quigs', { type: 'raise', to: 60 });

      const page = await table.open('Pam', 'phone', LISTEN);
      const press = pressOn(page, 'phone');
      const warnings = complaints(page);
      let heard = 0;

      /** Waits for the page to play as many sounds as are expected, gives it a moment to play more, and says what it played. */
      const next = async (count: number, settled: string) => {
        await page.waitForFunction(`window.played.length >= ${heard + count}`);
        await page.waitForSelector(settled, { state: 'attached' });
        await page.waitForTimeout(300);

        const sounds = await playedNames(page, heard);
        heard += sounds.length;

        return sounds;
      };

      await page.waitForSelector('.bet');
      await page.waitForTimeout(500);
      assert.deepEqual(await playedNames(page), [], 'opening the table mid-hand plays what had already happened');

      table.act('Stu', { type: 'fold' });
      assert.deepEqual(await next(2, '.turn [data-action="fold"]:enabled'), ['fold', 'turn'], 'a fold, then the chime');

      table.act('Pam', { type: 'call' });
      assert.deepEqual(await next(2, '.board .card[data-card]:nth-child(3)'), ['street', 'turn'], 'the flop, with no sound for the call the viewer made');

      table.act('Pam', { type: 'check' });
      table.act('Quigs', { type: 'check' });
      assert.deepEqual(await next(3, '.board .card[data-card]:nth-child(4)'), ['knock', 'street', 'turn'], 'a check, then the turn');

      // The chime rings for the action coming back to the page, so the page sees it leave first
      table.act('Pam', { type: 'check' });
      await page.waitForSelector('.turn [data-action="check"]', { state: 'detached' });
      table.act('Quigs', { type: 'raise', to: 100 });
      assert.deepEqual(await next(2, '.turn [data-action="call"]:enabled'), ['chips', 'turn'], 'a bet');

      table.act('Pam', { type: 'fold' });
      assert.deepEqual(await next(1, '.feed li:has-text("wins")'), ['win'], 'someone else’s win');

      // A reload is not a touch: until one, the next hand makes no sound
      await page.reload();
      await page.waitForSelector('.stage .table');
      table.play(() => null, (view) => view.hand?.number === 2);
      await page.waitForSelector('.seat.me .card[data-card]');
      await page.waitForTimeout(500);
      assert.deepEqual(await playedNames(page), [], 'a sound played before the page was touched');

      heard = 0;
      await press('.pot');
      table.play(passive, (view) => view.hand!.toAct === 2);
      assert.deepEqual(await next(2, '.turn [data-action="fold"]:enabled'), ['chips', 'turn'], 'after a touch the sounds are back');
      assert.deepEqual(await page.evaluate('window.contexts.map((context) => context.inGesture)'), [true], 'the audio was set up outside a touch');

      // A phone that slept comes back with its audio suspended: until a touch wakes it, sounds are dropped, not saved up
      await page.evaluate('window.contexts[0].audio.suspend()');
      table.act('Pam', { type: 'call' });
      table.act('Quigs', { type: 'check' });
      await page.waitForSelector('.board .card[data-card]:nth-child(3)');
      await page.waitForSelector('.turn [data-action="check"]:enabled');
      await press('.pot');
      await page.waitForFunction(`window.contexts[0].audio.state === 'running'`);
      await page.waitForTimeout(500);
      assert.deepEqual(await playedNames(page, heard), [], 'the sounds of a suspended page played when it woke');

      table.act('Pam', { type: 'check' });
      table.act('Quigs', { type: 'raise', to: 40 });
      assert.deepEqual(await next(1, '.bet'), ['chips'], 'a touch wakes the sound');

      assert.deepEqual(warnings, [], 'the page complained in its console');
      await page.context().close();
    },
  ],
  [
    'a bomb pot, dealt straight to the flop, plays the deal and then the flop on another player’s page, the one clear of the other',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
        { name: 'Pam', stack: 1000 },
      ]);
      const page = await table.open('Pam', 'phone', LISTEN);

      table.act('Quigs', { type: 'setBombPot', on: true });
      table.deal({ button: 0, board: '3s 4c Jd 9h Qd' });
      await page.waitForSelector('.board .card[data-card]:nth-child(3)');
      await page.waitForFunction('window.played.length >= 2');
      await page.waitForTimeout(300);

      assert.deepEqual(await playedNames(page), ['deal', 'street'], 'the deal and the flop, and nothing for the posts');

      const [deal, flop] = await playedAt(page);
      const dealLasts = Math.max(...RECIPES.deal.map((voice) => voice.at + voice.length));
      assert.ok(flop! - deal! >= dealLasts, `the flop starts ${(flop! - deal!).toFixed(3)} s after the deal, which lasts ${dealLasts} s`);

      await page.context().close();
    },
  ],
  [
    'the volume sets how loud the sounds play, with a sample as it is set, and the sound switch silences them all',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        const table = rig.table([
          { name: 'Quigs', stack: 1000 },
          { name: 'Stu', stack: 1000 },
        ]);
        const page = await table.open('Stu', screen, LISTEN);
        const press = pressOn(page, screen);
        const gains = async (from: number) => (await played(page, from)).map((sound) => sound.gain);

        await press('[data-action="menu"]');
        await press('.menu [data-action="preferences"]');
        await page.waitForSelector('#pref-volume');
        assert.equal(await page.inputValue('#pref-volume'), '50');

        // Set as a player would: arrow keys at a computer, a tap partway along on a phone
        if (screen === 'desktop') {
          await page.focus('#pref-volume');
          for (let step = 0; step < 3; step++) {
            await page.keyboard.press('ArrowRight');
          }
        } else {
          const [slider] = await boxes(page, '#pref-volume');
          await page.touchscreen.tap(slider!.left + (slider!.right - slider!.left) * 0.8, (slider!.top + slider!.bottom) / 2);
        }

        const volume = Number(await page.inputValue('#pref-volume')) / 100;
        assert.ok(volume > 0.5, `the slider did not move: ${volume}`);

        await page.waitForFunction('window.played.length > 0');
        await page.waitForTimeout(500);
        const loudness = Math.round(volume * volume * 1000) / 1000;
        assert.deepEqual(await played(page), [{ sound: 'chips', gain: loudness }], 'setting the volume plays one sample, at the new volume');
        await press('[data-action="close"]');

        table.deal({ button: 0 });
        table.act('Quigs', { type: 'call' });
        await page.waitForSelector('.turn [data-action="check"]:enabled');
        await page.waitForFunction('window.played.length >= 4');
        assert.deepEqual(await playedNames(page, 1), ['deal', 'chips', 'turn']);
        assert.deepEqual(await gains(1), [loudness, loudness, loudness], 'the table’s sounds play at the volume set');

        await press('[data-action="menu"]');
        await press('.menu [data-action="preferences"]');
        await press('#pref-sound');
        await page.waitForSelector('#pref-sound[aria-checked="false"]');
        await press('[data-action="close"]');

        const before = (await played(page)).length;
        table.act('Stu', { type: 'check' });
        table.act('Stu', { type: 'check' });
        table.act('Quigs', { type: 'raise', to: 40 });
        await page.waitForSelector('.turn [data-action="call"]:enabled');
        await page.waitForTimeout(500);
        assert.deepEqual(await playedNames(page, before), [], 'a sound played with the sound switched off');

        await page.context().close();
      }
    },
  ],
  [
    'the deck and the back a player picks are drawn on every card, shown before they are picked, and kept',
    async (rig) => {
      for (const screen of ['phone', 'desktop'] as const) {
        const table = rig.table([
          { name: 'Quigs', stack: 1000 },
          { name: 'Stu', stack: 1000 },
          { name: 'Pam', stack: 1000 },
        ]);
        // A card of each suit in sight on the flop: hearts and diamonds in hand, spades, clubs and diamonds on the board
        table.deal({ button: 0, holes: { 0: 'Ah Kd', 1: 'Qs Qh', 2: '7c 2d' }, board: '3s 4c Jd 9h Qd' });
        table.play(passive, (view) => view.hand!.street === 'flop');

        const page = await table.open('Quigs', screen);
        const press = (selector: string) => (screen === 'phone' ? page.tap(selector) : page.click(selector));
        const pick = (key: string, value: string) => press(`#pref-${key} .tile:has(input[value="${value}"])`);

        await page.waitForSelector('.board .card[data-card]:nth-child(3)');
        await page.waitForSelector('.entries li:has-text("Flop")', { state: 'attached' });

        const theme = await suitColors(page);
        const themeBack = await style(page, FACE_DOWN, 'backgroundImage');
        assert.equal(theme.d, theme.h, 'Card Room draws diamonds as it did');
        assert.equal(await page.locator('.entries .card-text').count(), 0, 'a card in the play-by-play is marked out with nothing chosen');

        await press('[data-action="menu"]');
        await press('.menu [data-action="preferences"]');
        await page.waitForSelector('#pref-deck');

        assertOnScreen(await boxes(page, '.dialog, .samples .tile'), screen, 'the Preferences dialog with its cards');
        assert.deepEqual(await squeezed(page, '.dialog h3, .samples > span, .tile > span:last-child'), [], 'a choice of cards is cut off');
        assert.equal(await page.evaluate(`document.querySelector('.dialog-body').scrollWidth <= document.querySelector('.dialog-body').clientWidth`), true, 'the dialog scrolls sideways');
        const tiles = await boxes(page, '.samples .tile');
        tiles.forEach((tile, index) => assertApart([tile], tiles.slice(index + 1), 'two choices of cards'));

        // Each sample is drawn as its choice would draw the table, whatever the table is drawn with now
        assert.equal(await style(page, '#pref-deck [data-deck="four"] .card.suit-d', 'color'), await tokenColor(page, '--suit-four-d'));
        assert.equal(await style(page, '#pref-deck [data-deck="theme"] .card.suit-d', 'color'), theme.d);
        await shot(page, `preferences-cards-${screen}`);

        await pick('deck', 'four');
        assert.equal(await page.evaluate(`localStorage.getItem('cnd.deck')`), 'four');

        const backs = new Set<string>();
        for (const back of ['lattice', 'dots', 'gingham', 'felt', 'theme']) {
          const sample = `#pref-cardBack [data-card-back="${back}"] .card.back`;
          assert.notEqual(await style(page, sample, 'backgroundImage'), await style(page, FACE_DOWN, 'backgroundImage'), `the ${back} sample is drawn with the back the table has now`);

          await pick('cardBack', back);
          const drawn = await style(page, FACE_DOWN, 'backgroundImage');

          assert.equal(drawn, await style(page, sample, 'backgroundImage'), `the ${back} back on the table is not the one Preferences showed`);
          backs.add(drawn);
        }

        assert.equal(backs.size, 5, 'two backs look the same on the table');
        assert.equal(await style(page, FACE_DOWN, 'backgroundImage'), themeBack, 'the theme back is not the one there was before');

        await pick('cardBack', 'gingham');
        const gingham = await style(page, FACE_DOWN, 'backgroundImage');
        await press('[data-action="close"]');

        const four = await suitColors(page);
        for (const suit of ['s', 'h', 'd', 'c']) {
          assert.equal(four[suit], await tokenColor(page, `--suit-four-${suit}`), `the ${suit} cards are not drawn in the four-color deck`);
        }

        assert.equal(new Set(Object.values(four)).size, 4, `two suits share a color: ${JSON.stringify(four)}`);
        assert.equal(await style(page, '.entries .card-text.suit-c', 'color'), four.c, 'a club in the play-by-play is not drawn as a club');
        assert.equal(await style(page, '.entries .card-text.suit-c', 'backgroundColor'), await tokenColor(page, '--card'), 'a card in the play-by-play is not set on a card');
        await shot(page, `four-color-${screen}`);

        await page.reload();
        await page.waitForSelector('.board .card[data-card]:nth-child(3)');
        assert.deepEqual(await suitColors(page), four, 'the deck changed with a reload');
        assert.equal(await style(page, FACE_DOWN, 'backgroundImage'), gingham, 'the back changed with a reload');

        await page.context().close();
      }
    },
  ],
  [
    'keyboard shortcuts play the moves a tap would, never while typing, in a dialog, switched off or just after the buttons change',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
      ]);

      // Heads-up the button acts first, so the deal puts the action on this page, facing the big blind
      table.deal({ button: 0 });
      const page = await table.open('Quigs', 'desktop');
      const sent = movesSent(page);
      const quigs = () => table.view('Stu').seats[0]!;
      const nothingSent = async (what: string) => {
        await page.waitForTimeout(300);
        assert.deepEqual(sent, [], `${what} sent a move`);
        assert.equal(table.view('Quigs').hand!.toAct, 0, `${what} moved the hand on`);
      };

      await page.waitForSelector('.turn [data-action="call"]:enabled');
      await settle(page);

      for (const selector of ['[data-action="fold"]', '[data-action="call"]', '[data-action="raise"]', '.presets button:nth-child(3)']) {
        assert.equal(await hintShown(page, `.turn ${selector}`), true, `no key is shown on ${selector}`);
      }
      assert.equal(await page.getByRole('button', { name: 'Fold', exact: true }).count(), 1, 'the key is read out as part of the button\'s name');
      assert.equal(await page.getByRole('button', { name: 'Call 10', exact: true }).count(), 1);
      assert.equal(await page.getAttribute('.turn [data-action="call"]', 'data-hotkey'), 'C');
      await shot(page, 'hotkeys-turn-desktop');

      await page.focus('#chat-input');
      await page.keyboard.type('fcr12345');
      assert.equal(await page.inputValue('#chat-input'), 'fcr12345', 'the keys were not typed into the chat box');
      assert.equal(await page.inputValue('#raise-amount'), '40', 'typing in the chat box changed the bet size');
      await nothingSent('typing in the chat box');
      await page.fill('#chat-input', '');

      await page.click('[data-action="menu"]');
      for (const key of ['f', 'c', '3']) {
        await page.keyboard.press(key);
      }
      await page.keyboard.press('Escape');
      await page.waitForSelector('.dialog', { state: 'detached' });
      assert.equal(await page.inputValue('#raise-amount'), '40', 'a key with the menu open changed the bet size');

      // The buttons were behind the menu, so a key the moment it closes was not pressed looking at them
      await page.keyboard.press('c');
      await nothingSent('a key with the menu open, or just after it closed');

      await page.click('[data-action="menu"]');
      await page.click('.menu [data-action="preferences"]');
      assert.match(await text(page, '[data-glossary="hotkeys"]'), /F\s*Fold/);
      // The dialog scrolls once its preferences outgrow the screen, as they do in a wider font
      await page.locator('[data-glossary="hotkeys"]').scrollIntoViewIfNeeded();
      assertOnScreen(await boxes(page, '[data-glossary="hotkeys"] div'), 'desktop', 'the list of keys');
      await shot(page, 'hotkeys-preferences-desktop');
      await page.click('#pref-hotkeys');
      await page.waitForSelector('#pref-hotkeys[aria-checked="false"]');
      await page.click('[data-action="close"]');
      assert.equal(await hintShown(page, '.turn [data-action="fold"]'), false, 'a key is still shown with the shortcuts off');
      for (const key of ['f', 'c', 'r', '3']) {
        await page.keyboard.press(key);
      }
      await nothingSent('a key with the shortcuts off');
      assert.equal(await page.evaluate(`localStorage.getItem('cnd.hotkeys')`), 'off');

      await page.click('[data-action="menu"]');
      await page.click('.menu [data-action="preferences"]');
      await page.click('#pref-hotkeys');
      await page.click('[data-action="close"]');
      await page.evaluate('document.activeElement.blur()');
      await settle(page);

      // 3 picks the third size, three quarters of the pot with the call counted: to 20 + ¾ × (30 + 10)
      await page.keyboard.press('3');
      assert.equal(await page.inputValue('#raise-amount'), '50');
      assert.equal(await text(page, '.turn [data-action="raise"]'), 'Raise to 50');
      await page.keyboard.press('4');
      assert.equal(await text(page, '.turn [data-action="raise"]'), 'Raise to 60', 'the fourth size, the pot');
      await page.keyboard.press('5');
      assert.equal(await text(page, '.turn [data-action="raise"]'), 'All in 1,000');

      await page.keyboard.press('c');
      await page.waitForSelector('.turn', { state: 'detached' });
      assert.deepEqual(sent, ['call']);
      assert.equal(quigs().bet, 20, 'C did not call the big blind');

      // The big blind checks, and checks again on the flop, which puts the action back here with a check to make
      table.act('Stu', { type: 'check' });
      table.act('Stu', { type: 'check' });
      await page.waitForSelector('.turn [data-action="check"]:enabled');
      await settle(page);
      await page.keyboard.press('c');
      await page.waitForSelector('.turn', { state: 'detached' });
      assert.deepEqual(sent, ['call', 'check']);
      assert.equal(table.view('Quigs').hand!.street, 'turn', 'C did not check the flop through');

      // On the turn a bet arrives: the C meant for the check that is no longer there is not taken as a call
      table.act('Stu', { type: 'raise', to: 60 });
      await page.waitForSelector('.turn [data-action="call"]:enabled');
      await page.keyboard.press('c');
      await page.waitForTimeout(150);
      assert.deepEqual(sent, ['call', 'check'], 'a key pressed as the buttons changed was taken');
      await settle(page);
      await page.keyboard.press('c');
      await page.waitForSelector('.turn', { state: 'detached' });
      assert.deepEqual(sent, ['call', 'check', 'call']);
      assert.equal(table.view('Quigs').hand!.street, 'river');

      // R goes to the amount, what is typed replaces it, Escape gives the keys back and Enter makes the bet
      table.act('Stu', { type: 'check' });
      await page.waitForSelector('.turn [data-action="check"]:enabled');
      await settle(page);
      await page.keyboard.press('r');
      assert.equal(await page.evaluate('document.activeElement.id'), 'raise-amount');
      assert.equal(await page.inputValue('#raise-amount'), '20', 'R was typed into the amount');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate('document.activeElement === document.body'), true, 'Escape kept the keyboard in the amount');
      await page.keyboard.press('r');
      await page.keyboard.type('120');
      assert.equal(await text(page, '.turn [data-action="raise"]'), 'Bet 120');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.turn', { state: 'detached' });
      assert.deepEqual(sent, ['call', 'check', 'call', 'raise']);
      assert.equal(quigs().bet, 120, 'Enter did not bet what was typed');

      // F held down folds once
      table.act('Stu', { type: 'raise', to: 400 });
      await page.waitForSelector('.turn [data-action="fold"]:enabled');
      await settle(page);
      for (let press = 0; press < 5; press++) {
        await page.keyboard.down('f');
      }
      await page.keyboard.up('f');
      await page.waitForSelector('.turn', { state: 'detached' });
      await page.waitForTimeout(300);
      assert.deepEqual(sent, ['call', 'check', 'call', 'raise', 'fold']);
      assert.equal(quigs().folded, true, 'F did not fold');
      await page.context().close();
    },
  ],
  [
    'on a cents table the keys size, type and play a bet in dollars and cents, and a box that cannot be read plays nothing',
    async (rig) => {
      const table = rig.table(
        [
          { name: 'Quigs', stack: 10_000 },
          { name: 'Stu', stack: 10_000 },
        ],
        CENTS,
      );
      table.deal({ button: 0 });

      const page = await table.open('Quigs', 'desktop');
      const sent = movesSent(page);

      await page.waitForSelector('.turn [data-action="call"]:enabled');
      await settle(page);

      // Three quarters of the pot with the call counted: to 0.50 + ¾ × (0.75 + 0.25)
      await page.keyboard.press('3');
      assert.equal(await text(page, '.turn [data-action="raise"]'), 'Raise to 1.25');
      assert.equal(await page.inputValue('#raise-amount'), '1.25');

      await page.keyboard.press('r');
      await page.keyboard.type('1.505');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      assert.deepEqual(sent, [], 'a box that cannot be read played a move by key');
      assert.equal(await complaintOf(page, '#raise-amount'), TO_THE_CENT);

      await page.fill('#raise-amount', '1.50');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.turn', { state: 'detached' });
      assert.deepEqual(sent, ['raise']);
      assert.equal(table.view('Stu').seats[0]!.bet, 150, 'Enter did not raise to 1.50');
      await page.context().close();
    },
  ],
  [
    'O and T answer the run-it-twice question',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
      ]);
      table.deal({ button: 0 });
      table.act('Quigs', { type: 'raise', to: 1000 });
      table.act('Stu', { type: 'call' });

      const pages = [await table.open('Quigs', 'desktop'), await table.open('Stu', 'desktop')];
      const sent = pages.map(movesSent);

      for (const page of pages) {
        await page.waitForSelector('.turn [data-action="rit-yes"]:enabled');
        await settle(page);
        assert.equal(await hintShown(page, '.turn [data-action="rit-no"]'), true);
        assert.equal(await hintShown(page, '.turn [data-action="rit-yes"]'), true);
      }
      await shot(pages[0]!, 'hotkeys-run-it-twice-desktop');

      // One no ends the vote, so the yes comes first
      await pages[1]!.keyboard.press('t');
      await pages[1]!.waitForSelector('.turn', { state: 'detached' });
      assert.equal(table.view('Quigs').seats[1]!.ritVote, true, 'T did not say twice');

      await pages[0]!.keyboard.press('o');
      await pages[0]!.waitForSelector('.turn', { state: 'detached' });
      assert.deepEqual(sent, [['ritVote false'], ['ritVote true']]);
      assert.equal(table.view('Stu').seats[0]!.ritVote, false, 'O did not say once');

      for (const page of pages) {
        await page.context().close();
      }
    },
  ],
  [
    'on a phone no key is shown and none does anything',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
      ]);
      table.deal({ button: 0 });

      const page = await table.open('Quigs', 'phone');
      const sent = movesSent(page);

      await page.waitForSelector('.turn [data-action="call"]:enabled');
      await settle(page);
      assert.equal(await page.locator('.turn [data-hotkey]').count(), 8);
      for (const key of ['F', 'C', 'R', '1', '2', '3', '4', '5']) {
        assert.equal(await hintShown(page, `.turn [data-hotkey="${key}"]`), false, `${key} is shown on a phone`);
      }

      await page.keyboard.press('c');
      await page.waitForTimeout(300);
      assert.deepEqual(sent, []);
      assert.equal(table.view('Quigs').hand!.toAct, 0);
      await page.context().close();
    },
  ],
  [
    'the host can take someone who never played off the table',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
      ]);
      table.join('Lurker');

      const lurker = await table.open('Lurker', 'phone');
      const host = await table.open('Quigs', 'desktop');

      await host.click('[data-action="menu"]');
      await host.click('.menu [data-action="players"]');
      await host.click('li:has-text("Lurker") button:has-text("Remove")');
      await host.click('[data-action="confirm"]');

      await lurker.waitForSelector('#join-name');
      assert.deepEqual(
        table.view('Quigs').members.map((member) => member.name),
        ['Quigs', 'Stu'],
      );
    },
  ],
  [
    'the host makes a co-host from the Players dialog and ends it again, on a phone and a desktop',
    async (rig) => {
      for (const screen of ['phone', 'desktop'] as const) {
        const table = rig.table([
          { name: 'Quigs', stack: 1000 },
          { name: 'Marge Simpson-Jr', stack: 1000 },
        ]);
        table.join('Lurker');

        const page = await table.open('Quigs', screen);
        const press = pressOn(page, screen);
        const row = (name: string) => `.dialog li:has-text("${name}")`;

        await press('[data-action="menu"]');
        await press('.menu [data-action="players"]');

        for (const name of ['Marge Simpson-Jr', 'Lurker']) {
          assert.deepEqual(await page.locator(`${row(name)} button`).allInnerTexts(), name === 'Lurker' ? ['Make co-host', 'Make host', 'Remove'] : ['Set stack', 'Move', 'Make co-host', 'Make host', 'Remove']);
        }
        assert.deepEqual(await page.locator(`${row('Quigs')} button`).allInnerTexts(), ['Set stack', 'Move', 'Remove'], 'the host is offered a say over their own role');
        assertOnScreen(await boxes(page, '.dialog .row-actions .btn'), screen, 'a button in the Players dialog');
        assert.deepEqual(await squeezed(page, '.dialog .row-actions .btn'), [], 'a button in the Players dialog is cut off');
        await shot(page, `players-host-${screen}`);

        await press(`${row('Marge Simpson-Jr')} [data-action="make-cohost"]`);
        assert.equal(await text(page, '.dialog h2'), 'Make Marge Simpson-Jr a co-host?');
        await press('[data-action="confirm"]');
        assert.deepEqual(table.view('Quigs').cohostIds, [table.auth('Marge Simpson-Jr').id]);

        await press('[data-action="menu"]');
        await press('.menu [data-action="players"]');
        await page.waitForSelector(`${row('Marge Simpson-Jr')} .cohost`);
        assert.equal(await page.locator('.seat[data-seat="1"] .plate .cohost').count(), 1, 'the seat does not show the co-host mark');
        await shot(page, `players-cohost-named-${screen}`);

        // Ending it is undone in one tap, so it asks nothing
        await press(`${row('Marge Simpson-Jr')} [data-action="end-cohost"]`);
        await page.waitForSelector(`${row('Marge Simpson-Jr')} [data-action="make-cohost"]`);
        assert.deepEqual(table.view('Quigs').cohostIds, []);
        assert.match(await text(page, '.feed-toggle .latest'), /Marge Simpson-Jr is no longer a co-host/);

        await page.context().close();
      }
    },
  ],
  [
    'a co-host gets the host\'s tools but not the host\'s own, and a plain member gets neither',
    async (rig) => {
      for (const screen of ['phone', 'desktop'] as const) {
        const table = rig.table([
          { name: 'Quigs', stack: 1000 },
          { name: 'Stu', stack: 1000 },
          { name: 'Pam', stack: 1000 },
        ]);
        table.join('Lurker');
        table.act('Quigs', { type: 'setCohost', playerId: table.auth('Stu').id, on: true });

        const cohost = await table.open('Stu', screen);
        const press = pressOn(cohost, screen);
        assert.equal(await cohost.locator('.table.movable').count(), 1, 'a co-host cannot drag players to other seats');

        await press('[data-action="menu"]');
        const menu = await cohost.locator('.menu .menu-item').evaluateAll((items) => items.map((item) => item.getAttribute('data-action')));
        for (const tool of ['players', 'shuffle', 'settings', 'start']) {
          assert.ok(menu.includes(tool), `the co-host's menu has no ${tool}: ${menu.join(', ')}`);
        }

        await press('.menu [data-action="players"]');
        assert.deepEqual(await cohost.locator('.dialog li:has-text("Quigs") button').allInnerTexts(), ['Set stack', 'Move'], 'a co-host is offered to remove the host');
        assert.deepEqual(await cohost.locator('.dialog li:has-text("Pam") button').allInnerTexts(), ['Set stack', 'Move', 'Remove']);
        assert.deepEqual(await cohost.locator('.dialog li:has-text("Lurker") button').allInnerTexts(), ['Remove']);
        assert.equal(await cohost.locator('.dialog [data-action="transfer"]').count(), 1, 'a co-host is not offered to transfer chips');
        assert.equal(await cohost.locator('[data-action="make-host"], [data-action="make-cohost"], [data-action="end-cohost"]').count(), 0, 'a co-host is offered what only the host may do');
        assertOnScreen(await boxes(cohost, '.dialog .row-actions .btn'), screen, 'a button in the co-host\'s Players dialog');
        await shot(cohost, `players-as-cohost-${screen}`);

        // No longer a co-host, they are left holding none of the host's tools
        table.act('Quigs', { type: 'setCohost', playerId: table.auth('Stu').id, on: false });
        await cohost.waitForSelector('.dialog', { state: 'detached' });
        await cohost.context().close();

        if (screen === 'phone') {
          const member = await table.open('Pam', screen);
          await member.tap('[data-action="menu"]');
          await member.waitForSelector('.menu');
          assert.equal(
            await member.locator('.menu [data-action="players"], .menu [data-action="shuffle"], .menu [data-action^="bomb-pot"], .menu [data-action="settings"], .menu [data-action="start"]').count(),
            0,
            'a plain member is offered the host\'s tools',
          );
          assert.equal(await member.locator('.table.movable').count(), 0, 'a plain member can drag players to other seats');
          assert.equal(await member.locator('.message [data-action="start"]').count(), 0);
          await member.context().close();
        }
      }
    },
  ],
  [
    'the co-host mark sits beside the host\'s star, whole, however long the names',
    async (rig) => {
      for (const screen of ['smallPhone', 'desktop'] as const) {
        // The host's name is a long one too
        const players = tenPlayers();
        [players[0]!.name, players[3]!.name] = [players[3]!.name, players[0]!.name];

        const table = rig.table(players);
        for (const name of ['WWWWWWWWWWWWWWWW', '你好你好你好你好', 'Stu']) {
          table.act('Marge Simpson-Jr', { type: 'setCohost', playerId: table.auth(name).id, on: true });
        }

        const page = await table.open('Big Al', screen);
        await page.waitForSelector('.plate .cohost');
        assert.equal(await page.locator('.plate .host').count(), 1);
        assert.equal(await page.locator('.plate .cohost').count(), 3);

        // The name gives way to its mark: the mark is drawn whole, inside its plate
        const cut = await page.evaluate(`[...document.querySelectorAll('.plate .host, .plate .cohost')].filter((mark) => {
          const box = mark.getBoundingClientRect();
          const name = mark.parentElement.getBoundingClientRect();
          return box.width < 4 || box.left < name.left - 1 || box.right > name.right + 1;
        }).length`);
        assert.equal(cut, 0, 'a host or co-host mark is cut off by a long name');
        assert.deepEqual(await squeezed(page, '.plate .stack'), [], 'a stack is cut off');
        assertOnScreen(await boxes(page, '.seat .plate'), screen, 'a seat');
        await shot(page, `cohost-marks-${screen}`);
        await page.context().close();
      }
    },
  ],
  [
    'a co-host approves a seat request from the banner',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
      ]);
      table.join('Ann');
      table.act('Quigs', { type: 'setCohost', playerId: table.auth('Stu').id, on: true });

      const page = await table.open('Stu', 'phone');
      table.act('Ann', { type: 'requestSeat', seat: 4, buyIn: 500 });

      await page.waitForSelector('.banner:has-text("Ann wants seat 5") [data-action="approve"]');
      assert.equal(await text(page, '.menu-button .dot'), '1');
      assertOnScreen(await boxes(page, '.banner .btn'), 'phone', 'the banner\'s buttons');
      await shot(page, 'cohost-approves-phone');

      await page.tap('.banner [data-action="approve"]');
      await page.waitForSelector('.banner', { state: 'detached' });
      assert.equal(table.view('Ann').you.seat, 4);
      assert.match(await text(page, '.feed-toggle .latest'), /Ann sits down with 500/);
      await page.context().close();
    },
  ],
  [
    'the voice chat button fits the top bar beside everything already there, and leaves it as it was when taken away',
    async (rig) => {
      const link = 'https://meet.google.com.a-very-long-subdomain.example/abc-defg-hij';
      const shown = '…-long-subdomain.example';

      for (const screen of ['smallPhone', 'phone', 'phoneSideways', 'desktop'] as const) {
        const table = rig.table(
          [
            { name: 'Quigs', stack: 1000 },
            { name: 'Stu', stack: 1000 },
          ],
          { name: 'Friday night at the Quigleys, every week' },
        );
        table.join('Lurker');
        table.deal({ button: 0 });

        const page = await table.open('Lurker', screen);
        const bar = '.topbar > *';
        const before = await boxes(page, bar);
        assert.equal(await page.locator('.voice-link').count(), 0, 'a button with no call to go to');

        table.act('Quigs', { type: 'updateConfig', config: { voiceLink: link } });
        await page.waitForSelector('.voice-link');

        const button = page.locator('.voice-link');
        assert.equal(await button.getAttribute('href'), link);
        assert.equal(await button.getAttribute('target'), '_blank');
        assert.equal(await button.getAttribute('rel'), 'noopener noreferrer');
        assert.equal(await text(page, '.voice-link'), `Voice · ${shown}`, 'the button names where it leads, keeping the end of the host');

        const [voice] = await boxes(page, '.voice-link');
        assertOnScreen([voice!], screen, 'the voice chat button');
        for (const other of ['.menu-button', '.topbar .title', '.topbar .pill', '[data-action="invite"]']) {
          assertApart(await boxes(page, other), [voice!], `the voice chat button and ${other}`);
        }

        const [title] = await boxes(page, '.topbar .title b');
        assert.ok(title!.right - title!.left >= 120, `the table's name is squeezed to ${title!.right - title!.left}px`);
        assert.deepEqual(await squeezed(page, '.voice-link, .topbar .pill, [data-action="invite"]'), [], 'a part of the top bar is cut off');
        assertOnScreen(await boxes(page, bar), screen, 'the top bar');

        const [stage] = await boxes(page, '.stage');
        assertOnScreen(await boxes(page, '.seat .plate'), screen, 'a seat');
        for (const seat of await boxes(page, '.seat .plate')) {
          assert.ok(seat.top >= stage!.top - 1, `a seat is drawn under the top bar: ${JSON.stringify(seat)}`);
        }
        await shot(page, `voice-link-${screen}`);

        table.act('Quigs', { type: 'updateConfig', config: { voiceLink: '' } });
        await page.waitForSelector('.voice-link', { state: 'detached' });
        assert.deepEqual(await boxes(page, bar), before, 'the top bar is not as it was before the call was set');
        await page.context().close();
      }
    },
  ],
  [
    'a co-host sets the voice chat link in the settings, a bad address is refused with the reason, and a plain member cannot change it',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
        { name: 'Pam', stack: 1000 },
      ]);
      table.act('Quigs', { type: 'setCohost', playerId: table.auth('Stu').id, on: true });

      // The host has the settings open from before the link was set, and saves something else after
      const host = await table.open('Quigs', 'desktop');
      await host.click('[data-action="menu"]');
      await host.click('.menu [data-action="settings"]');
      await host.waitForSelector('#table-voice-link');

      const cohost = await table.open('Stu', 'phone');
      await cohost.tap('[data-action="menu"]');
      await cohost.tap('.menu [data-action="settings"]');

      const typed = 'http://meet.google.com/abc-defg-hij';
      await cohost.fill('#table-voice-link', typed);
      await cohost.tap('[data-action="save-settings"]');
      await cohost.waitForSelector('.toast:has-text("The voice chat link must start with https://")');
      assert.equal(await cohost.inputValue('#table-voice-link'), typed, 'a refused save threw away what was typed');
      await cohost.locator('#table-voice-link').scrollIntoViewIfNeeded();
      assertOnScreen(await boxes(cohost, '#table-voice-link'), 'phone', 'the voice chat link field');
      await shot(cohost, 'voice-link-refused-phone');

      await cohost.fill('#table-voice-link', ' https://meet.google.com/abc-defg-hij ');
      await cohost.tap('[data-action="save-settings"]');
      await cohost.waitForSelector('.dialog', { state: 'detached' });
      await cohost.waitForSelector('.voice-link');
      assert.equal(await cohost.getAttribute('.voice-link', 'href'), 'https://meet.google.com/abc-defg-hij');
      assert.equal(await text(cohost, '.voice-link'), 'Voice · meet.google.com');
      assert.match(await text(cohost, '.feed-toggle .latest'), /Co-host Stu set the voice chat link/);
      await cohost.context().close();

      await host.fill('#table-big-blind', '40');
      await host.click('[data-action="save-settings"]');
      await host.waitForSelector('.dialog', { state: 'detached' });
      assert.equal(table.view('Quigs').config.bigBlind, 40);
      assert.equal(table.view('Quigs').config.voiceLink, 'https://meet.google.com/abc-defg-hij', 'a settings form opened earlier undid the co-host\'s link');
      await host.context().close();

      const member = await table.open('Pam', 'phone');
      assert.equal(await member.getAttribute('.voice-link', 'href'), 'https://meet.google.com/abc-defg-hij', 'a player at the table has the button too');
      await member.tap('[data-action="menu"]');
      await member.waitForSelector('.menu');
      assert.equal(await member.locator('.menu [data-action="settings"]').count(), 0, 'a plain member is offered the settings');
      await member.context().close();

      const answer = table.tryAct('Pam', { type: 'updateConfig', config: { voiceLink: 'https://evil.example' } });
      assert.equal(answer.ok, false, 'a plain member changed the voice chat link');
      assert.equal(table.view('Quigs').config.voiceLink, 'https://meet.google.com/abc-defg-hij');
    },
  ],
  [
    'a table that plays dollars and cents shows its stacks, bets and pot in dollars',
    async (rig) => {
      const table = rig.table(
        [
          { name: 'Quigs', stack: 10_000 },
          { name: 'Stu', stack: 25_000 },
          { name: 'Pocket Pam', stack: 30_000 },
          { name: 'Big Al', stack: 25_000 },
          { name: 'Marge Simpson-Jr', stack: 20_000 },
          { name: 'Zed', stack: 50_000 },
        ],
        CENTS,
      );
      table.deal({ button: 0 });
      table.act('Big Al', { type: 'raise', to: 150 });
      table.act('Marge Simpson-Jr', { type: 'call' });
      table.act('Zed', { type: 'raise', to: 1250 });
      table.act('Quigs', { type: 'call' });
      table.act('Stu', { type: 'call' });
      table.act('Pocket Pam', { type: 'raise', to: 4500 });

      for (const screen of PHONE_AND_DESKTOP) {
        const page = await table.open('Quigs', screen);

        assert.equal(await text(page, '.topbar .title span'), '0.25/0.50 hold’em');
        assert.deepEqual(
          await stacksBySeat(page, 6),
          ['87.50', '237.50', '255.00', '248.50', '198.50', '487.50'],
        );
        assert.deepEqual((await texts(page, '.bet')).sort(), ['1.50', '1.50', '12.50', '12.50', '12.50', '45.00']);
        assert.equal(await text(page, '.pot'), 'Pot85.50');
        assert.match(await text(page, '.feed-toggle .latest'), /Pocket Pam raises to 45\.00$/);
        await shot(page, `cents-table-${screen}`);

        assert.deepEqual(await squeezed(page, '.plate .stack, .bet, .pot, .topbar .title span'), [], 'an amount is cut off, so it reads wrong');
        assertOnScreen(await boxes(page, '.seat .plate, .bet, .pot'), screen, 'a seat, a bet or the pot');
        await assertBetsApart(page);

        await page.context().close();
      }

      // A table only just taller than it is wide stands up with the least height it will ever have, which is
      // where the bets beside the middle come nearest the board and the pot.
      const page = await table.open('Quigs', 'phone');
      await setStageHeight(page, JUST_STANDING);
      await page.waitForSelector('.table.tall').catch(() => assert.fail(`a phone's table ${JUST_STANDING} tall is not standing up: has WIDE_ASPECT changed?`));
      await shot(page, 'cents-table-phone-just-standing');

      const [stage] = await boxes(page, '.stage');
      for (const bet of await boxes(page, '.bet')) {
        assert.ok(bet.top >= stage!.top && bet.bottom <= stage!.bottom, `a bet runs off the table: ${JSON.stringify(bet)}`);
      }

      await assertBetsApart(page);
      await page.context().close();
    },
  ],
  [
    'the longest amounts a cents table can show are whole on a small phone and on the desktop',
    async (rig) => {
      // 99,999.99 is the longest amount written out; from there up a seat and a bet shorten it, and the pot never does
      const table = rig.table(
        [
          { name: 'Quigs', stack: 10_000 },
          { name: 'Stu', stack: 9_999_999 },
          { name: 'Pocket Pam', stack: 1_000_000_000 },
          { name: 'Big Al', stack: 1_000_000_000 },
          { name: 'Marge Simpson-Jr', stack: 2000 },
          { name: 'Zed', stack: 123_456 },
        ],
        CENTS,
      );
      table.deal({ button: 0 });
      table.act('Big Al', { type: 'raise', to: 150 });
      table.act('Marge Simpson-Jr', { type: 'call' });
      table.act('Zed', { type: 'raise', to: 123_456 });
      table.act('Quigs', { type: 'call' });
      table.act('Stu', { type: 'raise', to: 9_999_999 });
      table.act('Pocket Pam', { type: 'raise', to: 987_654_321 });

      for (const screen of ['smallPhone', 'desktop'] as const) {
        const page = await table.open('Quigs', screen);

        assert.deepEqual(
          await stacksBySeat(page, 6),
          ['0.00', '0.00', '123.45K', '9.99M', '18.50', '0.00'],
        );
        assert.deepEqual((await texts(page, '.bet')).sort(), ['1,234.56', '1.50', '1.50', '100.00', '9.87M', '99,999.99']);
        assert.equal(await text(page, '.pot'), 'Pot9,977,880.76');
        await shot(page, `cents-longest-${screen}`);

        assert.deepEqual(await squeezed(page, '.plate .stack, .bet, .pot'), [], 'an amount is cut off, so it reads wrong');
        assertOnScreen(await boxes(page, '.seat .plate, .bet, .pot'), screen, 'a seat, a bet or the pot');
        assertApart(await boxes(page, '.bet'), await boxes(page, '.board .card, .pot'), 'a bet and the middle of the table');
        assertApart(await boxes(page, '.pot'), await boxes(page, '.seat .plate'), 'the pot and a seat');

        await page.context().close();
      }
    },
  ],
  [
    'on a cents table the bet box reads dollars, the size buttons land on a cent, and an amount that cannot be read is not played',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        const table = rig.table(
          [
            { name: 'Quigs', stack: 10_000 },
            { name: 'Stu', stack: 10_000 },
            { name: 'Pam', stack: 10_000 },
          ],
          CENTS,
        );
        table.deal({ button: 0 });

        const page = await table.open('Quigs', screen);
        const press = pressOn(page, screen);
        const raiseButton = '.turn [data-action="raise"]';
        const typeAmount = (typed: string) => page.fill('#raise-amount', typed);

        assert.equal(await text(page, '.turn [data-action="call"]'), 'Call 0.50');
        assert.equal(await text(page, raiseButton), 'Raise to 1.00');
        assert.equal(await page.inputValue('#raise-amount'), '1.00');
        assert.equal(await page.getAttribute('#raise-amount', 'inputmode'), 'decimal', 'a phone would not offer a decimal point');

        await typeAmount('1.50');
        assert.equal(await text(page, raiseButton), 'Raise to 1.50');
        await typeAmount('.5');
        assert.equal(await text(page, raiseButton), 'Raise to 1.00', 'less than the smallest raise is the smallest raise');
        await typeAmount('');
        assert.equal(await text(page, raiseButton), 'Raise to 1.00');

        // 0.75 in the pot and 0.50 to call: no share of that is a round number of cents
        for (const [preset, expected] of [['½ pot', '1.13'], ['¾ pot', '1.44'], ['Pot', '1.75'], ['Min', '1.00']] as const) {
          await press(`.presets button:text-is("${preset}")`);
          assert.equal(await page.inputValue('#raise-amount'), expected, preset);
          assert.equal(await text(page, raiseButton), `Raise to ${expected}`, preset);
        }

        await page.locator('#raise-slider').fill('4321');
        assert.equal(await page.inputValue('#raise-amount'), '43.21');
        assert.equal(await text(page, raiseButton), 'Raise to 43.21');

        // A third decimal is neither rounded nor swapped for the last amount that could be read
        await typeAmount('1.555');
        assert.equal(await text(page, raiseButton), 'Raise');
        assert.equal(await page.getAttribute(raiseButton, 'aria-disabled'), 'true');
        assert.equal(await complaintOf(page, '#raise-amount'), TO_THE_CENT);

        // The button takes no part in the browser's own disabling, so a press still lands on it, and gets the reason
        await page.locator(raiseButton).dispatchEvent('click');
        await shot(page, `cents-third-decimal-${screen}`);

        // Halfway to an amount, as "1," is to "1,000", nothing is played either
        await typeAmount('1,');
        assert.equal(await page.getAttribute(raiseButton, 'aria-disabled'), 'true');
        await page.locator(raiseButton).dispatchEvent('click');

        await typeAmount('1.50');
        assert.equal(await page.getAttribute(raiseButton, 'aria-disabled'), null);
        assert.deepEqual(await squeezed(page, '.turn .btn, #raise-amount'), [], 'a move button or the amount box is cut off');
        assertOnScreen(await boxes(page, '.turn .btn, #raise-amount, .presets button'), screen, 'the bet controls');
        await shot(page, `cents-my-turn-${screen}`);

        await press(raiseButton);
        await page.waitForSelector('.turn', { state: 'detached' });

        const quigs = table.view('Quigs');
        assert.equal(quigs.seats[0]!.bet, 150);
        assert.deepEqual(
          quigs.feed.filter((entry) => entry.text.startsWith('Quigs ')).map((entry) => entry.text),
          ['Quigs opened the table', 'Quigs sits down with 100.00', 'Quigs raises to 1.50'],
          'the press on a box that could not be read played something',
        );

        await page.context().close();
      }
    },
  ],
  [
    'on a cents table a size button never asks for more than the stack',
    async (rig) => {
      const table = rig.table(
        [
          { name: 'Quigs', stack: 120 },
          { name: 'Stu', stack: 10_000 },
          { name: 'Pam', stack: 10_000 },
        ],
        CENTS,
      );
      table.deal({ button: 0 });

      const page = await table.open('Quigs', 'phone');
      await page.tap('.presets button:text-is("Pot")');
      assert.equal(await page.inputValue('#raise-amount'), '1.20');
      assert.equal(await text(page, '.turn [data-action="raise"]'), 'All in 1.20');
      await page.fill('#raise-amount', '1,000,000.00');
      assert.equal(await text(page, '.turn [data-action="raise"]'), 'All in 1.20', 'more than the stack is the stack');
    },
  ],
  [
    'the ledger, who pays whom and the hand history of a cents table read in dollars',
    async (rig) => {
      const table = rig.table(
        [
          { name: 'Quigs', stack: 10_000 },
          { name: 'Stu', stack: 5000 },
          { name: 'Pocket Pam', stack: 30_000 },
        ],
        CENTS,
      );
      table.deal({ button: 0, holes: { 0: 'As Ah', 1: '7c 2d', 2: 'Ks Kh' }, board: '3s 4d 9h Jc Qd' });
      table.act('Quigs', { type: 'pause' });
      table.act('Quigs', { type: 'raise', to: 150 });
      table.act('Stu', { type: 'fold' });
      table.play(passive, (view) => view.hand === null);

      for (const screen of PHONE_AND_DESKTOP) {
        const page = await table.open('Quigs', screen);
        const press = pressOn(page, screen);
        await openLedger(page, screen);

        assert.deepEqual(await ledgerRows(page), [
          ['Quigs', '100.00', '0.00', '101.75', '+1.75'],
          ['Stu', '50.00', '0.00', '49.75', '-0.25'],
          ['Pocket Pam', '300.00', '0.00', '298.50', '-1.50'],
        ]);
        assert.deepEqual(await texts(page, '.settle li'), ['Pocket Pam pays Quigs 1.50', 'Stu pays Quigs 0.25']);

        assert.deepEqual(await squeezed(page, '.ledger th, .ledger td, .settle li, .dialog h2'), [], 'an amount in the ledger is cut off');
        assertOnScreen(await boxes(page, '.dialog, .ledger th, .ledger td, .settle li'), screen, 'the ledger');
        await shot(page, `cents-ledger-${screen}`);

        await press('[data-action="close"]');
        await press('[data-action="menu"]');
        await press('.menu [data-action="history"]');
        await page.waitForSelector('.history summary');
        assert.equal(await text(page, '.history summary small'), 'Quigs +3.25');
        await press('.history summary');
        assert.match(await text(page, '.history pre'), /^Hand #1 · blinds 0\.25\/0\.50 · Quigs has the button\n[^]*\nPocket Pam calls 1\.00\n[^]*\nQuigs wins 3\.25 with [^\n]+$/);

        await page.context().close();
      }

      // Four columns of a million to the cent are wider than a phone: the table scrolls sideways inside the dialog, and nothing else gives
      const rich = rig.table([{ name: 'Quigs', stack: 100_000_000 }, { name: 'Stu', stack: 100_000_000 }], CENTS);
      const page = await rich.open('Quigs', 'phone');
      await openLedger(page, 'phone');

      assert.deepEqual((await ledgerRows(page))[0], ['Quigs', '1,000,000.00', '0.00', '1,000,000.00', '0.00']);
      assert.deepEqual(await squeezed(page, '.ledger th, .ledger td'), [], 'an amount in the ledger is cut off');
      assertOnScreen(await boxes(page, '.dialog'), 'phone', 'the ledger');
      await assertNoSidewaysScroll(page);

      await page.evaluate(`document.querySelector('.ledger td:last-child').scrollIntoView({ inline: 'end' })`);
      assertOnScreen(await boxes(page, '.ledger tbody tr:first-child td:last-child'), 'phone', 'the last column, scrolled to');
    },
  ],
  [
    'the host transfers chips between two players, a refused amount keeps what was typed, and the ledger and the settle-up show it',
    async (rig) => {
      const LONG = 'WWWWWWWWWWWWWWWW';
      const kinds = [
        {
          name: 'chips',
          config: {},
          stack: 1000,
          fraction: '2.5',
          tooMuch: '5000',
          refusal: 'The amount must be a whole number from 1 to 1,000',
          amount: '300',
          moved: `The host moved 300 from ${LONG} to Stu`,
          rows: [
            ['Stu', '1,000', '0', '+300', '1,300', '+300'],
            ['Quigs', '1,000', '0', '0', '1,000', '0'],
            [LONG, '1,000', '0', '-300', '700', '-300'],
          ],
          settle: [`${LONG} pays Stu 300`],
        },
        {
          name: 'cents',
          config: CENTS,
          stack: 10_000,
          fraction: '1.234',
          tooMuch: '150.00',
          refusal: 'The amount must be an amount to the cent from 0.01 to 100.00',
          amount: '12.34',
          moved: `The host moved 12.34 from ${LONG} to Stu`,
          rows: [
            ['Stu', '100.00', '0.00', '+12.34', '112.34', '+12.34'],
            ['Quigs', '100.00', '0.00', '0.00', '100.00', '0.00'],
            [LONG, '100.00', '0.00', '-12.34', '87.66', '-12.34'],
          ],
          settle: [`${LONG} pays Stu 12.34`],
        },
      ];

      for (const kind of kinds) {
        for (const screen of PHONE_AND_DESKTOP) {
          const table = rig.table(
            ['Quigs', LONG, 'Stu'].map((name) => ({ name, stack: kind.stack })),
            kind.config,
          );
          const page = await table.open('Quigs', screen);
          const press = pressOn(page, screen);

          await press('[data-action="menu"]');
          await press('.menu [data-action="players"]');
          assertOnScreen(await boxes(page, '.dialog [data-action="transfer"]'), screen, 'the button that starts a transfer');
          await shot(page, `transfer-players-${kind.name}-${screen}`);
          await press('.dialog [data-action="transfer"]');
          assert.equal(await text(page, '.dialog h2'), 'Transfer chips');

          await page.selectOption('#transfer-from', { label: LONG });
          await page.selectOption('#transfer-to', { label: 'Stu' });
          await page.fill('#transfer-amount', kind.fraction);
          assert.notEqual(await complaintOf(page, '#transfer-amount'), '', 'a fraction of the smallest unit can be sent');

          await page.fill('#transfer-amount', kind.tooMuch);
          await press('[data-action="confirm-transfer"]');
          await page.waitForSelector(`.toast:has-text("${kind.refusal}")`);
          assert.equal(await page.inputValue('#transfer-amount'), kind.tooMuch, 'the refused amount was thrown away');
          assert.deepEqual([await page.inputValue('#transfer-from'), await page.inputValue('#transfer-to')], [table.auth(LONG).id, table.auth('Stu').id], 'the players picked were thrown away');

          await page.fill('#transfer-amount', kind.amount);
          assert.deepEqual(await squeezed(page, '.dialog .field, .dialog .field select, .dialog .field input, .dialog .btn, .dialog h2'), [], 'part of the transfer form is cut off');
          assertOnScreen(await boxes(page, '.dialog .field, .dialog [data-action="confirm-transfer"]'), screen, 'the transfer form');
          await shot(page, `transfer-${kind.name}-${screen}`);

          await press('[data-action="confirm-transfer"]');
          await page.waitForSelector('.dialog [data-action="transfer"]');
          assert.equal(await text(page, '.feed-toggle .latest'), kind.moved);

          await press('[data-action="close"]');
          await openLedger(page, screen);

          assert.deepEqual(await texts(page, '.ledger th'), ['Player', 'Bought', 'Cashed out', 'Transferred', 'On table', 'Net']);
          assert.deepEqual(await ledgerRows(page), kind.rows);
          assert.deepEqual(await texts(page, '.settle li'), kind.settle);
          assert.match(await text(page, '.dialog-body > .note'), /^Transferred is chips/);

          assert.deepEqual(await squeezed(page, '.ledger th, .ledger td, .settle li, .dialog .note, .dialog h2'), [], 'part of the ledger is cut off');
          assertOnScreen(await boxes(page, '.dialog, .settle li, .dialog-body > .note'), screen, 'the ledger');
          await assertNoSidewaysScroll(page);
          await shot(page, `transfer-ledger-${kind.name}-${screen}`);
          await page.evaluate(`document.querySelector('.ledger td:last-child').scrollIntoView({ inline: 'end' })`);
          assertOnScreen(await boxes(page, '.ledger tbody tr:last-child td:last-child'), screen, 'the last column of the ledger, scrolled to');

          await page.context().close();
        }
      }
    },
  ],
  [
    'the form for a new table switches between whole chips and dollars and cents, and the table it makes plays what was picked',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        const page = await rig.lobby(screen);
        const press = pressOn(page, screen);
        const stakes = () => Promise.all(['small-blind', 'big-blind', 'min-buy-in', 'max-buy-in'].map((field) => page.inputValue(`#new-table-${field}`)));
        const pick = (label: string) => press(`#new-table-unit label:has-text("${label}")`);

        assert.equal(await page.isChecked('#new-table-unit input[value="chips"]'), true, 'whole chips is what a table plays unless its host says otherwise');
        assert.deepEqual(await stakes(), ['10', '20', '400', '2000']);
        assert.equal(await text(page, '#new-table-unit small'), "Can't be changed once the table is created");

        await page.fill('#host-name', 'Quigs');
        await page.fill('#new-table-name', 'Friday nickels');
        await pick('Dollars and cents');
        assert.deepEqual(await stakes(), ['0.25', '0.50', '20.00', '100.00']);
        assert.equal(await page.inputValue('#new-table-name'), 'Friday nickels', 'picking what to play with threw away the name that was typed');
        assert.equal(await page.getAttribute('#new-table-small-blind', 'inputmode'), 'decimal');

        // The front page scrolls, so what matters is that the form keeps to the width of the screen
        await page.locator('#new-table-max-buy-in').scrollIntoViewIfNeeded();
        await shot(page, `cents-new-table-${screen}`);
        assert.deepEqual(await squeezed(page, '#new-table-unit .check span, #new-table-unit > span, #new-table-unit small, .card-panel .field input'), [], 'part of the form is cut off');
        assertOnScreen(await boxes(page, '#new-table-max-buy-in'), screen, 'the end of the form for a new table');
        await page.locator('#new-table-unit').scrollIntoViewIfNeeded();
        assertOnScreen(await boxes(page, '#new-table-unit, #new-table-unit .check, #new-table-small-blind'), screen, 'the form for a new table');
        await assertNoSidewaysScroll(page);
        const [chips, cents] = await boxes(page, '#new-table-unit .check');
        assert.ok(chips && cents && !overlap(chips, cents), 'the two choices are drawn over each other');

        await pick('Whole chips');
        assert.deepEqual(await stakes(), ['10', '20', '400', '2000']);
        assert.equal(await page.getAttribute('#new-table-small-blind', 'inputmode'), 'numeric');
        await page.fill('#new-table-small-blind', '0.25');
        assert.equal(await complaintOf(page, '#new-table-small-blind'), 'This table plays whole chips, so an amount has no decimals');

        await pick('Dollars and cents');
        assert.deepEqual(await stakes(), ['0.25', '0.50', '20.00', '100.00'], 'the stakes start over with the choice');

        // The browser keeps a form with a field it has a complaint about from being sent
        await page.fill('#new-table-small-blind', '0.255');
        assert.equal(await complaintOf(page, '#new-table-small-blind'), TO_THE_CENT);
        await press('[data-action="create-table"]');
        assert.equal(await page.locator('#table-link').count(), 0, 'a table was made from a blind that could not be read');

        await page.fill('#new-table-small-blind', '.10');
        await page.fill('#new-table-big-blind', '0,25');
        await page.fill('#new-table-max-buy-in', '1,000.00');
        await press('[data-action="create-table"]');
        await page.waitForSelector('#table-link');

        const link = await page.inputValue('#table-link');
        const tableId = new URL(link).searchParams.get('table')!;
        const { unit, name, smallBlind, bigBlind, minBuyIn, maxBuyIn } = rig.store.read(tableId)!.config;
        assert.deepEqual({ unit, name, smallBlind, bigBlind, minBuyIn, maxBuyIn }, { unit: 'cents', name: 'Friday nickels', smallBlind: 10, bigBlind: 25, minBuyIn: 2000, maxBuyIn: 100_000 });

        await press('[data-action="close"]');
        assert.equal(await text(page, '.topbar .title span'), '0.10/0.25 hold’em');

        // Sitting down: the buy-in is offered, bounded and read in dollars
        await press('[data-sit="0"]');
        assert.equal(await page.inputValue('#buy-in'), '25.00');
        assert.equal(await text(page, '.dialog .field small'), 'From 20.00 to 1,000.00');
        await page.fill('#buy-in', '19.99');
        assert.equal(await complaintOf(page, '#buy-in'), "This can't be less than 20.00");
        await page.fill('#buy-in', '1,000.01');
        assert.equal(await complaintOf(page, '#buy-in'), "This can't be more than 1,000.00");
        await page.fill('#buy-in', '40.5');
        assert.equal(await complaintOf(page, '#buy-in'), '');
        await press('[data-action="confirm-sit"]');
        await page.waitForSelector('.seat.me');
        assert.equal(await text(page, '.seat.me .stack'), '40.50');
        assert.equal(rig.store.read(tableId)!.seats[0]!.stack, 4050);

        // Someone following the link is told the stakes the same way
        const visitor = await rig.page(screen, 'a visitor');
        await visitor.goto(link);
        await visitor.waitForSelector('[data-action="join-table"]:enabled');
        assert.deepEqual(await texts(visitor, '.about p:not(.note)'), ['Blinds 0.10/0.25']);

        await visitor.context().close();
        await page.context().close();
      }
    },
  ],
  [
    'the table settings show what the table plays with as chosen for good, and take their amounts the way the table writes them',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        const table = rig.table(
          [
            { name: 'Quigs', stack: 5000 },
            { name: 'Stu', stack: 10_000 },
          ],
          { ...CENTS, minBuyIn: 2000, maxBuyIn: 10_000 },
        );
        const page = await table.open('Quigs', screen);
        const press = pressOn(page, screen);

        await press('[data-action="menu"]');
        assert.equal(await text(page, '.menu [data-action="settings"] small'), 'Blinds 0.25/0.50');
        await press('.menu [data-action="settings"]');
        await page.waitForSelector('#table-unit');

        assert.equal(await page.isChecked('#table-unit input[value="cents"]'), true);
        assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#table-unit input')].map((input) => input.disabled)`), [true, true], 'what the table plays with can still be picked');
        assert.equal(await text(page, '#table-unit small'), "Can't be changed once the table is created");
        assert.deepEqual(
          await Promise.all(['small-blind', 'big-blind', 'min-buy-in', 'max-buy-in', 'seven-deuce-bounty'].map((field) => page.inputValue(`#table-${field}`))),
          ['0.25', '0.50', '20.00', '100.00', '0.00'],
        );
        assert.deepEqual(await squeezed(page, '#table-unit .check span, #table-unit small, .dialog .field input'), [], 'part of the settings is cut off');
        assertOnScreen(await boxes(page, '.dialog, #table-unit, #table-unit .check'), screen, 'the settings');
        await shot(page, `cents-settings-${screen}`);

        await page.fill('#table-seven-deuce-bounty', '2.5');
        await page.fill('#table-small-blind', '.5');
        await page.fill('#table-big-blind', '1');
        await press('[data-action="save-settings"]');
        await page.waitForSelector('.dialog', { state: 'detached' });

        const { unit, smallBlind, bigBlind, sevenDeuceBounty } = table.view('Quigs').config;
        assert.deepEqual({ unit, smallBlind, bigBlind, sevenDeuceBounty }, { unit: 'cents', smallBlind: 50, bigBlind: 100, sevenDeuceBounty: 250 });
        assert.equal(await text(page, '.topbar .title span'), '0.50/1.00 hold’em');

        // Adding chips and setting a stack are typed in dollars too
        await press('.controls [data-action="rebuy"]');
        assert.equal(await page.inputValue('#rebuy-amount'), '50.00');
        assert.equal(await text(page, '.dialog .field small'), 'Up to 50.00, which brings you to the table maximum');
        await page.fill('#rebuy-amount', '12.34');
        await press('[data-action="confirm-rebuy"]');
        await page.waitForSelector('.dialog', { state: 'detached' });
        assert.equal(await text(page, '.seat.me .stack'), '62.34');

        await press('[data-action="menu"]');
        await press('.menu [data-action="players"]');
        assert.match(await text(page, '.rows li:has-text("Stu") > span'), /^Stu · seat 2 · 100\.00$/);
        await press('.rows li:has-text("Stu") button:has-text("Set stack")');
        assert.equal(await page.inputValue('#new-stack'), '100.00');
        await page.fill('#new-stack', '1,000.5');
        await press('.dialog button[type="submit"]');
        await page.waitForSelector('.rows li:has-text("1,000.50")');
        assert.equal(table.view('Quigs').seats[1]!.stack, 100_050);

        await page.context().close();
      }

      // A table that plays whole chips says so in the same place
      const chips = rig.table([{ name: 'Quigs', stack: 1000 }]);
      const page = await chips.open('Quigs', 'desktop');
      await page.click('[data-action="menu"]');
      await page.click('.menu [data-action="settings"]');
      assert.equal(await page.isChecked('#table-unit input[value="chips"]'), true);
      assert.equal(await page.isDisabled('#table-unit input[value="cents"]'), true);
      assert.equal(await page.inputValue('#table-small-blind'), '10');
    },
  ],
  [
    'the host moves a player by picking an open seat, on a phone and a desktop, and everyone sees them there',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        const table = rig.table(['Quigs', 'Stu', 'Pam', 'Big Al', 'Zed', 'WWWWWWWWWWWWWWWW'].map((name) => ({ name, stack: 1000 })));

        const host = await table.open('Quigs', screen);
        const watcher = await table.open('Pam', 'phone');
        const press = pressOn(host, screen);
        await standOrLie(host, screen);

        await press('[data-action="menu"]');
        await press('.menu [data-action="players"]');
        await press('.dialog li:has-text("Stu") [data-action="move"]');

        await host.waitForSelector('.dialog', { state: 'detached' });
        assert.equal(await text(host, '.banner.move-prompt span'), 'Pick an open seat for Stu');
        assertOnScreen(await boxes(host, '.banner.move-prompt, [data-action="cancel-move"]'), screen, 'the prompt to pick a seat');
        assertOnScreen(await boxes(host, '[data-move-to]'), screen, 'an open seat to move to');
        assert.equal(await host.locator('[data-move-to]').count(), 4, 'every open seat is offered');
        assertApart(await boxes(host, '[data-move-to]'), await boxes(host, '.seat[data-seat] .plate, .seat[data-seat] .card'), 'an open seat to move to and a seated player');
        assert.equal(await host.locator('[data-sit]').count(), 0);
        assert.equal(await host.locator('.seat.moving[data-seat="1"]').count(), 1, 'the player being moved is not picked out');
        assert.deepEqual(await squeezed(host, '[data-move-to]'), []);
        await shot(host, `move-pick-${screen}`);

        await press('[data-move-to="6"]');
        await host.waitForSelector('.seat[data-seat="6"] .name:has-text("Stu")');
        assert.equal(await host.locator('.banner.move-prompt, [data-move-to]').count(), 0, 'picking goes on after the move');
        assert.equal(table.view('Quigs').seats[6]?.name, 'Stu');
        assert.equal(table.view('Quigs').seats[1], null);

        await watcher.waitForSelector('.seat[data-seat="6"] .name:has-text("Stu")');
        assert.equal(await watcher.locator('.seat[data-seat="1"]').count(), 0);
        assert.match(await text(watcher, '.feed-toggle .latest'), /The host moved Stu to seat 7/);
        await shot(watcher, `moved-seen-by-another-${screen}`);

        await host.context().close();
        await watcher.context().close();
      }
    },
  ],
  [
    'cancelling a pick leaves the table as it was, from its button or the Escape key',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
      ]);
      table.join('Lurker');
      const before = JSON.stringify(table.view('Quigs').seats);

      for (const screen of ['phone', 'desktop'] as const) {
        const page = await table.open('Quigs', screen);
        const press = pressOn(page, screen);
        const drawn = await page.innerHTML('.stage');
        const shape = (await page.getAttribute('.stage .table', 'class'))!.includes('tall') ? 'tall' : 'wide';

        for (const way of ['button', 'Escape'] as const) {
          if (way === 'Escape' && screen === 'phone') {
            continue;
          }

          await press('[data-action="menu"]');
          await press('.menu [data-action="players"]');
          await press('.dialog li:has-text("Stu") [data-action="move"]');
          await page.waitForSelector('[data-move-to]');

          if (way === 'button') {
            await press('[data-action="cancel-move"]');
          } else {
            await page.keyboard.press('Escape');
          }

          // The prompt took height from the table, which may have lain down for it and stands up again once it goes
          await page.waitForSelector('.banner.move-prompt', { state: 'detached' });
          await page.waitForSelector(`.stage .table.${shape}`);
          assert.equal(await page.innerHTML('.stage'), drawn, `the table is not drawn as it was after cancelling with the ${way}`);
          assert.equal(JSON.stringify(table.view('Quigs').seats), before);
        }

        await page.context().close();
      }

      // Someone watching is still offered the open seats once the host has cancelled
      const lurker = await table.open('Lurker', 'phone');
      assert.equal(await lurker.locator('[data-sit]').count(), 8);
      await lurker.context().close();
    },
  ],
  [
    'a move that waits for the hand shows on the seat, whole, beside a long name, and happens when the hand ends',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        const table = rig.table([
          { name: 'Quigs', stack: 1000 },
          { name: 'Marge Simpson-Jr', stack: 1000 },
          { name: 'WWWWWWWWWWWWWWWW', stack: 1000 },
          { name: 'Stu', stack: 1000 },
          { name: 'Pam', stack: 1000 },
          { name: 'Big Al', stack: 1000 },
        ]);
        table.deal({ button: 0 });

        const host = await table.open('Quigs', screen);
        const watcher = await table.open('Stu', screen);
        const press = pressOn(host, screen);
        await standOrLie(host, screen);
        await standOrLie(watcher, screen);

        await press('[data-action="menu"]');
        await press('.menu [data-action="players"]');
        await press('.dialog li:has-text("WWWWWWWWWWWWWWWW") [data-action="move"]');
        assert.equal(await text(host, '.banner.move-prompt span'), 'Pick an open seat for WWWWWWWWWWWWWWWW. They move when this hand ends.');
        await press('[data-move-to="7"]');
        await host.waitForSelector('.seat[data-seat="2"] .move-note');
        await shot(host, `move-waiting-${screen}`);

        for (const page of [host, watcher]) {
          const note = '.seat[data-seat="2"] .move-note';
          await page.waitForSelector(note);
          assert.equal(await text(page, note), '→ Seat 8');
          assert.equal(await page.getAttribute(note, 'aria-label'), 'Moves to seat 8 after this hand');
          assertOnScreen(await boxes(page, note), screen, 'the note of a move that waits');
          assert.deepEqual(await squeezed(page, `${note}, .seat[data-seat="2"] .plate .stack`), [], 'the note or the stack beside it is cut off');
          // Inside its own plate, it takes no room the plate does not already have, down the side of a crowded table as anywhere
          const [box] = await boxes(page, note);
          const [plate] = await boxes(page, '.seat[data-seat="2"] .plate');
          assert.ok(box!.left >= plate!.left && box!.right <= plate!.right && box!.top >= plate!.top && box!.bottom <= plate!.bottom, 'the note of a move sticks out of its seat');
          assertApart(await boxes(page, '.seat[data-seat="2"] .plate'), await boxes(page, '.seat:not([data-seat="2"]) .plate, .board .card, .bet, .pot'), 'the seat with a move waiting and the table around it');
        }

        assert.equal(table.view('Quigs').seats[2]?.moveTo, 7);

        await press('[data-action="menu"]');
        await press('.menu [data-action="players"]');
        assert.equal(await text(host, '.dialog li:has-text("WWWWWWWWWWWWWWWW") .move-note'), 'Moves to seat 8 after this hand');
        assert.deepEqual(await host.locator('.dialog li:has-text("WWWWWWWWWWWWWWWW") button').allInnerTexts(), ['Set stack', 'Stay put', 'Make co-host', 'Make host', 'Remove'], 'a move that waits cannot be taken back');
        await press('[data-action="close"]');

        table.play(() => ({ type: 'fold' }), (view) => view.hand === null || view.hand.number > 1);
        await watcher.waitForSelector('.seat[data-seat="7"] .name:has-text("WWWWWWWWWWWWWWWW")');
        assert.equal(await watcher.locator('.seat .move-note').count(), 0);
        assert.equal(table.view('Quigs').seats[7]?.name, 'WWWWWWWWWWWWWWWW');

        await host.context().close();
        await watcher.context().close();
      }
    },
  ],
  [
    'the host shuffles the seats after saying yes, at once between hands and at the end of a hand during one',
    async (rig) => {
      const players = ['Quigs', 'Stu', 'Pam', 'Big Al'];
      const table = rig.table(players.map((name) => ({ name, stack: 1000 })));
      const seatsOf = () => table.view('Quigs').seats.map((seat) => seat?.name ?? null);
      const before = seatsOf();

      const page = await table.open('Quigs', 'phone');
      await page.tap('[data-action="menu"]');
      assert.equal(await text(page, '.menu [data-action="shuffle"] small'), 'Everyone gets a random seat');
      await page.tap('.menu [data-action="shuffle"]');
      assert.equal(await text(page, '.dialog h2'), 'Shuffle the seats?');
      assertOnScreen(await boxes(page, '.dialog [data-action="confirm"]'), 'phone', 'the button that shuffles');
      await shot(page, 'shuffle-confirm-phone');
      await page.tap('[data-action="confirm"]');

      await page.waitForSelector('.feed-toggle .latest:has-text("The host shuffled the seats")');
      const after = seatsOf();
      assert.deepEqual(after.map((name) => name !== null), before.map((name) => name !== null), 'a shuffle opened or filled a seat');
      assert.deepEqual([...after].sort(), [...before].sort());
      await page.context().close();

      table.deal({ button: 0 });
      const desktop = await table.open('Quigs', 'desktop');
      await desktop.click('[data-action="menu"]');
      assert.equal(await text(desktop, '.menu [data-action="shuffle"] small'), 'Everyone gets a random seat when this hand ends');
      await desktop.click('.menu [data-action="shuffle"]');
      await desktop.click('[data-action="confirm"]');
      await desktop.waitForSelector('.feed-toggle .latest:has-text("The host shuffles the seats after this hand")', { state: 'attached' });
      assert.deepEqual(seatsOf(), after, 'the seats were shuffled in the middle of a hand');

      await desktop.click('[data-action="menu"]');
      assert.equal(await text(desktop, '.menu [data-action="shuffle"] small'), 'Set for when this hand ends');
      await desktop.click('[data-action="close"]');

      table.play(() => ({ type: 'fold' }), (view) => view.hand === null || view.hand.number > 1);
      assert.equal(table.view('Quigs').shuffleAfterHand, false);
      assert.deepEqual([...seatsOf()].sort(), [...before].sort());
      await desktop.context().close();
    },
  ],
  [
    'on the desktop the host drags a player onto an open seat, lying down and standing up, even while the table is redrawn under the mouse',
    async (rig) => {
      for (const shape of ['wide', 'tall'] as const) {
        const table = rig.table(['Quigs', 'Stu', 'Pam', 'Big Al', 'Zed', 'Pocket Pam'].map((name) => ({ name, stack: 1000 })));

        const page = await table.open('Quigs', 'desktop');
        if (shape === 'tall') {
          // A desktop window taller than it is wide, which stands the table up
          await setStageHeight(page, 900);
        }
        await page.waitForSelector(`.table.${shape}`);

        const center = async (selector: string) => {
          const [box] = await boxes(page, selector);
          assert.ok(box, `${selector} is not on the screen`);

          return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
        };

        // Let go over the felt, and nothing moves
        const from = await center('.seat[data-seat="1"] .plate');
        const felt = await center('.felt');
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(felt.x, felt.y, { steps: 8 });
        await page.mouse.up();
        assert.equal(table.view('Quigs').seats[1]?.name, 'Stu');
        assert.equal(await page.locator('.seat.dragging, .seat.drop').count(), 0);

        const to = await center('[data-open-seat="7"] .plate');
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
        assert.equal(await page.locator('.seat.dragging[data-seat="1"]').count(), 1, 'the seat does not follow the mouse');

        // A change at the table draws it again while the seat is in the air
        table.act('Pam', { type: 'sitOut' });
        await page.waitForSelector('.seat[data-seat="2"] .status:has-text("Sitting out")');
        assert.equal(await page.locator('.seat.dragging[data-seat="1"]').count(), 1, 'the drag was lost when the table was drawn again');

        await page.mouse.move(to.x, to.y, { steps: 8 });
        assert.equal(await page.locator('.seat.drop[data-open-seat="7"]').count(), 1, 'the open seat under the mouse is not picked out');
        await shot(page, `move-drag-desktop-${shape}`);
        await page.mouse.up();

        await page.waitForSelector('.seat[data-seat="7"] .name:has-text("Stu")');
        assert.equal(table.view('Quigs').seats[7]?.name, 'Stu');
        assert.equal(table.view('Quigs').seats[1], null);
        assert.equal(await page.locator('.seat.dragging, .seat.drop').count(), 0);
        await page.context().close();
      }
    },
  ],
  [
    'the keys of a turn do nothing while the host picks a seat, and Escape backs out of the pick and nothing else',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
        { name: 'Pam', stack: 1000 },
      ]);

      // Three-handed the button acts first, so the deal puts the action on the host's own page
      table.deal({ button: 0 });
      const page = await table.open('Quigs', 'desktop');
      const sent = movesSent(page);

      await page.waitForSelector('.turn [data-action="call"]:enabled');
      await page.click('[data-action="menu"]');
      await page.click('.menu [data-action="players"]');
      await page.click('.dialog li:has-text("Stu") [data-action="move"]');
      await page.waitForSelector('[data-move-to]');
      await settle(page);

      const amount = await page.inputValue('#raise-amount');
      await page.evaluate('document.activeElement.blur()');
      for (const key of ['f', 'c', 'r', '1', '2', '3', '4']) {
        await page.keyboard.press(key);
      }

      // In the bet box Enter is the raise key
      await page.focus('#raise-amount');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);

      assert.deepEqual(sent, [], 'a key played a move while the host was picking a seat');
      assert.equal(table.view('Quigs').hand!.toAct, 0);
      assert.equal(await page.inputValue('#raise-amount'), amount, 'a key changed the bet size while the host was picking a seat');
      assert.equal(await page.locator('[data-move-to]').count(), 7, 'a key ended the pick');

      // With the bet box in use, Escape backs out of the pick and leaves the box as it was
      await page.keyboard.press('Escape');
      await page.waitForSelector('.banner.move-prompt', { state: 'detached' });
      assert.equal(await page.evaluate('document.activeElement?.id'), 'raise-amount', 'Escape also left the bet box');
      assert.equal(table.view('Quigs').seats[1]?.name, 'Stu');

      // Back from the pick, the keys are the turn's again
      await page.evaluate('document.activeElement.blur()');
      await settle(page);
      await page.keyboard.press('f');
      await page.waitForTimeout(300);
      assert.deepEqual(sent, ['fold']);
      await page.context().close();
    },
  ],
  [
    'the hand hint names your two cards, then your hand on every street, and lifts the cards that make it',
    async (rig) => {
      for (const screen of ['phone', 'smallPhone', 'desktop'] as const) {
        const table = rig.table([
          { name: 'Quigs', stack: 1000 },
          { name: 'Stu', stack: 1000 },
        ]);
        table.deal({ button: 0, holes: { 0: 'Ks 7d', 1: 'Qc Qd' }, board: 'Kh 7s 2c 9d Ah' });

        const page = await table.open('Quigs', screen);
        await hintSays(page, 'King-seven offsuit');
        assert.deepEqual(await marking(page), { plays: [], idle: [] }, 'cards are picked out before there is a hand to make');
        await shot(page, `hint-preflop-${screen}`);
        await assertHintFits(page);

        table.play(passive, (view) => view.hand!.street === 'flop');
        await hintSays(page, 'Two pair, kings and sevens');
        assert.deepEqual(await marking(page), { plays: sortedCards('Ks 7d Kh 7s 2c'), idle: [] });
        await shot(page, `hint-flop-${screen}`);

        table.play(passive, (view) => view.hand!.street === 'river');
        await page.waitForSelector('.board .card[data-card="Ah"]');
        await hintSays(page, 'Two pair, kings and sevens');
        assert.deepEqual(await marking(page), { plays: sortedCards('Ks 7d Kh 7s Ah'), idle: sortedCards('2c 9d') });
        await assertMarked(page);
        await shot(page, `hint-river-${screen}`);
        await assertHintFits(page);

        if (screen !== 'desktop') {
          await inEveryShape(page, async (shape) => {
            await shot(page, `hint-river-${screen}-${shape}`);
            await assertMarked(page);
            await assertHintFits(page);
          });
        }

        await page.context().close();
      }
    },
  ],
  [
    'the hand hint says when the board plays, points out a bounty hand, reads both boards run twice, and keeps a long name clear of the seats',
    async (rig) => {
      const heads = () =>
        rig.table(
          [
            { name: 'Quigs', stack: 1000 },
            { name: 'Stu', stack: 1000 },
          ],
          { allowRunItTwice: true, sevenDeuceBounty: 50 },
        );

      const boardPlays = heads();
      boardPlays.deal({ button: 0, holes: { 0: '2c 3d', 1: '4c 5d' }, board: 'As Ks Qs Js Ts' });
      boardPlays.play(passive, (view) => view.hand!.street === 'river');
      let page = await boardPlays.open('Quigs', 'phone');
      await hintSays(page, 'Playing the board');
      assert.deepEqual(await marking(page), { plays: sortedCards('As Ks Qs Js Ts'), idle: ['2c', '3d'] });
      await assertMarked(page);
      await shot(page, 'hint-board-plays-phone');
      await inEveryShape(page, async () => {
        await assertMarked(page);
        await assertHintFits(page);
      });
      await page.context().close();

      const bounty = heads();
      bounty.deal({ button: 0, holes: { 0: '7h 2c' } });
      page = await bounty.open('Quigs', 'smallPhone');
      await hintSays(page, 'Seven-deuce offsuit');
      assert.equal(await text(page, `${HINT} .bounty`), 'Bounty hand');
      await shot(page, 'hint-bounty-small-phone');
      await inEveryShape(page, () => assertHintFits(page));
      await page.context().close();

      const twice = heads();
      twice.deal({ button: 0, holes: { 0: 'Ks Kh', 1: 'As Ah' }, board: '2c 7d 9h Jc 3s', secondBoard: 'Kd 4c 5h 8s Td' });
      page = await twice.open('Quigs', 'phone');

      // The second board's turn is out: each board read as far as it goes
      twice.play(allIn, (view) => view.hand!.boards[1]?.length === 4);
      await hintSays(page, 'Pair of kings', 'Three kings');
      assert.deepEqual(await texts(page, `${HINT} .run`), ['1', '2']);
      assert.equal(await page.locator('.board[data-run="0"] .card.plays').count(), 3, 'the first board\'s jack, nine and seven play');
      assert.equal(await page.locator('.board[data-run="1"] .card.plays').count(), 3, 'the second board\'s king, eight and five play');
      await shot(page, 'hint-run-twice-phone');
      await inEveryShape(page, async (shape) => {
        await shot(page, `hint-run-twice-phone-${shape}`);
        await assertMarked(page);
        await assertHintFits(page);
      }, { buttonsUp: false });

      // Over, the result in the middle names each board's hands, and the hint gives it the room
      twice.play(allIn, (view) => view.hand!.stage === 'done');
      await page.waitForSelector('.message.result');
      assert.equal(await page.locator(HINT).count(), 0);
      assert.equal(await page.locator('.board[data-run="1"] .card.plays').count(), 3, 'the cards that play stay picked out');
      await inEveryShape(page, async () => {
        assertApart(await boxes(page, '.message.result > div'), await boxes(page, '.seat .plate, .seat .hole .card'), 'a result line and a seat');
      }, { buttonsUp: false });
      await page.context().close();

      // Two boards that disagree on a card in hand leave it unmarked: lifted under one line, it would say it plays under the other
      const split = heads();
      split.deal({ button: 0, holes: { 0: 'Ah 3c', 1: 'Kd Kh' }, board: 'Ad Kc Qs Jd 9h', secondBoard: '3d 3s' });
      split.play(passive, (view) => view.hand!.street === 'flop');
      page = await split.open('Quigs', 'phone');
      split.play(allIn, (view) => view.hand!.boards[1]?.length === 4);
      await hintSays(page, 'Pair of aces', 'Two pair, aces and threes');
      assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.seat.me .hole .card')].map((card) => card.className.match(/plays|idle/)?.[0] ?? 'unmarked')`), ['plays', 'unmarked']);
      await page.context().close();

      // The longest kind of name, at a full table on the smallest phone
      const full = rig.table(tenPlayers());
      full.deal({ button: 0, holes: { 0: '7c 3d' }, board: '7h 7s 3c 2d 5h' });
      full.play(passive, (view) => view.hand!.street === 'river');
      page = await full.open('Quigs', 'smallPhone');
      await hintSays(page, 'Full house, sevens over threes');
      await shot(page, 'hint-long-small-phone');
      await inEveryShape(page, async (shape) => {
        await shot(page, `hint-long-small-phone-${shape}`);
        await assertHintFits(page);
      });
      await page.context().close();
    },
  ],
  [
    'the cards the hand hint picks out are clear in every theme and with the four-color deck, and the hint can be switched off',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
      ]);
      table.deal({ button: 0, holes: { 0: 'Ks 7d', 1: 'Qc Qd' }, board: 'Kh 7s 2c 9d Ah' });
      table.play(passive, (view) => view.hand!.street === 'river');

      const page = await table.open('Quigs', 'phone');
      for (const theme of THEMES) {
        await choose(page, { theme: theme.id });
        await hintSays(page, 'Two pair, kings and sevens');
        await assertMarked(page);
        await shot(page, `hint-theme-${theme.id}-phone`);
      }

      await choose(page, { theme: 'cardroom', deck: 'four' });
      await hintSays(page, 'Two pair, kings and sevens');
      await assertMarked(page);
      await shot(page, 'hint-four-color-phone');

      await page.tap('[data-action="menu"]');
      await page.tap('.menu [data-action="preferences"]');
      await page.tap('#pref-handHint');
      await page.waitForSelector('#pref-handHint[aria-checked="false"]');
      await page.tap('[data-action="close"]');

      assert.deepEqual(await boxes(page, HINT), [], 'the hint is still shown');
      assert.equal(await page.evaluate(`[...document.querySelectorAll('.table .card')].every((card) => getComputedStyle(card).transform === 'none' && getComputedStyle(card).opacity === '1')`), true, 'a card is still lifted or faded');
      await shot(page, 'hint-off-phone');

      await page.reload();
      await page.waitForSelector('.board .card[data-card="Ah"]');
      assert.deepEqual(await boxes(page, HINT), [], 'the hint came back with a reload');
      await page.context().close();
    },
  ],
  [
    'a move that waits for the hand sits whole beside the hand hint on the viewer\'s own seat, standing and lying, and that seat still moves by a pick or a drag',
    async (rig) => {
      const sixAtTheRiver = () => {
        const table = rig.table(['Quigs', 'Stu', 'Pam', 'Big Al', 'Zed', 'Pocket Pam'].map((name) => ({ name, stack: 1000 })));
        table.deal({ button: 0, holes: { 0: 'Ks 7d' }, board: 'Kh 7s 2c 9d Ah' });
        table.play(passive, (view) => view.hand!.street === 'river');

        return table;
      };
      const marked = { plays: sortedCards('Ks 7d Kh 7s Ah'), idle: sortedCards('2c 9d') };

      // On a phone the host picks a seat for themselves, and the move waits for the hand
      for (const screen of ['phone', 'smallPhone'] as const) {
        const picked = sixAtTheRiver();
        const page = await picked.open('Quigs', screen);
        await hintSays(page, 'Two pair, kings and sevens');
        await page.tap('[data-action="menu"]');
        await page.tap('.menu [data-action="players"]');
        await page.tap('.dialog li:has-text("Quigs") [data-action="move"]');
        await page.waitForSelector('.dialog', { state: 'detached' });
        assert.deepEqual(await marking(page), marked, 'picking a seat changed the marking');
        await page.tap('[data-move-to="7"]');
        await page.waitForSelector('.seat.me .move-note');
        assert.equal(picked.view('Quigs').seats[0]?.moveTo, 7);

        await inEveryShape(page, async (shape) => {
          await shot(page, `hint-move-waiting-${screen}-${shape}`);
          assert.deepEqual(await marking(page), marked);
          await assertMarked(page);
          await assertHintFits(page);

          const [note] = await boxes(page, '.seat.me .move-note');
          const [plate] = await boxes(page, '.seat.me .plate');
          assert.ok(note!.left >= plate!.left && note!.right <= plate!.right && note!.top >= plate!.top && note!.bottom <= plate!.bottom, 'the note of a move sticks out of the seat');
          assertApart(await textBoxes(page, `${HINT} .read`), [note!], 'the hand hint and the note of a move');
          assert.deepEqual(await squeezed(page, '.seat.me .move-note'), [], 'the note of a move is cut off');
        });
        await page.context().close();
      }

      // On the desktop the host drags their own seat, marked cards and all, onto an open one
      for (const shape of ['wide', 'tall'] as const) {
        const dragged = sixAtTheRiver();
        const page = await dragged.open('Quigs', 'desktop');
        if (shape === 'tall') {
          await setStageHeight(page, 900);
        }
        await page.waitForSelector(`.table.${shape}`);
        await hintSays(page, 'Two pair, kings and sevens');

        const middle = async (selector: string) => {
          const [box] = await boxes(page, selector);
          assert.ok(box, `${selector} is not on the screen`);

          return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
        };
        const from = await middle('.seat.me .plate');
        const to = await middle('[data-open-seat="7"] .plate');

        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        assert.equal(await page.locator('.seat.drop[data-open-seat="7"]').count(), 1, 'the open seat under the mouse is not picked out');
        await page.mouse.up();

        await page.waitForSelector('.seat.me .move-note');
        assert.equal(dragged.view('Quigs').seats[0]?.moveTo, 7);
        assert.deepEqual(await marking(page), marked, 'the marking was lost with the drag');
        await shot(page, `hint-move-dragged-desktop-${shape}`);
        await page.context().close();
      }
    },
  ],
  [
    'the start of a hand with antes shows them in the pot and in the stakes, with nothing squeezed',
    async (rig) => {
      for (const kind of ANTE_TABLES) {
        for (const screen of ['smallPhone', 'desktop'] as const) {
          const table = rig.table(
            LONG_NAMES.slice(0, 6).map((name) => ({ name, stack: kind.stack })),
            kind.config,
          );
          // A hand number of three digits leaves the stakes the least room they will have
          table.alter((state) => {
            state.handCount = 122;
          });
          table.deal({ button: 0 });

          const page = await table.open('Quigs', screen);

          // Where the stakes don't fit one line, which depends on the machine's fonts, the ante moves to the next
          // line whole: it is never broken, so the stakes never take a third line
          assert.equal(await text(page, '.topbar .title > span'), kind.stakes);
          const [stakes] = await textBoxes(page, '.topbar .title > span');
          const [ante] = await textBoxes(page, '.topbar .title .ante');
          assert.ok(stakes && ante);
          assert.equal(await page.locator('.topbar .title .ante').evaluate((el) => el.getClientRects().length), 1, 'the ante is broken over two lines');
          const lines = Math.round((stakes.bottom - stakes.top) / (ante.bottom - ante.top));
          assert.ok(lines <= (screen === 'desktop' ? 1 : 2), `the stakes take ${lines} lines`);
          assert.deepEqual(await squeezed(page, '.topbar .title > span, .topbar .pill'), [], 'the stakes or the hand number are cut off');
          assertApart([stakes], await boxes(page, '.topbar .pill, .topbar .menu-button, .topbar [data-action="invite"]'), 'the stakes and the rest of the top bar');
          assertOnScreen([stakes, ...(await boxes(page, '.topbar .pill, .topbar [data-action="invite"]'))], screen, 'the top bar');

          // An ante is in the pot from the start, and no bet in front of its player
          assert.equal(await text(page, '.pot'), `Pot${kind.pot}`);
          assert.deepEqual(await texts(page, '.bet'), kind.bets);
          assert.deepEqual(await stacksBySeat(page, 6), kind.stacks);
          assert.deepEqual(await squeezed(page, '.pot, .bet, .plate .stack'), [], 'an amount on the table is cut off');
          assertOnScreen(await boxes(page, '.seat .plate, .bet, .pot'), screen, 'a seat, a bet or the pot');
          await assertBetsApart(page);
          await shot(page, `antes-start-${kind.name}-${screen}`);

          // The play-by-play says what the ante is and who posted what
          if (screen !== 'desktop') {
            await page.tap('.feed-toggle');
          }
          assert.deepEqual((await texts(page, '.entries li')).slice(-kind.lines.length), kind.lines);
          assert.deepEqual(await squeezed(page, '.entries li'), [], 'a line of the play-by-play is cut off');
          await assertNoSidewaysScroll(page);
          await shot(page, `antes-play-by-play-${kind.name}-${screen}`);

          await page.context().close();
        }
      }
    },
  ],
  [
    'the table settings take an ante and who pays it, and the table says so from then on',
    async (rig) => {
      for (const kind of ANTE_TABLES) {
        for (const screen of PHONE_AND_DESKTOP) {
          const { ante: _ante, anteFrom: _anteFrom, ...withoutAnte } = kind.config;
          const table = rig.table(
            [
              { name: 'Quigs', stack: kind.stack },
              { name: 'Stu', stack: kind.stack },
            ],
            withoutAnte,
          );
          const page = await table.open('Quigs', screen);
          const press = pressOn(page, screen);
          const fromBigBlind = kind.config.anteFrom === 'bigBlind';

          await press('[data-action="menu"]');
          assert.equal(await text(page, '.menu [data-action="settings"] small'), `Blinds ${kind.blinds}`);
          await press('.menu [data-action="settings"]');
          await page.waitForSelector('#table-ante');

          assert.equal(await page.inputValue('#table-ante'), kind.noAnte);
          assert.equal(await text(page, 'label[for="table-ante"] small'), 'Goes into the pot before any betting. 0 for no ante');
          assert.equal(await page.isChecked('#table-ante-from input[value="everyone"]'), true, 'everyone antes unless the host says otherwise');
          assert.deepEqual(await texts(page, '#table-ante-from .check'), ['Everyone dealt in', 'The big blind, once for the table']);
          assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#table-ante-from input')].map((input) => input.disabled)`), [false, false]);

          await page.locator('#table-ante-from').scrollIntoViewIfNeeded();
          assert.deepEqual(await squeezed(page, '#table-ante-from .check span, #table-ante-from > span, label[for="table-ante"] small, .dialog .field input'), [], 'part of the settings is cut off');
          assertOnScreen(await boxes(page, '.dialog, #table-ante, #table-ante-from, #table-ante-from .check'), screen, 'the ante settings');
          const [everyone, bigBlind] = await boxes(page, '#table-ante-from .check');
          assert.ok(everyone && bigBlind && !overlap(everyone, bigBlind), 'the two choices are drawn over each other');
          await assertNoSidewaysScroll(page);

          await page.fill('#table-ante', kind.typed);
          if (fromBigBlind) {
            await press('#table-ante-from label:has-text("The big blind")');
          }
          await shot(page, `antes-settings-${kind.name}-${screen}`);
          await press('[data-action="save-settings"]');
          await page.waitForSelector('.dialog', { state: 'detached' });

          const { ante, anteFrom, smallBlind, bigBlind: blind } = table.view('Quigs').config;
          assert.deepEqual({ ante, anteFrom, smallBlind, blind }, { ante: kind.config.ante, anteFrom: kind.config.anteFrom ?? 'everyone', smallBlind: kind.config.smallBlind ?? 10, blind: kind.config.bigBlind ?? 20 });
          assert.equal(await text(page, '.topbar .title span'), kind.stakes);
          assert.equal(table.view('Stu').feed.at(-1)!.text, kind.said);

          await press('[data-action="menu"]');
          assert.equal(await text(page, '.menu [data-action="settings"] small'), `Blinds ${kind.stakes}`);
          await press('.menu [data-action="settings"]');
          assert.equal(await page.inputValue('#table-ante'), kind.shown);
          assert.equal(await page.isChecked(`#table-ante-from input[value="${kind.config.anteFrom ?? 'everyone'}"]`), true);

          await page.context().close();
        }
      }
    },
  ],
  [
    'the form for a new table takes an ante and who pays it, and someone following the link is told',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        const page = await rig.lobby(screen);
        const press = pressOn(page, screen);

        assert.equal(await page.inputValue('#new-table-ante'), '0');
        assert.equal(await page.isChecked('#new-table-ante-from input[value="everyone"]'), true);

        await page.fill('#host-name', 'Quigs');
        await page.fill('#new-table-small-blind', '15');
        await page.fill('#new-table-ante', '5');
        await press('#new-table-ante-from label:has-text("The big blind")');
        assert.deepEqual([await page.inputValue('#new-table-small-blind'), await page.inputValue('#new-table-ante')], ['15', '5'], 'picking who antes threw away the amounts that were typed');

        // What the table plays with still starts the amounts over, the ante among them, and keeps who pays it
        await press('#new-table-unit label:has-text("Dollars and cents")');
        assert.deepEqual([await page.inputValue('#new-table-small-blind'), await page.inputValue('#new-table-ante')], ['0.25', '0.00']);
        assert.equal(await page.isChecked('#new-table-ante-from input[value="bigBlind"]'), true);
        assert.equal(await page.getAttribute('#new-table-ante', 'inputmode'), 'decimal');

        await page.fill('#new-table-ante', '0.555');
        assert.equal(await complaintOf(page, '#new-table-ante'), TO_THE_CENT);
        await page.fill('#new-table-ante', '.5');

        await page.locator('#new-table-ante-from').scrollIntoViewIfNeeded();
        await shot(page, `antes-new-table-${screen}`);
        assert.deepEqual(await squeezed(page, '#new-table-ante-from .check span, #new-table-ante-from > span, label[for="new-table-ante"] small, .card-panel .field input'), [], 'part of the form is cut off');
        assertOnScreen(await boxes(page, '#new-table-ante, #new-table-ante-from, #new-table-ante-from .check'), screen, 'the ante in the form for a new table');
        const [everyone, bigBlind] = await boxes(page, '#new-table-ante-from .check');
        assert.ok(everyone && bigBlind && !overlap(everyone, bigBlind), 'the two choices are drawn over each other');
        await assertNoSidewaysScroll(page);

        await press('[data-action="create-table"]');
        await page.waitForSelector('#table-link');

        const link = await page.inputValue('#table-link');
        const { unit, ante, anteFrom } = rig.store.read(new URL(link).searchParams.get('table')!)!.config;
        assert.deepEqual({ unit, ante, anteFrom }, { unit: 'cents', ante: 50, anteFrom: 'bigBlind' });

        await press('[data-action="close"]');
        assert.equal(await text(page, '.topbar .title span'), '0.25/0.50 · BB ante 0.50');

        const visitor = await rig.page(screen, 'a visitor');
        await visitor.goto(link);
        await visitor.waitForSelector('[data-action="join-table"]:enabled');
        assert.deepEqual(await texts(visitor, '.about p:not(.note)'), ['Blinds 0.25/0.50 · BB ante 0.50']);
        assert.deepEqual(await squeezed(visitor, '.about p'), []);
        await shot(visitor, `antes-join-${screen}`);

        await visitor.context().close();
        await page.context().close();
      }
    },
  ],
  [
    'a page from before an update says so over the table, keeps the keyboard and the taps, and a reload comes back to the seat',
    async (rig) => {
      for (const screen of ['phone', 'phoneSideways', 'desktop'] as const) {
        const build = `updated-${screen}`;

        // A clock, to see it stopped, and an ante, which makes the top bar the notice has to cover a line taller on a phone
        const table = rig.table(
          [
            { name: 'Quigs', stack: 1000 },
            { name: 'Stu', stack: 1000 },
          ],
          { actionSeconds: 30, ante: 5 },
        );

        // On the river with the big blind's check in: the page is on the clock, with every button of a turn to
        // press, and its hand hint has lifted the cards that play and let the others sink and fade
        table.deal({ button: 0, holes: { 0: 'Ks 7d', 1: 'Qc Qd' }, board: 'Kh 7s 2c 9d Ah' });
        table.play(passive, (view) => view.hand!.street === 'river');
        table.act('Stu', { type: 'check' });

        const page = await table.open('Quigs', screen);
        const press = pressOn(page, screen);
        const sent = movesSent(page);
        const inNotice = `!!document.activeElement.closest('.outdated')`;

        await page.waitForSelector('.turn [data-action="fold"]:enabled');
        await hintSays(page, 'Two pair, kings and sevens');
        await press('[data-action="menu"]');
        await page.waitForSelector('.app .dialog');

        // The game is updated, and the page hears of it with the table's next news
        rig.deploy(build);
        table.act('Stu', { type: 'chat', text: 'still there?' });
        await page.waitForSelector('.outdated');

        assert.equal(await text(page, '.outdated h2'), 'The game was updated');
        assert.equal(await text(page, '.outdated p'), 'Reload to keep playing. Your place at the table is kept.');
        assert.equal(await page.locator('.app .dialog').count(), 0, 'the menu that was open is still up under the notice');
        assert.equal(await page.locator('.feed li:has-text("still there?")').count(), 0, 'what the newer build sent was drawn');

        const [notice] = await boxes(page, '.outdated .dialog');
        const [cover] = await boxes(page, '.outdated');
        const parts = await boxes(page, '.outdated h2, .outdated p, .outdated [data-action="reload"]');
        const [button] = await boxes(page, '.outdated [data-action="reload"]');
        const { width, height } = SCREENS[screen];

        assertOnScreen([notice!], screen, 'the notice');
        assert.equal(parts.length, 3);
        assert.ok(cover!.left <= 0 && cover!.top <= 0 && cover!.right >= width && cover!.bottom >= height, `the notice leaves some of the page uncovered: ${JSON.stringify(cover)}`);
        for (const part of parts) {
          assert.ok(part.left >= notice!.left && part.right <= notice!.right && part.top >= notice!.top && part.bottom <= notice!.bottom, `part of the notice is outside its box: ${JSON.stringify(part)}`);
        }
        parts.forEach((part, index) => assertApart([part], parts.slice(index + 1), 'two parts of the notice'));
        assert.deepEqual(await squeezed(page, '.outdated h2, .outdated p, .outdated [data-action="reload"]'), []);
        assert.ok(button!.bottom - button!.top >= 44 && button!.right - button!.left >= 120, `the reload button is too small to tap: ${JSON.stringify(button)}`);

        // Nothing of the table shows through on top: not a lifted card, the hint, a bet or a toast
        const onTop = (await page.evaluate(`(() => {
          const found = [];

          for (let x = 4; x < innerWidth; x += innerWidth / 12) {
            for (let y = 4; y < innerHeight; y += innerHeight / 16) {
              const top = document.elementFromPoint(x, y);

              if (!top || !top.closest('.outdated')) {
                found.push((top ? top.className || top.tagName : 'nothing') + ' at ' + Math.round(x) + ',' + Math.round(y));
              }
            }
          }

          return found;
        })()`)) as string[];
        assert.deepEqual(onTop, [], 'part of the page behind the notice is drawn over it');
        assert.equal((await marking(page)).plays.length, 5, 'the table behind the notice no longer shows the hand as it was');
        await shot(page, `outdated-${screen}`);

        // The keyboard is in the notice and stays there
        assert.equal(await page.evaluate(inNotice), true, 'the notice came up with the keyboard left on the page behind it');
        assert.equal(await page.evaluate(`[...document.querySelectorAll('.cnd > *:not(.outdated)')].every((element) => element.inert)`), true, 'the page behind the notice can still be reached');

        let landedInNotice = 0;
        for (let tab = 0; tab < 10; tab++) {
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(`document.activeElement === document.body || ${inNotice}`), true, `Tab number ${tab + 1} reached the page behind the notice`);
          landedInNotice += (await page.evaluate(inNotice)) ? 1 : 0;
        }
        assert.ok(landedInNotice >= 4, `only ${landedInNotice} of 10 Tabs landed on the reload button`);

        // No key of the turn plays, Escape puts nothing away, and a tap where a button of the turn is lands on the notice
        await page.evaluate('document.activeElement.blur()');
        await settle(page);
        for (const key of ['f', 'c', '1', 'Escape']) {
          await page.keyboard.press(key);
        }

        const [fold] = await boxes(page, '.turn [data-action="fold"]');
        if (fold && !overlap(fold, notice!)) {
          await page.mouse.click((fold.left + fold.right) / 2, (fold.top + fold.bottom) / 2);
        }

        // A button that had been pressed would be held while its move is on its way
        assert.equal(await page.locator('.turn [data-action="fold"]:enabled').count(), 1, 'a key or a tap pressed a button behind the notice');

        // The clock on the table behind stops with the page: running on, it would say the table is being followed
        const clock = await text(page, '.seat.me [data-countdown]');
        await page.waitForTimeout(1300);
        assert.equal(await text(page, '.seat.me [data-countdown]'), clock, 'the clock behind the notice is still counting down');

        const animations = (await page.evaluate(`document.querySelector('.app').getAnimations({ subtree: true }).map((animation) => animation.playState)`)) as string[];
        assert.ok(animations.length > 0 && animations.every((state) => state === 'paused'), `the bar that drains with the clock is still draining: ${animations.join(', ')}`);

        assert.equal(await page.locator('.outdated').count(), 1);
        assert.deepEqual(sent, [], 'a move was sent from behind the notice');
        assert.equal(table.view('Stu').hand!.toAct, 0, 'the hand moved on');

        // On its own site the page reloads itself, and its browser remembers the seat
        assert.equal(await page.locator('.outdated [data-action="reload"]').evaluate((element) => element.tagName), 'BUTTON');
        await press('.outdated [data-action="reload"]');
        await page.waitForSelector('.seat.me');
        await page.waitForSelector('.feed li:has-text("still there?")', { state: 'attached' });

        assert.equal(await page.evaluate('window.CND_BUILD'), build, 'the page that came back is not the updated one');
        assert.equal(await page.locator('.outdated').count(), 0);
        assert.equal(await page.locator('.turn [data-action="fold"]:enabled').count(), 1, 'back at the table, it is not this player’s turn anymore');
        await page.context().close();
      }
    },
  ],
  [
    'a bomb pot the host calls from the menu is told to everyone under the table, and can be called off again',
    async (rig) => {
      for (const kind of BOMB_POT_TABLES) {
        for (const screen of ['smallPhone', 'desktop'] as const) {
          const table = rig.table(
            LONG_NAMES.slice(0, 6).map((name) => ({ name, stack: kind.stack })),
            kind.config,
          );
          table.join('Zed');

          const host = await table.open('Quigs', screen);
          const player = await table.open('Stu', screen);
          const watcher = await table.open('Zed', screen);
          const everyone = { host, player, watcher };
          const press = pressOn(host, screen);
          const [roomBefore] = await boxes(player, '.stage');

          await press('[data-action="menu"]');
          assert.equal(await text(host, '.menu [data-action="bomb-pot"]'), `Bomb pot next hand${kind.amount} each, no blinds, starts on the flop`);
          assert.equal(await host.locator('.menu [data-action="bomb-pot-off"]').count(), 0, 'a bomb pot nobody called can be called off');
          await host.locator('.menu [data-action="bomb-pot"]').scrollIntoViewIfNeeded();
          assert.deepEqual(await squeezed(host, '.menu-item, .menu-item small'), [], 'a line of the menu is cut off');
          assertOnScreen(await boxes(host, '.menu [data-action="bomb-pot"]'), screen, 'the bomb pot in the menu');
          await assertNoSidewaysScroll(host);
          await shot(host, `bomb-pot-menu-${kind.name}-${screen}`);

          await press('.menu [data-action="bomb-pot"]');
          await host.waitForSelector('.dialog', { state: 'detached' });
          assert.equal(table.view('Stu').feed.at(-1)!.text, 'The host called a bomb pot for the next hand');

          // A seated player's bar keeps its height, so the word costs their table nothing
          await player.waitForSelector('.controls .next-hand');
          assert.deepEqual(await boxes(player, '.stage'), [roomBefore], 'word of the bomb pot took room from a seated player\'s table');

          for (const [who, page] of Object.entries(everyone)) {
            await page.waitForSelector('.controls .next-hand');
            assert.equal(await text(page, '.controls .next-hand'), nextIsBombPot(kind.amount), who);

            await inShapesOf(
              page,
              screen,
              async (shape) => {
                assert.deepEqual(await squeezed(page, '.controls .waiting, .controls .next-hand'), [], `what the ${who} is told about the next hand is cut off`);
                assertOnScreen(await boxes(page, '.controls .next-hand, .seat .plate'), screen, `the ${who}'s table and what is said under it`);
                assertApart(await boxes(page, '.controls .next-hand'), await boxes(page, '.stage, .controls .extras'), 'word of the bomb pot and what is around it');
                await shot(page, `bomb-pot-next-${who}-${kind.name}-${screen}-${shape}`);
              },
              { buttonsUp: false },
            );
          }

          await press('[data-action="menu"]');
          assert.equal(await text(host, '.menu [data-action="bomb-pot-off"]'), 'Call off the bomb potThe next hand is an ordinary one');
          assert.equal(await host.locator('.menu [data-action="bomb-pot"]').count(), 0, 'a bomb pot that is called already is offered again');
          await press('.menu [data-action="bomb-pot-off"]');
          await host.waitForSelector('.dialog', { state: 'detached' });
          assert.equal(table.view('Stu').feed.at(-1)!.text, 'The host called off the bomb pot');

          for (const page of Object.values(everyone)) {
            await page.waitForSelector('.controls .next-hand', { state: 'detached' });
            await page.context().close();
          }
        }
      }
    },
  ],
  [
    'a bomb pot starts on the flop with what everyone posted in the pot, and the felt, the play-by-play and the hand history say what it is',
    async (rig) => {
      for (const kind of BOMB_POT_TABLES) {
        for (const screen of ['smallPhone', 'desktop'] as const) {
          const names = LONG_NAMES.slice(0, 6);
          const firstToAct = names[1]!;
          const table = rig.table(
            names.map((name, seat) => ({ name, stack: seat === 3 ? kind.short : kind.stack })),
            kind.config,
          );
          // A hand number of three digits, as in the checks of the antes
          table.alter((state) => {
            state.handCount = 122;
          });
          table.act('Quigs', { type: 'setBombPot', on: true });
          table.deal({ button: 0, holes: { 1: 'As Ah', 3: 'Ks Kh' }, board: '2c 7d 9h Jc 3s' });

          const page = await table.open(firstToAct, screen);
          const press = pressOn(page, screen);

          const lookInShapes = (name: string, buttonsUp: boolean) =>
            inShapesOf(
              page,
              screen,
              async (shape) => {
                assert.deepEqual(await squeezed(page, '.pot, .bet, .plate .stack'), [], 'an amount on the table is cut off');
                assertOnScreen(await boxes(page, '.seat .plate, .bet, .pot, .board .card'), screen, 'a seat, a bet, the pot or the board');
                assertApart(await boxes(page, '.pot'), await boxes(page, '.board .card'), 'the pot and the board');
                await assertBetsApart(page);
                await shot(page, `bomb-pot-${name}-${shape}-${kind.name}-${screen}`);
              },
              { buttonsUp },
            );

          // The flop is out, everything posted is in the pot, and the player left of the button is asked first
          assert.deepEqual((await texts(page, '.board .card:not(.slot)')).map((card) => card.replace(/\s/g, '')), ['2♣', '7♦', '9♥']);
          assert.equal(await text(page, '.pot'), `Bomb pot${kind.pot}`);
          assert.equal(await page.locator('.bet').count(), 0, 'what is posted for a bomb pot is in front of a player');
          assert.deepEqual(await stacksBySeat(page, 6), kind.stacks);
          assert.equal(await page.locator('.seat.acting').getAttribute('data-seat'), '1');
          assert.equal(await text(page, '.turn [data-action="check"]'), 'Check');
          assert.equal(await page.locator('.next-hand').count(), 0, 'the hand on the table is still called the next one');
          await lookInShapes('start', true);

          // Bets on the flop sit around a pot that is labeled as a bomb pot, with another called for the hand after
          table.act(firstToAct, { type: 'raise', to: table.view(firstToAct).hand!.options!.minRaiseTo });
          for (const caller of [names[2]!, names[4]!, names[5]!]) {
            table.act(caller, { type: 'call' });
          }
          table.act('Quigs', { type: 'setBombPot', on: true });

          await page.waitForSelector('.controls .next-hand');
          assert.deepEqual(await texts(page, '.bet'), Array(4).fill(kind.bet));
          assert.equal(await text(page, '.controls .waiting'), `Waiting for Quigs${nextIsBombPot(kind.amount)}`);
          await lookInShapes('bets', false);

          const feedToggle = async () => {
            if (screen !== 'desktop') {
              await page.tap('.feed-toggle');
            }
          };

          await feedToggle();
          const said = await texts(page, '.entries li');
          const from = said.indexOf(kind.lines[0]!);
          assert.deepEqual(said.slice(from, from + kind.lines.length), kind.lines);
          assert.deepEqual(await squeezed(page, '.entries li'), [], 'a line of the play-by-play is cut off');
          await assertNoSidewaysScroll(page);
          await shot(page, `bomb-pot-play-by-play-${kind.name}-${screen}`);
          await feedToggle();

          table.act('Quigs', { type: 'pause' });
          table.play(passive, (view) => view.hand === null);

          await press('[data-action="menu"]');
          await press('.menu [data-action="history"]');
          await page.waitForSelector('.history summary');
          assert.match(await text(page, '.history summary'), /^Hand #123 · bomb pot/);
          await press('.history summary');
          assert.deepEqual((await text(page, '.history pre')).split('\n').slice(0, 3), kind.lines.slice(0, 3));
          assert.deepEqual(await squeezed(page, '.history summary'), [], 'the hand\'s line in the history is cut off');
          await shot(page, `bomb-pot-history-${kind.name}-${screen}`);

          await page.context().close();
        }
      }
    },
  ],
  [
    'the table settings take what a bomb pot costs and how often one comes, and the table says so from then on',
    async (rig) => {
      for (const kind of BOMB_POT_TABLES) {
        for (const screen of PHONE_AND_DESKTOP) {
          const table = rig.table(
            [
              { name: 'Quigs', stack: kind.stack },
              { name: 'Stu', stack: kind.stack },
            ],
            kind.config,
          );
          const page = await table.open('Quigs', screen);
          const press = pressOn(page, screen);
          const values = async () => [await page.inputValue('#table-bomb-pot-amount'), await page.inputValue('#table-bomb-pot-every')];
          const openSettings = async () => {
            await press('[data-action="menu"]');
            await press('.menu [data-action="settings"]');
            await page.waitForSelector('#table-bomb-pot-amount');
          };

          await openSettings();
          assert.deepEqual(await values(), [kind.amount, '0'], 'bomb pots come only when called unless the host says otherwise');
          assert.equal(await text(page, 'label[for="table-bomb-pot-amount"] small'), 'What everyone puts in for a bomb pot: no blinds, and the hand starts on the flop');
          assert.equal(await text(page, 'label[for="table-bomb-pot-every"] small'), '0 for only when the host calls one from the menu');

          await page.locator('label[for="table-bomb-pot-every"]').scrollIntoViewIfNeeded();
          assert.deepEqual(await squeezed(page, 'label[for^="table-bomb-pot"] span, label[for^="table-bomb-pot"] small, .dialog .field input'), [], 'part of the settings is cut off');
          assertOnScreen(await boxes(page, '.dialog, #table-bomb-pot-amount, #table-bomb-pot-every, label[for="table-bomb-pot-every"]'), screen, 'the bomb pot settings');
          await assertNoSidewaysScroll(page);

          await page.fill('#table-bomb-pot-amount', kind.typed);
          await page.fill('#table-bomb-pot-every', '3');
          await shot(page, `bomb-pot-settings-${kind.name}-${screen}`);
          await press('[data-action="save-settings"]');
          await page.waitForSelector('.dialog', { state: 'detached' });

          assert.equal(table.view('Stu').feed.at(-1)!.text, `A bomb pot of ${kind.shown} comes every 3 hands`);
          assert.equal(await page.locator('.next-hand').count(), 0, 'the count has two hands to go');

          // With one every hand, the next hand is one without being called, so there is nothing to call or call off
          await openSettings();
          assert.deepEqual(await values(), [kind.shown, '3']);
          await page.fill('#table-bomb-pot-every', '1');
          await press('[data-action="save-settings"]');
          await page.waitForSelector('.controls .next-hand');
          assert.equal(await text(page, '.controls .next-hand'), nextIsBombPot(kind.shown));

          await press('[data-action="menu"]');
          await page.waitForSelector('.menu [data-action="settings"]');
          assert.equal(await page.locator('.menu [data-action^="bomb-pot"]').count(), 0, 'the menu offers a bomb pot that comes anyway, or to call off one nobody called');

          await page.context().close();
        }
      }
    },
  ],
  [
    'the form for a new table takes the bomb pot settings, starts the amount over in dollars and keeps the rest',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        const page = await rig.lobby(screen);
        const press = pressOn(page, screen);
        const values = async () => [await page.inputValue('#new-table-bomb-pot-amount'), await page.inputValue('#new-table-bomb-pot-every'), await page.locator('#new-table-bomb-pot-boards input:checked').inputValue()];

        assert.deepEqual(await values(), ['100', '0', 'one']);

        await page.fill('#host-name', 'Quigs');
        await page.fill('#new-table-bomb-pot-amount', '300');
        await page.fill('#new-table-bomb-pot-every', '4');
        await press('#new-table-bomb-pot-boards label:has-text("Two boards")');

        // What the table plays with starts the amounts over, the bomb pot among them, and keeps how often one comes and on how many boards
        await press('#new-table-unit label:has-text("Dollars and cents")');
        assert.deepEqual(await values(), ['2.50', '4', 'two']);
        await page.fill('#new-table-bomb-pot-amount', '5');

        await page.locator('#new-table-bomb-pot-boards').scrollIntoViewIfNeeded();
        await shot(page, `bomb-pot-new-table-${screen}`);
        assert.deepEqual(await squeezed(page, 'label[for^="new-table-bomb-pot"] span, label[for^="new-table-bomb-pot"] small, #new-table-bomb-pot-boards span, #new-table-bomb-pot-boards small, .card-panel .field input'), [], 'part of the form is cut off');
        assertOnScreen(await boxes(page, '#new-table-bomb-pot-amount, #new-table-bomb-pot-every, label[for="new-table-bomb-pot-every"], #new-table-bomb-pot-boards'), screen, 'the bomb pot in the form for a new table');
        await assertNoSidewaysScroll(page);

        await press('[data-action="create-table"]');
        await page.waitForSelector('#table-link');

        const link = await page.inputValue('#table-link');
        const { unit, bombPotAmount, bombPotEvery, bombPotBoards } = rig.store.read(new URL(link).searchParams.get('table')!)!.config;
        assert.deepEqual({ unit, bombPotAmount, bombPotEvery, bombPotBoards }, { unit: 'cents', bombPotAmount: 500, bombPotEvery: 4, bombPotBoards: 'two' });

        await page.context().close();
      }
    },
  ],
  [
    'a host saves the table settings as a preset, replaces one only after saying yes, and deletes one; a co-host can save, and a plain member is not offered it',
    async (rig) => {
      try {
        for (const screen of PHONE_AND_DESKTOP) {
          const table = rig.table(
            [
              { name: 'Quigs', stack: 1000 },
              { name: 'Stu', stack: 1000 },
              { name: 'Pam', stack: 1000 },
            ],
            { smallBlind: 25, bigBlind: 50, voiceLink: 'https://meet.google.com/abc-defg-hij' },
          );
          table.act('Quigs', { type: 'setCohost', playerId: table.auth('Stu').id, on: true });

          const page = await table.open('Quigs', screen);
          const press = pressOn(page, screen);
          const listed = () => texts(page, '.preset-list .preset-name');

          await press('[data-action="menu"]');
          await press('.menu [data-action="settings"]');
          await page.waitForSelector('.preset-list li.note:has-text("None yet")');
          assert.equal(await page.locator('.preset-panel p.note:has-text("plays the preset"):visible').count(), 0);

          await page.fill('#preset-name', 'Friday 25/50');
          await press('[data-action="save-preset"]');
          await page.waitForSelector('.preset-list .preset-name:has-text("Friday 25/50")');
          assert.deepEqual(rig.presets.list(), [{ name: 'Friday 25/50', settings: presetSettings({ ...table.view('Quigs').config }) }]);
          assert.equal('voiceLink' in rig.presets.list()[0]!.settings, false, 'the call went into a preset anyone can read');
          assert.equal(await text(page, '.preset-panel p.note[aria-live]'), 'Saved Friday 25/50.');
          assert.equal(await text(page, '.preset-panel p.note:not([hidden]):not([aria-live])'), 'This table plays the preset Friday 25/50.');

          await page.locator('.preset-panel').scrollIntoViewIfNeeded();
          assertOnScreen(await boxes(page, '.preset-panel, #preset-name, [data-action="save-preset"], .preset-list [data-action="delete-preset"]'), screen, 'the presets in the table settings');
          assert.deepEqual(await squeezed(page, '.preset-panel .field span, .preset-panel button, .preset-list .preset-name'), [], 'part of the presets is cut off');
          assertApart(await boxes(page, '#preset-name'), await boxes(page, '[data-action="save-preset"]'), 'the name of a preset and its Save');
          await assertNoSidewaysScroll(page);
          await shot(page, `presets-saved-${screen}`);

          // What the form holds is what is saved, before the table itself is
          // Read the way the server reads a name, so a stray space still finds the preset it would replace
          await page.fill('#table-small-blind', '30');
          await page.fill('#preset-name', ' friday  25/50');
          await press('[data-action="save-preset"]');
          await page.waitForSelector('.preset-question:not([hidden])');
          assert.equal(await text(page, '.preset-question p'), 'There is already a preset called Friday 25/50. Replace it with these settings?');
          assert.equal(rig.presets.list()[0]!.settings.smallBlind, 25, 'it was replaced before anyone said yes');
          await page.locator('.preset-question').scrollIntoViewIfNeeded();
          assertOnScreen(await boxes(page, '.preset-question, [data-action="replace-preset"], .preset-question [data-action="keep-preset"]'), screen, 'the question before a preset is replaced');
          await shot(page, `presets-replace-${screen}`);

          await press('.preset-question [data-action="keep-preset"]');
          await page.waitForSelector('.preset-question', { state: 'hidden' });
          assert.equal(rig.presets.list()[0]!.settings.smallBlind, 25);

          await press('[data-action="save-preset"]');
          await press('[data-action="replace-preset"]');
          await page.waitForSelector('.preset-panel p.note[aria-live]:has-text("Saved Friday 25/50.")');
          assert.deepEqual(await listed(), ['Friday 25/50'], 'the preset kept its name as it was first written');
          assert.equal(rig.presets.list()[0]!.settings.smallBlind, 30);
          assert.equal(table.view('Quigs').config.smallBlind, 25, 'saving a preset changed the table');
          assert.equal(await page.locator('.preset-panel p.note:has-text("plays the preset"):visible').count(), 0, 'the table no longer plays it');

          await page.fill('#preset-name', 'Tuesday');
          await press('[data-action="save-preset"]');
          await page.waitForSelector('.preset-list .preset-name:has-text("Tuesday")');

          await press('[aria-label="Delete Tuesday"]');
          assert.equal(await text(page, '.preset-list li.asking .preset-name'), 'Delete Tuesday for everyone?');
          assert.deepEqual(await listed(), ['Friday 25/50', 'Delete Tuesday for everyone?']);
          assertOnScreen(await boxes(page, '.preset-list li.asking button'), screen, 'the question before a preset is deleted');
          await shot(page, `presets-delete-${screen}`);
          await press('[data-action="confirm-delete-preset"]');
          await page.waitForSelector('.preset-panel p.note[aria-live]:has-text("Deleted Tuesday.")');
          assert.deepEqual(await listed(), ['Friday 25/50']);
          assert.deepEqual(rig.presets.list().map((preset) => preset.name), ['Friday 25/50']);
          await page.context().close();

          // A co-host keeps a preset as the host would
          const cohost = await table.open('Stu', screen);
          await pressOn(cohost, screen)('[data-action="menu"]');
          await pressOn(cohost, screen)('.menu [data-action="settings"]');
          await cohost.waitForSelector('.preset-list .preset-name:has-text("Friday 25/50")');
          await cohost.fill('#preset-name', 'Stu night');
          await pressOn(cohost, screen)('[data-action="save-preset"]');
          await cohost.waitForSelector('.preset-list .preset-name:has-text("Stu night")');
          await cohost.context().close();

          const member = await table.open('Pam', screen);
          await pressOn(member, screen)('[data-action="menu"]');
          await member.waitForSelector('.menu');
          assert.equal(await member.locator('.menu [data-action="settings"], .preset-panel').count(), 0, 'a plain member is offered the presets');
          await member.context().close();
          forgetPresets(rig);
        }
      } finally {
        forgetPresets(rig);
      }
    },
  ],
  [
    'the form for a new table offers the presets there are, picking one fills the form and says what changed, and the table made from it plays its stakes',
    async (rig) => {
      try {
        const keep = (name: string, config: Partial<TableConfig>, extra: Record<string, unknown> = {}) =>
          rig.presets.save({ name, settings: { ...presetSettings({ ...DEFAULT_CONFIG, ...config }), ...extra }, savedAt: 0, savedBy: 'Quigs' }, false);
        const stakes = (page: Page) => Promise.all(['unit input:checked', 'small-blind', 'big-blind', 'min-buy-in', 'max-buy-in'].map((field) => page.inputValue(`#new-table-${field}`)));

        for (const screen of ['smallPhone', 'phone', 'desktop'] as const) {
          const none = await rig.lobby(screen);
          await none.waitForLoadState('networkidle');
          assert.equal(await none.locator('#new-table-preset, .preset-pick:visible').count(), 0, 'a picker with nothing to pick');
          await none.context().close();

          keep('Friday 25/50', { smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 5000 });
          const one = await rig.lobby(screen);
          await one.waitForSelector('#new-table-preset');
          assert.deepEqual(await texts(one, '#new-table-preset option'), ['The usual settings', 'Friday 25/50']);
          assert.equal(await one.inputValue('#new-table-preset'), '', 'a preset was picked for the host');
          assert.deepEqual(await stakes(one), ['chips', '10', '20', '400', '2000']);
          assert.equal(await one.locator('.preset-notes p, .changed').count(), 0, 'the form says something changed before anything was picked');
          await one.context().close();

          for (let index = 0; index < 13; index++) {
            keep(`${'Wednesday Wild WWWWWWW'.slice(0, 22)} ${String(index).padStart(7, 'W')}`, { smallBlind: 5 + index, bigBlind: 10 + index });
          }

          keep('Tuesday cents', { unit: 'cents', smallBlind: 25, bigBlind: 50, ante: 10, minBuyIn: 2000, maxBuyIn: 10_000, actionSeconds: 20, allowStraddle: false, sevenDeuceBounty: 100 });

          // Saved when the clock could be set higher, with a setting the game has since dropped, and before a bomb pot could have two boards
          const { bombPotBoards: _boards, ...fromBefore } = { ...presetSettings({ ...DEFAULT_CONFIG, smallBlind: 5, bigBlind: 10 }), actionSeconds: 900, rabbitHunting: true };
          rig.presets.save({ name: 'From before', settings: fromBefore, savedAt: 0, savedBy: 'Quigs' }, false);

          keep('Bombs in chips', { bombPotAmount: 300, bombPotEvery: 5, bombPotBoards: 'two' });
          keep('Bombs in cents', { unit: 'cents', smallBlind: 25, bigBlind: 50, minBuyIn: 2000, maxBuyIn: 10_000, bombPotAmount: 500 });

          const page = await rig.lobby(screen);
          const press = pressOn(page, screen);
          await page.waitForSelector('#new-table-preset');
          assert.equal(await page.locator('#new-table-preset option').count(), 19);

          await page.fill('#host-name', 'Quigs');
          await page.fill('#new-table-name', 'Friday nickels');
          await page.fill('#new-table-voice-link', 'https://discord.gg/abc');
          await page.selectOption('#new-table-preset', { label: 'Tuesday cents' });

          assert.deepEqual(await stakes(page), ['cents', '0.25', '0.50', '20.00', '100.00']);
          assert.equal(await page.inputValue('#new-table-ante'), '0.10');
          assert.equal(await page.inputValue('#new-table-name'), "Chips n' Dipshits", 'the preset names the table');
          assert.equal(await page.inputValue('#new-table-voice-link'), 'https://discord.gg/abc', 'the call typed in was thrown away');
          assert.deepEqual(await texts(page, '.preset-notes p'), [
            'Changed here: Table name, Play with, Small blind, Big blind, Ante, Minimum buy-in, Maximum buy-in.',
            'Also set, in the table settings: Seconds to act 20, Allow straddles off, Seven-deuce bounty 1.00.',
          ]);
          assert.equal(await page.locator('.changed').count(), 7);
          assert.equal(await page.locator('#new-table-unit.changed, label[for="new-table-small-blind"].changed').count(), 2);
          assert.equal(await page.locator('label[for="new-table-voice-link"].changed, label[for="new-table-host-name"].changed').count(), 0);

          await page.locator('#new-table-preset').scrollIntoViewIfNeeded();
          assertOnScreen(await boxes(page, '#new-table-preset, .preset-notes p'), screen, 'the presets in the form for a new table');
          assert.deepEqual(await squeezed(page, '.preset-pick .field span, .preset-notes p'), [], 'part of what the picker says is cut off');
          await assertNoSidewaysScroll(page);
          await shot(page, `presets-picked-${screen}`);

          await page.selectOption('#new-table-preset', { label: 'From before' });
          assert.deepEqual(await stakes(page), ['chips', '5', '10', '400', '2000']);
          assert.deepEqual(await texts(page, '.preset-notes p.warn'), ['Seconds to act is back to 30: the preset’s is no longer allowed.']);
          await shot(page, `presets-outdated-${screen}`);

          await page.selectOption('#new-table-preset', { label: 'The usual settings' });
          assert.deepEqual(await stakes(page), ['chips', '10', '20', '400', '2000']);
          assert.equal(await page.inputValue('#new-table-name'), 'Chips n’ Dipshits');

          // The bounty the form doesn't show is an amount too, and starts over with the others when what the table plays with changes
          await page.selectOption('#new-table-preset', { label: 'Tuesday cents' });
          await press('#new-table-unit label:has-text("Whole chips")');
          assert.deepEqual(await stakes(page), ['chips', '10', '20', '400', '2000']);
          assert.deepEqual(await texts(page, '.preset-notes p'), ['Also set, in the table settings: Seconds to act 20, Allow straddles off.']);
          await press('#new-table-unit label:has-text("Dollars and cents")');

          // Every amount starts over with what the table plays with, the bomb pot's as much as the blinds
          await page.selectOption('#new-table-preset', { label: 'Bombs in chips' });
          assert.equal(await page.inputValue('#new-table-bomb-pot-amount'), '300');
          await press('#new-table-unit label:has-text("Dollars and cents")');
          assert.equal(await page.inputValue('#new-table-bomb-pot-amount'), '2.50');
          assert.equal(await page.inputValue('#new-table-bomb-pot-every'), '5', 'a count is no amount, and stays');

          await page.selectOption('#new-table-preset', { label: 'Bombs in cents' });
          assert.equal(await page.inputValue('#new-table-bomb-pot-amount'), '5.00');
          await press('#new-table-unit label:has-text("Whole chips")');
          assert.equal(await page.inputValue('#new-table-bomb-pot-amount'), '100');

          // One board or two is marked like any field a preset changes, and a preset from before there were two says one
          const boardsMarked = () => page.locator('#new-table-bomb-pot-boards.changed input:checked').inputValue();

          await page.selectOption('#new-table-preset', { label: 'Bombs in chips' });
          assert.equal(await boardsMarked(), 'two');
          assert.match(await text(page, '.preset-notes p'), /^Changed here: .*A bomb pot is played on\.$/);

          await page.locator('#new-table-bomb-pot-boards').scrollIntoViewIfNeeded();
          assertOnScreen(await boxes(page, '#new-table-bomb-pot-boards'), screen, 'the boards of a bomb pot, marked as changed');
          await shot(page, `presets-boards-${screen}`);

          await page.selectOption('#new-table-preset', { label: 'From before' });
          assert.equal(await boardsMarked(), 'one');

          // Edited after picking, before the table is made
          await page.selectOption('#new-table-preset', { label: 'Tuesday cents' });
          await page.fill('#new-table-small-blind', '0.10');
          await page.fill('#new-table-name', 'Tuesday at Stu’s');
          await press('[data-action="create-table"]');
          await page.waitForSelector('#table-link');

          const tableId = new URL(await page.inputValue('#table-link')).searchParams.get('table')!;
          const config = rig.store.read(tableId)!.config;
          assert.deepEqual(config, { ...DEFAULT_CONFIG, name: 'Tuesday at Stu’s', voiceLink: 'https://discord.gg/abc', unit: 'cents', smallBlind: 10, bigBlind: 50, ante: 10, minBuyIn: 2000, maxBuyIn: 10_000, actionSeconds: 20, allowStraddle: false, sevenDeuceBounty: 100 });

          await press('[data-action="close"]');
          assert.equal(await text(page, '.topbar .title span'), '0.10/0.50 · ante 0.10');

          await press('[data-sit="0"]');
          assert.equal(await text(page, '.dialog .field small'), 'From 20.00 to 100.00');
          await page.context().close();
          forgetPresets(rig);
        }
      } finally {
        forgetPresets(rig);
      }
    },
  ],
  [
    'the flash when it becomes your turn lights the space around the table, under every card, bet and button, in a light and a dark theme, and a half-typed bet survives it',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        for (const theme of ['cardroom', 'daylight']) {
          const table = rig.table([
            { name: 'Quigs', stack: 1000 },
            { name: 'Stu', stack: 1000 },
          ]);
          const page = await table.open('Quigs', screen);

          await choose(page, { theme });
          await standOrLie(page, screen);

          // Heads-up the button acts first, so the deal puts the action on this page; the flash is caught at its brightest
          table.deal({ button: 0, holes: { 0: 'As Kd', 1: '7h 2c' } });
          await page.waitForFunction(PAUSE_FLASH);
          await page.waitForSelector('.turn [data-action="fold"]:enabled');

          const timing = (await page.evaluate(`(() => { const t = window.flash.effect.getComputedTiming(); return { duration: t.duration, iterations: t.iterations }; })()`)) as { duration: number; iterations: number };
          assert.ok(timing.duration <= 1200 && timing.iterations === 1, `the flash lasts ${JSON.stringify(timing)}`);

          const lit = await style(page, '.stage', 'background-color');
          assert.notEqual(lit, TRANSPARENT, 'the space around the table is not lit');
          await dealt(page);
          await shot(page, `turn-flash-${screen}-${theme}`);

          // A bet being typed while the flash plays is still there after it, in the same box
          await page.fill('#raise-amount', '137');
          await page.evaluate(`window.turnPanel = document.querySelector('.turn')`);
          const onTopLit = await page.evaluate(ON_TOP);
          await page.evaluate('window.flash.play(); window.flash.finished');
          table.act('Stu', { type: 'chat', text: 'take your time' });
          await page.waitForSelector('.entries li:has-text("take your time")', { state: 'attached' });

          assert.equal(await style(page, '.stage', 'background-color'), TRANSPARENT, 'the light stays on after the flash');
          assert.deepEqual(await page.evaluate(ON_TOP), onTopLit, 'the flash is drawn over something on the table');
          assert.equal(await page.inputValue('#raise-amount'), '137');
          assert.equal(await page.evaluate(`window.turnPanel === document.querySelector('.turn')`), true, 'the turn panel was drawn again');

          await page.context().close();
        }
      }
    },
  ],
  [
    'with motion turned down the flash is a steady light for the whole turn, in every shape of the table, and goes when the player acts',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        const table = rig.table([
          { name: 'Quigs', stack: 1000 },
          { name: 'Stu', stack: 1000 },
        ]);
        const page = await table.open('Quigs', screen);
        const press = pressOn(page, screen);

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(`window.lightOn = 0; document.addEventListener('animationstart', (event) => event.animationName === 'attention-flash' && (window.lightOn += 1))`);
        table.deal({ button: 0, holes: { 0: 'As Kd', 1: '7h 2c' } });
        await page.waitForSelector('.turn [data-action="fold"]:enabled');
        await page.waitForTimeout(1500);

        assert.equal(await page.evaluate('window.lightOn'), 0, 'the flash moved');
        const lit = await style(page, '.stage', 'background-color');
        assert.notEqual(lit, TRANSPARENT, 'no steady light a second and a half into the turn');

        await inShapesOf(page, screen, async (shape) => {
          assert.equal(await style(page, '.stage', 'background-color'), lit);
          await shot(page, `turn-flash-steady-${screen}-${shape}`);
        });

        await press('.turn [data-action="call"]');
        await page.waitForSelector('.turn [data-action="fold"]', { state: 'detached' });
        assert.equal(await style(page, '.stage', 'background-color'), TRANSPARENT, 'the light outlasted the turn');

        await page.context().close();
      }
    },
  ],
  [
    'the flash reads in every theme: its line stands out from the page behind the table',
    async (rig) => {
      const page = await rig.lobby('desktop');

      for (const theme of THEMES) {
        const [accent, bg] = (await page.evaluate(`(() => {
          document.documentElement.dataset.theme = ${JSON.stringify(theme.id)};
          const tokens = getComputedStyle(document.documentElement);
          return [tokens.getPropertyValue('--accent'), tokens.getPropertyValue('--bg')];
        })()`)) as [string, string];

        assert.ok(contrast(accent, bg) >= 3, `${theme.name}: the flash's ${accent} on ${bg} is ${contrast(accent, bg).toFixed(2)} to 1`);
      }

      await page.context().close();
    },
  ],
  [
    'a phone buzzes when it becomes your turn, once the page has been touched',
    async (rig) => {
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
      ]);
      const page = await table.open('Quigs', 'phone', BUZZ);
      const warnings = complaints(page);

      // Opening the table took a tap; a reload is none
      await page.reload();
      await page.waitForSelector('.stage .table');
      table.deal({ button: 0 });
      await page.waitForSelector('.turn [data-action="fold"]:enabled');
      await page.waitForTimeout(300);
      assert.deepEqual(await page.evaluate('window.buzzes'), [], 'a buzz before the page was touched');

      await page.tap('.pot');
      table.act('Quigs', { type: 'call' });
      await page.waitForSelector('.turn [data-action="fold"]', { state: 'detached' });
      table.act('Stu', { type: 'check' });
      table.act('Stu', { type: 'check' });
      await page.waitForSelector('.turn [data-action="check"]:enabled');
      await page.waitForFunction('window.buzzes.length > 0');

      assert.deepEqual(await page.evaluate('window.buzzes'), [{ pattern: BUZZ_PATTERN, touched: true }]);
      assert.deepEqual(warnings, [], 'the page complained in its console');

      await page.context().close();
    },
  ],
  [
    'from another tab a notification and the tab’s title say it is your turn at the table, with no card or amount, and go when the turn does or the player comes back',
    async (rig) => {
      const table = rig.table(
        [
          { name: 'Quigs', stack: 1000 },
          { name: 'Stu', stack: 1000 },
        ],
        { name: 'Friday Night' },
      );
      const page = await table.open('Quigs', 'desktop', [SIGHT, NOTICES('granted'), TITLES].join(';'));
      const own = await page.title();
      const notices = () => page.evaluate('window.notices.map(({ title, options, open }) => ({ title, options, open }))') as Promise<{ title: string; options: Record<string, unknown>; open: boolean }[]>;
      const words = 'Your turn at Friday Night';

      // In sight, the page itself is enough
      table.deal({ button: 0, holes: { 0: 'As Kd', 1: '7h 2c' } });
      await page.waitForSelector('.turn [data-action="fold"]:enabled');
      await page.waitForTimeout(300);
      assert.deepEqual(await notices(), [], 'a notification with the page in sight');
      assert.deepEqual(await page.evaluate('window.titles'), []);

      table.act('Quigs', { type: 'call' });
      await page.waitForSelector('.turn [data-action="fold"]', { state: 'detached' });
      await page.evaluate('window.outOfSight(true)');
      table.act('Stu', { type: 'check' });
      table.act('Stu', { type: 'check' });
      await page.waitForFunction('window.notices.length > 0');

      assert.deepEqual(await notices(), [{ title: words, options: { tag: `cnd-${table.id}` }, open: true }]);
      assert.doesNotMatch(words, /\d|[♠♥♦♣]|\b[AKQJT2-9][shdc]\b/, 'a card or an amount on the lock screen');

      await page.waitForTimeout(2300);
      const titles = (await page.evaluate('window.titles')) as string[];
      assert.ok(titles.length >= 3, `the title changed ${titles.length} times in two seconds`);
      assert.deepEqual([...new Set(titles)].sort(), [`● ${words}`, `○ ${words}`].sort(), 'a title that does not say it is the player’s turn');

      // Acting from another device, or the clock acting for the player, ends the turn the same way
      table.act('Quigs', { type: 'check' });
      await page.waitForFunction('!window.notices[0].open');
      assert.equal(await page.title(), own, 'the title was not put back');

      const settled = ((await page.evaluate('window.titles')) as string[]).length;
      await page.waitForTimeout(1500);
      assert.equal(((await page.evaluate('window.titles')) as string[]).length, settled, 'the title kept changing after the turn');

      // Out of sight on the turn card, then back
      table.act('Stu', { type: 'check' });
      await page.waitForFunction('window.notices.length === 2');
      await page.evaluate('window.outOfSight(false)');
      await page.waitForFunction('!window.notices[1].open');
      assert.equal(await page.title(), own);
      assert.deepEqual(await page.evaluate('window.asks'), [], 'the page asked for notifications');

      await page.context().close();
    },
  ],
  [
    'the Preferences dialog offers the ways a device can get your attention, on the page served here and in Apps Script’s frame, and only a tap asks the browser',
    async (rig) => {
      const offered: Record<string, string[]> = {
        'here-phone': ['buzz', 'flash', 'tabTitle'],
        'here-desktop': ['flash', 'notify', 'tabTitle'],
        'frame-phone': ['buzz', 'flash'],
        'frame-desktop': ['flash'],
      };

      for (const where of ['here', 'frame'] as const) {
        for (const screen of PHONE_AND_DESKTOP) {
          const table = rig.table([
            { name: 'Quigs', stack: 1000 },
            { name: 'Stu', stack: 1000 },
          ]);
          const page = await table.open('Quigs', screen, [NOTICES('default', 'granted'), ...(where === 'frame' ? [STAND_IN_HOST] : [])].join(';'));
          const press = pressOn(page, screen);

          await press('[data-action="menu"]');
          await press('.menu [data-action="preferences"]');
          await page.waitForSelector('.switches');
          await page.locator('.switches').scrollIntoViewIfNeeded();

          assert.deepEqual(await page.locator('.switches [data-pref]').evaluateAll((found) => found.map((element) => element.getAttribute('data-pref'))), offered[`${where}-${screen}`]);
          assertOnScreen(await boxes(page, '.switches [data-pref]'), screen, 'the switches for your turn');
          assert.deepEqual(await squeezed(page, '.switches [data-pref], .switches [data-pref] span'), [], 'a switch is cut off');
          const switches = await boxes(page, '.switches [data-pref]');
          switches.forEach((one, index) => assertApart([one], switches.slice(index + 1), 'two switches'));
          assert.deepEqual(await page.evaluate('window.asks'), [], 'the page asked for notifications on its own');
          await shot(page, `preferences-attention-${where}-${screen}`);

          if (where === 'here' && screen === 'desktop') {
            assert.equal(await page.getAttribute('#pref-notify', 'aria-checked'), 'false', 'on before the browser said yes');
            await press('#pref-notify');
            await page.waitForSelector('#pref-notify[aria-checked="true"]');
            assert.deepEqual(await page.evaluate('window.asks'), [true], 'asked once, from inside the tap');
          }

          await page.context().close();
        }
      }

      // A player who said no in the browser is told so, and a tap asks nothing more
      const table = rig.table([
        { name: 'Quigs', stack: 1000 },
        { name: 'Stu', stack: 1000 },
      ]);
      const page = await table.open('Quigs', 'desktop', NOTICES('denied'));

      await page.click('[data-action="menu"]');
      await page.click('.menu [data-action="preferences"]');
      await page.waitForSelector('#pref-notify[aria-disabled="true"][aria-checked="false"]');
      await page.click('#pref-notify', { force: true });
      assert.match(await text(page, '#pref-notify'), /Blocked in this browser’s settings/);
      assert.deepEqual(await page.evaluate('window.asks'), []);
      await page.locator('.switches').scrollIntoViewIfNeeded();
      assert.deepEqual(await squeezed(page, '.switches [data-pref], .switches [data-pref] span'), [], 'the blocked switch is cut off');
      assertOnScreen(await boxes(page, '.switches [data-pref]'), 'desktop', 'the blocked switch');
      await shot(page, 'preferences-attention-blocked-desktop');
      await page.context().close();
    },
  ],
  [
    'a double-board bomb pot has two flops out from the start with the bets clear of both, names the viewer\'s hand on each board, and says who won each',
    async (rig) => {
      for (const kind of BOMB_POT_TABLES) {
        for (const screen of ['smallPhone', 'desktop'] as const) {
          const names = LONG_NAMES.slice(0, 6);
          const firstToAct = names[1]!;
          const results = DOUBLE_BOARD_RESULTS[kind.name]!;
          const table = rig.table(
            names.map((name, seat) => ({ name, stack: seat === 3 ? kind.short : kind.stack })),
            { ...kind.config, bombPotBoards: 'two' },
          );
          table.alter((state) => {
            state.handCount = 122;
          });

          const deal = (hand: keyof typeof DOUBLE_BOARD_HANDS) => {
            table.act('Quigs', { type: 'setBombPot', on: true });
            table.deal({ button: 0, ...DOUBLE_BOARD_HANDS[hand] });
          };

          deal('sidePot');
          const page = await table.open('Quigs', screen);
          const press = pressOn(page, screen);
          const cardsOn = async (board: number) => (await texts(page, `.board[data-run="${board}"] .card:not(.slot)`)).map((card) => card.replace(/\s/g, ''));
          // Where a line under the seat has no room for more, a hand is named by its kind alone
          const namedInShort = (shape: string) => screen === 'smallPhone' && shape.startsWith('wide');

          const lookInShapes = (name: string, buttonsUp: boolean, also: (shape: string) => Promise<void> = async () => undefined) =>
            inShapesOf(
              page,
              screen,
              async (shape) => {
                await dealt(page);
                const under = '.pot, .message.result > div';
                const middle = await boxes(page, `.board .card, ${under}`);

                assert.deepEqual(await squeezed(page, '.pot, .bet, .plate .stack'), [], 'an amount on the table is cut off');
                assertOnScreen([...middle, ...(await boxes(page, '.seat .plate, .bet'))], screen, 'a seat, a bet or the middle of the table');
                assertApart(middle, await boxes(page, '.seat .plate, .seat .hole .card'), 'the middle of the table and a seat');
                assertApart(await boxes(page, '.board[data-run="0"] .card'), await boxes(page, `.board[data-run="1"] .card, ${under}`), 'the first board and what is under it');
                assertApart(await boxes(page, '.board[data-run="1"] .card'), await boxes(page, under), 'the second board and what is under it');
                await also(shape);
                await shot(page, `double-board-${name}-${shape}-${kind.name}-${screen}`);
              },
              { buttonsUp },
            );

          const lookAtHint = async () => {
            await assertHintFits(page);
            assert.equal(new Set((await textBoxes(page, `${HINT} .read`)).map((line) => line.top)).size, 2, 'each board has one line of the hint');
          };

          const lookAtTwoPair = async (shape: string) => {
            await lookAtHint();
            assert.equal(await page.locator(`${HINT} .detail`).isVisible(), !namedInShort(shape), `the ranks of the two pair in the hint on a ${shape} table`);
          };

          // Both flops are out before anyone acts, over the one pot of what everyone posted
          assert.deepEqual([await cardsOn(0), await cardsOn(1)], [['K♥', '7♠', '2♣'], ['K♦', '9♣', '8♥']]);
          assert.equal(await page.locator('.board .card.slot').count(), 4, 'each board has room for its turn and river');
          assert.equal(await text(page, '.pot'), `Bomb pot${kind.pot}`);
          assert.deepEqual(await stacksBySeat(page, 6), kind.stacks);
          assert.equal(await page.locator('.seat.acting').getAttribute('data-seat'), '1');

          // One round of betting on the two flops: the bets sit around both boards, and the viewer, asked last, has a hand on each
          table.act(firstToAct, { type: 'raise', to: table.view(firstToAct).hand!.options!.minRaiseTo });
          for (const caller of [names[2]!, names[4]!, names[5]!]) {
            table.act(caller, { type: 'call' });
          }

          await page.waitForSelector('.turn [data-action="call"]');
          assert.deepEqual(await texts(page, '.bet'), Array(4).fill(kind.bet));
          await hintSays(page, 'Two pair, kings and sevens', 'Pair of kings');
          assert.deepEqual(await texts(page, `${HINT} .run`), ['1', '2']);
          await lookInShapes('bets', true, lookAtTwoPair);

          const feedToggle = async () => {
            if (screen !== 'desktop') {
              await page.tap('.feed-toggle');
            }
          };

          await feedToggle();
          const said = await texts(page, '.entries li');
          const start = said.indexOf(kind.lines[0]!.replace('bomb pot', 'double-board bomb pot'));
          assert.deepEqual(said.slice(start + 1, start + 5), [...kind.lines.slice(1, 3), 'First board, Flop: K♥ 7♠ 2♣', 'Second board, Flop: K♦ 9♣ 8♥']);
          assert.deepEqual(await squeezed(page, '.entries li'), [], 'a line of the play-by-play is cut off');
          await assertNoSidewaysScroll(page);
          await shot(page, `double-board-play-by-play-${kind.name}-${screen}`);
          await feedToggle();

          // On the river each board has its own cards picked out, and a card in hand only where both boards agree on it
          table.act('Quigs', { type: 'call' });
          table.play(passive, (view) => view.hand!.street === 'river' && view.hand!.toAct === 0);
          await page.waitForSelector('.board[data-run="1"] .card[data-card="3s"]');
          await page.waitForSelector('.turn [data-action="check"]');
          await hintSays(page, 'Two pair, kings and sevens', 'Pair of kings');
          assert.deepEqual(await marking(page), { plays: sortedCards('Kh 7s 9d Kd 9c 8h Ts Ks'), idle: sortedCards('2c 4h 3s') });
          await lookInShapes('river', true, async (shape) => {
            await assertMarked(page);
            await lookAtTwoPair(shape);
          });

          // Each pot is split between the boards: the short stack takes the first board's half of the one she is in for
          const lookAtResult = async (hand: keyof typeof DOUBLE_BOARD_HANDS) => {
            table.play(passive, (view) => view.hand!.stage === 'done');
            await page.waitForFunction(`document.querySelector('.message.result > div')?.textContent === ${JSON.stringify(results[hand][0])}`);
            assert.deepEqual(await texts(page, '.message.result > div'), results[hand]);
            assert.equal(await page.locator(`${HINT}, .pot`).count(), 0, 'the result names the hands and says who won what, so the hint and the pot make room for it');
            await lookInShapes(`result-${hand}`, false);
          };

          await lookAtResult('sidePot');

          const nextHand = () => {
            table.act('Quigs', { type: 'pause' });
            table.play(passive, (view) => view.hand === null);
          };

          for (const hand of ['oneEach', 'both'] as const) {
            nextHand();
            deal(hand);
            await lookAtResult(hand);
          }

          // A hand everyone else folds is won whole, on neither board, and the hint stays since nothing in the middle names a hand
          nextHand();
          deal('both');
          table.play(
            (view, name) => {
              const { canCheck, minRaiseTo } = view.hand!.options!;

              return name === 'Quigs' ? { type: 'raise', to: minRaiseTo } : { type: canCheck ? 'check' : 'fold' };
            },
            (view) => view.hand!.stage === 'done',
          );
          await page.waitForFunction(`document.querySelector('.message.result > div')?.textContent?.startsWith('Quigs wins')`);
          assert.deepEqual(await texts(page, '.message.result > div'), [`Quigs wins ${kind.name === 'cents' ? '12.50' : '500'}`]);
          await hintSays(page, 'Pair of deuces', 'Ace high');
          await lookInShapes('result-folded', false, lookAtHint);

          nextHand();

          await press('[data-action="menu"]');
          await press('.menu [data-action="history"]');
          await page.waitForSelector('.history summary');
          assert.deepEqual((await texts(page, '.history summary')).map((line) => line.split('\n')[0]), [126, 125, 124, 123].map((hand) => `Hand #${hand} · double-board bomb pot`));
          await page.locator('.history details').nth(1).locator('summary').scrollIntoViewIfNeeded();
          await page.locator('.history details').nth(1).locator('summary').click();

          const told = (await text(page, '.history details[open] pre')).split('\n');
          const [first, second] = results.both.map((line) => line.replace(/^Board \d: /, '').replace(' with ', (_with) => ' on the BOARD with '));
          assert.deepEqual(told.filter((line) => line.includes('River')), ['First board, River: A♥ 7♠ 2♣ 9♦ 4♥', 'Second board, River: A♣ 9♣ 8♥ 10♠ 3♠']);
          assert.deepEqual(told.slice(-2), [first!.replace('BOARD', 'first board'), second!.replace('BOARD', 'second board')]);
          assert.deepEqual(await squeezed(page, '.history summary'), [], 'the hand\'s line in the history is cut off');
          await assertNoSidewaysScroll(page);
          await shot(page, `double-board-history-${kind.name}-${screen}`);

          await page.context().close();
        }
      }
    },
  ],
  [
    'a double-board bomb pot plays the deal and one flop for the two on another player’s page, and one street for the turn of both',
    async (rig) => {
      const table = rig.table(
        [
          { name: 'Quigs', stack: 1000 },
          { name: 'Stu', stack: 1000 },
          { name: 'Pam', stack: 1000 },
        ],
        { bombPotBoards: 'two' },
      );
      const page = await table.open('Pam', 'phone', LISTEN);

      table.act('Quigs', { type: 'setBombPot', on: true });
      table.deal({ button: 0, board: '3s 4c Jd 9h Qd', secondBoard: 'Kd 5c 8h Ts 2s' });
      await page.waitForSelector('.board[data-run="1"] .card[data-card]:nth-child(3)');
      await page.waitForFunction('window.played.length >= 2');
      await page.waitForTimeout(300);

      assert.deepEqual(await playedNames(page), ['deal', 'street'], 'the deal and one flop for the two boards');

      const [deal, flop] = await playedAt(page);
      const dealLasts = Math.max(...RECIPES.deal.map((voice) => voice.at + voice.length));
      assert.ok(flop! - deal! >= dealLasts, `the flops start ${(flop! - deal!).toFixed(3)} s after the deal, which lasts ${dealLasts} s`);

      // Stu, left of the button, checks to Pam, whose own check is silent to her; the button's check brings the turn
      table.act('Stu', { type: 'check' });
      await page.waitForSelector('.turn [data-action="check"]:enabled');
      await page.waitForFunction('window.played.length >= 4');
      await page.waitForTimeout(300);
      assert.deepEqual(await playedNames(page, 2), ['knock', 'turn']);

      table.act('Pam', { type: 'check' });
      table.act('Quigs', { type: 'check' });
      await page.waitForSelector('.board[data-run="1"] .card[data-card]:nth-child(4)');
      await page.waitForFunction('window.played.length >= 6');
      await page.waitForTimeout(300);

      assert.deepEqual(await playedNames(page, 4), ['knock', 'street'], 'the button’s check, and one street for the turn of both boards');

      await page.context().close();
    },
  ],
  [
    'the table settings take one board or two for a bomb pot, and the menu and the bar under the table say which is coming',
    async (rig) => {
      for (const kind of BOMB_POT_TABLES) {
        // The settings are a long list now, and the narrowest phone is where a row of it runs out of room first
        for (const screen of ['smallPhone', 'desktop'] as const) {
          const table = rig.table(
            [
              { name: 'Quigs', stack: kind.stack },
              { name: 'Stu', stack: kind.stack },
            ],
            kind.config,
          );
          const page = await table.open('Quigs', screen);
          const press = pressOn(page, screen);
          const picked = (boards: string) => page.isChecked(`#table-bomb-pot-boards input[value="${boards}"]`);
          const openSettings = async () => {
            await press('[data-action="menu"]');
            await press('.menu [data-action="settings"]');
            await page.waitForSelector('#table-bomb-pot-boards');
          };

          await openSettings();
          assert.equal(await picked('one'), true, 'a bomb pot is on one board unless the host says otherwise');
          assert.equal(await text(page, '#table-bomb-pot-boards > span'), 'A bomb pot is played on');
          assert.deepEqual(await texts(page, '#table-bomb-pot-boards .check'), ['One board', 'Two boards']);
          assert.equal(await text(page, '#table-bomb-pot-boards small'), 'With two, each board wins half of every pot');

          await page.locator('#table-bomb-pot-boards').scrollIntoViewIfNeeded();
          assert.deepEqual(await squeezed(page, '#table-bomb-pot-boards .check span, #table-bomb-pot-boards > span, #table-bomb-pot-boards small'), [], 'part of the settings is cut off');
          assertOnScreen(await boxes(page, '.dialog, #table-bomb-pot-boards, #table-bomb-pot-boards .check'), screen, 'the boards of a bomb pot in the settings');
          const [one, two] = await boxes(page, '#table-bomb-pot-boards .check');
          assert.ok(one && two && !overlap(one, two), 'the two choices are drawn over each other');
          await assertNoSidewaysScroll(page);

          await press('#table-bomb-pot-boards label:has-text("Two boards")');
          await shot(page, `double-board-settings-${kind.name}-${screen}`);
          await press('[data-action="save-settings"]');
          await page.waitForSelector('.dialog', { state: 'detached' });
          assert.equal(table.view('Stu').feed.at(-1)!.text, `A double-board bomb pot is ${kind.amount} and comes only when called`);

          // Called from the menu, which says what it starts on, it is told under the table by its name
          await press('[data-action="menu"]');
          assert.equal(await text(page, '.menu [data-action="bomb-pot"]'), `Bomb pot next hand${kind.amount} each, no blinds, starts on two flops`);
          assert.deepEqual(await squeezed(page, '.menu-item, .menu-item small'), [], 'a line of the menu is cut off');
          await press('.menu [data-action="bomb-pot"]');
          await page.waitForSelector('.controls .next-hand');
          assert.equal(await text(page, '.controls .next-hand'), `Next hand is a double-board bomb pot: ${kind.amount} each`);

          await inShapesOf(
            page,
            screen,
            async (shape) => {
              assert.deepEqual(await squeezed(page, '.controls .waiting, .controls .next-hand'), [], 'what is said about the next hand is cut off');
              assertOnScreen(await boxes(page, '.controls .next-hand, .seat .plate'), screen, 'the table and what is said under it');
              assertApart(await boxes(page, '.controls .next-hand'), await boxes(page, '.stage, .controls .extras'), 'word of the bomb pot and what is around it');
              await shot(page, `double-board-next-${kind.name}-${screen}-${shape}`);
            },
            { buttonsUp: false },
          );

          await openSettings();
          assert.equal(await picked('two'), true);

          await page.context().close();
        }
      }
    },
  ],
  [
    'the last hands the host calls are told under the table to everyone, beside word of a bomb pot, and changing them leaves a bet being typed alone',
    async (rig) => {
      for (const kind of BOMB_POT_TABLES) {
        for (const screen of PHONE_AND_DESKTOP) {
          const table = rig.table(
            LONG_NAMES.slice(0, 6).map((name) => ({ name, stack: kind.stack })),
            kind.config,
          );
          table.join('Zed');
          table.deal({ button: 0, holes: { 0: 'As Ah', 3: 'Ks Kh' }, board: '2c 7d 9h Jc 3s' });

          const host = await table.open('Quigs', screen);
          const deciding = await table.open('Marge Simpson-Jr', screen);
          const watcher = await table.open('Zed', screen);
          const everyone = { host, watcher };
          const press = pressOn(host, screen);
          const [roomBefore] = await boxes(host, '.stage');

          const lookInShapes = async (state: string, said: string[]) => {
            for (const [who, page] of Object.entries(everyone)) {
              await page.waitForFunction(`JSON.stringify([...document.querySelectorAll('.controls .next-hand span')].map((part) => part.textContent)) === ${JSON.stringify(JSON.stringify(said))}`);

              await inShapesOf(
                page,
                screen,
                async (shape) => {
                  await assertNextHandsFit(page, screen, who);
                  await shot(page, `last-hands-${state}-${who}-${kind.name}-${screen}-${shape}`);
                },
                { buttonsUp: false },
              );
            }
          };

          // Called during a hand, from the menu, the count is of the hands after it
          await press('[data-action="menu"]');
          assert.equal(await text(host, '.menu [data-action="lastHands"]'), 'Last handsCall how many hands are left, or end the night');
          await press('.menu [data-action="lastHands"]');
          await host.waitForSelector('.hand-counts');
          assert.deepEqual(await texts(host, '.this-hand button, .hand-counts button'), ['This hand is the last', ...Array.from({ length: 10 }, (_, index) => String(index + 1))]);
          assert.equal(await host.locator('.dialog [data-action="end-night"], .dialog [data-action="call-off-last-hands"]').count(), 0, 'the night can be ended outright during a hand, or a count nobody called called off');
          assertOnScreen(await boxes(host, '.dialog, .dialog button'), screen, 'the last hands dialog');
          assert.deepEqual(await squeezed(host, '.dialog button, .dialog p'), [], 'part of the last hands dialog is cut off');
          await assertNoSidewaysScroll(host);
          await shot(host, `last-hands-dialog-${kind.name}-${screen}`);

          await press('.hand-counts [data-hands="3"]');
          await host.waitForSelector('.dialog', { state: 'detached' });
          assert.equal(table.view('Zed').feed.at(-1)!.text, 'The host calls it a night after this hand and 3 more');

          // A seated player's bar keeps its height, so the count costs their table nothing
          await host.waitForSelector('.controls .next-hand');
          assert.deepEqual(await boxes(host, '.stage'), [roomBefore], 'the count took room from a seated player\'s table');
          await lookInShapes('3', ['3 more hands after this one']);

          table.act('Quigs', { type: 'setBombPot', on: true });
          await lookInShapes('and-bomb-pot', ['3 more hands after this one', nextIsBombPot(kind.amount)]);

          // The player on the clock is typing a bet when the count changes, and the bet is left as it was typed
          await deciding.fill('#raise-amount', kind.typed);
          await deciding.evaluate(`document.querySelector('#raise-amount').dataset.typed = 'yes'`);
          table.act('Quigs', { type: 'setLastHands', hands: 1 });
          await deciding.waitForSelector('.feed li:has-text("now calls it a night after this hand and 1 more")', { state: 'attached' });
          assert.equal(await deciding.inputValue('#raise-amount'), kind.typed);
          assert.equal(await deciding.locator('#raise-amount[data-typed="yes"]').count(), 1, 'the bet being typed was drawn again');
          assert.equal(await deciding.locator('.next-hand').count(), 0, 'word of the hands to come takes room from a decision');
          await shot(deciding, `last-hands-deciding-${kind.name}-${screen}`);

          // Once their move is made, they see the count too
          await pressOn(deciding, screen)('.turn [data-action="call"]');
          await deciding.waitForFunction(`document.querySelector('.controls .next-hand')?.textContent === ${JSON.stringify(`1 more hand after this one${nextIsBombPot(kind.amount)}`)}`);

          // Made the last hand, nothing is said of a bomb pot that will never be dealt
          await press('[data-action="menu"]');
          assert.equal(await text(host, '.menu [data-action="lastHands"] small'), '1 more hand after this one');
          await press('.menu [data-action="lastHands"]');
          await host.waitForSelector('.hand-counts');
          assert.deepEqual(await texts(host, '.dialog [aria-pressed="true"]'), ['1']);
          assert.equal(await host.locator('.dialog [data-action="call-off-last-hands"]').count(), 1);
          await shot(host, `last-hands-dialog-called-${kind.name}-${screen}`);
          await press('.this-hand [data-hands="0"]');
          await host.waitForSelector('.dialog', { state: 'detached' });
          assert.equal(table.view('Zed').feed.at(-1)!.text, 'The host now calls it a night after this hand');
          await lookInShapes('last', ['Last hand of the night']);
          await press('[data-action="menu"]');
          await host.waitForSelector('.menu [data-action="lastHands"]');
          assert.equal(await host.locator('.menu [data-action="bomb-pot"]').count(), 0, 'a bomb pot is offered for a hand that never comes');
          await press('[data-action="close"]');

          for (const page of [host, deciding, watcher]) {
            await page.context().close();
          }
        }
      }
    },
  ],
  [
    'the longest count of hands left and the longest word of a bomb pot on two boards share the bar whole on the smallest phone',
    async (rig) => {
      const table = rig.table(
        LONG_NAMES.slice(0, 6).map((name) => ({ name, stack: 10_000_000 })),
        { ...CENTS, bombPotAmount: 999_999, bombPotBoards: 'two' },
      );
      table.deal({ button: 0, holes: { 0: 'As Ah' } });
      table.act('Quigs', { type: 'setLastHands', hands: LIMITS.lastHands, from: 1 });
      table.act('Quigs', { type: 'setBombPot', on: true });

      const page = await table.open('Stu', 'smallPhone');
      const said = [`${LIMITS.lastHands} more hands after this one`, 'Next hand is a double-board bomb pot: 9,999.99 each'];
      await page.waitForFunction(`JSON.stringify([...document.querySelectorAll('.controls .next-hand span')].map((part) => part.textContent)) === ${JSON.stringify(JSON.stringify(said))}`);
      await inShapesOf(
        page,
        'smallPhone',
        async (shape) => {
          await assertNextHandsFit(page, 'smallPhone', 'player');
          await shot(page, `last-hands-longest-double-board-smallPhone-${shape}`);
        },
        { buttonsUp: false },
      );
    },
  ],
  [
    'the host or a co-host can end the night outright between hands or after a last hand, everyone is told it is over, and either can play on while a member cannot',
    async (rig) => {
      for (const kind of BOMB_POT_TABLES) {
        for (const screen of PHONE_AND_DESKTOP) {
          const table = rig.table(
            LONG_NAMES.slice(0, 6).map((name) => ({ name, stack: kind.stack })),
            kind.config,
          );
          table.join('Zed');
          table.act('Quigs', { type: 'setCohost', playerId: table.auth('Stu').id, on: true });

          const pages = { host: await table.open('Quigs', screen), cohost: await table.open('Stu', screen), member: await table.open('Big Al', screen), watcher: await table.open('Zed', screen) };
          const runs = (who: string) => who === 'host' || who === 'cohost';
          const host = pages.host;
          const press = pressOn(host, screen);

          // Between hands, ended outright from the menu once the host has said so twice
          await press('[data-action="menu"]');
          await press('.menu [data-action="lastHands"]');
          await host.waitForSelector('.dialog [data-action="end-night"]');
          assert.equal(await host.locator('.this-hand, .dialog [data-action="call-off-last-hands"]').count(), 0, 'with no hand on the table it is offered as the last, or a count nobody called is offered to be called off');
          assert.deepEqual(await squeezed(host, '.dialog button, .dialog p'), [], 'part of the last hands dialog is cut off');
          await shot(host, `last-hands-dialog-between-hands-${kind.name}-${screen}`);
          await press('.dialog [data-action="end-night"]');
          await host.waitForSelector('.dialog [data-action="confirm"]');
          assert.equal(await text(host, '.dialog h2'), 'End the night?');
          await press('.dialog [data-action="confirm"]');
          await host.waitForSelector('.message.night-over');
          assert.equal(table.view('Zed').feed.at(-1)!.text, 'The host ended the night');

          // A co-host plays on from the felt, and the next hand is the last
          await pages.cohost.waitForSelector('.message.night-over [data-action="play-on"]');
          await pressOn(pages.cohost, screen)('.message.night-over [data-action="play-on"]');
          await pages.cohost.waitForSelector('.message.night-over', { state: 'detached' });
          table.deal({ button: 0, holes: { 0: 'As Ah', 3: 'Ks Kh' }, board: '2c 7d 9h Jc 3s' });
          assert.equal(table.view('Zed').feed.find((entry) => entry.text.startsWith('Co-host'))?.text, 'Co-host Stu started play again');
          table.act('Quigs', { type: 'setLastHands', hands: 0 });

          // The last hand's result is up, and the bar says it was the last
          const done = table.play(passive, (view) => view.hand?.stage === 'done');
          await pages.member.waitForSelector('.controls .waiting:has-text("That was the last hand")');
          assert.equal(await pages.member.locator('.controls .next-hand').count(), 0);

          rig.advance(done.hand!.deadline! - rig.now());
          assert.notEqual(table.view('Quigs').nightEndedAt, null);
          assert.equal(table.view('Zed').feed.at(-1)!.text, 'That was the last hand. The night is over');

          for (const [who, page] of Object.entries(pages)) {
            await page.waitForSelector('.message.night-over');
            assert.equal(await text(page, '.message.night-over > div'), 'The night is over', who);
            assert.equal(await page.locator('.message.night-over [data-action="play-on"]').count(), runs(who) ? 1 : 0, `${who} is offered to play on`);
            assert.equal(await text(page, '.topbar .pill'), 'Night over', who);
            assert.equal(await text(page, '.controls .waiting'), 'The night is over', who);
            assert.equal(await page.locator('.controls .extras, [data-sit]').count(), 0, `${who} is offered to sit down, sit out or add chips with no hands to come`);

            await inShapesOf(
              page,
              screen,
              async (shape) => {
                assert.deepEqual(await squeezed(page, '.message.night-over > *, .controls .waiting, .topbar .pill'), [], `what the ${who} is told is cut off`);
                assertOnScreen(await boxes(page, '.message.night-over > *, .seat .plate'), screen, `the ${who}'s table`);
                assertApart(await boxes(page, '.message.night-over > *'), await boxes(page, '.seat .plate, .seat .hole .card, .board .card'), 'the end of the night and the seats');
                await shot(page, `night-over-${who}-${kind.name}-${screen}-${shape}`);
              },
              { buttonsUp: false },
            );
          }

          // However long the table waits, nothing is dealt
          rig.advance(60_000);
          assert.equal(table.view('Quigs').hand, null);

          for (const [who, page] of Object.entries(pages)) {
            const pressHere = pressOn(page, screen);

            await pressHere('[data-action="menu"]');
            await page.waitForSelector('.menu [data-action="ledger"]');
            assert.equal(await page.locator('.menu [data-action="keep-playing"]').count(), runs(who) ? 1 : 0, `${who} is offered to play on`);
            assert.equal(await page.locator('.menu :is([data-action="lastHands"], [data-action="bomb-pot"], [data-action="start"])').count(), 0, `${who} is offered something that waits for hands to be dealt`);
            await pressHere('.menu [data-action="ledger"]');
            await page.waitForSelector('.ledger');
            await pressHere('[data-action="close"]');
          }

          // The host plays on from the menu
          await press('[data-action="menu"]');
          await press('.menu [data-action="keep-playing"]');
          for (const page of Object.values(pages)) {
            await page.waitForSelector('.message.night-over', { state: 'detached' });
          }
          assert.equal(table.view('Zed').feed.at(-1)!.text, 'The host started play again');

          for (const page of Object.values(pages)) {
            await page.context().close();
          }
        }
      }
    },
  ],
  [
    'with animations on, each move starts where it should and the table lands exactly as a still one stands, on one board and on two and at the end of the night, standing, lying, on the desktop and on a slow phone',
    async (rig) => {
      for (const layout of MOTION_LAYOUTS) {
        const table = rig.table(MOTION_PLAYERS, layout.config);
        const { config } = table.view('Quigs');
        const big = config.bigBlind;
        const says = (amount: number) => shortAmount(amount, config);
        const { moving, still, step } = await watch(table, 'Quigs', layout);
        const where = (what: string) => `${layout.name}, ${what}`;

        // A hand's last move, with the game paused first: a table that is running deals the next hand itself, with cards nobody chose
        const last = (move: () => unknown) => {
          table.act('Quigs', { type: 'pause' });
          move();
        };

        // The button is on Al, so Quigs and Stu post the blinds and the cards go around from Quigs
        let seen = await step('the deal', () => table.deal({ button: 3, holes: { 0: 'Ah Kd', 1: 'Qc Qd', 2: '7h 7s', 3: '9c 4d' }, board: 'Kh 7c 2c 9d 3s' }));
        let bets = flightsOf(seen, 'chips', false);
        let cards = flightsOf(seen, 'card', false);

        assert.equal(seen.flights.length, 10, where('two blinds and eight cards move'));
        assert.deepEqual(bets.map((bet) => [bet.seat, bet.text, bet.delay]), [[0, says(big / 2), 0], [1, says(big), 0]], where('the blinds'));
        bets.forEach((bet) => assertOver(bet.from, seen.after.plates[bet.seat!], where(`the blind of seat ${bet.seat} leaves its seat`)));
        assert.deepEqual(cards.map((card) => card.seat), [0, 0, 1, 1, 2, 2, 3, 3], where('the cards go around from the left of the button'));
        cards.forEach((card) => assertOver(card.from, seen.after.felt, where(`a card of seat ${card.seat} leaves the middle of the table`)));
        assert.equal(cards[0]!.delay, 0, where('the first cards wait'));
        cards.slice(2).forEach((card, nth) => assert.ok(card.delay >= cards[nth]!.delay && card.delay > 0, where('a seat is dealt before the one to its right')));

        seen = await step('a raise', () => table.act('Pam', { type: 'raise', to: 3 * big }));
        assert.deepEqual(seen.flights.map((flight) => [flight.what, flight.standIn, flight.seat, flight.text, flight.delay]), [['chips', false, 2, says(3 * big), 0]], where('a raise'));
        assertOver(seen.flights[0]!.from, seen.after.plates[2], where('the raise leaves its seat'));

        seen = await step('a fold', () => table.act('Al', { type: 'fold' }));
        assert.deepEqual(seen.flights.map((flight) => [flight.what, flight.standIn, flight.delay]), [['cards', true, 0]], where('a fold'));
        assertLeavesSeat(seen.flights[0]!, seen, 3, where('a fold'));

        seen = await step('the viewer’s own call', () => table.act('Quigs', { type: 'call' }));
        assert.deepEqual(seen.flights.map((flight) => [flight.what, flight.standIn, flight.seat, flight.text]), [['chips', false, 0, says(3 * big)]], where('the viewer’s own call'));
        assertOver(seen.flights[0]!.from, seen.after.plates[0], where('the viewer’s call leaves their seat'));

        // The last call ends the street: it is seen going to the pot with the other bets, and the flop comes a beat later
        seen = await step('the end of a street', () => table.act('Stu', { type: 'call' }));
        bets = flightsOf(seen, 'chips', true);
        cards = flightsOf(seen, 'card', false);

        assert.equal(seen.flights.length, 6, where('three bets and three cards move'));
        assert.deepEqual(bets.map((bet) => [bet.text, bet.delay]), [0, 1, 2].map(() => [says(3 * big), 0]), where('the bets going to the pot'));
        bets.forEach((bet, seat) => {
          assertOver(bet.from, seen.before.bets[seat], where(`the bet of seat ${seat} leaves where it lay`));
          assertOver(bet.to, seen.after.pot, where(`the bet of seat ${seat} goes to the pot`));
        });
        assert.deepEqual(cards.map((card) => [card.board, card.delay]), [0, 1, 2].map((nth) => [0, STEP_GAP_MS + nth * 60]), where('the flop'));
        cards.forEach((card) => assertDrops(card, where('a card of the flop')));

        seen = await step('a check', () => table.act('Quigs', { type: 'check' }));
        assert.deepEqual(seen.flights, [], where('a check moves nothing'));

        seen = await step('a bet', () => table.act('Stu', { type: 'raise', to: 5 * big }));
        assert.deepEqual(seen.flights.map((flight) => [flight.what, flight.standIn, flight.seat, flight.text]), [['chips', false, 1, says(5 * big)]], where('a bet'));
        assertOver(seen.flights[0]!.from, seen.after.plates[1], where('the bet leaves its seat'));

        seen = await step('another fold', () => table.act('Pam', { type: 'fold' }));
        assert.equal(seen.flights.length, 1, where('another fold'));
        assertLeavesSeat(seen.flights[0]!, seen, 2, where('another fold'));

        // The viewer's own fold leaves their cards where they are and is silent to them, so the pot won is heard at once:
        // the bet nobody called goes back and the pot leaves with it
        seen = await step('a win', () => last(() => table.act('Quigs', { type: 'fold' })));
        bets = flightsOf(seen, 'chips', true);

        assert.equal(seen.flights.length, 2, where('the bet going back and the pot move'));
        assert.deepEqual(bets.map((bet) => [bet.text, bet.delay]), [[says(5 * big), 0], [says(9 * big), 0]], where('the bet going back and the pot'));
        assertOver(bets[0]!.from, seen.before.bets[1], where('the bet going back leaves where it lay'));
        assertOver(bets[1]!.from, seen.after.pot, where('the pot leaves the middle'));
        bets.forEach((bet) => assertOver(bet.to, seen.after.plates[1], where('the winner’s chips go to their seat')));

        // The board plays for everyone, so the pot is split four ways: the other hands turn up, then each winner gets a pile
        await step('the next deal', () => {
          table.play(() => null, (view) => !view.hand);
          table.deal({ button: 3, board: 'As Ks Qs Js Ts' });
        });
        await step('to the river', () => table.play(passive, (view) => view.hand!.street === 'river' && view.hand!.toAct === 3));

        seen = await step('a split pot', () => last(() => table.act('Al', { type: 'check' })));
        bets = flightsOf(seen, 'chips', true);
        cards = flightsOf(seen, 'card', false);

        assert.equal(seen.flights.length, 10, where('six cards turn up and four piles move'));
        assert.deepEqual(cards.map((card) => [card.seat, card.delay]), [1, 1, 2, 2, 3, 3].map((seat) => [seat, 0]), where('the other three hands turn up'));
        cards.forEach((card) => assertOver(card.from, card.to, where('a card turns up where it lies')));
        assert.deepEqual(bets.map((bet) => [bet.text, bet.delay]), [0, 1, 2, 3].map(() => [says(big), STEP_GAP_MS]), where('a pile for each winner'));
        assert.deepEqual(bets.map((bet) => Object.keys(seen.after.plates).find((seat) => over(bet.to, seen.after.plates[Number(seat)]!))).sort(), ['0', '1', '2', '3'], where('each pile goes to a winner of its own'));
        bets.forEach((bet) => assertOver(bet.from, seen.after.pot, where('a winner’s pile leaves the middle')));

        // A bomb pot: a bare chip from every seat as the cards go out, then the flop
        seen = await step('a bomb pot', () => {
          table.play(() => null, (view) => !view.hand);
          table.act('Quigs', { type: 'setBombPot', on: true });
          table.deal({ button: 3, board: '2c 7d 9h Jc 3s' });
        });
        bets = flightsOf(seen, 'chips', true);
        cards = flightsOf(seen, 'card', false);

        assert.equal(seen.flights.length, 15, where('four chips, eight cards and the flop move'));
        assert.deepEqual(bets.map((bet) => [bet.text, bet.delay]), [0, 1, 2, 3].map(() => ['', 0]), where('a bare chip from every seat'));
        bets.forEach((bet, seat) => {
          assertOver(bet.from, seen.after.plates[seat], where(`the chip of seat ${seat} leaves its seat`));
          assertOver(bet.to, seen.after.pot, where(`the chip of seat ${seat} goes to the pot`));
        });
        assert.deepEqual(cards.map((card) => card.seat ?? `board ${card.board}`), [0, 0, 1, 1, 2, 2, 3, 3, 'board 0', 'board 0', 'board 0'], where('the cards, then the flop'));
        assert.deepEqual(cards.slice(8).map((card) => card.delay), [0, 1, 2].map((nth) => STEP_GAP_MS + nth * 60), where('the flop comes a beat after the deal'));

        // The same on two boards: both flops land together, each card on its own place
        seen = await step('a double-board bomb pot', () => {
          last(() => table.play(passive, (view) => view.hand?.stage === 'done'));
          table.play(() => null, (view) => !view.hand);
          table.act('Quigs', { type: 'updateConfig', config: { bombPotBoards: 'two' } });
          table.act('Quigs', { type: 'setBombPot', on: true });
          table.deal({ button: 3, board: '2c 7d 9h Jc 3s', secondBoard: 'Kd 5c 8h Ts 2h' });
        });
        bets = flightsOf(seen, 'chips', true);
        cards = flightsOf(seen, 'card', false);

        assert.equal(seen.flights.length, 18, where('four chips, eight cards and two flops move'));
        bets.forEach((bet, seat) => {
          assertOver(bet.from, seen.after.plates[seat], where(`the chip of seat ${seat} leaves its seat for two boards`));
          assertOver(bet.to, seen.after.pot, where(`the chip of seat ${seat} goes to the pot under two boards`));
        });
        assert.deepEqual(cards.slice(8).map((card) => [card.board, card.delay]), [0, 1].flatMap((board) => [0, 1, 2].map((nth) => [board, STEP_GAP_MS + nth * 60])), where('both flops come together, a beat after the deal'));
        cards.slice(8).forEach((card) => assertDrops(card, where(`a card of the flop of board ${card.board}`)));
        await shot(moving, `motion-landed-two-flops-${layout.name}`);

        // Bets lie clear of both boards, a row further out on a standing phone, and that is where each slides to and leaves from
        for (const name of ['Quigs', 'Stu', 'Pam']) {
          seen = await step(`${name}’s bet beside two boards`, () => table.act(name, name === 'Quigs' ? { type: 'raise', to: 2 * big } : { type: 'call' }));
          assert.deepEqual(seen.flights.map((flight) => [flight.what, flight.standIn, flight.text]), [['chips', false, says(2 * big)]], where(`${name}’s bet beside two boards`));
          assertOver(seen.flights[0]!.from, seen.after.plates[seen.flights[0]!.seat!], where(`${name}’s bet beside two boards leaves its seat`));
        }

        // The button's call ends the street: the bets go to the pot as it is heard, and the turn of both boards a beat later, as the one sound of the two
        seen = await step('the turn of two boards', () => table.act('Al', { type: 'call' }));
        bets = flightsOf(seen, 'chips', true);
        cards = flightsOf(seen, 'card', false);

        assert.equal(seen.flights.length, 6, where('four bets and the turn of two boards move'));
        assert.deepEqual(bets.map((bet) => [bet.text, bet.delay]), [0, 1, 2, 3].map(() => [says(2 * big), 0]), where('the bets going to the pot under two boards'));
        bets.forEach((bet, seat) => {
          if (seen.before.bets[seat]) {
            assertOver(bet.from, seen.before.bets[seat], where(`beside two boards, the bet of seat ${seat} leaves where it lay`));
          }
          assertOver(bet.to, seen.after.pot, where(`the bet of seat ${seat} goes to the pot under two boards`));
        });
        assert.deepEqual(Object.keys(seen.before.bets), ['0', '1', '2'], where('the bets that lay beside two boards'));
        assert.deepEqual(cards.map((card) => [card.board, card.delay]), [0, 1].map((board) => [board, STEP_GAP_MS]), where('the turn of both boards comes together'));
        cards.forEach((card) => assertDrops(card, where(`the turn of board ${card.board}`)));
        await shot(moving, `motion-landed-two-turns-${layout.name}`);

        // The last hand of the night, played out in one view: each winner gets one pile, all at once
        table.act('Quigs', { type: 'setLastHands', hands: 0 });
        seen = await step('the last hand of the night', () => table.play(passive, (view) => view.hand?.stage === 'done'));
        bets = flightsOf(seen, 'chips', true);

        assert.ok(bets.length > 0 && bets.every((bet) => bet.delay === bets[0]!.delay), where('the last pot goes to its winners at once'));
        bets.forEach((bet) => assertOver(bet.from, seen.after.pot, where('a pile of the last pot leaves the middle')));
        assert.equal(new Set(bets.map((bet) => Object.keys(seen.after.plates).find((seat) => over(bet.to, seen.after.plates[Number(seat)]!)))).size, bets.length, where('each pile of the last pot goes to a winner of its own'));

        // And when the felt comes to say the night is over, nothing moves and nothing is left on it
        seen = await step('the end of the night', () => rig.advance(table.view('Quigs').hand!.deadline! - rig.now()));
        assert.notEqual(table.view('Quigs').nightEndedAt, null);
        assert.deepEqual(seen.flights, [], where('the end of the night moves nothing'));
        assert.equal(await text(moving, '.message.night-over > div'), 'The night is over', where('the felt'));
        assert.equal(await moving.locator('.stand-in').count(), 0, where('something is left on the felt when the night is over'));
        await shot(moving, `motion-night-over-${layout.name}`);

        await shot(moving, `motion-landed-${layout.name}`);
        await moving.context().close();
        await still.context().close();
      }
    },
  ],
  [
    'with animations on, a tap, a key and a half-typed bet work while cards are in the air, and a new view, a squeezed table, a turned phone or the end of the night leaves nothing behind',
    async (rig) => {
      // Every animation the page's script has running, what each changes, and every stand-in on the table.
      // The flash of a turn is the stylesheet's own, on the table's background
      const inTheAir = (page: Page) =>
        page.evaluate(`(() => {
          const animations = document.getAnimations().filter((animation) => !(animation instanceof CSSAnimation));

          // What a tap would land on where each thing in flight is right now: never the thing itself
          const inTheWay = animations.filter(({ effect: { target } }) => {
            const box = target.getBoundingClientRect();

            return target.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
          });

          return {
            moving: document.querySelector('.stage').hasAttribute('data-moving'),
            animations: animations.length,
            animated: [...new Set(animations.flatMap((animation) => animation.effect.getKeyframes().flatMap(Object.keys)))].filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key)).sort(),
            standIns: document.querySelectorAll('.stand-in').length,
            inTheWay: inTheWay.length,
          };
        })()`) as Promise<{ moving: boolean; animations: number; animated: string[]; standIns: number; inTheWay: number }>;
      const still = { moving: false, animations: 0, animated: [], standIns: 0, inTheWay: 0 };
      const air = (animations: number, standIns: number) => ({ moving: true, animations, animated: ['opacity', 'transform'], standIns, inTheWay: 0 });

      for (const layout of MOTION_LAYOUTS.filter((layout) => ['phone-standing', 'desktop'].includes(layout.name))) {
        const table = rig.table(MOTION_PLAYERS);
        const { moving, still: unmoved } = await watch(table, 'Quigs', layout, 0.5);
        const press = pressOn(moving, layout.screen);
        const where = (what: string) => `${layout.name}, ${what}`;
        const shown = () => Promise.all([moving, unmoved].map((page) => caughtUp(page, table.view('Quigs'))));

        // The button is on Stu, so the deal puts the action on Quigs with every card still in the air
        table.deal({ button: 1 });
        await shown();
        assert.deepEqual(await inTheAir(moving), air(10, 0), where('the deal'));
        await shot(moving, `motion-held-deal-${layout.name}`);

        // A bet half typed stays through a view that brings no news of the hand, which leaves the cards in the air too
        await moving.fill('#raise-amount', '55');
        table.act('Stu', { type: 'chat', text: 'any day now' });
        await moving.getByText('any day now').first().waitFor({ state: 'attached' });
        assert.equal(await moving.inputValue('#raise-amount'), '55', where('the half-typed bet was lost to a line of chat'));
        assert.deepEqual(await inTheAir(moving), air(10, 0), where('a line of chat'));

        // A tap on a phone and a key on the desktop play the move with the cards still in the air
        if (layout.screen === 'desktop') {
          await moving.locator('#raise-amount').blur();
          await settle(moving);
          await moving.keyboard.press('c');
        } else {
          await press('.turn [data-action="raise"]');
        }
        await moving.waitForSelector('.seat.acting[data-seat="1"]');
        assert.equal(table.view('Quigs').seats[0]!.bet, layout.screen === 'desktop' ? 20 : 55, where('the move did not reach the table'));
        await shown();
        assert.deepEqual(await inTheAir(moving), air(1, 0), where('the viewer’s bet slides alone, and nothing of the deal is left'));

        // Each fold takes the place of the one in the air before it
        for (const name of ['Stu', 'Pam']) {
          table.act(name, { type: 'fold' });
          await shown();
          assert.deepEqual(await inTheAir(moving), air(1, 1), where(`${name}’s fold`));
        }

        // A stand-in is drawn from the theme as what it stands in for is: here two cards face down, on their way to the middle
        if (layout.screen === 'desktop') {
          for (const theme of THEMES) {
            await moving.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme.id)}`);
            await shot(moving, `motion-held-fold-theme-${theme.id}`);
          }
          await moving.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(THEMES[0]!.id)}`);
        }

        // The bets on their way to the pot as the flop comes: Pam's blind with them, though she folded
        table.act('Al', passive(table.view('Al')));
        await shown();
        assert.deepEqual(await inTheAir(moving), air(6, 3), where('the end of the street'));
        await shot(moving, `motion-held-flop-${layout.name}`);

        if (!layout.height) {
          // A page put out of sight, as by another tab, would hold what is in the air until it came back
          await moving.evaluate(SIGHT);
          await moving.evaluate('window.outOfSight(true)');
          assert.deepEqual(await inTheAir(moving), still, where('the page out of sight'));
          await moving.evaluate('window.outOfSight(false)');
          await assertAsStill(moving, unmoved, where('the page out of sight'));
        } else {
          // A keyboard opening squeezes the table and a turned phone lays it down: either way what was in the air is gone at once
          for (const page of [moving, unmoved]) {
            await page.addStyleTag({ content: `.stage { height: ${layout.height - 40}px !important; }` });
          }
          await dealt(moving);
          assert.deepEqual(await inTheAir(moving), still, where('the table squeezed'));
          await assertAsStill(moving, unmoved, where('the table squeezed'));

          // And the next thing to happen moves as ever
          table.act('Al', { type: 'raise', to: 40 });
          await shown();
          assert.deepEqual(await inTheAir(moving), air(1, 0), where('a bet after the squeeze'));

          for (const page of [moving, unmoved]) {
            await page.setViewportSize({ width: SCREENS.phoneSideways.width, height: layout.height + 600 });
            await page.waitForSelector('.table.wide');
          }
          await dealt(moving);
          assert.deepEqual(await inTheAir(moving), still, where('the phone turned'));
          await assertAsStill(moving, unmoved, where('the phone turned'));
        }

        await flown(moving);
        await assertAsStill(moving, unmoved, where('landed'));

        // The last hand of the night is won, and the felt comes to say the night is over with the pot still on its way
        table.act('Quigs', { type: 'setLastHands', hands: 0 });
        const done = table.play(passive, (view) => view.hand?.stage === 'done');
        await shown();
        assert.ok((await inTheAir(moving)).standIns > 0, where('the last pot is not in the air'));

        rig.advance(done.hand!.deadline! - rig.now());
        for (const page of [moving, unmoved]) {
          await page.waitForSelector('.message.night-over');
        }
        assert.deepEqual(await inTheAir(moving), still, where('the night over'));
        await assertAsStill(moving, unmoved, where('the night over'));
        await shot(moving, `motion-held-night-over-${layout.name}`);

        await moving.context().close();
        await unmoved.context().close();
      }
    },
  ],
  [
    'animations are on for a new player, off for one who switched them off and for a device that asks for less motion, and the switch says which',
    async (rig) => {
      const table = rig.table(MOTION_PLAYERS);
      const page = await table.open('Quigs', 'phone', MOTION, { moving: true });
      const kept = await table.open('Stu', 'phone', MOTION);
      const press = pressOn(page, 'phone');
      const shown = (on: Page = page) => caughtUp(on, table.view('Quigs'));
      const moved = async (on: Page = page) => (await flown(on)).length;

      const preferences = async () => {
        await press('[data-action="menu"]');
        await press('.menu [data-action="preferences"]');
        await page.waitForSelector('#pref-motion');
        await page.locator('#pref-motion').scrollIntoViewIfNeeded();
      };

      table.deal({ button: 3 });
      await shown();
      await shown(kept);
      assert.equal(await moved(), 10, 'a new player sees the blinds slide in and the cards dealt');
      assert.equal(await moved(kept), 0, 'a page the rig keeps still moved');
      assert.equal(await kept.evaluate(`localStorage.getItem('cnd.motion')`), 'off');
      await kept.context().close();

      await preferences();
      assert.equal(await page.getAttribute('#pref-motion', 'aria-checked'), 'true');
      assert.match(await text(page, '#pref-motion'), /^Animations\s*Cards are dealt around the table and chips slide to the pot$/);
      assertOnScreen(await boxes(page, '#pref-motion'), 'phone', 'the switch for animations');
      assert.deepEqual(await squeezed(page, '#pref-motion, #pref-motion span'), [], 'the switch for animations is cut off');
      await shot(page, 'preferences-motion-phone');

      await press('#pref-motion');
      await page.waitForSelector('#pref-motion[aria-checked="false"]');
      assert.equal(await page.evaluate(`localStorage.getItem('cnd.motion')`), 'off');
      await press('[data-action="close"]');

      table.act('Pam', { type: 'raise', to: 60 });
      await shown();
      assert.equal(await moved(), 0, 'a bet moved with animations switched off');

      await preferences();
      await press('#pref-motion');
      await page.waitForSelector('#pref-motion[aria-checked="true"]');
      await press('[data-action="close"]');

      table.act('Al', { type: 'fold' });
      await shown();
      assert.equal(await moved(), 1, 'a fold did not move with animations switched back on');

      // The device's own setting wins, and leaves the player's choice as it was for when the device stops asking
      await page.emulateMedia({ reducedMotion: 'reduce' });
      table.act('Quigs', { type: 'call' });
      await shown();
      assert.equal(await moved(), 0, 'a call moved on a device that asks for less motion');

      await preferences();
      await page.waitForSelector('#pref-motion[aria-disabled="true"][aria-checked="false"]');
      assert.match(await text(page, '#pref-motion'), /Off while this device asks for less motion/);
      await page.tap('#pref-motion', { force: true });
      assert.equal(await page.getAttribute('#pref-motion', 'aria-checked'), 'false', 'the switch turned on against the device');
      assert.equal(await page.evaluate(`localStorage.getItem('cnd.motion')`), 'on', 'the player’s own choice was lost');
      assert.deepEqual(await squeezed(page, '#pref-motion, #pref-motion span'), [], 'the switch that cannot be turned on is cut off');
      await shot(page, 'preferences-motion-reduced-phone');
      await press('[data-action="close"]');

      await page.emulateMedia({ reducedMotion: 'no-preference' });
      table.act('Stu', { type: 'call' });
      await shown();
      assert.equal(await moved(), 6, 'the bets did not go to the pot, or the flop did not come, once the device stopped asking');
      await page.context().close();
    },
  ],
  [
    'animations start in the frame their sound does: the deal at once, a street a beat after what is heard before it, and a street on two boards with the one sound of the two',
    async (rig) => {
      /**
       * What a view set moving on Stu's page and what it played, since the last look. Whatever is heard
       * and seen was set off in one frame, and the first card of each board starts when its sound does.
       */
      const watcher = async (table: RigTable) => {
        const page = await table.open('Stu', 'desktop', [LISTEN, MOTION].join(';'), { moving: true });
        let listened = 0;

        return {
          page,
          look: async (what: string) => {
            await caughtUp(page, table.view('Stu'));

            const flights = await flown(page);
            const names = await playedNames(page, listened);
            const starts = (await playedAt(page)).slice(listened);
            const frames = ((await page.evaluate('window.played')) as { frame: number }[]).slice(listened).map((sound) => sound.frame);
            const heard = names.map((sound, nth) => ({ sound, frame: frames[nth]!, after: Math.round((starts[nth]! - starts[0]!) * 1000) }));
            const boards = [...new Set(flights.flatMap((flight) => (flight.board === null ? [] : [flight.board])))].sort();
            const firstOf = (these: Flight[]) => these.reduce((first, flight) => (flight.delay < first.delay ? flight : first));
            const streets = boards.map((board) => firstOf(flights.filter((flight) => flight.board === board)));
            const street = heard.find(({ sound }) => sound === 'street');

            listened += names.length;

            for (const card of streets) {
              assert.equal(card.frame, street?.frame, `${what}: board ${card.board} was not set off in the frame its sound was`);
              // Sounds keep their gap by the clock and moves by the frame they start in, so the two agree to within a frame
              assert.ok(Math.abs(card.delay - street!.after) < 17, `${what}: board ${card.board} is seen ${card.delay} ms after the view and heard ${street!.after} ms after it`);
            }

            return { flights, heard: heard.map(({ sound, after }) => [sound, Math.round(after / STEP_GAP_MS)]), streets: streets.map((card) => [card.board, card.delay]), firstOf };
          },
        };
      };

      // A bomb pot on one board: the deal at once, and the flop a beat later
      let table = rig.table(MOTION_PLAYERS);
      let { page, look } = await watcher(table);

      table.act('Quigs', { type: 'setBombPot', on: true });
      table.deal({ button: 3, board: '2c 7d 9h Jc 3s' });

      let seen = await look('a bomb pot');
      const deal = seen.firstOf(seen.flights.filter((flight) => flight.what === 'card' && flight.seat !== null));

      assert.deepEqual(seen.heard, [['deal', 0], ['street', 1]]);
      assert.equal(deal.delay, 0, 'the deal waits');
      assert.equal(deal.frame, seen.flights.find((flight) => flight.board !== null)!.frame, 'the deal and the flop were not set off together');
      assert.deepEqual(seen.streets, [[0, STEP_GAP_MS]]);
      await page.context().close();

      // On two boards the flops are one sound and land together
      table = rig.table(MOTION_PLAYERS, { bombPotBoards: 'two' });
      ({ page, look } = await watcher(table));

      table.act('Quigs', { type: 'setBombPot', on: true });
      table.deal({ button: 3, board: '2c 7d 9h Jc 3s', secondBoard: 'Kd 5c 8h Ts 2h' });
      seen = await look('a double-board bomb pot');
      assert.deepEqual(seen.heard, [['deal', 0], ['street', 1]]);
      assert.deepEqual(seen.streets, [[0, STEP_GAP_MS], [1, STEP_GAP_MS]]);

      // Checked around to the button, whose check Stu hears as a knock: the turn of both boards comes with the street's sound, a beat after it
      for (const name of ['Quigs', 'Stu', 'Pam']) {
        table.act(name, { type: 'check' });
      }
      await look('checks');
      table.act('Al', { type: 'check' });
      seen = await look('the turn of two boards');
      assert.deepEqual(seen.heard.slice(0, 2), [['knock', 0], ['street', 1]]);
      assert.deepEqual(seen.streets, [[0, STEP_GAP_MS], [1, STEP_GAP_MS]]);

      // Stu's own call is silent to him, so when it ends the street the river of both comes at once, with the bets going to the pot
      table.act('Quigs', { type: 'check' });
      table.act('Stu', { type: 'check' });
      table.act('Pam', { type: 'raise', to: 40 });
      table.act('Al', { type: 'fold' });
      table.act('Quigs', { type: 'fold' });
      await look('a bet and two folds');
      table.act('Stu', { type: 'call' });
      seen = await look('the river of two boards');
      assert.deepEqual(seen.heard[0], ['street', 0]);
      assert.deepEqual(seen.streets, [[0, 0], [1, 0]]);
      assert.equal(seen.flights.filter((flight) => flight.what === 'chips' && flight.delay === 0).length, 2, 'the two bets go to the pot as the river comes');
      await page.context().close();

      // A hand run twice is dealt a street at a time, a board after the other: each card lands as its own street is heard
      table = rig.table(MOTION_PLAYERS.slice(0, 2), { allowRunItTwice: true });
      ({ page, look } = await watcher(table));

      table.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kc' }, board: '3c 8d Jh Qs 4d', secondBoard: '2c 5h 9s Td 6c' });
      table.play(allIn, (view) => view.hand?.stage === 'runout');
      // With every chip in before the flop, the table has no more on it than before the deal but the cards
      await page.waitForSelector('.seat[data-seat="0"] .hole .card[data-card]');
      await look('all in');

      const streets: unknown[] = [];
      for (let street = 0; street < 7 && table.view('Stu').hand!.stage === 'runout'; street++) {
        rig.advance(table.view('Stu').hand!.deadline! - rig.now());
        seen = await look(`street ${street} of a hand run twice`);
        assert.equal(seen.heard[0]![0], 'street');
        streets.push(...seen.streets);
      }

      assert.deepEqual(streets, [[0, 0], [0, 0], [0, 0], [1, 0], [1, 0], [1, 0]], 'each street of a hand run twice, on its own board');
      await page.context().close();
    },
  ],
  [
    'a player who owes blinds is offered to post them or to wait for the big blind, the bar says what happens next, and every seat shows who is waiting',
    async (rig) => {
      for (const kind of MISSED_BLIND_TABLES) {
        for (const screen of ['smallPhone', 'desktop'] as const) {
          const table = blindsOwed(rig, kind);
          const page = await table.open(MARGE, screen);
          const other = await table.open('Stu', screen);
          const press = pressOn(page, screen);
          const statuses = async () => [await text(page, '.seat[data-seat="3"] .status'), await text(other, '.seat[data-seat="3"] .status')];
          const said = (words: string) => page.waitForSelector(`.controls .owed-note:has-text("${words}")`);

          const lookInShapes = (name: string) =>
            inShapesOf(
              page,
              screen,
              async (shape) => {
                await assertOwedBarFits(page, screen);

                const buttons = await boxes(page, '.controls .extras button');
                buttons.forEach((button, index) => assertApart([button], buttons.slice(index + 1), 'two buttons under the table'));
                await assertNoSidewaysScroll(page);
                await shot(page, `missed-blinds-${name}-${kind.name}-${screen}-${shape}`);
              },
              { buttonsUp: false },
            );

          // Sitting out and owing: the one button that brings a player back is two, one for each way to settle
          assert.equal(await text(page, '.controls .waiting'), `The game is pausedYou owe ${kind.both} for the blinds you missed`);
          assert.deepEqual(await texts(page, '.controls .extras [data-action="wait-for-blind"], .controls .extras [data-action="post-blinds"]'), ['Wait for big blind', `Post ${kind.both} and play`]);
          assert.equal(await page.locator('.controls [data-action="sit-in"], .controls [data-action="sit-out"]').count(), 0);
          assert.deepEqual(await statuses(), ['Sitting out', 'Sitting out']);
          await lookInShapes('choice');

          // Between the button and the big blind of the next hand, so posting waits for the button to pass
          await press('.controls [data-action="post-blinds"]');
          await said('once the button has passed you');
          assert.equal(await text(page, '.controls .owed-note'), `You post ${kind.both} and are dealt in once the button has passed you`);
          assert.deepEqual(await texts(page, '.controls .extras [data-action="wait-for-blind"]'), ['Wait for big blind']);
          assert.equal(await page.locator('.controls [data-action="post-blinds"], .controls [data-action="sit-in"]').count(), 0);
          assert.equal(await page.locator('.controls [data-action="sit-out"]').count(), 1, 'a player back in the game is not offered to sit out again');
          await other.waitForSelector('.seat[data-seat="3"] .status:has-text("Waiting to post")');
          assert.deepEqual(await statuses(), ['Waiting to post', 'Waiting to post']);
          await lookInShapes('after-the-button');

          // That hand is dealt without her, and the one after is hers to post in
          table.dealNext();
          await said('next hand');
          assert.equal(await text(page, '.controls .waiting'), `Waiting for Quigs\nYou post ${kind.both} and are dealt in next hand`.replace('\n', ''));
          assert.equal(await page.locator('.seat.me .hole .card').count(), 0);
          await lookInShapes('posting-next');

          // Waiting instead, which is what coming back does unless she says otherwise
          await press('.controls [data-action="wait-for-blind"]');
          await said('reaches you');
          assert.equal(await text(page, '.controls .owed-note'), 'You are dealt in when the big blind reaches you');
          assert.deepEqual(await texts(page, '.controls .extras [data-action="post-blinds"]'), [`Post ${kind.both} instead`]);
          await other.waitForSelector('.seat[data-seat="3"] .status:has-text("Waiting for BB")');
          assert.deepEqual(await statuses(), ['Waiting for BB', 'Waiting for BB']);
          assert.equal(table.view('Quigs').seats[3]!.comesIn, 'big blind');
          await lookInShapes('waiting');

          assert.deepEqual(await squeezed(other, '.seat .plate .status'), [], 'what a seat says is cut off for another player');
          await shot(other, `missed-blinds-waiting-seen-${kind.name}-${screen}`);

          await page.context().close();
          await other.context().close();
        }
      }
    },
  ],
  [
    'what a player owes shares the bar with the count of the last hands and word of a bomb pot, each at its longest and whole, on the smallest phone',
    async (rig) => {
      const longest = {
        ...MISSED_BLIND_TABLES[1]!,
        config: { ...CENTS, smallBlind: 50_000, bigBlind: 100_000, bombPotAmount: 999_999, bombPotBoards: 'two' } as Partial<TableConfig>,
        stack: 10_000_000,
      };
      const owed = '1,500.00';
      const bombPot = 'Next hand is a double-board bomb pot: 9,999.99 each';
      const screen = 'smallPhone';

      const table = blindsOwed(rig, longest);
      table.act('Quigs', { type: 'setLastHands', hands: LIMITS.lastHands });
      table.act('Quigs', { type: 'setBombPot', on: true });

      const page = await table.open(MARGE, screen);
      const press = pressOn(page, screen);

      const look = async (name: string, says: { hands: string; note: string; buttons: string[] }) => {
        await page.waitForSelector(`.controls .owed-note:has-text("${says.note}")`);
        assert.deepEqual(await texts(page, '.controls .next-hand span'), [says.hands, bombPot]);
        assert.equal(await text(page, '.controls .owed-note'), says.note);
        assert.deepEqual(await texts(page, '.controls .extras button'), says.buttons);

        await inShapesOf(
          page,
          screen,
          async (shape) => {
            await assertNextHandsFit(page, screen, 'player who owes');
            await assertOwedBarFits(page, screen);
            assertApart(await boxes(page, '.controls .owed-note'), await boxes(page, '.controls .next-hand span'), 'what is owed and word of the hands to come');

            const buttons = await boxes(page, '.controls .extras button');
            buttons.forEach((button, index) => assertApart([button], buttons.slice(index + 1), 'two buttons under the table'));
            await assertNoSidewaysScroll(page);
            await shot(page, `missed-blinds-with-last-hands-${name}-${shape}`);
          },
          { buttonsUp: false },
        );
      };

      // Back from sitting out, with the choice to make
      await look('choice', { hands: `${LIMITS.lastHands} more hands to play`, note: `You owe ${owed} for the blinds you missed`, buttons: ['Wait for big blind', `Post ${owed} and play`, 'Straddle', 'Add chips'] });

      // Set to post from where the button has yet to pass: the longest thing the bar says about blinds
      await press('.controls [data-action="post-blinds"]');
      await look('after-the-button', { hands: `${LIMITS.lastHands} more hands to play`, note: `You post ${owed} and are dealt in once the button has passed you`, buttons: ['Sit out next hand', 'Wait for big blind', 'Straddle', 'Add chips'] });

      // A hand is on without her, and the one after it is the bomb pot, which has no blinds for her to post
      table.act('Quigs', { type: 'setBombPot', on: false });
      table.dealNext();
      table.act('Quigs', { type: 'setLastHands', hands: LIMITS.lastHands });
      table.act('Quigs', { type: 'setBombPot', on: true });
      await page.waitForSelector('.controls .waiting:has-text("Waiting for ")');
      await look('during-a-hand', { hands: `${LIMITS.lastHands} more hands after this one`, note: `You post ${owed} in the hand after the bomb pot`, buttons: ['Sit out next hand', 'Wait for big blind', 'Straddle', 'Add chips'] });

      // The night ends with her still owing. Nothing is charged or forgiven: the bar has no hand to speak of, and her seat still says she is waiting
      playOut(table);
      table.act('Quigs', { type: 'endNight' });
      await page.waitForSelector('.message.night-over');
      await page.waitForSelector('.controls .owed-note', { state: 'detached' });
      assert.equal(await text(page, '.controls .waiting'), 'The night is over');
      assert.equal(await page.locator('.controls .extras button').count(), 0);
      assert.equal(await text(page, '.seat.me .status'), 'Waiting to post');
      assert.deepEqual([table.view(MARGE).seats[3]!.owesBigBlind, table.view(MARGE).seats[3]!.owesSmallBlind], [true, true]);
      await shot(page, 'missed-blinds-night-over');

      // Play starts again where it stopped, for her too
      table.act('Quigs', { type: 'playOn' });
      await page.waitForSelector(`.controls .owed-note:has-text("You post ${owed} and are dealt in next hand")`);
      assert.deepEqual(await texts(page, '.controls .extras button'), ['Sit out next hand', 'Wait for big blind', 'Straddle', 'Add chips']);
      assert.equal(await text(page, '.seat.me .status'), 'Waiting to post');
      await assertOwedBarFits(page, screen);

      await page.context().close();
    },
  ],
  [
    'a hand with a missed big blind and a dead small blind shows both on the felt, in the play-by-play and in the hand history, and gives their player the option',
    async (rig) => {
      for (const kind of MISSED_BLIND_TABLES) {
        for (const screen of ['smallPhone', 'desktop'] as const) {
          const table = blindsOwed(rig, kind);
          const [bigBlind, firstToAct, second] = LONG_NAMES;

          // The button passes Marge in the first of these, and she posts in the second: the button on seat 4, the blinds on seats 5 and 0
          table.act(MARGE, { type: 'comeIn', post: true });
          table.dealNext();
          playOut(table);
          table.dealNext({ holes: { 0: 'Ks Kh', 3: 'As Ah' }, board: '2c 7d 9h Jc 3s' });

          const lines = [
            `Hand #123 · blinds ${kind.blinds} · Stu has the button`,
            `${MARGE} posts missed big blind ${kind.big}`,
            `${MARGE} posts dead small blind ${kind.small}`,
            `Big Al posts small blind ${kind.small}`,
            `${bigBlind} posts big blind ${kind.big}`,
          ];

          const page = await table.open(firstToAct!, screen);
          const press = pressOn(page, screen);

          // Her big blind is in front of her like the real one, her small blind is in the pot with no bet to show for it, and the action starts left of the real big blind
          assert.deepEqual(await texts(page, '.bet'), [kind.big, kind.big, kind.small]);
          assert.equal(await text(page, '.pot'), `Pot${kind.pot}`);
          assert.equal(await text(page, '.seat[data-seat="3"] .status'), 'Missed BB');
          assert.equal(await page.locator('.seat[data-seat="4"] .dealer-button').count(), 1);
          assert.equal(await page.locator('.seat.acting').getAttribute('data-seat'), '1');
          assert.equal(await text(page, '.turn [data-action="call"]'), `Call ${kind.big}`);

          await inShapesOf(page, screen, async (shape) => {
            assert.deepEqual(await squeezed(page, '.pot, .bet, .plate .stack, .plate .status'), [], 'an amount or a status on the table is cut off');
            assertOnScreen(await boxes(page, '.seat .plate, .bet, .pot'), screen, 'a seat, a bet or the pot');
            await assertBetsApart(page);
            await shot(page, `missed-blinds-hand-${kind.name}-${screen}-${shape}`);
          });

          await toggleFeed(page, screen);
          const said = await texts(page, '.entries li');
          const from = said.indexOf(lines[0]!);
          assert.deepEqual(said.slice(from, from + lines.length), lines);
          assert.deepEqual(await squeezed(page, '.entries li'), [], 'a line of the play-by-play is cut off');
          await assertNoSidewaysScroll(page);
          await shot(page, `missed-blinds-play-by-play-${kind.name}-${screen}`);
          await toggleFeed(page, screen);

          // With nothing to call she may still raise: the big blind in front of her is a bet she has not acted on
          table.act(firstToAct!, { type: 'fold' });
          table.act(second!, { type: 'fold' });
          const hers = await table.open(MARGE, screen);
          assert.equal(await text(hers, '.turn [data-action="check"]'), 'Check');
          assert.equal(await text(hers, '.turn [data-action="raise"]'), `Raise to ${kind.raiseTo}`);
          assert.equal(await text(hers, '.pot'), `Pot${kind.pot}`);
          await shot(hers, `missed-blinds-option-${kind.name}-${screen}`);
          await hers.context().close();

          playOut(table);
          await press('[data-action="menu"]');
          await press('.menu [data-action="history"]');
          await page.waitForSelector('.history summary');
          assert.match(await text(page, '.history summary'), new RegExp(`^Hand #123${MARGE} \\+`));
          await press('.history summary');
          assert.deepEqual((await text(page, '.history pre')).split('\n').slice(0, lines.length), lines);
          assert.deepEqual(await squeezed(page, '.history summary'), [], 'the hand\'s line in the history is cut off');
          await shot(page, `missed-blinds-history-${kind.name}-${screen}`);

          await page.context().close();
        }
      }
    },
  ],
  [
    'a player who sits down while a game is going waits for the big blind or posts one, and their seat says which',
    async (rig) => {
      for (const kind of MISSED_BLIND_TABLES) {
        for (const screen of PHONE_AND_DESKTOP) {
          const table = rig.table(
            ['Quigs', 'Stu', 'Pocket Pam', 'Big Al'].map((name) => ({ name, stack: kind.stack })),
            kind.config,
          );
          table.deal({ button: 0 });
          table.join(MARGE);

          const page = await table.open(MARGE, screen);
          const other = await table.open('Stu', 'phone');
          const press = pressOn(page, screen);
          table.seat(MARGE, 6, kind.stack);

          const look = async (name: string) => {
            await assertOwedBarFits(page, screen);
            await shot(page, `missed-blinds-newcomer-${name}-${kind.name}-${screen}`);
          };

          // Sat down between hands of a game, she owes a big blind and waits for it unless she says otherwise
          await page.waitForSelector('.controls .owed-note');
          assert.equal(await text(page, '.controls .owed-note'), 'You are dealt in when the big blind reaches you');
          assert.deepEqual(await texts(page, '.controls .extras [data-action="post-blinds"]'), [`Post ${kind.big} instead`]);
          assert.equal(await text(page, '.seat.me .status'), 'Waiting for BB');
          await other.waitForSelector('.seat[data-seat="6"] .status:has-text("Waiting for BB")');
          await look('waiting');

          await press('.controls [data-action="post-blinds"]');
          await page.waitForSelector('.controls .owed-note:has-text("next hand")');
          assert.equal(await text(page, '.controls .owed-note'), `You post ${kind.big} and are dealt in next hand`);
          await other.waitForSelector('.seat[data-seat="6"] .status:has-text("Waiting to post")');
          await look('posting');

          // In for a big blind that plays, and no small blind: she never had the big blind before it
          playOut(table);
          table.dealNext();
          await page.waitForSelector('.seat.me .hole .card');
          assert.deepEqual(await texts(page, '.bet'), [kind.small, kind.big, kind.big]);
          assert.equal(await page.locator('.controls .owed-note').count(), 0);
          assert.ok(table.view('Quigs').feed.some((entry) => entry.text === `${MARGE} posts missed big blind ${kind.big}`));
          assert.ok(!table.view('Quigs').feed.some((entry) => entry.text.includes('dead small blind')));
          await assertBetsApart(page);
          await look('dealt-in');

          await page.context().close();
          await other.context().close();
        }
      }
    },
  ],
  [
    'the host forgives a player the blinds they missed from the Players dialog, and the player is simply back',
    async (rig) => {
      for (const kind of MISSED_BLIND_TABLES) {
        for (const screen of PHONE_AND_DESKTOP) {
          const table = blindsOwed(rig, kind);
          const page = await table.open('Quigs', screen);
          const hers = await table.open(MARGE, 'phone');
          const press = pressOn(page, screen);
          // Hers is the one line that says anything is owed
          const row = '.rows li:has(.owes-note)';

          await press('[data-action="menu"]');
          await press('.menu [data-action="players"]');
          await page.waitForSelector(row);

          // Only the player who owes has anything to forgive
          assert.match(await text(page, `${row} > span`), new RegExp(`^${MARGE} · seat 4 · `));
          assert.equal(await text(page, `${row} .owes-note`), 'Owes the big blind and the small blind');
          assert.deepEqual(await texts(page, '.dialog [data-action="forgive-blinds"]'), ['Forgive blinds']);
          assert.equal(await page.locator(`${row} [data-action="forgive-blinds"]`).count(), 1);
          await page.locator(row).scrollIntoViewIfNeeded();
          assert.deepEqual(await squeezed(page, `${row} > span, ${row} .owes-note, ${row} button`), [], 'part of her line in the list is cut off');
          assertOnScreen(await boxes(page, `.dialog, ${row}, ${row} button`), screen, 'her line in the list of players');
          await assertNoSidewaysScroll(page);
          await shot(page, `missed-blinds-forgive-${kind.name}-${screen}`);

          await press(`${row} [data-action="forgive-blinds"]`);
          await page.waitForSelector('.dialog [data-action="forgive-blinds"]', { state: 'detached' });
          assert.equal(await page.locator('.dialog .owes-note').count(), 0);
          assert.equal(table.view('Stu').feed.at(-1)!.text, `The host forgave ${MARGE} the blinds they missed`);

          // Owing nothing, she is offered the one way back that anyone sitting out is
          await hers.waitForSelector('.controls [data-action="sit-in"]');
          assert.equal(await hers.locator('.controls .owed-note, .controls [data-action="post-blinds"], .controls [data-action="wait-for-blind"]').count(), 0);

          await page.context().close();
          await hers.context().close();
        }
      }
    },
  ],
  [
    'the table settings and the form for a new table take whether missed blinds are owed or forgiven, and forgiving them clears what is owed',
    async (rig) => {
      for (const kind of MISSED_BLIND_TABLES) {
        for (const screen of ['smallPhone', 'desktop'] as const) {
          const table = blindsOwed(rig, kind);
          const page = await table.open('Quigs', screen);
          const press = pressOn(page, screen);
          const picked = (value: string) => page.isChecked(`#table-missed-blinds input[value="${value}"]`);
          const openSettings = async () => {
            await press('[data-action="menu"]');
            await press('.menu [data-action="settings"]');
            await page.waitForSelector('#table-missed-blinds');
          };

          await openSettings();
          assert.equal(await picked('owed'), true, 'missed blinds are owed unless the host says otherwise');
          assert.equal(await text(page, '#table-missed-blinds > span'), 'Missed blinds');
          assert.deepEqual(await texts(page, '#table-missed-blinds .check'), ['Owed', 'Forgiven']);
          assert.equal(await text(page, '#table-missed-blinds small'), 'Owed: a player the blinds pass while sitting out posts them to come back, or waits for the big blind');

          await page.locator('#table-missed-blinds').scrollIntoViewIfNeeded();
          assert.deepEqual(await squeezed(page, '#table-missed-blinds .check span, #table-missed-blinds > span, #table-missed-blinds small'), [], 'part of the settings is cut off');
          assertOnScreen(await boxes(page, '.dialog, #table-missed-blinds, #table-missed-blinds .check'), screen, 'missed blinds in the settings');
          const [owed, forgiven] = await boxes(page, '#table-missed-blinds .check');
          assert.ok(owed && forgiven && !overlap(owed, forgiven), 'the two choices are drawn over each other');
          await assertNoSidewaysScroll(page);

          await press('#table-missed-blinds label:has-text("Forgiven")');
          await shot(page, `missed-blinds-settings-${kind.name}-${screen}`);
          await press('[data-action="save-settings"]');
          await page.waitForSelector('.dialog', { state: 'detached' });

          const seen = table.view('Stu');
          assert.equal(seen.feed.at(-1)!.text, 'Missed blinds are forgiven: nobody owes any');
          assert.deepEqual([seen.config.missedBlinds, seen.seats[3]!.owesBigBlind, seen.seats[3]!.owesSmallBlind], ['forgiven', false, false]);

          await openSettings();
          assert.equal(await picked('forgiven'), true);
          await page.context().close();
        }
      }

      for (const screen of PHONE_AND_DESKTOP) {
        const page = await rig.lobby(screen);
        const press = pressOn(page, screen);

        assert.equal(await page.isChecked('#new-table-missed-blinds input[value="owed"]'), true);
        await page.fill('#host-name', 'Quigs');
        await press('#new-table-missed-blinds label:has-text("Forgiven")');

        await page.locator('#new-table-missed-blinds').scrollIntoViewIfNeeded();
        assert.deepEqual(await squeezed(page, '#new-table-missed-blinds .check span, #new-table-missed-blinds > span, #new-table-missed-blinds small'), [], 'part of the form is cut off');
        assertOnScreen(await boxes(page, '#new-table-missed-blinds, #new-table-missed-blinds .check'), screen, 'missed blinds in the form for a new table');
        await assertNoSidewaysScroll(page);
        await shot(page, `missed-blinds-new-table-${screen}`);

        await press('[data-action="create-table"]');
        await page.waitForSelector('#table-link');
        assert.equal(rig.store.read(new URL(await page.inputValue('#table-link')).searchParams.get('table')!)!.config.missedBlinds, 'forgiven');

        await page.context().close();
      }
    },
  ],
  [
    'a dead button sits on the seat it is due on though nobody is in it, and a hand with no small blind says so in the play-by-play',
    async (rig) => {
      for (const screen of ['smallPhone', 'desktop'] as const) {
        const table = rig.table(['Quigs', 'Stu', 'Pocket Pam', 'Big Al'].map((name) => ({ name, stack: 1000 })));
        table.alter((state) => {
          state.handCount = 121;
        });
        table.deal({ button: 0 });
        playOut(table);

        // Pam had the big blind and leaves: the small blind is due on her seat next, and the button the hand after
        table.act('Pocket Pam', { type: 'standUp' });
        table.dealNext();

        const page = await table.open('Quigs', screen);
        const saidFrom = async (first: string, count: number) => {
          await toggleFeed(page, screen);
          const said = await texts(page, '.entries li');
          await toggleFeed(page, screen);

          return said.slice(said.indexOf(first), said.indexOf(first) + count);
        };

        const noSmallBlind = ['Hand #123 · blinds 10/20 · Stu has the button', 'No small blind this hand', 'Big Al posts big blind 20'];
        assert.deepEqual(await saidFrom(noSmallBlind[0]!, 3), noSmallBlind);
        assert.deepEqual(await texts(page, '.bet'), ['20']);
        assert.equal(await page.locator('.seat[data-seat="1"] .dealer-button').count(), 1);
        await shot(page, `missed-blinds-no-small-blind-${screen}`);

        // Folded to, the big blind was the only chips in the hand, so the felt says how it ended and not what was won
        table.act('Quigs', { type: 'pause' });
        table.play(folding, (view) => view.hand!.stage === 'done');
        await page.waitForSelector('.message.result > div');
        assert.deepEqual(await texts(page, '.message.result > div'), ['Everyone folded to Big Al']);
        assert.deepEqual((await saidFrom('Uncalled bet of 20 returned to Big Al', 2)), ['Uncalled bet of 20 returned to Big Al', 'Everyone folded to Big Al']);
        await shot(page, `missed-blinds-folded-to-the-big-blind-${screen}`);

        table.play(folding, (view) => view.hand === null);
        table.dealNext();
        await page.waitForSelector('[data-open-seat="2"] .dealer-button');

        const deadButton = ['Hand #124 · blinds 10/20 · dead button on seat 3', 'Big Al posts small blind 10', 'Quigs posts big blind 20'];
        assert.deepEqual(await saidFrom(deadButton[0]!, 3), deadButton);
        assert.equal(await page.locator('.dealer-button').count(), 1);

        await inShapesOf(
          page,
          screen,
          async (shape) => {
            const button = await boxes(page, '.dealer-button');

            assertOnScreen(button, screen, 'the dead button');
            assertApart(button, await boxes(page, '.bet, .board .card, .pot, .seat[data-seat] .plate'), 'the dead button and what is on the table');
            await assertBetsApart(page);
            await shot(page, `missed-blinds-dead-button-${screen}-${shape}`);
          },
          { buttonsUp: false },
        );

        // The hand that was folded to the big blind had no winner, and its line in the history names none
        const press = pressOn(page, screen);
        await press('[data-action="menu"]');
        await press('.menu [data-action="history"]');
        await page.waitForSelector('.history summary');
        assert.equal((await texts(page, '.history summary'))[0], 'Hand #123');

        await page.context().close();
      }

      // With a bounty on, seven-deuce folded to as that big blind collects it, and its seat shows what it took though the hand itself won nothing
      const table = rig.table(['Quigs', 'Stu', 'Pocket Pam', 'Big Al'].map((name) => ({ name, stack: 1000 })), { sevenDeuceBounty: 50 });
      table.deal({ button: 0 });
      playOut(table);
      table.act('Pocket Pam', { type: 'standUp' });
      table.dealNext({ holes: { 3: '7s 2h' } });

      const page = await table.open('Quigs', 'phone');
      table.act('Quigs', { type: 'pause' });
      table.play(folding, (view) => view.hand!.stage === 'done');
      await page.waitForSelector('.message.result > div');
      assert.deepEqual(await texts(page, '.message.result > div'), ['Everyone folded to Big Al', 'Seven-deuce! Big Al collects a 100 bounty']);
      assert.equal(await text(page, '.seat[data-seat="3"] .status.won'), '+100');
      assert.deepEqual(await squeezed(page, '.message.result > div, .seat .plate .status'), [], 'the result or what a seat took is cut off');
      await shot(page, 'missed-blinds-bounty-on-a-lone-big-blind');
      await page.context().close();
    },
  ],
];

await mkdir(OUT, { recursive: true });

const rig = await Rig.start();
const only = process.argv[2];
let failed = 0;

try {
  for (const [name, run] of CHECKS) {
    if (only && !name.includes(only)) {
      continue;
    }

    try {
      await run(rig);
      console.log(`  ok    ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${name}\n${(error as Error).stack}`);
    }
  }

  assert.deepEqual(rig.pageErrors, [], 'a page threw an error');
  assert.equal(failed, 0, `${failed} screen checks failed`);
} finally {
  await rig.close();
}
