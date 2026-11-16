/*
 * Checks of what must be done once however often it is asked: chips moved or bought, and the answer to
 * a request for them. Each goes to the table under a key (`ONCE` in src/client/once.ts), and when no
 * answer comes the page asks the table how it stands and sends the same again under that key. The
 * server here answers at once, so each check stops a request at a gate and loses it there, on the way
 * to the table or on the way back.
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { isKey } from '../src/engine/index.ts';
import type { Check } from './checkRunner.ts';
import { buttonNow, keysSent, refusalTold, toasts, toastTold } from './pageSpies.ts';
import { CLOSE, dialogNamed, fromMenu, HOST, noDialog, seatedAndWatched } from './playersDialog.ts';
import { Gate } from './rig.ts';
import type { RigTable } from './rig.ts';

const GIVER = 'Danny';
const ASKING = 'Nana';
const AMOUNT = 300;
const STACK = 2000;
const CHECKING = 'Checking whether that went through';

/** A form of the host's that moves or buys chips at once, with nobody to approve it. */
interface ChipsForm {
  what: string;
  name: string;
  open(page: Page): Promise<void>;
  /** The gate that stops what it sends. */
  gate: 'hosting' | 'asking';
  button: string;
  doing: string;
  /** Resolves once the form has gone, and leaves the table with nothing over it. */
  gone(page: Page): Promise<unknown>;
  /** How many chips of the amount the table has moved or sold, as the table itself has it. */
  done(table: RigTable): number;
  /** The seat that shows them, as the page draws it once it has heard of that many. */
  shows(chips: number): string;
}

const seatWith = (name: string, stack: number) => `.seat:has-text("${name}"):has-text("${stack.toLocaleString('en-US')}")`;

const stackOf = (table: RigTable, name: string): number => table.view(HOST).seats.find((seat) => seat?.name === name)!.stack;

const FORMS: ChipsForm[] = [
  {
    what: 'Transfer chips',
    name: 'Transfer chips',
    open: async (page) => {
      await fromMenu(page, (selector) => page.locator(selector).tap(), 'players');
      await page.locator('.dialog [data-action="transfer"]').tap();
      await dialogNamed(page, 'Transfer chips');
      await page.selectOption('#transfer-from', { label: GIVER });
      await page.selectOption('#transfer-to', { label: HOST });
      await page.fill('#transfer-amount', String(AMOUNT));
    },
    gate: 'hosting',
    button: '.dialog [data-action="confirm-transfer"]',
    doing: 'Transferring…',
    // The form was reached from Players, which is what it gives way to
    gone: async (page) => {
      await dialogNamed(page, 'Players');
      await page.locator(CLOSE).tap();
      await noDialog(page);
    },
    done: (table) => STACK - stackOf(table, GIVER),
    shows: (chips) => seatWith(GIVER, STACK - chips),
  },
  {
    what: 'the host’s own Add chips',
    name: 'Add chips',
    open: async (page) => {
      await page.locator('.controls [data-action="rebuy"]').tap();
      await dialogNamed(page, 'Add chips');
      await page.fill('#rebuy-amount', String(AMOUNT));
    },
    gate: 'asking',
    button: '.dialog [data-action="confirm-rebuy"]',
    doing: 'Adding…',
    gone: noDialog,
    done: (table) => stackOf(table, HOST) - STACK,
    shows: (chips) => seatWith(HOST, STACK + chips),
  },
];

/** Six seated with 2,000 each and nothing dealt, at a table that sells up to 10,000. */
const tableOfSix = (rig: Parameters<typeof seatedAndWatched>[0]): RigTable => {
  const table = seatedAndWatched(rig, 6);

  table.act(HOST, { type: 'updateConfig', config: { maxBuyIn: 10_000 } });

  return table;
};

const noAnswer = FORMS.map((form): Check => [
  `chips sent with no answer are not left at one try: the form stays with its button held while the page says it is checking, goes once the table is seen to have taken them, is sent once more under the same key when the table had not heard, and told to try again both times stays and says so in the line by its button: ${form.what}, on a phone`,
  async (rig) => {
    const table = tableOfSix(rig);
    const page = await table.open(HOST, 'smallPhone');
    const keys = keysSent(page);
    const gate = await Gate.on(page, form.gate);

    const sent = async (path: string) => {
      await form.open(page);
      await page.locator(form.button).tap();
      await gate.holding();
      assert.deepEqual(await buttonNow(page, form.button), { says: form.doing, held: true }, `${path}: the button pressed does not show that it was`);
    };

    // Taken by the table, and the answer lost on its way back: the page learns from the table that it went through
    await gate.close('answers');
    await sent('answer lost');
    await gate.lose();
    await toastTold(page, CHECKING);
    await form.gone(page);
    assert.equal(form.done(table), AMOUNT, 'answer lost: the table does not have the chips where they were sent');
    assert.equal(keys.length, 1, 'answer lost: what the table had taken was sent again');

    // Lost on its way to the table: the page finds the table has not heard, and sends it again itself
    const told = (await toasts(page)).length;

    await gate.close('requests');
    await sent('request lost');
    await gate.lose();
    await toastTold(page, CHECKING, told);
    await gate.holding();
    assert.deepEqual(await buttonNow(page, form.button), { says: form.doing, held: true }, 'request lost: the form let go of its button while the page was asking again');
    assert.equal(await page.locator('.overlay .dialog').getAttribute('aria-label'), form.name, 'request lost: the form went before anything was known');
    assert.equal(form.done(table), AMOUNT, 'request lost: the table took what the gate never let through');

    await gate.open();
    await form.gone(page);
    assert.equal(form.done(table), 2 * AMOUNT);
    assert.deepEqual([keys.length, keys[2] === keys[1], keys[1] === keys[0]], [3, true, false], 'the second asking went under another key than the first, or a new command under an old one');

    // Told to try again at both askings, with the table showing nothing done: the form stays as it was filled in, and says why by its button
    const said = (await toasts(page)).length;

    await gate.close('requests');
    await sent('told to try again');
    await gate.refuse();
    await gate.holding();
    await gate.refuse();
    await refusalTold(page, 'The table is busy');
    await page.waitForSelector(`${form.button}:enabled`);
    assert.equal(await page.locator('.overlay .dialog').getAttribute('aria-label'), form.name, 'told to try again: the form went, and nothing was done');
    assert.deepEqual((await toasts(page)).slice(said).flatMap(({ text }) => (text.includes('busy') ? [text] : [])), [], 'told to try again: a toast says what the form says by its button');
    assert.equal(form.done(table), 2 * AMOUNT, 'told to try again: the table took what the gate never let through');

    // Pressed again as the line asks, the same words go under the same key
    await gate.open();
    await page.locator(form.button).tap();
    await form.gone(page);
    assert.equal(form.done(table), 3 * AMOUNT);
    assert.deepEqual([keys.length, new Set(keys.slice(3)).size, keys[3] === keys[2]], [6, 1, false], 'a try after being told to try again went under another key');
    assert.ok(keys.every(isKey), 'a command that moves chips went without a key');
  },
]);

