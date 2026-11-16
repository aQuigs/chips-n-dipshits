/*
 * The checks of the two links a table hands out: the one that is sent to friends, alone in Invite
 * players, and a member's own, which is their seat to whoever opens it, in a dialog to itself. They
 * run with the other browser checks (`screenChecks.ts`).
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import type { Check } from './checkRunner.ts';
import { openTheMenu, textSize, TEXT_SIZES } from './layoutSweep.ts';
import { boxes, pressOn, squeezed } from './rig.ts';
import type { Rig } from './rig.ts';

const [HOST, PLAYER, THIRD, WATCHER] = ['Quigs', 'Danny', 'Marge', 'Kibitz'];
const SCREEN = 'smallPhone';

const GIVES_AWAY = 'Keep it to yourself: whoever opens it plays as you and sees your cards.';

/** Everything the open dialog draws, as the page holds it: its markup, and what stands in its boxes, which the markup does not show. */
const DRAWN = `(() => {
  const dialog = document.querySelector('.overlay');

  return [dialog.outerHTML, ...[...dialog.querySelectorAll('input, textarea')].map((box) => box.value)].join('\\n');
})()`;

/** The buttons of the open dialog but the one that closes it, each as what it says and whether it is the gold one. */
const BUTTONS = `[...document.querySelectorAll('.dialog-body button')].map((button) => [button.textContent, button.classList.contains('primary')])`;

const copied = (page: Page) => page.evaluate('navigator.clipboard.readText()') as Promise<string>;

/** Whose tokens are in what the open dialog draws. */
async function tokensDrawn(page: Page, tokens: Map<string, string>): Promise<string[]> {
  const drawn = (await page.evaluate(DRAWN)) as string;

  return [...tokens].filter(([, token]) => drawn.includes(token)).map(([name]) => name);
}

/** The open dialog at every size of text: nothing in it cut short, and its button whole on the screen. */
async function wholeAtEverySize(page: Page, button: string, where: string): Promise<void> {
  const { width, height } = page.viewportSize()!;

  for (const size of TEXT_SIZES) {
    await textSize(page, size);
    await page.locator(button).scrollIntoViewIfNeeded();

    const [box] = await boxes(page, button);

    assert.deepEqual(await squeezed(page, '.dialog h2, .dialog-body button, .dialog-body label > span, .dialog-body p'), [], `${where}, ${size} text: something is cut short`);
    assert.ok(box && box.left >= 0 && box.top >= 0 && box.right <= width && box.bottom <= height, `${where}, ${size} text: the button runs off the screen: ${JSON.stringify(box)}`);
  }

  await textSize(page, TEXT_SIZES[0]!);
}

