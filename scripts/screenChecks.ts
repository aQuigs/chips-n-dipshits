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
import type { Command, TableView } from '../src/engine/index.ts';
import { boxes, overlap, Rig, SCREENS, squeezed, textBoxes } from './rig.ts';
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

/** Taps on a touch screen and clicks on the desktop, as the rig opens every screen but the desktop as a touch one. */
const pressOn = (page: Page, screen: ScreenName) => (selector: string) => (screen === 'desktop' ? page.click(selector) : page.tap(selector));

const text = async (page: Page, selector: string) => ((await page.locator(selector).first().textContent()) ?? '').trim();

// Run in the page: counts the notes it plays, since a check cannot listen
const COUNT_NOTES = `(() => {
  const make = AudioContext.prototype.createOscillator;

  window.notesPlayed = 0;
  AudioContext.prototype.createOscillator = function () {
    window.notesPlayed += 1;

    return make.call(this);
  };
})()`;

const CHIME_NOTES = 2;

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

const TO_THE_CENT = 'This table plays to the cent, so an amount has at most two decimals';

const texts = (page: Page, selector: string) => page.locator(selector).allInnerTexts();

const stacksBySeat = (page: Page, seats: number) => Promise.all(Array.from({ length: seats }, (_, seat) => text(page, `.seat[data-seat="${seat}"] .stack`)));

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
    'the Preferences dialog fits a phone and a desktop, keeps the keyboard, and its sound switch is kept and obeyed',
    async (rig) => {
      for (const screen of ['phone', 'desktop'] as const) {
        const table = rig.table([
          { name: 'Quigs', stack: 1000 },
          { name: 'Stu', stack: 1000 },
        ]);
        const page = await table.open('Quigs', screen);
        const press = pressOn(page, screen);
        const notes = () => page.evaluate('window.notesPlayed') as Promise<number>;
        const myTurnOn = (street: string) => (view: TableView) => view.hand!.street === street && view.hand!.toAct === 0;

        await page.addInitScript(COUNT_NOTES);
        await page.evaluate(COUNT_NOTES);

        // Heads-up the button acts first, so the deal puts the action on this page
        table.deal({ button: 0 });
        await page.waitForSelector('.turn [data-action="fold"]:enabled');
        assert.equal(await notes(), CHIME_NOTES, 'the action arriving plays the chime once');

        table.act('Stu', { type: 'chat', text: 'your go' });
        await page.waitForSelector('.entries li:has-text("your go")', { state: 'attached' });
        assert.equal(await notes(), CHIME_NOTES, 'a view that leaves the action where it was chimes again');

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
        assertOnScreen(await boxes(page, '.dialog, #pref-sound'), screen, 'the Preferences dialog');
        assert.deepEqual(await squeezed(page, '.dialog h2, #pref-sound'), [], 'a preference is cut off');
        assert.match(await text(page, '#pref-sound'), /^Sound/);
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
        assert.equal(await notes(), CHIME_NOTES, 'the chime plays with the sound switched off');

        // A page that opens with the action on it chimes, unless the choice was kept
        await page.reload();
        await page.waitForSelector('.turn [data-action="check"]:enabled');
        assert.equal(await notes(), 0, 'the sound came back on with a reload');

        await press('[data-action="menu"]');
        await press('.menu [data-action="preferences"]');
        assert.equal(await page.getAttribute('#pref-sound', 'aria-checked'), 'false', 'the switch forgot it was off');
        await press('#pref-sound');
        await page.waitForSelector('#pref-sound[aria-checked="true"]');
        await press('[data-action="close"]');

        table.play(passive, myTurnOn('turn'));
        await page.waitForSelector('.board .card[data-card]:nth-child(4)');
        await page.waitForSelector('.turn [data-action="check"]:enabled');
        assert.equal(await notes(), CHIME_NOTES, 'switched back on, the chime stays silent');

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
          assert.deepEqual(await page.locator(`${row(name)} button`).allInnerTexts(), name === 'Lurker' ? ['Make co-host', 'Make host', 'Remove'] : ['Set stack', 'Make co-host', 'Make host', 'Remove']);
        }
        assert.deepEqual(await page.locator(`${row('Quigs')} button`).allInnerTexts(), ['Set stack', 'Remove'], 'the host is offered a say over their own role');
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

        await press('[data-action="menu"]');
        const menu = await cohost.locator('.menu .menu-item').evaluateAll((items) => items.map((item) => item.getAttribute('data-action')));
        for (const tool of ['players', 'settings', 'start']) {
          assert.ok(menu.includes(tool), `the co-host's menu has no ${tool}: ${menu.join(', ')}`);
        }

        await press('.menu [data-action="players"]');
        assert.deepEqual(await cohost.locator('.dialog li:has-text("Quigs") button').allInnerTexts(), ['Set stack'], 'a co-host is offered to remove the host');
        assert.deepEqual(await cohost.locator('.dialog li:has-text("Pam") button').allInnerTexts(), ['Set stack', 'Remove']);
        assert.deepEqual(await cohost.locator('.dialog li:has-text("Lurker") button').allInnerTexts(), ['Remove']);
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
          assert.equal(await member.locator('.menu [data-action="players"], .menu [data-action="settings"], .menu [data-action="start"]').count(), 0, 'a plain member is offered the host\'s tools');
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

        const bets = await boxes(page, '.bet');
        assertApart(bets, await textBoxes(page, '.plate .stack, .plate .status'), 'a bet and what a seat says');
        assertApart(bets, await boxes(page, '.board .card, .pot'), 'a bet and the middle of the table');
        assertApart(await boxes(page, '.pot'), await boxes(page, '.seat .plate'), 'the pot and a seat');
        bets.forEach((bet, index) => assertApart([bet], bets.slice(index + 1), 'two bets'));

        await page.context().close();
      }
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

      const openLedger = async (page: Page, screen: ScreenName) => {
        const press = pressOn(page, screen);

        await press('[data-action="menu"]');
        await press('.menu [data-action="ledger"]');
        await page.waitForSelector('.ledger');
      };

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
        assertOnScreen(await boxes(page, '#new-table-unit, #new-table-unit .check, #new-table-small-blind, #new-table-max-buy-in'), screen, 'the form for a new table');
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
