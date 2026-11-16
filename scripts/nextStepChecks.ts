/*
 * The checks of the button a host and a player need next at the two ends of a night: Invite players on
 * the felt until two are seated, and once the night is over the way to who pays whom, in the bar, in
 * the recap and as text to copy. They run with the other browser checks (`screenChecks.ts`).
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { DEFAULT_CONFIG } from '../src/engine/index.ts';
import type { Check } from './checkRunner.ts';
import { telling, unreadable } from './covered.ts';
import { NEXT_FRAME, TEXT_SIZES } from './layoutSweep.ts';
import { SCREENS, squeezed } from './rig.ts';
import type { Rig, RigTable } from './rig.ts';
import { namedByTheWatch, tellingOf, watched, watchTheBar } from './underTheFinger.ts';

const HOST = 'Quigs';
const PLAYER = 'Danny';
const THIRD = 'Marge';
const WATCHER = 'Zed';
const LYING = { width: 740, height: 360 };

const STAKES = { smallBlind: 10, bigBlind: 20, minBuyIn: 100, maxBuyIn: 20_000, actionSeconds: 0 };

const INVITE = '.message [data-action="invite-players"]';
const START = '.message [data-action="start"]';
const DIALOG = '.overlay .dialog';
const RECAP = '.dialog[aria-label="Tonight"] .tonight-crown';
const LEDGER = '.dialog[aria-label="Ledger"]';

const said = (page: Page, selector: string): Promise<string[]> => page.locator(selector).allInnerTexts();

async function closed(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForSelector(DIALOG, { state: 'detached' });
}

/** The menu's lines that start or resume the game, as a host has them now. */
async function startInTheMenu(page: Page): Promise<number> {
  await page.click('[data-action="menu"]');
  await page.waitForSelector('.menu');

  const lines = await page.locator('.menu [data-action="start"]').count();

  await closed(page);

  return lines;
}

const inviteUntilTwoAreSeated = (picturesIn: string): Check => [
  'a host alone at a new table is offered Invite players on the felt, which opens the invitation, and no way to start on the felt or in the menu, with nothing of it cut off or covered on a 360 phone standing and lying and on the desktop at every size of text; Start the game takes its place when the second player sits down, and takes no tap in the moment it comes up there',
  async (rig) => {
    const table = rig.table([{ name: HOST, stack: 2000 }], STAKES);
    const page = await table.open(HOST, 'smallPhone');

    await page.waitForSelector(INVITE);
    assert.equal(await page.locator(START).count(), 0, 'Start is on the felt with one player seated');
    assert.equal(await startInTheMenu(page), 0, 'the menu offers to start with one player seated');

    for (const size of [{ name: 'a 360 phone', ...SCREENS.smallPhone }, { name: 'a phone lying', ...LYING }, { name: 'the desktop', ...SCREENS.desktop }]) {
      await page.setViewportSize(size);

      for (const text of TEXT_SIZES) {
        await page.evaluate(`document.querySelector('#app').setAttribute('data-text-size', ${JSON.stringify(text)})`);
        await page.evaluate(NEXT_FRAME);
        await page.evaluate(NEXT_FRAME);

        const where = `${size.name}, ${text} text`;

        assert.deepEqual(await squeezed(page, `.message > div, ${INVITE}`), [], `${where}: what the felt says or its button is cut off`);
        assert.deepEqual((await unreadable(page)).map(telling), [], `${where}: something of the table cannot be read`);
      }
    }

    await page.evaluate(`document.querySelector('#app').setAttribute('data-text-size', ${JSON.stringify(TEXT_SIZES[0])})`);
    await page.setViewportSize(SCREENS.smallPhone);
    await page.screenshot({ path: `${picturesIn}check-next-step-invite-players-smallPhone.png` });

    await page.click(INVITE);
    await page.waitForSelector('.dialog[aria-label="Invite players"] input');
    await closed(page);

    // The second player asks, and the host's page learns of the seat by itself: the gold button changes where it lies
    table.join(PLAYER);
    table.act(PLAYER, { type: 'requestSeat', seat: 4, buyIn: 2000 });
    await table.heardBy(page);
    await watchTheBar(page);

    const invite = await namedByTheWatch(page, INVITE);

    table.act(HOST, { type: 'approve', playerId: table.auth(PLAYER).id });
    await page.waitForSelector(START);

    const under = (await watched(page)).found.filter((one) => one.aimedAt === invite);

    assert.ok(under.length > 0, 'nothing came up where Invite players lay, so nothing is shown of a tap on its way there');
    assert.deepEqual(under.flatMap(tellingOf), [], 'a tap on its way to Invite players starts the game');
    assert.equal(await page.innerText(START), 'Start the game');
    assert.equal(await page.locator(INVITE).count(), 0);
    assert.equal(await startInTheMenu(page), 1, 'the menu does not offer to start with two seated');
    await page.screenshot({ path: `${picturesIn}check-next-step-start-smallPhone.png` });

    // Anyone can still invite from the top bar, and a start pressed now deals to the two who are there
    await page.click(START);
    await page.waitForSelector('.message [data-countdown]');
    assert.equal(table.view(HOST).running, true);
  },
];

