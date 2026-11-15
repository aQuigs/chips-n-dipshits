/*
 * The checks of what the page owes someone who plays by ear or by keyboard: what is said and when,
 * where the keyboard is, what everything is called, and what a rule engine makes of every screen.
 * They run with the other browser checks (`screenChecks.ts`).
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { THEMES } from '../src/client/themes.ts';
import type { Command, TableConfig } from '../src/engine/index.ts';
import { alike, controls, findings, focused, focusIn, heard, SPOKEN, spoken, tree } from './a11y.ts';
import type { Check } from './checkRunner.ts';
import { MOTION, movesSent } from './pageSpies.ts';
import { Gate, SCREENS, setStageHeight } from './rig.ts';
import { tapsLive } from './underTheFinger.ts';
import type { PageOptions, Rig, RigPlayer, RigTable, ScreenName } from './rig.ts';

const THREE: RigPlayer[] = ['Quigs', 'Pam', 'Stu'].map((name) => ({ name, stack: 1000 }));

/** Quigs on the button with aces, Pam in the small blind with kings, Stu in the big blind with nothing, and a board that helps nobody. */
const ACES_OVER_KINGS = { button: 0, holes: { 0: 'As Ah', 1: 'Kd Kc', 2: '7h 2c' }, board: 'Qs Jh 4d 9c 3s' };

/** A table of three at 5/10 with nothing dealt, and Kibitz watching. */
function threeHanded(rig: Rig, config: Partial<TableConfig> = {}): RigTable {
  const table = rig.table(THREE, { name: 'Friday Night', smallBlind: 5, bigBlind: 10, ...config });

  table.join('Kibitz');

  return table;
}

/** A member's page that writes down what it says. `init` runs in it too. */
const listening = (table: RigTable, name: string, screen: ScreenName = 'desktop', init = '', options?: PageOptions): Promise<Page> => table.open(name, screen, `${SPOKEN};${init}`, options);

/** Presses Tab until the keyboard is on what `selector` matches, and fails if it never gets there. */
async function tabTo(page: Page, selector: string, key = 'Tab'): Promise<void> {
  for (let presses = 0; presses < 60; presses++) {
    if (await page.evaluate(`document.activeElement?.matches(${JSON.stringify(selector)}) ?? false`)) {
      return;
    }

    await page.keyboard.press(key);
  }

  assert.fail(`the keyboard never reached ${selector}; it is on ${await focused(page)}`);
}

/** Plays the hand of aces over kings down to the showdown, waiting at each of Quigs's turns for his page to have said so. */
async function playToShowdown(table: RigTable, quigs: Page): Promise<void> {
  table.deal(ACES_OVER_KINGS);
  await heard(quigs, 'alert: Your turn. 10 to call. Pot 15 chips.');
  table.act('Quigs', { type: 'raise', to: 30 });
  table.act('Pam', { type: 'call' });
  table.act('Stu', { type: 'fold' });
  table.act('Pam', { type: 'check' });
  await heard(quigs, 'alert: Your turn. Check or bet. Pot 70 chips.');
  table.act('Quigs', { type: 'raise', to: 50 });
  table.act('Pam', { type: 'call' });
  table.act('Pam', { type: 'check' });
  await heard(quigs, 'alert: Your turn. Check or bet. Pot 170 chips.');

  // The same words on the next street: heard again, since the first
  const turn = table.version;

  table.act('Quigs', { type: 'check' });
  table.act('Pam', { type: 'check' });
  await heard(quigs, 'alert: Your turn. Check or bet. Pot 170 chips.', turn);
  table.act('Quigs', { type: 'check' });
}

/**
 * Lets the cards of an all-in hand come one at a time, as they do at a table, each seen by the page
 * before the next: dealt all at once, the first would reach the page as cards it had missed.
 */
async function runOut(rig: Rig, table: RigTable, page: Page): Promise<void> {
  for (let hand = table.view('Quigs').hand!; hand.stage !== 'done'; hand = table.view('Quigs').hand!) {
    rig.advance(Math.max(1, hand.deadline! - rig.now()));

    const last = table.view('Quigs').feed.at(-1)!.text;
    await page.waitForFunction(`[...document.querySelectorAll('.feed li')].at(-1)?.textContent === ${JSON.stringify(last)}`);
  }
}

const DEAL = ['log: The game is on', 'log: Hand #1 · blinds 5/10 · Quigs has the button', 'log: Pam posts small blind 5', 'log: Stu posts big blind 10'];
const SHOWDOWN = ['log: Pam shows king of diamonds, king of clubs (Pair of kings)', 'log: Quigs shows ace of spades, ace of hearts (Pair of aces)', 'log: Quigs wins 170 with pair of aces'];

/** What the rule engine found over the screens of one check, gathered so that a failure names all of them at once. */
class Sweep {
  private readonly found: string[] = [];
  private screens = 0;

  /**
   * Runs the rule engine over a page in every theme, each as the page would be had its viewer picked it. `without`
   * names rules left out. And holds the page to a rule of this game's own: no two controls alike in a part drawn anew.
   */
  async over(page: Page, where: string, without: string[] = []): Promise<void> {
    const own = await page.evaluate('document.documentElement.dataset.theme');

    this.found.push(...(await alike(page)).map((finding) => `${where}: ${finding}`));

    for (const theme of THEMES) {
      await page.evaluate(`void (document.documentElement.dataset.theme = ${JSON.stringify(theme.id)})`);
      this.found.push(...(await findings(page, { enhancedContrast: theme.id === 'contrast', without })).map((finding) => `${where}, ${theme.name}: ${finding}`));
    }

    await page.evaluate(`void (document.documentElement.dataset.theme = ${JSON.stringify(own)})`);
    this.screens += 1;
  }

  /** Fails with everything found, and with nothing looked at. */
  done(atLeast: number): void {
    assert.ok(this.screens >= atLeast, `the rule engine saw ${this.screens} screens of the ${atLeast} it was to see`);
    assert.deepEqual(this.found, [], `${this.found.length} found over ${this.screens} screens`);
  }
}