const linksAreApart = (picturesIn: string): Check => [
  'Invite players holds the table’s link and nothing that is one member’s: no token is anywhere in what it draws, for the host, a player and someone watching, and its one gold button says it copies the invite link and copies that; Play on another device, in the viewer’s part of the menu, holds the viewer’s personal link and nobody else’s, says over the link what it gives away, and its plain button says it copies my link and copies that; opened in another browser, the link asks whether to go on as the viewer; both dialogs are whole on a 360 phone at every size of text',
  async (rig: Rig) => {
    const table = rig.table([HOST, PLAYER, THIRD].map((name) => ({ name, stack: 2000 })));

    table.join(WATCHER);

    const tokens = new Map([HOST, PLAYER, THIRD, WATCHER].map((name) => [name, table.auth(name).token]));

    for (const viewer of [HOST, PLAYER, WATCHER]) {
      const page = await table.open(viewer, SCREEN);
      const press = pressOn(page, SCREEN);
      const { id, token } = table.auth(viewer);

      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

      // Invite players: the link for friends, and no member in it
      await press('.topbar [data-action="invite"]');
      await page.waitForSelector('.dialog #table-link');

      const invite = new URL(await page.inputValue('#table-link'));

      assert.deepEqual([...invite.searchParams], [['table', table.id]], `${viewer}: the link to send carries more than the table`);
      assert.deepEqual(await tokensDrawn(page, tokens), [], `${viewer}: Invite players draws a member’s token`);
      assert.equal(await page.locator('.dialog #member-link').count(), 0, `${viewer}: Invite players has a box for a personal link`);
      assert.deepEqual(await page.evaluate(BUTTONS), [['Copy invite link', true]], `${viewer}: the buttons of Invite players`);
      await wholeAtEverySize(page, '[data-copy="table-link"]', `${viewer}, Invite players`);

      if (viewer === PLAYER) {
        await page.screenshot({ path: `${picturesIn}check-invite-links-invite-${SCREEN}.png` });
      }

      await press('[data-copy="table-link"]');
      await page.waitForSelector('[data-copy="table-link"]:text-is("Copied")');
      assert.equal(await copied(page), invite.href, `${viewer}: what Copy invite link copied`);
      assert.deepEqual(await tokensDrawn(page, tokens), [], `${viewer}: Invite players draws a member’s token once its link is copied`);
      await press('.dialog [data-action="close"]');
      await page.waitForSelector('.dialog', { state: 'detached' });

      // Play on another device: the viewer's own link, and nobody else's
      await press('[data-action="menu"]');
      await page.waitForSelector('.menu .menu-item');
      assert.equal(await page.innerText('.menu > section:has(h3:text-is("You")) [data-action="otherDevice"]'), 'Play on another device', `${viewer}: the line of the menu`);
      await page.locator('.menu [data-action="otherDevice"]').scrollIntoViewIfNeeded();
      await press('.menu [data-action="otherDevice"]');
      await page.waitForSelector('.dialog #member-link');

      const own = new URL(await page.inputValue('#member-link'));

      assert.equal(await page.innerText('.dialog h2'), 'Play on another device', viewer);
      assert.deepEqual([...own.searchParams], [['table', table.id], ['me', `${id}.${token}`]], `${viewer}: the personal link is not the viewer’s own`);
      assert.deepEqual(await tokensDrawn(page, tokens), [viewer], `${viewer}: whose tokens Play on another device draws`);
      assert.deepEqual(await page.evaluate(BUTTONS), [['Copy my link', false]], `${viewer}: the buttons of Play on another device`);

      // What it gives away is read before the link, and said with the box and the button to whoever tabs to them
      const [warning] = await boxes(page, '.dialog .keep-to-yourself');
      const [box] = await boxes(page, '#member-link');

      assert.equal(await page.innerText('.dialog .keep-to-yourself'), GIVES_AWAY, viewer);
      assert.ok(warning && box && warning.bottom <= box.top, `${viewer}: the warning is not over the link: ${JSON.stringify([warning, box])}`);
      assert.deepEqual(
        await page.evaluate(`['#member-link', '[data-copy="member-link"]'].map((control) => document.getElementById(document.querySelector(control).getAttribute('aria-describedby')).textContent)`),
        [GIVES_AWAY, GIVES_AWAY],
        `${viewer}: the warning is not said with the box and the button`,
      );
      await wholeAtEverySize(page, '[data-copy="member-link"]', `${viewer}, Play on another device`);

      if (viewer === PLAYER) {
        await page.screenshot({ path: `${picturesIn}check-invite-links-other-device-${SCREEN}.png` });
      }

      await press('[data-copy="member-link"]');
      await page.waitForSelector('[data-copy="member-link"]:text-is("Copied")');
      assert.equal(await copied(page), own.href, `${viewer}: what Copy my link copied`);

      // On a browser that has never been at the table the link is the viewer's seat, once they say so
      const elsewhere = await rig.page(SCREEN, `${viewer} on another device`);

      await elsewhere.goto(own.href);
      await elsewhere.waitForSelector('[data-action="confirm-member"]');
      assert.equal(await elsewhere.innerText('[data-action="confirm-member"]'), `Yes, I’m ${viewer}`);
      await elsewhere.context().close();
      await page.context().close();
    }
  },
];

/** The checks of the table's two links. Pictures go into `picturesIn`, a folder ending in a slash. */
export function inviteLinksChecks(picturesIn: string): Check[] {
  return [linksAreApart(picturesIn)];
}