/** Three at 10/20 and someone watching, in the last hand of the night: the host has taken 100 from one player and the big blind from the other, and one fold ends it. */
function lastHand(rig: Rig): RigTable {
  const table = rig.table(
    [
      { name: HOST, stack: 2000 },
      { name: PLAYER, stack: 2000 },
      { name: THIRD, stack: 2000 },
    ],
    STAKES,
  );

  table.join(WATCHER);
  table.deal({ button: 0 });
  table.act(HOST, { type: 'setLastHands', hands: 0 });
  table.act(HOST, { type: 'raise', to: 100 });
  table.act(PLAYER, { type: 'call' });
  table.act(THIRD, { type: 'fold' });
  table.act(PLAYER, { type: 'check' });
  table.act(HOST, { type: 'raise', to: 200 });

  return table;
}

const PAYMENTS = [`${PLAYER} pays ${HOST} 100`, `${THIRD} pays ${HOST} 20`];

const settleUpIsAtHand = (picturesIn: string): Check => [
  'once the night is over the recap tells each player their own part of who pays whom and leads to the Ledger, the bar under the table offers Settle up and Tonight beside the last hand to see again, to a player and to someone watching, and the Ledger’s list copies as text with the very sums it shows',
  async (rig) => {
    const table = lastHand(rig);
    const pages: [who: string, page: Page, own: string[]][] = [
      ['a player who lost', await table.open(PLAYER, 'smallPhone'), [`You pay ${HOST} 100`]],
      ['the host, who won', await table.open(HOST, 'desktop'), [`${PLAYER} pays you 100`, `${THIRD} pays you 20`]],
      ['someone watching', await table.open(WATCHER, 'smallPhone'), []],
    ];

    // The night ends under their eyes: a page opened after it is not shown the recap by itself
    for (const [, page] of pages) {
      await table.heardBy(page);
    }

    table.act(PLAYER, { type: 'fold' });
    table.play(
      () => null,
      (view) => view.nightEndedAt !== null,
    );

    for (const [who, page, own] of pages) {
      // The recap opens by itself, with the viewer's own payments over the way to all of them
      await page.waitForSelector(RECAP);
      assert.deepEqual(await said(page, '.tonight-settle b'), own, `${who}: their own part of who pays whom`);
      assert.deepEqual(await squeezed(page, '.tonight-settle > *'), [], `${who}: a payment or the button is cut off`);

      if (who !== 'the host, who won') {
        await page.screenshot({ path: `${picturesIn}check-next-step-recap-${who === 'someone watching' ? 'watcher' : 'player'}-smallPhone.png` });
      }

      await page.click('.tonight-settle [data-action="settle-up"]');
      await page.waitForSelector(LEDGER);
      assert.deepEqual(await said(page, '.settle li'), PAYMENTS, `${who}: the Ledger's list`);
      await closed(page);

      // The bar: what is left to do, and the last hand again for whoever has a seat
      const bar = await said(page, '.controls .spare-line button');

      assert.deepEqual(bar.slice(0, 2), ['Settle up', 'Tonight'], `${who}: the bar's buttons`);
      assert.equal(bar.length, who === 'someone watching' ? 2 : 3, `${who}: the last hand to see again is for whoever has a seat`);
      assert.deepEqual(await squeezed(page, '.controls .spare-line button'), [], `${who}: a button of the bar is cut off`);
      assert.deepEqual((await unreadable(page)).map(telling), [], `${who}: something of the table cannot be read`);

      await page.click('.controls [data-action="tonight"]');
      await page.waitForSelector(RECAP);
      await closed(page);
    }

    const [, player] = pages[0]!;

    await player.screenshot({ path: `${picturesIn}check-next-step-night-over-bar-smallPhone.png` });
    await player.click('.controls [data-action="settle-up"]');
    await player.waitForSelector(LEDGER);

    // Real money: what is pasted in the group chat is the list on the screen, sum for sum
    await player.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await player.click('[data-action="copy-settle"]');
    await player.waitForSelector('[data-action="copy-settle"]:has-text("Copied")');

    const copied = ((await player.evaluate('navigator.clipboard.readText()')) as string).split('\n');

    assert.deepEqual(copied, [`${DEFAULT_CONFIG.name}: to settle up`, ...(await said(player, '.settle li'))]);
    assert.deepEqual(copied.slice(1), PAYMENTS);
    assert.equal(await player.locator('#settle-text:visible').count(), 0, 'the box to copy from is shown though the text was copied');
    assert.deepEqual(await squeezed(player, '.settle li, .copy-text > *'), [], 'a payment or the button to copy is cut off');
    await player.screenshot({ path: `${picturesIn}check-next-step-ledger-copy-smallPhone.png` });
  },
];

/** The checks of the next step at the start and the end of a night. Pictures go into `picturesIn`, a folder ending in a slash. */
export function nextStepChecks(picturesIn: string): Check[] {
  return [inviteUntilTwoAreSeated(picturesIn), settleUpIsAtHand(picturesIn)];
}
