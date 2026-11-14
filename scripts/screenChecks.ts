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

import { KEYS_SETTLE_MS } from '../src/client/hotkeys.ts';
import { RECIPES } from '../src/client/soundRecipes.ts';
import { THEMES } from '../src/client/themes.ts';
import type { Command, TableConfig, TableView } from '../src/engine/index.ts';
import { boxes, overlap, Rig, SCREENS, setStageHeight, squeezed, textBoxes } from './rig.ts';
import type { Box, RigPlayer, ScreenName } from './rig.ts';

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
      window.played.push({ gain: this.gain.value, voices: [] });
    }

    return connect.call(this, target, ...rest);
  };

  for (const kind of [OscillatorNode, AudioBufferSourceNode]) {
    const start = kind.prototype.start;
    kind.prototype.start = function (...args) {
      window.played.at(-1).voices.push(this instanceof OscillatorNode ? 'tone ' + this.frequency.value : 'noise');

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

/** Waits for the cards just dealt to land where they will sit. */
const dealt = (page: Page) => page.waitForFunction(`document.getAnimations().every((animation) => animation.animationName !== 'deal')`);

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

type Check = [name: string, run: (rig: Rig) => Promise<void>];

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
      const warnings: string[] = [];
      let heard = 0;

      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          warnings.push(message.text());
        }
      });

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
    'the form for a new table takes the bomb pot settings, and starts the amount over in dollars',
    async (rig) => {
      for (const screen of PHONE_AND_DESKTOP) {
        const page = await rig.lobby(screen);
        const press = pressOn(page, screen);
        const values = async () => [await page.inputValue('#new-table-bomb-pot-amount'), await page.inputValue('#new-table-bomb-pot-every')];

        assert.deepEqual(await values(), ['100', '0']);

        await page.fill('#host-name', 'Quigs');
        await page.fill('#new-table-bomb-pot-amount', '300');
        await page.fill('#new-table-bomb-pot-every', '4');

        // What the table plays with starts the amounts over, the bomb pot among them, and keeps how often one comes
        await press('#new-table-unit label:has-text("Dollars and cents")');
        assert.deepEqual(await values(), ['2.50', '4']);
        await page.fill('#new-table-bomb-pot-amount', '5');

        await page.locator('label[for="new-table-bomb-pot-every"]').scrollIntoViewIfNeeded();
        await shot(page, `bomb-pot-new-table-${screen}`);
        assert.deepEqual(await squeezed(page, 'label[for^="new-table-bomb-pot"] span, label[for^="new-table-bomb-pot"] small, .card-panel .field input'), [], 'part of the form is cut off');
        assertOnScreen(await boxes(page, '#new-table-bomb-pot-amount, #new-table-bomb-pot-every, label[for="new-table-bomb-pot-every"]'), screen, 'the bomb pot in the form for a new table');
        await assertNoSidewaysScroll(page);

        await press('[data-action="create-table"]');
        await page.waitForSelector('#table-link');

        const link = await page.inputValue('#table-link');
        const { unit, bombPotAmount, bombPotEvery } = rig.store.read(new URL(link).searchParams.get('table')!)!.config;
        assert.deepEqual({ unit, bombPotAmount, bombPotEvery }, { unit: 'cents', bombPotAmount: 500, bombPotEvery: 4 });

        await page.context().close();
      }
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
