/*
 * Checks, in real browsers, that the screens hold up where play testing found them breaking: on small
 * phones, with long chat, with the largest stacks, with a result too long for the felt, and under the
 * keyboard. Each check sets its table up on the rig, so the cards and the seats are the same every run.
 * Pictures of what was checked are left in screenshots/.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Page } from 'playwright';

import type { Command, TableView } from '../src/engine/index.ts';
import { boxes, overlap, Rig, SCREENS, squeezed } from './rig.ts';
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
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'the page scrolls sideways');
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
      const table = rig.table([
        { name: 'Quigs', stack: 1_000_000_000 },
        { name: 'Stu', stack: 1_000_000_000 },
        { name: 'Pam', stack: 5000 },
      ]);
      table.deal({ button: 0 });

      const page = await table.open('Quigs', 'phone');
      await page.tap('.presets button:has-text("All in")');

      assert.equal(await text(page, '.turn [data-action="raise"]'), 'All in 1B');
      assert.deepEqual(await squeezed(page, '.turn .btn, #raise-amount'), [], 'a move button or the amount box is cut off');
      assert.equal(await page.inputValue('#raise-amount'), '1000000000');
      await shot(page, 'biggest-all-in-phone');

      // A five-figure raise is the everyday case: its amount must be whole too
      await page.fill('#raise-amount', '12345');
      assert.equal(await text(page, '.turn [data-action="raise"]'), 'Raise to 12,345');
      assert.deepEqual(await squeezed(page, '.turn .btn'), []);

      // Shortened, what a move costs is rounded up: the button never says less than it takes
      await page.fill('#raise-amount', '12340001');
      assert.equal(await text(page, '.turn [data-action="raise"]'), 'Raise to 12.35M');
      await page.fill('#raise-amount', '999999999');
      assert.equal(await text(page, '.turn [data-action="raise"]'), 'Raise to 1B');
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
        const press = (selector: string) => (screen === 'phone' ? page.tap(selector) : page.click(selector));
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