export const ACCESSIBILITY_CHECKS: Check[] = [
  [
    'a seated player hears a whole hand once and in order: the deal, their cards, each move, each street as its new card, their turn with what they face, the showdown, who won and what they have',
    async (rig) => {
      const table = threeHanded(rig);
      const page = await listening(table, 'Quigs');
      const start = table.version;

      await playToShowdown(table, page);
      await heard(page, 'log: You have 1,090 chips.', start);

      assert.deepEqual(await spoken(page, start), [
        ...DEAL,
        'log: Your cards: ace of spades, ace of hearts.',
        'alert: Your turn. 10 to call. Pot 15 chips.',
        'log: Quigs raises to 30',
        'log: Pam calls 25',
        'log: Stu folds',
        'log: Flop: queen of spades, jack of hearts, four of diamonds',
        'log: Pam checks',
        'alert: Your turn. Check or bet. Pot 70 chips.',
        'log: Quigs bets 50',
        'log: Pam calls 50',
        'log: Turn: nine of clubs',
        'log: Pam checks',
        'alert: Your turn. Check or bet. Pot 170 chips.',
        'log: Quigs checks',
        'log: River: three of spades',
        'log: Pam checks',
        'alert: Your turn. Check or bet. Pot 170 chips.',
        'log: Quigs checks',
        ...SHOWDOWN,
        'log: You have 1,090 chips.',
      ]);

      // What stands on the table when it is over, for whoever reads it through
      assert.equal(
        await tree(page, '.stage'),
        [
          '- main "The table":',
          '  - heading "Board and pot" [level=2]',
          '  - paragraph: "Board: queen of spades, jack of hearts, four of diamonds, nine of clubs, three of spades."',
          '  - text: Quigs wins 170 with pair of aces',
          '  - heading "Seats" [level=2]',
          '  - list "Seats, clockwise from seat 1. Yours is seat 1":',
          '    - listitem: "Quigs, you, dealer, 1,090 chips, won 170, your cards: ace of spades, ace of hearts, shown to the table, pair of aces, host."',
          '    - listitem: Pam, small blind, 920 chips, shows king of diamonds, king of clubs, pair of kings.',
          '    - listitem: Stu, big blind, 990 chips, folded.',
          ...[4, 5, 6, 7, 8, 9, 10].map((seat) => `    - listitem: Seat ${seat}, open.`),
        ].join('\n'),
      );
    },
  ],
  [
    'someone watching hears the same hand with nobody’s cards but those shown, no turn and no stack, and reads the seats from seat 1 with a button on each open one; a page that hears of the whole hand in one view says every line of it too',
    async (rig) => {
      const table = threeHanded(rig);
      const quigs = await listening(table, 'Quigs');
      const page = await listening(table, 'Kibitz');
      // Another page of the watcher's, which hears nothing of the hand until it is over
      const late = await listening(table, 'Kibitz');
      const polls = await Gate.on(late, 'polls');
      const start = table.version;

      await polls.close('requests');
      await playToShowdown(table, quigs);
      await heard(page, SHOWDOWN.at(-1)!, start);

      const said = await spoken(page, start);

      assert.deepEqual(said, [
        ...DEAL,
        'log: Quigs raises to 30',
        'log: Pam calls 25',
        'log: Stu folds',
        'log: Flop: queen of spades, jack of hearts, four of diamonds',
        'log: Pam checks',
        'log: Quigs bets 50',
        'log: Pam calls 50',
        'log: Turn: nine of clubs',
        'log: Pam checks',
        'log: Quigs checks',
        'log: River: three of spades',
        'log: Pam checks',
        'log: Quigs checks',
        ...SHOWDOWN,
      ]);

      assert.equal(
        await tree(page, '.seats'),
        [
          '- list "Seats, clockwise from seat 1":',
          '  - listitem: Quigs, dealer, 1,090 chips, won 170, shows ace of spades, ace of hearts, pair of aces, host.',
          '  - listitem: Pam, small blind, 920 chips, shows king of diamonds, king of clubs, pair of kings.',
          '  - listitem: Stu, big blind, 990 chips, folded.',
          ...[4, 5, 6, 7, 8, 9, 10].flatMap((seat) => ['  - listitem:', `    - button "Sit here, seat ${seat}": Sit here`]),
        ].join('\n'),
      );
      assert.doesNotMatch(JSON.stringify([said, await tree(page, '.app')]), /\b(seven|deuce) of/, 'a card nobody showed was said');

      // More lines in one view than the account of the game keeps: each is said all the same
      await polls.open();
      await heard(late, SHOWDOWN.at(-1)!, start);
      assert.deepEqual(await spoken(late, start), said, 'a page told of the whole hand at once did not say every line of it');
    },
  ],
  [
    'a hand is played with the keyboard alone: past the table to the bar, a bet typed, a bet sized with a button that says what it set, and the keyboard never left on nothing',
    async (rig) => {
      const table = threeHanded(rig);
      const page = await listening(table, 'Quigs');
      const moved = () => table.view('Pam').seats[0]!;

      table.deal(ACES_OVER_KINGS);
      await heard(page, 'alert: Your turn. 10 to call. Pot 15 chips.');

      // The first thing the keyboard reaches is the way past the table, and it lands on the bar
      await page.keyboard.press('Tab');
      assert.equal(await focused(page), 'skip');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(`document.activeElement.matches('.controls-slot')`), true, 'the way past the table does not lead to the bar');

      await tabTo(page, '#raise-amount');
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('30');
      await tabTo(page, '[data-action="raise"]');
      assert.equal(await page.getAttribute('[data-action="raise"]', 'aria-label'), 'Raise to 30');
      await page.keyboard.press('Enter');
      await heard(page, 'log: Quigs raises to 30');
      assert.equal(moved().bet, 30, 'the typed raise was not made');
      assert.notEqual(await focused(page), 'nothing', 'the raise left the keyboard on nothing');

      table.act('Pam', { type: 'call' });
      table.act('Stu', { type: 'fold' });
      table.act('Pam', { type: 'check' });
      await heard(page, 'alert: Your turn. Check or bet. Pot 70 chips.');
      assert.notEqual(await focused(page), 'nothing', 'the turn arriving left the keyboard on nothing');

      // A size button says what it set, which is shown on another button
      await tabTo(page, '.presets button:nth-child(4)');
      await page.keyboard.press('Enter');
      await heard(page, 'status: Bet 70');
      assert.equal(await page.inputValue('#raise-amount'), '70');
      await tabTo(page, '[data-action="raise"]');
      await page.keyboard.press('Space');
      await heard(page, 'log: Quigs bets 70');

      table.act('Pam', { type: 'call' });
      table.act('Pam', { type: 'check' });
      await heard(page, 'alert: Your turn. Check or bet. Pot 210 chips.');

      const turn = table.version;

      await tabTo(page, '[data-action="check"]');
      await page.keyboard.press('Enter');
      await heard(page, 'log: Quigs checks', turn);

      table.act('Pam', { type: 'check' });
      await heard(page, 'alert: Your turn. Check or bet. Pot 210 chips.', turn);
      await tabTo(page, '[data-action="check"]');
      await page.keyboard.press('Enter');
      await heard(page, 'log: You have 1,110 chips.');

      // And the chat, there and back
      await tabTo(page, '#chat-input');
      await page.keyboard.type('gg');
      await page.keyboard.press('Enter');
      await heard(page, 'log: Quigs: gg');
      assert.equal(await focused(page), '#chat-input', 'sending a line took the keyboard off the chat');
    },
  ],
  [
    'beside a table lying down the open chat goes down for the viewer’s turn: the keyboard in its empty box goes to the bar under the table, not to nothing, and nothing is said of it; with a line begun the box keeps the keyboard and the line',
    async (rig) => {
      const table = threeHanded(rig);
      const page = await listening(table, 'Pam', 'phoneSideways');
      const chatShows = (shows: boolean) => page.waitForSelector('.feed.open .feed-body', { state: shows ? 'visible' : 'hidden' });

      table.deal(ACES_OVER_KINGS);
      await table.heardBy(page);
      await page.tap('.feed-toggle');
      await chatShows(true);
      await page.focus('#chat-input');

      const waiting = table.version;

      table.act('Quigs', { type: 'call' });
      await heard(page, 'alert: Your turn. 5 to call. Pot 25 chips.', waiting);
      await chatShows(false);
      assert.equal(await focused(page), 'Your move', 'the chat went down for the turn and took the keyboard with it');
      assert.deepEqual(await spoken(page, waiting), ['log: Quigs calls 10', 'alert: Your turn. 5 to call. Pot 25 chips.'], 'something was said of the chat going down');

      // Her move made, the chat is back. A line begun in its box keeps it open through her next turn
      table.act('Pam', { type: 'call' });
      await chatShows(true);
      await page.focus('#chat-input');
      await page.keyboard.type('gg');
      table.act('Stu', { type: 'check' });
      await heard(page, 'alert: Your turn. Check or bet. Pot 30 chips.', waiting);
      await chatShows(true);
      assert.deepEqual(await page.evaluate(`[document.activeElement.id, document.activeElement.value]`), ['chat-input', 'gg'], 'the turn took the keyboard or the line from the chat’s box');
    },
  ],
  [
    'ten views that draw the table and the bar again say nothing, leave the keyboard where it was and keep a bet half typed; so do a chat line, a toast and a move that are said',
    async (rig) => {
      const table = threeHanded(rig);
      const page = await listening(table, 'Quigs');

      table.deal(ACES_OVER_KINGS);
      await heard(page, 'alert: Your turn. 10 to call. Pot 15 chips.');

      const onTurn = table.version;

      await page.focus('#raise-amount');
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('12');

      // A chip moved from one stack to another and a setting changed draw the table and the bar again, and are no news to anyone
      for (let nth = 1; nth <= 10; nth++) {
        await page.evaluate(`void (document.querySelector('#raise-amount').old = true)`);
        table.alter((state) => {
          state.seats[2]!.stack -= 1;
          state.seats[1]!.stack += 1;
          state.config.maxBuyIn += 1;
        });
        await page.waitForSelector(`.seat[data-seat="2"] .stack:text-is("${990 - nth}")`);
        await page.waitForFunction(`document.querySelector('#raise-amount').old !== true`);
      }

      assert.deepEqual(await spoken(page, onTurn), [], 'a view that brought no news was said');
      assert.equal(await focused(page), '#raise-amount', 'the bar drawn again took the keyboard off the bet');
      assert.equal(await page.inputValue('#raise-amount'), '12', 'the bet half typed did not last');
      assert.equal(await page.getAttribute('[data-action="raise"]', 'aria-label'), 'Raise to 20', 'the button no longer names what the box, not yet a raise, stands for');

      // What is said is said once, and takes nothing from whoever is typing
      table.act('Pam', { type: 'chat', text: 'take your time' });
      await heard(page, 'log: Pam: take your time');
      table.act('Stu', { type: 'react', kind: 'clap' });
      await heard(page, 'log: Stu is clapping.');
      assert.deepEqual(await spoken(page, onTurn), ['log: Pam: take your time', 'log: Stu is clapping.']);
      assert.equal(await focused(page), '#raise-amount');
      assert.equal(await page.inputValue('#raise-amount'), '12', 'the bet half typed did not last a line being said');

      // With others' reactions switched off they are not said either. A page that opens on its viewer's turn says so
      const quiet = await listening(table, 'Quigs', 'desktop', `localStorage.setItem('cnd.reactions', 'off')`);
      rig.advance(5000);
      table.act('Stu', { type: 'react', kind: 'clap' });
      table.act('Pam', { type: 'chat', text: 'well?' });
      await heard(quiet, 'log: Pam: well?');
      assert.deepEqual(await spoken(quiet), ['alert: Your turn. 10 to call. Pot 15 chips.', 'log: Pam: well?']);
    },
  ],
  [
    'each offer is said when it is made and answered from the keyboard: how many times to run it, a chop offered and agreed to, a card shown, the rabbit hunted',
    async (rig) => {
      // Everyone left is all in, at a table that runs it twice
      const twice = threeHanded(rig, { maxRuns: 2 });
      const allIn = await listening(twice, 'Quigs');

      twice.deal(ACES_OVER_KINGS);
      await heard(allIn, 'alert: Your turn. 10 to call. Pot 15 chips.');

      const shoving = twice.version;

      twice.act('Quigs', { type: 'raise', to: 1000 });
      twice.act('Pam', { type: 'call' });
      twice.act('Stu', { type: 'fold' });
      await heard(allIn, 'alert: All in. Pick how many times to run it: once or twice.');
      await tabTo(allIn, '[data-action="rit-2"]');
      await allIn.keyboard.press('Enter');
      await allIn.waitForSelector('.seat.me > .unseen:has-text("picked twice")', { state: 'attached' });
      // Her chance to win is worked out a moment after the cards are up
      await allIn.waitForSelector('.seat[data-seat="1"] > .unseen:text-is("Pam, small blind, 0 chips, chance to win: ~18%, still picking, shows king of diamonds, king of clubs.")', { state: 'attached' });

      twice.act('Pam', { type: 'ritVote', runs: 2 });
      await runOut(rig, twice, allIn);
      await heard(allIn, 'log: You have 2,010 chips.', shoving);
      assert.deepEqual(await spoken(allIn, shoving), [
        'log: Quigs raises to 1,000 and is all in',
        'log: Pam calls 995 and is all in',
        'log: Stu folds',
        'log: Quigs shows ace of spades, ace of hearts',
        'log: Pam shows king of diamonds, king of clubs',
        'alert: All in. Pick how many times to run it: once or twice.',
        'log: Everyone agreed: running it twice',
        'log: First board, Flop: queen of spades, jack of hearts, four of diamonds',
        'log: First board, Turn: nine of clubs',
        'log: First board, River: three of spades',
        'log: Second board, Flop: king of spades, jack of spades, ten of spades',
        'log: Second board, Turn: nine of spades',
        'log: Second board, River: eight of spades',
        'log: Quigs wins 1,005 on the first board with pair of aces',
        'log: Quigs wins 1,005 on the second board with flush, ace high',
        'log: You have 2,010 chips.',
      ]);
      assert.match(await tree(allIn, '.stage'), /paragraph: "First board: queen of spades, jack of hearts, four of diamonds, nine of clubs, three of spades\. Second board: king of spades, jack of spades, ten of spades, nine of spades, eight of spades\."/);

      // Folded to the blinds, at a table that chops
      const chops = threeHanded(rig, { allowChop: true });
      const small = await listening(chops, 'Pam');
      const big = await listening(chops, 'Stu');

      chops.deal(ACES_OVER_KINGS);
      chops.act('Quigs', { type: 'fold' });
      await heard(small, 'alert: Your turn. 5 to call. Pot 15 chips. You may offer to chop the blinds.');
      await tabTo(small, '[data-action="offer-chop"]');
      await small.keyboard.press('Enter');
      await heard(big, 'alert: Your turn. Pam offers to chop the blinds.');
      assert.match(await tree(big, '.controls-slot'), /text: "Pam offers to chop: you each take back your blind and the hand ends"\n {2}- button "Play on"\n {2}- button "Chop"/);
      await tabTo(big, '[data-action="chop-yes"]');
      await big.keyboard.press('Enter');

      const CHOPPED = ['log: Stu agrees to chop', 'log: Pam and Stu chop the blinds: each takes back their own', 'log: You have 1,000 chips.', 'log: You may show your cards.'];

      await heard(small, CHOPPED.at(-1)!);
      await heard(big, CHOPPED.at(-1)!);
      assert.deepEqual((await spoken(small)).slice(-6), ['alert: Your turn. 5 to call. Pot 15 chips. You may offer to chop the blinds.', 'log: Pam offers to chop the blinds', ...CHOPPED]);
      assert.deepEqual((await spoken(big)).slice(-6), ['log: Pam offers to chop the blinds', 'alert: Your turn. Pam offers to chop the blinds.', ...CHOPPED]);

      // Folded to on the flop, at a table that hunts
      const hunts = threeHanded(rig, { rabbitHunting: true });
      const page = await listening(hunts, 'Quigs');

      hunts.deal(ACES_OVER_KINGS);
      await heard(page, 'alert: Your turn. 10 to call. Pot 15 chips.');
      hunts.act('Quigs', { type: 'raise', to: 30 });
      hunts.act('Pam', { type: 'call' });
      hunts.act('Stu', { type: 'fold' });
      hunts.act('Pam', { type: 'check' });
      hunts.act('Quigs', { type: 'raise', to: 50 });
      hunts.act('Pam', { type: 'fold' });
      await heard(page, 'log: You may show your cards. You may see the cards that would have come.');
      assert.deepEqual((await spoken(page)).slice(-5), [
        'log: Pam folds',
        'log: Uncalled bet of 50 returned to Quigs',
        'log: Quigs wins 70',
        'log: You have 1,040 chips.',
        'log: You may show your cards. You may see the cards that would have come.',
      ]);

      const folded = hunts.version;

      await tabTo(page, '[data-action="show-card"][data-place="0"]');
      assert.equal(await page.evaluate('document.activeElement.getAttribute("aria-label")'), 'Show the ace of spades');
      await page.keyboard.press('Enter');
      await heard(page, 'log: Quigs shows one card, ace of spades', folded);
      await page.waitForSelector('.seat.me > .unseen:has-text("ace of spades shown to the table")', { state: 'attached' });
      assert.notEqual(await focused(page), 'nothing', 'showing a card left the keyboard on nothing');

      await tabTo(page, '[data-action="hunt"]', 'Shift+Tab');
      await page.keyboard.press('Enter');
      await heard(page, 'log: Quigs hunts the rabbit, cards that did not count: nine of clubs, three of spades');
      assert.match(await tree(page, '.stage'), /paragraph: "Board: queen of spades, jack of hearts, four of diamonds\. Would have come, did not count: nine of clubs, three of spades\."/);
      assert.notEqual(await focused(page), 'nothing', 'the hunt left the keyboard on nothing');
      assert.deepEqual(await spoken(page, folded), ['log: Quigs shows one card, ace of spades', 'log: Quigs hunts the rabbit, cards that did not count: nine of clubs, three of spades']);
    },
  ],
  [
    'with animations on, nothing of an all-in’s end is said while its last card lies face down, not the river, the winner or the stack; turned up, they are said once and in that order',
    async (rig) => {
      const table = threeHanded(rig, { maxRuns: 1 });
      const page = await listening(table, 'Quigs', 'desktop', MOTION, { moving: true });

      table.deal(ACES_OVER_KINGS);
      await heard(page, 'alert: Your turn. 10 to call. Pot 15 chips.');

      const shoving = table.version;

      table.act('Quigs', { type: 'raise', to: 1000 });
      table.act('Pam', { type: 'call' });
      table.act('Stu', { type: 'fold' });

      for (const street of ['log: Flop: queen of spades, jack of hearts, four of diamonds', 'log: Turn: nine of clubs']) {
        rig.advance(table.view('Quigs').hand!.deadline! - rig.now());
        await heard(page, street, shoving);
      }

      // Every move from here on is stopped where it starts, so the river lies face down until the check turns it
      await page.evaluate('window.holdAt = 0');
      rig.advance(table.view('Quigs').hand!.deadline! - rig.now());
      assert.equal(table.view('Quigs').hand!.stage, 'done', 'the hand is not over at the table');
      await page.waitForSelector('.board-card.stand-in');

      // No view comes between the river lying face down and its being turned: what is said after is told from what was said before
      const faceDown = await spoken(page, shoving);

      assert.equal(faceDown.at(-1), 'log: Turn: nine of clubs', 'something of the hand’s end was said with the river face down');

      await page.evaluate('window.holdAt = null; window.land()');
      await heard(page, 'log: You have 2,010 chips.', shoving);
      assert.deepEqual((await spoken(page, shoving)).slice(faceDown.length), ['log: River: three of spades', 'log: Quigs wins 2,010 with pair of aces', 'log: You have 2,010 chips.']);
    },
  ],
  [
    'a player is told once that their clock is running down, ten seconds from the end of a thirty-second clock',
    async (rig) => {
      const table = threeHanded(rig, { actionSeconds: 30 });
      const page = await listening(table, 'Quigs');
      const warnings = async () => ((await page.evaluate('window.spoken.map((said) => said.text)')) as string[]).filter((text) => text.includes('seconds left'));
      // A line of chat at each moment looked at: once the page has said it, it has looked at its clock since the rig moved it
      const withLeft = async (ms: number, line: string) => {
        rig.advance(table.view('Quigs').hand!.deadline! - ms - rig.now());
        table.act('Pam', { type: 'chat', text: line });
        await heard(page, `log: Pam: ${line}`);
      };

      table.deal(ACES_OVER_KINGS);
      await heard(page, 'alert: Your turn. 10 to call. Pot 15 chips.');
      await withLeft(15_000, 'thinking?');
      assert.deepEqual(await warnings(), [], 'the clock was called with half of it left');

      await withLeft(9700, 'tick');
      await heard(page, 'alert: 10 seconds left.');

      await withLeft(5000, 'tock');
      assert.deepEqual(await warnings(), ['10 seconds left.'], 'the clock was called more than once');
    },
  ],
  [
    'every dialog of the menu opens from the keyboard with the keyboard in it and a name, breaks no rule in any theme, closes on Escape and gives the keyboard back to the menu button',
    async (rig) => {
      const table = threeHanded(rig);
      const page = await listening(table, 'Quigs');
      const sweep = new Sweep();
      const dialogName = () => page.getAttribute('.overlay [role$="dialog"]', 'aria-label');
      const inDialog = () => focusIn(page, '.dialog');

      await playToShowdown(table, page);
      await heard(page, 'log: You have 1,090 chips.');

      await page.focus('[data-action="menu"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.menu');
      assert.equal(await inDialog(), true, 'the menu opened with the keyboard left behind it');
      assert.equal(await dialogName(), 'Friday Night');
      await sweep.over(page, 'the menu');

      const entries = (await page.evaluate(`[...document.querySelectorAll('.menu-item')].map((item) => item.dataset.action)`)) as string[];
      const opened: string[] = [];

      // Leaving for the lobby is the one entry that takes the page off the table
      for (const entry of entries.filter((action) => action !== 'lobby')) {
        await tabTo(page, `.menu-item[data-action="${entry}"]`);
        await page.keyboard.press('Enter');
        await page.waitForFunction(`document.querySelector('.menu') === null`);

        // An entry that does something outright, as pausing the game, opens nothing
        if ((await page.locator('.overlay .dialog').count()) > 0) {
          const name = await dialogName();

          assert.ok(name, `the dialog ${entry} opens has no name`);
          assert.equal(await inDialog(), true, `${name} opened with the keyboard left behind it`);
          await sweep.over(page, `the dialog ${name}`);
          opened.push(name);

          await page.keyboard.press('Escape');
          await page.waitForSelector('.overlay .dialog', { state: 'detached' });
        }

        assert.equal(await focused(page), 'menu', `after ${entry} the keyboard is not back on the menu button`);
        await page.keyboard.press('Enter');
        await page.waitForSelector('.menu');
      }

      assert.deepEqual(opened, ['Invite players', 'Ledger', 'Tonight', 'Standings', 'Hand history', 'Players', 'Shuffle the seats?', 'Last hands', 'Table settings', 'Who you are', 'Theme', 'Preferences', 'Mute players', 'Show or muck', 'Stand up?']);
      sweep.done(opened.length + 1);
    },
  ],
  [
    'a dialog that opens by itself takes the keyboard and gives it back where it was; a replay that makes way for a turn says why, and the turn is said; a replay asked for before its hand is on record says when it will come, and why it has opened; the night’s recap waits for a line half typed',
    async (rig) => {
      const table = threeHanded(rig);
      const quigs = await listening(table, 'Quigs');
      const page = await listening(table, 'Pam');

      await playToShowdown(table, quigs);
      await heard(page, 'log: You have 920 chips.');

      // A hand played back, opened from the keyboard, with the hand after it dealt underneath: Pam is on the button and first to act
      table.act('Quigs', { type: 'pause' });
      table.play(() => null, (view) => view.hand === null);
      await table.heardBy(page);
      await page.focus('[data-action="menu"]');
      await page.keyboard.press('Enter');
      await tabTo(page, '.menu-item[data-action="history"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.history details[data-hand="1"] summary');
      await tabTo(page, '.history details[data-hand="1"] summary');
      await page.keyboard.press('Enter');
      await tabTo(page, '.history [data-action="replay"]');
      assert.equal(await page.evaluate('document.activeElement.getAttribute("aria-label")'), 'Replay this hand, number 1');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.replay:not([hidden])');
      assert.equal(await page.getAttribute('.replay', 'aria-label'), 'Replay of hand #1');
      assert.equal(await focusIn(page, '.replay'), true, 'the replay opened with the keyboard left behind it');

      const replaying = table.version;

      table.dealNext();
      await heard(page, 'alert: Your turn. 10 to call. Pot 15 chips.', replaying);
      await heard(page, 'status: Your turn. The replay will pick up where you left it.', replaying);
      assert.equal(await page.locator('.replay:not([hidden])').count(), 0, 'the replay is still over the turn');
      assert.notEqual(await focused(page), 'nothing', 'the replay closing left the keyboard on nothing');

      // That hand is played out, and its result is still up when Pam asks for it back from the bar. It is not on record
      // yet and she is told when it will be played; cleared from the table, it opens by itself and says why
      table.act('Quigs', { type: 'pause' });
      table.play((view) => ({ type: view.hand!.options!.canCheck ? 'check' : 'fold' }), (view) => view.hand?.stage === 'done');
      await page.focus('.controls [data-action="replay-last"]');
      await page.keyboard.press('Enter');
      await heard(page, 'status: Hand #2 plays back as soon as it is cleared from the table.');
      table.play(() => null, (view) => view.hand === null);
      await heard(page, 'status: Hand #2 is cleared from the table. Playing it back, as you asked.');
      await page.waitForSelector('.replay:not([hidden])');
      assert.equal(await page.getAttribute('.replay', 'aria-label'), 'Replay of hand #2');
      assert.equal(await focusIn(page, '.replay'), true, 'the replay opened by itself with the keyboard left behind it');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.replay', { state: 'hidden' });

      // The night ends while she has a line half typed in the chat: Tonight waits, and the keyboard and the line stay hers
      await page.focus('#chat-input');
      await page.keyboard.type('gg');
      table.act('Quigs', { type: 'endNight' });
      await table.heardBy(page);
      assert.equal(await page.locator('.dialog').count(), 0, 'Tonight opened over a line half typed');
      assert.deepEqual(await page.evaluate(`[document.activeElement.id, document.activeElement.value]`), ['chat-input', 'gg'], 'the night’s end took the keyboard or the line from the chat’s box');

      // The line sent, Tonight opens over the empty box, and closing it puts her back there
      await page.keyboard.press('Enter');
      await page.waitForSelector('.dialog[aria-label="Tonight"]');
      assert.equal(await focusIn(page, '.dialog'), true, 'Tonight opened with the keyboard left behind it');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.dialog', { state: 'detached' });
      assert.equal(await focused(page), '#chat-input', 'closing Tonight did not give the keyboard back');
    },
  ],
  [
    'the bar drawn again never leaves the keyboard on a button that has come to say something else, through seven ways a new bar arrives; one turn’s bar drawn straight over the last leaves the keyboard on the bar itself, and Enter held down from one decision into the next makes no move in the second',
    async (rig) => {
      type Move = [name: string, command: Command];
      // Quigs is the viewer. `arrived` is something the new bar has that the old one had not
      const ARRIVALS: { name: string; config?: Partial<TableConfig>; button: number; before: Move[]; step: Move[]; arrived: string }[] = [
        { name: 'the turn comes facing a raise', button: 1, before: [['Pam', { type: 'raise', to: 30 }]], step: [['Stu', { type: 'call' }]], arrived: '.turn [data-action="call"]' },
        { name: 'the turn comes with nothing to call', button: 1, before: [['Pam', { type: 'call' }]], step: [['Stu', { type: 'call' }]], arrived: '.turn [data-action="check"]' },
        { name: 'the viewer called and the hand goes on', button: 0, before: [], step: [['Quigs', { type: 'call' }]], arrived: '.controls-slot:not(:has(.turn))' },
        { name: 'the viewer folded and the hand goes on', button: 0, before: [], step: [['Quigs', { type: 'fold' }]], arrived: '.controls-slot:not(:has(.turn))' },
        { name: 'the viewer’s fold ends the hand', button: 2, before: [['Stu', { type: 'fold' }]], step: [['Quigs', { type: 'fold' }]], arrived: '.controls-slot [data-action="show-card"]' },
        { name: 'the viewer called all in and is asked how many times to run it', config: { maxRuns: 3 }, button: 1, before: [['Pam', { type: 'raise', to: 1000 }], ['Stu', { type: 'fold' }]], step: [['Quigs', { type: 'call' }]], arrived: '[data-action="rit-1"]' },
        { name: 'a hand won uncalled while waiting and the show offer comes', button: 0, before: [['Quigs', { type: 'raise', to: 30 }], ['Pam', { type: 'fold' }]], step: [['Stu', { type: 'fold' }]], arrived: '.controls-slot [data-action="show-card"]' },
        { name: 'one turn’s bar is drawn straight over the last', button: 2, before: [['Stu', { type: 'fold' }]], step: [['Quigs', { type: 'call' }], ['Pam', { type: 'raise', to: 40 }]], arrived: '.turn [data-action="call"]:has-text("30")' },
      ];

      for (const arrival of ARRIVALS) {
        const table = threeHanded(rig, arrival.config);

        table.deal({ ...ACES_OVER_KINGS, button: arrival.button });
        arrival.before.forEach(([name, command]) => table.act(name, command));

        const page = await table.open('Quigs', 'desktop');
        const last = arrival === ARRIVALS.at(-1);
        // The real keyboard, for the bar drawn straight over the last: on the call here, and on Fold on a second page
        const onFold = last ? await table.open('Quigs', 'desktop') : null;
        const sent = movesSent(page);

        if (last) {
          await page.focus('.turn [data-action="call"]');
          await onFold!.focus('.turn [data-action="fold"]');
        }

        const before = await controls(page, '.controls-slot');

        // In one breath, so that a bar which follows another is drawn straight over it
        arrival.step.forEach(([name, command]) => table.act(name, command));
        await page.waitForSelector(arrival.arrived);

        const after = await controls(page, '.controls-slot');
        const taken = after.flatMap((now) => before.filter((was) => was.marks === now.marks && was.says !== now.says).map((was) => `“${was.says}” is now “${now.says}” (${now.marks})`));

        assert.ok(before.length > 0 && after.length > 0, `${arrival.name}: the bar has no controls to look at`);
        assert.deepEqual(taken, [], `${arrival.name}: a button the keyboard may be on has come to say something else`);

        if (last) {
          await onFold!.waitForSelector(arrival.arrived);
          assert.deepEqual([await focused(page), await focused(onFold!)], ['Your move', 'Your move'], 'the keyboard was on a move of the last decision and is not on the bar itself');

          // A key that comes a moment late for the last decision makes no move in this one: not while its buttons, come
          // up where the last one's lay, take no tap, and not once they do, since the keyboard is on none of them
          await page.keyboard.press('Enter');
          await tapsLive(page);
          await page.keyboard.press('Enter');
          await page.evaluate('void 0');
          assert.deepEqual(sent, [], 'a key pressed as the new bar was drawn made a move');
          assert.equal(await focused(page), 'Your move', 'the keyboard left the bar as its buttons were let go');
        }
      }

      // Enter held down on the call. Its answer is lost on the way back and the raise behind it comes before the page looks
      // again, so the page finds both in one view and draws the next turn's bar straight over this one, the key still down
      const table = threeHanded(rig);

      table.deal({ ...ACES_OVER_KINGS, button: 2 });
      table.act('Stu', { type: 'fold' });

      const page = await table.open('Quigs', 'desktop');
      const sent = movesSent(page);
      const polls = await Gate.on(page, 'polls');
      const moves = await Gate.on(page, 'moves');

      await polls.close('requests');
      await moves.close('answers');
      await page.focus('.turn [data-action="call"]');
      await page.keyboard.down('Enter');
      await moves.holding();
      await moves.lose();
      table.act('Pam', { type: 'raise', to: 40 });
      await polls.open();
      await page.waitForSelector('.turn [data-action="call"]:has-text("30")');

      for (let repeats = 0; repeats < 3; repeats++) {
        await page.keyboard.down('Enter');
      }
      await page.keyboard.up('Enter');
      await page.evaluate('void 0');
      await tapsLive(page);
      await page.keyboard.press('Enter');
      await page.evaluate('void 0');
      assert.deepEqual(sent, ['call'], 'Enter held down from one decision made a move in the next');
      assert.equal(table.view('Quigs').seats[0]!.bet, 10, 'the call of 30 was made');
      assert.equal(await focused(page), 'Your move');
    },
  ],
  [
    'a list drawn again with the keyboard in it leaves the keyboard with the same player, never on the same button of another: a request in Players when one goes and another comes, the mute switch through its own flip, a row of Tonight when the standings change, a hand of the history and its button as hands are added over it; and the top bar takes the keyboard when what had it is gone',
    async (rig) => {
      const table = threeHanded(rig, { voiceLink: 'https://meet.jit.si/friday-night' });
      const host = await table.open('Quigs', 'desktop');
      const opened = async (item: string) => {
        await host.click('[data-action="menu"]');
        await host.click(`.menu-item[data-action="${item}"]`);
        await host.waitForSelector('.dialog li');
      };
      // What has the keyboard, and whose row it is in
      const held = () => host.evaluate(`[document.activeElement.getAttribute('aria-label') ?? document.activeElement.tagName, document.activeElement.closest('li')?.querySelector('b, .who')?.firstChild?.textContent ?? 'no row']`);

      // Two ask for a seat. With the keyboard on the second one's button the first is turned away and a third asks: as many
      // rows as before, and the second row is now the newcomer's
      for (const name of ['Lurk', 'Moth', 'Newt']) {
        table.join(name);
      }
      table.act('Lurk', { type: 'requestSeat', seat: 5, buyIn: 500 });
      table.act('Moth', { type: 'requestSeat', seat: 6, buyIn: 500 });
      await opened('players');
      await host.focus('.dialog li:has(b:text-is("Moth")) [data-action="approve"]');
      table.alter((state) => {
        state.requests = state.requests.filter((request) => request.playerId !== table.auth('Lurk').id);
      });
      table.act('Newt', { type: 'requestSeat', seat: 5, buyIn: 500 });
      await host.waitForSelector('.dialog li:has(b:text-is("Newt")) [data-action="approve"]');
      await host.waitForSelector('.dialog li:has(b:text-is("Lurk")) [data-action="approve"]', { state: 'detached' });
      assert.deepEqual(await held(), ['Approve, Moth', 'Moth'], 'the keyboard did not stay on the request it was on');

      // Her button came up where another's lay, and takes no tap for a moment: it is told from every other while it
      // is held as after, and the keyboard is still on it once it is let go
      assert.deepEqual(await alike(host), [], 'two controls are alike while one of them takes no tap');
      await tapsLive(host);
      assert.deepEqual(await alike(host), []);
      assert.deepEqual(await held(), ['Approve, Moth', 'Moth'], 'the keyboard left a button as it was let go');
      await host.keyboard.press('Escape');

      // The switch that mutes a player is the same switch once thrown, and keeps the keyboard both ways
      await opened('mute');
      await host.focus('.dialog li:has(b:text-is("Pam")) button');
      await host.keyboard.press('Space');
      await host.waitForSelector('.dialog [aria-label="Unmute Pam"]');
      assert.deepEqual(await held(), ['Unmute Pam', 'Pam'], 'muting a player took the keyboard off their switch');
      await host.keyboard.press('Space');
      await host.waitForSelector('.dialog [aria-label="Mute Pam"]');
      assert.deepEqual(await held(), ['Mute Pam', 'Pam'], 'unmuting a player took the keyboard off their switch');
      await host.keyboard.press('Escape');

      // Tonight lists players by how they stand. With the keyboard on the last row, that player wins a pot and goes first
      await opened('tonight');

      const rows = () => host.evaluate(`[...document.querySelectorAll('.dialog li summary .who')].map((who) => who.firstChild.textContent)`) as Promise<string[]>;
      const last = (await rows()).at(-1)!;

      await host.focus(`.dialog li:has(.who:text("${last}")) summary`);
      table.deal(ACES_OVER_KINGS);
      table.play(
        (_view, name) => (name === last ? { type: 'raise', to: 40 } : { type: 'fold' }),
        (view) => view.hand?.stage === 'done',
      );
      await host.waitForFunction(`document.querySelector('.dialog li summary .who')?.firstChild.textContent === ${JSON.stringify(last)}`);
      assert.deepEqual(await held(), ['SUMMARY', last], 'the keyboard did not stay on the row of the player it was on');
      await host.keyboard.press('Escape');

      // The hand history is drawn again as each hand goes on record, with that hand put in over the others. The keyboard
      // stays on the hand it was on: on its line, and then on the button under it
      // The game is paused after the hand, so that the hand is cleared from the table with none dealt behind it
      const onRecord = () => {
        table.act('Quigs', { type: 'pause' });
        table.play((view) => (view.hand!.options ? { type: view.hand!.options.canCheck ? 'check' : 'fold' } : null), (view) => view.hand === null);
      };
      const onHandOne = (control: string) => host.evaluate(`document.activeElement.matches('.history ${control}[data-hand="1"]')`);

      onRecord();
      await table.heardBy(host);
      await host.click('[data-action="menu"]');
      await host.click('.menu-item[data-action="history"]');
      await host.focus('.history summary[data-hand="1"]');
      await host.keyboard.press('Enter');

      for (const [hand, control] of [[2, 'summary'], [3, '[data-action="replay"]']] as const) {
        await host.focus(`.history ${control}[data-hand="1"]`);
        table.dealNext();
        onRecord();
        await host.waitForSelector(`.history details[data-hand="${hand}"]`);
        assert.equal(await onHandOne(control), true, `hand #${hand} went into the history and the keyboard is on ${await focused(host)}, not on hand #1 where it was`);
        assert.equal(await host.locator('.history details[data-hand="1"][open]').count(), 1, 'the hand being read was shut');
      }
      await host.keyboard.press('Escape');

      // The link to the voice chat is taken away while the keyboard is on it: the keyboard is left on the top bar, not on nothing
      await host.focus('.topbar .voice-link');
      table.alter((state) => {
        state.config.voiceLink = '';
      });
      await host.waitForSelector('.topbar .voice-link', { state: 'detached' });
      assert.equal(await focusIn(host, '.topbar'), true, 'the keyboard was left on nothing when the link it was on went');
    },
  ],
  [
    'the table breaks no rule of the rule engine in any theme, through a hand and its offers, for a player on a phone, the host on a desktop and someone watching, and under forced colors and a wish for more contrast',
    async (rig) => {
      const table = threeHanded(rig, { maxRuns: 2, rabbitHunting: true });
      const sweep = new Sweep();
      const watcher = await listening(table, 'Kibitz', 'smallPhone');

      // Before the game: open seats to take, and the dialog one opens
      await sweep.over(watcher, 'the table before the game, watching');
      await watcher.tap('[data-sit="5"]');
      await watcher.waitForSelector('.dialog');
      await sweep.over(watcher, 'the dialog to sit down');
      await watcher.keyboard.press('Escape');

      const host = await listening(table, 'Quigs');
      const phone = await listening(table, 'Pam', 'smallPhone');

      // A request waiting for the host, which is said and has buttons that name whose it is
      table.act('Kibitz', { type: 'requestSeat', seat: 5, buyIn: 500 });
      await heard(host, 'log: Kibitz wants seat 6 with 500. Approve or deny under Notices.');
      assert.match(await tree(host, '.banners'), /- region "Notices":\n {2}- text: Kibitz wants seat 6 with 500\n {2}- button "Approve Kibitz": Approve\n {2}- button "Deny Kibitz": Deny/);
      assert.equal(await host.getAttribute('[data-action="menu"]', 'aria-label'), 'Menu, 1 request waiting for you');
      await sweep.over(host, 'a request over the table');

      // With the keyboard on one player's button, that request goes and another's takes its place in the row: the keyboard
      // is not put on the newcomer's button, where the next Enter would approve someone the host never looked at
      table.join('Lurk');
      table.join('Moth');
      table.act('Lurk', { type: 'requestSeat', seat: 6, buyIn: 500 });
      await host.waitForSelector('[data-action="approve"][aria-label="Approve Lurk"]');
      await host.focus('[data-action="approve"][aria-label="Approve Lurk"]');
      table.act('Quigs', { type: 'deny', playerId: table.auth('Lurk').id });
      table.act('Moth', { type: 'requestSeat', seat: 7, buyIn: 500 });
      await host.waitForSelector('[data-action="approve"][aria-label="Approve Moth"]');
      assert.equal(await focused(host), 'Notices', 'the keyboard was moved to another player’s button');

      for (const name of ['Kibitz', 'Moth']) {
        table.act('Quigs', { type: 'deny', playerId: table.auth(name).id });
      }
      await host.waitForSelector('.banners', { state: 'hidden' });

      table.deal(ACES_OVER_KINGS);
      await heard(host, 'alert: Your turn. 10 to call. Pot 15 chips.');
      await phone.waitForSelector('.controls-slot .ahead');
      await sweep.over(host, 'the turn, desktop');
      await sweep.over(phone, 'waiting with a move to choose ahead, phone');

      // The same turn on a device that wants more contrast, and on one that draws every page in colors of its own. There
      // the colors are not the page's to answer for, and the engine reads the page's own, not the ones drawn: its rule
      // for contrast is left out, and every other rule is kept
      await host.emulateMedia({ contrast: 'more' });
      await sweep.over(host, 'the turn with more contrast asked for');
      await host.emulateMedia({ contrast: 'no-preference', forcedColors: 'active' });
      await sweep.over(host, 'the turn under forced colors', ['color-contrast']);
      // A shape that was a background and nothing else is gone there unless the page draws it in the device's inks: a bet's
      // chip is told from the empty place it would leave by its picture, since the styles read the same either way
      const chip = host.locator('.bet .chip').first();
      const drawn = await chip.screenshot();

      await host.evaluate(`void (document.querySelector('.bet .chip').style.background = 'none')`);
      assert.ok(!drawn.equals(await chip.screenshot()), 'a bet has an empty place where its chip was under forced colors');
      await host.evaluate(`void document.querySelector('.bet .chip').style.removeProperty('background')`);
      await host.emulateMedia({ forcedColors: 'none' });

      // A bet that cannot be read says so on the box and on the button
      await host.fill('#raise-amount', 'lots');
      assert.equal(await host.getAttribute('#raise-amount', 'aria-invalid'), 'true');
      assert.match((await host.getAttribute('[data-action="raise"]', 'aria-label')) ?? '', /^Raise: /);
      await sweep.over(host, 'a bet that cannot be read');

      // The chat opened on a phone, and the reactions over the table
      await phone.tap('.feed-toggle');
      await phone.waitForSelector('.feed.open');
      await sweep.over(phone, 'the chat open, phone');
      await phone.tap('[data-action="reactions"]');
      await phone.waitForSelector('.react-panel');
      assert.equal(await focusIn(phone, '.react-panel'), true, 'the reactions opened with the keyboard left behind them');
      await sweep.over(phone, 'the reactions open, phone');
      await phone.keyboard.press('Escape');
      assert.equal(await focused(phone), 'reactions', 'closing the reactions did not give the keyboard back');
      await phone.tap('.feed-toggle');

      table.act('Quigs', { type: 'raise', to: 1000 });
      table.act('Pam', { type: 'call' });
      table.act('Stu', { type: 'fold' });
      await heard(phone, 'alert: All in. Pick how many times to run it: once or twice.');
      await sweep.over(phone, 'picking how many times to run it, phone');
      table.act('Quigs', { type: 'ritVote', runs: 2 });
      table.act('Pam', { type: 'ritVote', runs: 2 });
      await runOut(rig, table, host);
      await heard(host, 'log: You have 2,010 chips.');

      for (const other of [phone, watcher]) {
        await heard(other, 'log: Quigs wins 1,005 on the second board with flush, ace high');
      }
      await sweep.over(host, 'two boards run and won, desktop');
      await sweep.over(phone, 'two boards run and lost, phone');
      await sweep.over(watcher, 'two boards run, watching');

      sweep.done(14);
    },
  ],
  [
    'the screens before a table break no rule of the rule engine in any theme, each has one main heading and says its language: the lobby, joining, the standings, a table that is gone',
    async (rig) => {
      const sweep = new Sweep();
      const table = threeHanded(rig);
      const structure = (page: Page) =>
        page.evaluate(`({
          language: document.documentElement.lang,
          headings: [...document.querySelectorAll('h1, [role="heading"][aria-level="1"]')].filter((heading) => heading.getClientRects().length > 0).length,
          mains: document.querySelectorAll('main').length,
        })`);

      for (const screen of ['desktop', 'smallPhone'] as const) {
        const lobby = await rig.lobby(screen);

        assert.deepEqual(await structure(lobby), { language: 'en', headings: 1, mains: 1 }, `the lobby, ${screen}`);
        await sweep.over(lobby, `the lobby, ${screen}`);

        await lobby.click('[data-action="standings"]');
        await lobby.waitForSelector('.dialog[aria-label="Standings"]');
        await sweep.over(lobby, `the standings over the lobby, ${screen}`);
        await lobby.keyboard.press('Escape');
        assert.equal(await focused(lobby), 'standings');

        const joining = await rig.page(screen, 'someone joining');

        await joining.goto(`${rig.url}?table=${table.id}`);
        await joining.waitForSelector('main.lobby form');
        assert.deepEqual(await structure(joining), { language: 'en', headings: 1, mains: 1 }, `joining, ${screen}`);
        await sweep.over(joining, `joining a table, ${screen}`);

        const gone = await rig.page(screen, 'someone late');

        await gone.goto(`${rig.url}?table=NOSUCH`);
        await gone.waitForSelector('main.lobby');
        await sweep.over(gone, `a table that is not there, ${screen}`);
      }

      const seated = await table.open('Quigs', 'desktop');

      assert.deepEqual(await structure(seated), { language: 'en', headings: 1, mains: 1 }, 'the table');
      assert.deepEqual(
        (await tree(seated, '.app')).split('\n').filter((line) => /^- (banner|main|region|complementary|button "Skip)/.test(line)),
        ['- button "Skip to your move"', '- banner:', '- main "The table":', '- region "Your move":', '- complementary "Chat and play-by-play":'],
        'the parts of the table screen a screen reader can jump between',
      );

      sweep.done(8);
    },
  ],
  [
    'larger text: each step enlarges everything read off the table on every screen; on a desktop the bars and every seat’s figures too; on a phone the bar, the pot and the viewer’s own stack by the whole step, with the other seats as drawn and the bar keeping its rows; nothing runs off the side; the choice is reached from the keyboard, takes effect at once and is kept',
    async (rig) => {
      const table = threeHanded(rig);
      // Prose and the table’s figures at each step, as styles/accessibility.css sets them
      const STEPS = { standard: [1, 1], large: [1.15, 1.08], largest: [1.3, 1.15] } as const;
      const MEASURED = `(() => {
        const px = (selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
        const tall = (row) => Math.round(row.getBoundingClientRect().height);

        return {
          dialog: px('.menu-item'),
          bar: px('[data-action="fold"]'),
          title: px('.topbar .title b'),
          own: px('.seat.me .plate .stack'),
          pot: px('.pot'),
          others: px('.seat:not(.me) .plate .stack'),
          sizing: [...document.querySelectorAll('.controls-slot :is(.presets, .amount)')].map(tall),
          moves: tall(document.querySelector('.controls-slot .turn .buttons')),
          extraRows: new Set([...document.querySelectorAll('.controls-slot .extras > *')].map((extra) => Math.round(extra.getBoundingClientRect().top))).size,
          movesInSight: document.querySelector('.controls-slot .turn .buttons').getBoundingClientRect().bottom <= innerHeight,
          offTheSide: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        };
      })()`;
      type Measured = { dialog: number; bar: number; title: number; own: number; pot: number; others: number; sizing: number[]; moves: number; extraRows: number; movesInSight: boolean; offTheSide: number };
      // What a move's words may add to the height of their row by taking a second line
      const SECOND_LINE = 8;
      // The rows the switches under the moves take at 360 wide as drawn, which the table already makes room for
      const EXTRA_ROWS = 2;
      // Sizes as the browser reports them, which is to a fraction of a pixel no eye can tell
      const sized = (found: number[], expected: number[], where: string) =>
        assert.ok(
          found.every((size, index) => Math.abs(size - expected[index]!) < 0.05),
          `${where}: ${found.join(', ')}px where ${expected.map((size) => size.toFixed(2)).join(', ')}px were expected`,
        );

      table.deal(ACES_OVER_KINGS);

      for (const screen of ['desktop', 'smallPhone', 'phoneSideways'] as const) {
        const measured = new Map<string, Measured>();

        for (const step of Object.keys(STEPS)) {
          const page = await table.open('Quigs', screen, `localStorage.setItem('cnd.textSize', '${step}')`);

          await page.waitForSelector('[data-action="fold"]');
          await page.click('[data-action="menu"]');
          await page.waitForSelector('.menu');
          measured.set(step, (await page.evaluate(MEASURED)) as Measured);
          await page.context().close();
        }

        const drawn = measured.get('standard')!;

        for (const [step, [prose, figures]] of Object.entries(STEPS)) {
          const found = measured.get(step)!;
          const where = `${step} on ${screen}`;

          assert.equal(found.offTheSide, 0, `${where}: the page runs off the side`);
          sized([found.dialog, found.bar], [drawn.dialog * prose, drawn.bar * prose], `${where}: a dialog and the bar under the table`);

          if (screen === 'desktop') {
            sized([found.title, found.own, found.pot, found.others], [drawn.title * prose, drawn.own * figures, drawn.pot * figures, drawn.others * figures], `${where}: the top bar and the table’s figures`);
          } else {
            sized([found.own, found.pot], [drawn.own * prose, drawn.pot * prose], `${where}: what a player reads on the table to make their move`);
            sized([found.title, found.others], [drawn.title, drawn.others], `${where}: the top bar and the other seats, which stay as drawn`);
            assert.ok(found.movesInSight, `${where}: the moves are not all in sight without scrolling`);
          }

          // Under the table the bar takes its height from the table's, so it keeps its rows whatever the font: no row of the
          // bet's sizes wraps, the moves grow by a second line at most, and the switches under them take no more rows than
          // the table has room for. Beside the table, on a phone on its side, its height costs the table nothing
          if (screen === 'smallPhone') {
            assert.deepEqual(found.sizing, drawn.sizing, `${where}: a row of the bet’s sizes is taller than it was drawn`);
            assert.ok(found.moves - drawn.moves <= SECOND_LINE, `${where}: the moves’ row grew by ${found.moves - drawn.moves}px`);
            assert.ok(found.extraRows <= Math.max(drawn.extraRows, EXTRA_ROWS), `${where}: the switches under the moves take ${found.extraRows} rows`);
          }
        }
      }

      // In Preferences, reached from the keyboard: the page changes at once, the keyboard stays on the choice, and the browser keeps it
      const page = await table.open('Quigs', 'desktop');

      await page.focus('[data-action="menu"]');
      await page.keyboard.press('Enter');
      await tabTo(page, '.menu-item[data-action="preferences"]');
      await page.keyboard.press('Enter');
      await tabTo(page, 'select[data-pref="textSize"]');
      assert.match(await tree(page, '.dialog'), /heading "Text" \[level=3\]\n\s+- text: Text size\n\s+- combobox "Text size [^"]*":\n\s+- option "Standard" \[selected\]\n\s+- option "Large"\n\s+- option "Largest"/);
      await page.selectOption('select[data-pref="textSize"]', 'largest');
      await page.waitForSelector('#app[data-text-size="largest"]');
      assert.equal(await focused(page), '#pref-textSize', 'the choice was made and the keyboard is no longer on it');
      assert.equal(await page.evaluate(`localStorage.getItem('cnd.textSize')`), 'largest');
    },
  ],
  [
    'at every text size the viewer’s own bet stays clear of their cards on a standing table of every height from 330 to 400 pixels, on a 360 and a 375 phone: a text size changes how tall the bar is, and with it the table, and makes the viewer’s own seat taller',
    async (rig) => {
      const table = threeHanded(rig);
      // Nearer than a pixel is touching, to the eye
      const CLEAR = 1;
      // How far the viewer's bet, which follows their seat in the list, ends above their cards
      const ROOM = `document.querySelector('.seat.me .hole').getBoundingClientRect().top - document.querySelector('.seat.me + .bet').getBoundingClientRect().bottom`;
      const near: string[] = [];

      // Pam is the small blind, so her bet is out from the deal
      table.deal(ACES_OVER_KINGS);

      for (const screen of ['smallPhone', 'phone'] as const) {
        for (const step of ['standard', 'large', 'largest']) {
          const page = await table.open('Pam', screen, `localStorage.setItem('cnd.textSize', '${step}')`);

          await page.waitForSelector(`#app[data-text-size="${step}"] .seat.me + .bet`);

          for (let height = 330; height <= 400; height++) {
            await setStageHeight(page, height);

            const room = (await page.evaluate(ROOM)) as number;

            if (room < CLEAR) {
              near.push(`${SCREENS[screen].width} wide, ${step}, a table ${height}px high: ${room.toFixed(1)}px`);
            }
          }

          assert.ok(await page.locator('.table.tall').isVisible(), 'the table lay down, where a bet from the bottom is placed another way');
          await page.context().close();
        }
      }

      assert.deepEqual(near, [], 'the viewer’s bet is on their cards, or touches them');
    },
  ],
];