const filledInAgain = FORMS.map((form): Check => [
  `chips sent twice with no answer, the form gone, and filled in again move once: before the page has heard, the same words go under the same key, and once the table has shown them moved the form says so and sends nothing: ${form.what}, on a phone`,
  async (rig) => {
    const table = tableOfSix(rig);
    const page = await table.open(HOST, 'smallPhone');
    const keys = keysSent(page);
    const gate = await Gate.on(page, form.gate);
    const polls = await Gate.on(page, 'polls');

    // The first asking never reaches the table. The page asks again, and that one the table takes, its answer lost too.
    // `unseen`: the table's news stops reaching the page before the table takes it, or a poll would show the page the chips
    const takenUnheard = async (unseen: boolean) => {
      await gate.close('requests');
      await form.open(page);
      await page.locator(form.button).tap();
      await gate.holding();
      await gate.lose();
      await gate.holding();

      if (unseen) {
        await polls.close('requests');
      }

      await gate.close('answers');
      await gate.holding();
      await gate.lose();
      await form.gone(page);
    };

    // Whoever sent the chips sees nothing of them, and sends them again
    await takenUnheard(true);
    assert.equal(form.done(table), AMOUNT, 'the table did not take the second asking, so the check shows nothing');

    await form.open(page);
    await page.locator(form.button).tap();
    await gate.holding();
    await gate.open();
    await form.gone(page);
    await polls.open();

    assert.equal(form.done(table), AMOUNT, 'filled in again before the page had heard, the form moved the chips a second time');
    assert.deepEqual([keys.length, new Set(keys).size], [3, 1], 'the same words went under more than one key while nothing was known of them');

    // The same again, and this time the table's news gets through: the page has drawn the chips where they went
    await page.waitForSelector(form.shows(AMOUNT));
    await takenUnheard(false);
    await gate.open();
    await page.waitForSelector(form.shows(2 * AMOUNT));

    const told = (await toasts(page)).length;

    await form.open(page);
    await page.locator(form.button).tap();
    await toastTold(page, 'That went through the first time', told);
    await form.gone(page);

    assert.equal(form.done(table), 2 * AMOUNT, 'filled in again after the table had shown the chips moved, the form moved them once more');
    assert.equal(keys.length, 5, 'what the table had shown done was sent again');
  },
]);

const requestOf = (page: Page) => page.locator('.banners .banner').first().innerText();

const staleAnswer: Check = [
  'Approve and Deny are for the request the page shows: one the player has changed since is neither granted nor turned down, the page says it has changed and draws the new one, and Approve then grants that, on a phone',
  async (rig) => {
    const table = seatedAndWatched(rig, 6);

    table.join(ASKING);
    table.act(ASKING, { type: 'requestSeat', seat: 7, buyIn: 500 });

    const page = await table.open(HOST, 'smallPhone');
    const polls = await Gate.on(page, 'polls');
    const seated = () => table.view(HOST).seats.find((seat) => seat?.name === ASKING)?.stack ?? null;

    await page.waitForSelector('.banners [data-action="approve"]');
    assert.match(await requestOf(page), /wants seat 8 with 500/);

    // The player asks for four times as much, which the host's page has not drawn
    await polls.close('requests');
    table.act(ASKING, { type: 'requestSeat', seat: 7, buyIn: 2000 });

    for (const action of ['deny', 'approve']) {
      const told = (await toasts(page)).length;

      await page.locator(`.banners [data-action="${action}"]`).tap();
      await toastTold(page, 'That request has changed', told);
      assert.equal(seated(), null, `${action}: the player was seated on an answer to a request they had changed`);
      assert.deepEqual(table.view(HOST).requests.map((request) => request.amount), [2000], `${action}: the request the host never saw was answered`);
    }

    await polls.open();
    await page.waitForFunction(`document.querySelector('.banners .banner')?.innerText.includes('2,000')`);
    await page.locator('.banners [data-action="approve"]').tap();
    await page.waitForSelector('.banners .banner', { state: 'detached' });
    assert.equal(seated(), 2000);
  },
];

/** The checks of what is done once however often it is asked. */
export const ONCE_CHECKS: Check[] = [...noAnswer, ...filledInAgain, staleAnswer];
