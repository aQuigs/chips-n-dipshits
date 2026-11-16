/*
 * The check of a hand's line in Hand history. It runs with the other browser checks (`screenChecks.ts`);
 * the layout sweep also looks at the history on every screen (`layoutSweep.ts`).
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { Sweep } from './accessibilityChecks.ts';
import type { Check } from './checkRunner.ts';
import { passive } from './layoutSweep.ts';
import { CLOSE, dialogNamed, fromMenu, HOST, noDialog } from './playersDialog.ts';
import { tapsLive } from './underTheFinger.ts';

const SIX = [HOST, 'Stu', 'Big Al', 'Pocket Pam', 'Marge', 'Zed'];

/** A line as the browser hands it to a screen reader, which is where it says that the line opens and whether it is open. */
async function read(page: Page, selector: string) {
  const session = await page.context().newCDPSession(page);
  const { root } = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  const { nodes } = await session.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  const [node] = nodes;

  await session.detach();

  return {
    role: String(node?.role?.value),
    name: String(node?.name?.value),
    expanded: node?.properties?.find((property) => property.name === 'expanded')?.value.value as boolean | undefined,
  };
}

/** The fold mark of a line, as it is drawn. */
interface Mark {
  glyph: string;
  hidden: string | null;
  color: string;
  size: string;
}

/** A hand's line as it is drawn: how many lines its number takes, its mark, and what of it is cut. */
interface Line {
  hand: string;
  numberOn: number;
  mark: (Mark & { turned: boolean }) | null;
  cut: string[];
}

const MARK = `(mark) => ({ glyph: mark.textContent, hidden: mark.getAttribute('aria-hidden'), color: getComputedStyle(mark).color, size: getComputedStyle(mark).fontSize })`;

const lines = (page: Page) =>
  page.evaluate(`[...document.querySelectorAll('.history details')].map((hand) => {
    const line = hand.querySelector('summary');
    const box = line.getBoundingClientRect();
    const mark = line.querySelector(':scope > .fold');

    const outside = (part) => {
      const { left, right, width } = part.getBoundingClientRect();

      return width === 0 || left < box.left - 0.5 || right > box.right + 0.5 || part.scrollWidth > part.clientWidth;
    };

    return {
      hand: hand.dataset.hand,
      numberOn: line.querySelector('.hand-number').getClientRects().length,
      mark: mark && { ...(${MARK})(mark), turned: getComputedStyle(mark).transform !== 'none' },
      cut: [...line.children].filter(outside).map((part) => part.tagName.toLowerCase()).concat(line.scrollWidth > line.clientWidth ? ['the line'] : []),
    };
  })`) as Promise<Line[]>;

const rowsSayTheyOpen: Check = [
  'a hand in Hand history says that it opens, with the mark a player’s line of Tonight carries and to a screen reader as that line does, and says when it is open; opened, its lines are in the font and at the size of the same lines in the chat, breaking no rule in any theme; and no line is cut, a pot six players split among them, on a 360 phone at the standard and the largest text',
  async (rig) => {
    const sweep = new Sweep();

    for (const textSize of ['standard', 'largest']) {
      const table = rig.table(SIX.map((name) => ({ name, stack: 2000 })));
      const over = () => table.view(HOST).hand === null;

      table.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Ks Kh' }, board: '2c 7d 9h Jc 3s' });
      table.act(HOST, { type: 'pause' });
      table.play(passive, over);
      // The board is the best hand of everyone who stays, so the pot is split among them all
      table.dealNext({ board: 'As Ks Qs Js Ts' });
      table.act(HOST, { type: 'pause' });
      table.play(passive, over);

      const page = await table.open(HOST, 'smallPhone', `localStorage.setItem('cnd.textSize', '${textSize}')`);
      const split = '.history details[data-hand="2"]';

      const press = async (selector: string) => {
        await tapsLive(page);
        await page.locator(selector).tap();
      };

      await fromMenu(page, press, 'tonight');
      await dialogNamed(page, 'Tonight');

      const tonights = (await page.evaluate(`(${MARK})(document.querySelector('.tonight-players summary > .fold'))`)) as Mark;
      const tonightsRead = await read(page, '.tonight-players summary');

      assert.deepEqual([tonights.glyph, tonights.hidden, tonightsRead.expanded], ['▾', 'true', false], `${textSize}: a line of Tonight is not what this check takes it for`);
      await press(CLOSE);
      await noDialog(page);

      await fromMenu(page, press, 'history');
      await dialogNamed(page, 'Hand history');
      await page.waitForSelector(split);

      const folded = await lines(page);

      assert.equal((await page.locator(`${split} small`).innerText()).split(', ').length, SIX.length, `${textSize}: the pot was not split among all six, so no line here is a long one`);

      for (const line of folded) {
        assert.deepEqual(line.mark, { ...tonights, turned: false }, `${textSize}: hand #${line.hand} does not carry the mark of a line of Tonight`);
        assert.equal(line.numberOn, 1, `${textSize}: the number of hand #${line.hand} is broken over ${line.numberOn} lines`);
        assert.deepEqual(line.cut, [], `${textSize}: hand #${line.hand} is cut`);
      }

      const closed = await read(page, `${split} > summary`);

      assert.deepEqual([closed.role, closed.expanded], [tonightsRead.role, false], `${textSize}: a screen reader is not told that a hand opens as it is of a line of Tonight`);
      assert.match(closed.name, /^Hand #2 /);
      assert.doesNotMatch(closed.name, /▾/, `${textSize}: the mark is read out as part of the hand's name`);

      await press(`${split} > summary`);
      await page.waitForSelector(`${split}[open] pre`);
      assert.equal((await read(page, `${split} > summary`)).expanded, true, `${textSize}: a screen reader is not told that the hand is open`);

      const opened = await lines(page);

      assert.deepEqual(opened.map((line) => line.mark?.turned), [true, false], `${textSize}: the mark of the open hand is not turned over, or another's is`);
      assert.deepEqual(opened.map((line) => line.cut), [[], []], `${textSize}: a line is cut with a hand open`);

      const set = (await page.evaluate(`(() => {
        const hand = document.querySelector('.history details[open] pre');
        const face = (element) => getComputedStyle(element).fontFamily;
        const size = (element) => getComputedStyle(element).fontSize;

        const chat = document.querySelector('.feed .entries');

        return { hand: [face(hand), size(hand)], chat: [face(chat), size(chat)], cut: hand.scrollWidth > hand.clientWidth };
      })()`)) as { hand: string[]; chat: string[]; cut: boolean };

      assert.deepEqual(set.hand, set.chat, `${textSize}: an opened hand's lines are not in the font and at the size of the same lines in the chat`);
      assert.equal(set.cut, false, `${textSize}: a line of the opened hand is cut`);

      await sweep.over(page, `the history with a hand open, ${textSize} text`);
      await page.context().close();
    }

    sweep.done(2);
  },
];

/** The checks of Hand history's lines. */
export const HISTORY_CHECKS: Check[] = [rowsSayTheyOpen];
