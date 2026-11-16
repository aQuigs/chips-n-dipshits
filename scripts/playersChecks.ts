/*
 * The checks of a row of the Players dialog: what it keeps in sight and what it folds away behind
 * "More"; that a row unfolded stays so until its player leaves it or the dialog is opened anew; where
 * the keyboard is as a row unfolds; and that six seated fit a phone. They run with the other browser
 * checks (`screenChecks.ts`). That a second tap presses nothing "More" brings up under it is among the
 * layout sweep's own dialogs (`OWN_DIALOGS` in `layoutSweep.ts`).
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { Sweep, tabTo } from './accessibilityChecks.ts';
import type { Check } from './checkRunner.ts';
import { commandsSent } from './pageSpies.ts';
import { CANCEL, CLOSE, dialogNamed, EIGHT, fromMenu, HOST, keyboardOn, more, named, noDialog, on, playersFromTheKeyboard, row, seated, seatedAndWatched, WATCHER } from './playersDialog.ts';
import { tapsLive } from './underTheFinger.ts';

const TOOLS = '.dialog .list-tools';

const inSight = (page: Page, rowOf: string) => page.locator(`${rowOf} button:visible`).allInnerTexts();
/** The rows that are unfolded, each as its "More" is named. */
const unfolded = (page: Page) => page.locator('.dialog [data-action="more"][aria-expanded="true"]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));

/** Whether the button of the open dialog that `selector` finds, in plain CSS, is drawn in the color of danger. */
const drawnAsDanger = (page: Page, selector: string) =>
  page.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    const probe = button.closest('.dialog').appendChild(document.createElement('i'));

    probe.style.background = 'var(--bad)';
    const danger = getComputedStyle(probe).backgroundColor;
    probe.remove();

    return getComputedStyle(button).backgroundColor === danger;
  })()`) as Promise<boolean>;

const rowsFoldAway: Check = [
  'a row of Players keeps what a host does every night and folds the rest behind “More”, a button that says whether it is unfolded and names what it unfolds: unfolded, the row shows who helps run the table, who runs it and Remove, which alone is in the color of danger; the host’s own row has no “More” and no Remove; and what is done to the whole table stands over the list, on a phone and a desktop',
  async (rig) => {
    for (const screen of ['tallPhone', 'desktop'] as const) {
      const table = seatedAndWatched(rig);
      const page = await table.open(HOST, screen);
      const sent = commandsSent(page);

      const press = async (selector: string) => {
        await tapsLive(page);
        await (screen === 'desktop' ? page.click(selector) : page.tap(selector));
      };

      await fromMenu(page, press, 'players');
      await dialogNamed(page, 'Players');

      assert.deepEqual(await page.locator(`${row(HOST)} button`).allInnerTexts(), ['Set stack', 'Move'], `${screen}: the host’s own row`);
      assert.deepEqual(await inSight(page, row(WATCHER)), ['More'], `${screen}: the row of someone watching`);

      for (const name of EIGHT.slice(1)) {
        assert.deepEqual(await inSight(page, row(name)), ['Set stack', 'Move', 'More'], `${screen}: what ${name}’s row keeps in sight`);
        assert.deepEqual(await page.locator(`${row(name)} .row-more button`).allInnerTexts(), ['Make co-host', 'Make host', 'Remove'], `${screen}: what ${name}’s row folds away`);
      }

      assert.deepEqual(await unfolded(page), [], `${screen}: a row is unfolded before anyone asked`);

      // What is done to the whole table is over the list it is done to, and under its heading
      const tools = (await page.locator(TOOLS).boundingBox())!;
      const heading = (await page.locator('.dialog h3:text-is("Seated")').boundingBox())!;
      const first = (await page.locator(row(HOST)).boundingBox())!;

      assert.deepEqual(await page.locator(`${TOOLS} button`).allInnerTexts(), ['Transfer chips', 'Shuffle seats']);
      assert.ok(heading.y + heading.height <= tools.y && tools.y + tools.height <= first.y, `${screen}: the tools are not between the heading of the seated and their first row`);

      // The button says what it is of, whether it is unfolded, and which part of the page it unfolds
      const toggle = page.locator(more('Marge'));
      const part = `[id="${await toggle.getAttribute('aria-controls')}"]`;

      assert.equal(await toggle.getAttribute('aria-label'), 'More, Marge');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator(part).isHidden(), true, `${screen}: what “More” names as its own is in sight before it is pressed`);

      await press(more('Marge'));
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.deepEqual(await page.locator(`${part} button:visible`).allInnerTexts(), ['Make co-host', 'Make host', 'Remove'], `${screen}: what “More” unfolds is not what it names as its own`);
      assert.deepEqual(await unfolded(page), ['More, Marge'], `${screen}: one “More” unfolded another row`);

      // In place: under the line of the row "More" is on, and over the next row. Where the rows around it go depends on whether the dialog has room to grow
      const [kept, came, next] = [(await page.locator(`${row('Marge')} .row-actions:not(.row-more)`).boundingBox())!, (await page.locator(part).boundingBox())!, (await page.locator(row('Stu')).boundingBox())!];

      assert.ok(kept.y + kept.height <= came.y && came.y + came.height <= next.y, `${screen}: the row did not unfold in place, between its own buttons and the next row`);

      for (const [says, danger] of [['Make co-host', false], ['Make host', false], ['Remove', true], ['Set stack', false], ['More', false]] as const) {
        assert.equal(await drawnAsDanger(page, named(says, 'Marge')), danger, `${screen}: ${says} is drawn as ${danger ? 'any other button' : 'danger'}`);
      }

      await press(more('Marge'));
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator(part).isHidden(), true, `${screen}: a second press of “More” did not fold the row again`);
      assert.deepEqual(sent, [], `${screen}: unfolding a row sent the table something`);
      await page.context().close();
    }
  },
];

const unfoldedStays: Check = [
  'a row unfolded stays unfolded when the table’s news draws the list again and when its reader comes back from Set stack or from a question, a watching player’s row as a seated one’s; it is folded once its player has left it, among those watching and when seated again; and every row is folded when Players is opened anew',
  async (rig) => {
    const table = seatedAndWatched(rig);

    table.join('Nana');

    const page = await table.open(HOST, 'desktop');
    const press = async (selector: string) => {
      await tapsLive(page);
      await page.click(selector);
    };

    await fromMenu(page, press, 'players');
    await press(more('Marge'));
    await press(more(WATCHER));
    assert.deepEqual(await unfolded(page), ['More, Marge', `More, ${WATCHER}`]);

    // Someone asks for a seat: the list is drawn again, with a part of its own over it
    table.act('Nana', { type: 'requestSeat', seat: 8, buyIn: 500 });
    await page.waitForSelector('.dialog [data-action="approve"]');
    assert.deepEqual(await unfolded(page), ['More, Marge', `More, ${WATCHER}`], 'the table’s news folded a row its reader had unfolded');
    assert.equal(await page.locator(on('Marge', 'remove')).isVisible(), true);
    assert.equal(await page.locator(on(WATCHER, 'remove')).isVisible(), true);

    await press(seated('Marge'));
    await dialogNamed(page, 'Set Marge\'s stack');
    await press(CLOSE);
    await dialogNamed(page, 'Players');
    assert.deepEqual(await unfolded(page), ['More, Marge', `More, ${WATCHER}`], 'back from Set stack a row is folded again');

    await press(on('Marge', 'remove'));
    await dialogNamed(page, 'Remove Marge?');
    await press(CANCEL);
    await dialogNamed(page, 'Players');
    assert.deepEqual(await unfolded(page), ['More, Marge', `More, ${WATCHER}`], 'back from a question a row is folded again');

    // She stands up, and has a row among those watching: not the row that was unfolded
    table.act('Marge', { type: 'standUp' });
    await page.waitForSelector(seated('Marge'), { state: 'detached' });
    assert.equal(await page.locator(more('Marge')).count(), 1, 'someone who has played has no row among those watching');
    assert.deepEqual(await unfolded(page), [`More, ${WATCHER}`], 'a row is still unfolded with its player gone from it');

    table.seat('Marge', 2, 2000);
    await page.waitForSelector(seated('Marge'));
    assert.deepEqual(await unfolded(page), [`More, ${WATCHER}`], 'seated again, a player is found with their row unfolded');

    await press(CLOSE);
    await noDialog(page);
    await fromMenu(page, press, 'players');
    await dialogNamed(page, 'Players');
    assert.deepEqual(await unfolded(page), [], 'Players opened anew has a row unfolded from the last time');
  },
];

const PHONE = { width: 390, height: 844 };

// Run in the page: where the list of players shows, how far it is scrolled, and where each seated player's row and the tools over them lie
const SEATED_ROWS = `(() => {
  const box = (element) => {
    const { top, bottom } = element.getBoundingClientRect();

    return { top, bottom };
  };
  const list = document.querySelector('.dialog-body');

  return { shows: box(list), scrolled: list.scrollTop, tools: box(document.querySelector(${JSON.stringify(TOOLS)})), rows: [...document.querySelectorAll('.dialog li.seated')].map(box) };
})()`;

interface SeatedRows {
  shows: { top: number; bottom: number };
  scrolled: number;
  tools: { top: number; bottom: number };
  rows: { top: number; bottom: number }[];
}

const sixFitAPhone: Check = [
  'on a 390 by 844 phone a host sees all six seated players and the tools over them when Players opens, with nothing scrolled, each row with its buttons in sight',
  async (rig) => {
    const table = seatedAndWatched(rig, 6);
    const page = await table.open(HOST, 'tallPhone');

    assert.deepEqual(page.viewportSize(), PHONE, 'the phone this check is about is no longer the tall one of the rig');
    await fromMenu(page, (selector) => page.tap(selector), 'players');
    await dialogNamed(page, 'Players');

    const { shows, scrolled, tools, rows } = (await page.evaluate(SEATED_ROWS)) as SeatedRows;

    assert.equal(rows.length, 6);
    assert.equal(scrolled, 0);
    assert.ok(tools.top >= shows.top, 'the tools over the list are cut off');
    assert.deepEqual(rows.filter((one) => one.top < shows.top || one.bottom > shows.bottom), [], `a seated player’s row is not all in sight in a list that shows ${shows.top} to ${shows.bottom}`);
    assert.equal(await page.locator('.dialog li.seated button:visible').count(), 2 + 5 * 3, 'a seated player’s row shows other buttons than Set stack, Move and “More”');
  },
];

const keyboardUnfolds: Check = [
  'from the keyboard “More” unfolds its row at Enter and folds it at Space, and keeps the keyboard both times; what it unfolded is the next stop after it, and folded again is no stop; the keyboard stays on “More” and on a button it unfolded when the table’s news draws the list again; and the list with a row unfolded breaks no rule of the rule engine in any theme',
  async (rig) => {
    const table = seatedAndWatched(rig);

    table.join('Nana');

    const page = await table.open(HOST, 'desktop');
    const expanded = () => page.getAttribute(named('More', 'Marge'), 'aria-expanded');

    await playersFromTheKeyboard(page);

    await tabTo(page, named('More', 'Marge'));
    await page.keyboard.press('Enter');
    assert.equal(await expanded(), 'true');
    assert.equal(await keyboardOn(page), 'More, Marge', 'unfolding a row took the keyboard off the button that unfolds it');

    // The table's news draws the list again, under a keyboard that stays where it is
    table.act('Nana', { type: 'requestSeat', seat: 8, buyIn: 500 });
    await page.waitForSelector('.dialog [data-action="approve"]');
    assert.equal(await keyboardOn(page), 'More, Marge', 'the list drawn again took the keyboard off “More”');
    assert.equal(await expanded(), 'true');

    await page.keyboard.press('Tab');
    assert.equal(await keyboardOn(page), 'Make co-host, Marge', 'what a row unfolds is not the next stop after the button that unfolds it');

    table.act('Nana', { type: 'cancelRequest' });
    await page.waitForSelector('.dialog [data-action="approve"]', { state: 'detached' });
    assert.equal(await keyboardOn(page), 'Make co-host, Marge', 'the list drawn again took the keyboard off a button a row had unfolded');

    const sweep = new Sweep();

    await sweep.over(page, 'Players with a row unfolded');
    sweep.done(1);

    await tabTo(page, named('More', 'Marge'), 'Shift+Tab');
    await page.keyboard.press('Space');
    assert.equal(await expanded(), 'false');
    assert.equal(await keyboardOn(page), 'More, Marge', 'folding a row took the keyboard off the button that folds it');

    await page.keyboard.press('Tab');
    assert.equal(await keyboardOn(page), 'Set stack, Stu', 'a button folded away is still a stop for the keyboard');
    assert.deepEqual(table.view(HOST).cohostIds, []);
  },
];

/** The checks of the rows of the Players dialog. */
export const PLAYERS_CHECKS: Check[] = [rowsFoldAway, unfoldedStays, sixFitAPhone, keyboardUnfolds];
