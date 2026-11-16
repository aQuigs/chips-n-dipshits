/*
 * The checks of three small things in the bar under a phone's table: the line that says what the moves
 * to choose ahead are for and the mark on the one that is set, the chat's bar counting what people
 * said and keeping a person's line a few seconds, and the bet slider stopping at whole blinds. They
 * run with the other browser checks (`screenChecks.ts`).
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { betStops } from '../src/client/betStops.ts';
import { SPOKEN_HOLDS_MS } from '../src/client/chatBar.ts';
import { formatAmount } from '../src/engine/amounts.ts';
import type { Check } from './checkRunner.ts';
import { telling, unreadable } from './covered.ts';
import { NEXT_FRAME, TEXT_SIZES } from './layoutSweep.ts';
import { answeredAfter } from './pageSpies.ts';
import { boxes, squeezed } from './rig.ts';
import type { Rig, RigTable } from './rig.ts';

const HOST = 'Quigs';
const VIEWER = 'Danny';
const FRIEND = 'Marge';

const STAKES = { smallBlind: 10, bigBlind: 20, minBuyIn: 100, maxBuyIn: 20_000, actionSeconds: 0 };

/** Three at 10/20 with the first hand dealt: the host is first to act, and the viewer, in the small blind, waits with the moves to choose ahead. */
function waitingForTheHost(rig: Rig, viewerStack = 2000): RigTable {
  const table = rig.table(
    [
      { name: HOST, stack: 2000 },
      { name: VIEWER, stack: viewerStack },
      { name: FRIEND, stack: 2000 },
    ],
    STAKES,
  );

  table.deal({ button: 0 });

  return table;
}

const CHOICES = '.ahead-btn';
const TITLE = '.ahead-title';

/** Whether each choice is set, and what stands on its corner. */
const CHOICES_MARKED = `[...document.querySelectorAll('${CHOICES}')].map((choice) => ({
  set: choice.getAttribute('aria-pressed') === 'true',
  mark: getComputedStyle(choice, '::after').content,
}))`;

const NO_MARK = 'none';

/**
 * Where the mark of the choice that is set lies, and what it lies over: every run of words in the
 * waiting bar that any part of it covers, by the whole line the words are set in.
 */
const MARK_OVER = `(() => {
  const set = document.querySelector('${CHOICES}[aria-pressed="true"]');
  const mark = getComputedStyle(set, '::after');
  const pill = set.getBoundingClientRect();
  const left = pill.left + set.clientLeft + parseFloat(mark.left);
  const top = pill.top + set.clientTop + parseFloat(mark.top);
  const box = { left, top, right: left + parseFloat(mark.width), bottom: top + parseFloat(mark.height) };
  const words = document.createTreeWalker(document.querySelector('.controls .waiting'), NodeFilter.SHOW_TEXT);
  const covered = [];

  for (let node = words.nextNode(); node; node = words.nextNode()) {
    const range = document.createRange();

    range.selectNodeContents(node);

    if ([...range.getClientRects()].some((line) => line.width > 1 && line.left < box.right && line.right > box.left && line.top < box.bottom && line.bottom > box.top)) {
      covered.push(node.textContent);
    }
  }

  return { box, covered, says: mark.content, onScreen: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
})()`;

interface Mark {
  box: { left: number; top: number; right: number; bottom: number };
  covered: string[];
  says: string;
  onScreen: boolean;
}

async function textSize(page: Page, size: string): Promise<void> {
  await page.evaluate(`document.querySelector('#app').setAttribute('data-text-size', ${JSON.stringify(size)})`);
  await page.evaluate(NEXT_FRAME);
  await page.evaluate(NEXT_FRAME);
}

const choicesSayWhatTheyAreFor = (picturesIn: string): Check => [
  'under a phone’s table standing the moves to choose ahead have a line over them that says they are for the viewer’s turn, whole and clear of them at every size of text; whichever of the five is set carries a check mark that lies over no word of the bar, and no other does; the line goes with the choices an open chat takes, and the table is where it is on the viewer’s turn',
  async (rig) => {
    const table = waitingForTheHost(rig);
    const page = await table.open(VIEWER, 'smallPhone');
    // The big blind may check, which the small blind may not: between them every one of the five is on offer
    const blind = await table.open(FRIEND, 'smallPhone');

    await page.waitForSelector(CHOICES);
    await blind.waitForSelector(CHOICES);

    const marked = () => page.evaluate(CHOICES_MARKED) as Promise<{ set: boolean; mark: string }[]>;
    const fits = async (where: string) => {
      const [title] = await boxes(page, TITLE);
      const [bar] = await boxes(page, '.controls-slot');
      const choices = await boxes(page, CHOICES);

      assert.ok(title && (await page.locator(TITLE).isVisible()), `${where}: nothing says what the choices are for`);
      assert.equal(await page.innerText(TITLE), 'On your turn', where);
      assert.equal(choices.length, 5, where);
      assert.ok(title.top >= bar!.top && choices.every((choice) => title.bottom <= choice.top), `${where}: the line is not over the choices and in the bar: ${JSON.stringify({ title, bar, choices })}`);
      assert.deepEqual(await squeezed(page, `${TITLE}, ${CHOICES}, ${CHOICES} span`), [], `${where}: the line or a choice is cut off`);
      assert.deepEqual((await unreadable(page)).map(telling), [], `${where}: something of the page cannot be read`);
    };

    for (const size of TEXT_SIZES) {
      await textSize(page, size);
      await fits(`nothing set, ${size} text`);
    }

    await textSize(page, TEXT_SIZES[0]!);
    assert.deepEqual(await marked(), Array.from({ length: 5 }, () => ({ set: false, mark: NO_MARK })), 'a choice is marked with none set');

    const [waitingTable] = await boxes(page, '.stage');

    // Each of the five set in turn, by whoever is offered it: the words are nearest the mark at the largest text
    for (const [on, kind] of [
      [page, 'fold'],
      [blind, 'checkFold'],
      [blind, 'check'],
      [page, 'call'],
      [page, 'callAny'],
    ] as const) {
      await on.click(`${CHOICES}.ahead-${kind}`);
      await on.waitForSelector(`${CHOICES}.ahead-${kind}[aria-pressed="true"]`);

      for (const size of TEXT_SIZES) {
        await textSize(on, size);

        const mark = (await on.evaluate(MARK_OVER)) as Mark;

        assert.equal(mark.says, '"✓"', `${kind} set, ${size} text`);
        assert.deepEqual(mark.covered, [], `${kind} set, ${size} text: its mark lies over words, at ${JSON.stringify(mark.box)}`);
        assert.ok(mark.onScreen, `${kind} set, ${size} text: its mark runs off the screen, at ${JSON.stringify(mark.box)}`);
      }

      await textSize(on, TEXT_SIZES[0]!);
    }

    // Calling is on offer to the small blind, and is the fourth of the five
    await page.click(`${CHOICES}.ahead-call`);
    await page.waitForSelector(`${CHOICES}.ahead-call[aria-pressed="true"]`);
    assert.deepEqual(
      (await marked()).map(({ set, mark }) => [set, mark]),
      [false, false, false, true, false].map((set) => [set, set ? '"✓"' : NO_MARK]),
      'the mark is not on the choice that is set, and on that one alone',
    );

    for (const size of TEXT_SIZES) {
      await textSize(page, size);
      await fits(`Call set, ${size} text`);
    }

    await textSize(page, TEXT_SIZES[0]!);
    assert.deepEqual(await boxes(page, '.stage'), [waitingTable], 'setting a choice moved the table');
    await page.screenshot({ path: `${picturesIn}check-bar-small-choices-smallPhone.png` });

    // An open chat takes the choices that are not set, and their line with them: the one left is the viewer's own
    await page.click('.feed-toggle');
    await page.waitForSelector('.feed.open');
    await page.waitForSelector(TITLE, { state: 'hidden' });
    assert.ok(await page.locator(`${CHOICES}[aria-pressed="true"]`).isVisible(), 'the choice that is set went with the others');
    assert.equal((await marked())[3]!.mark, '"✓"');
    await page.click('.feed-toggle');
    await page.waitForSelector(TITLE);

    // Taken back, nothing is marked
    await page.click(`${CHOICES}[aria-pressed="true"]`);
    await page.waitForSelector(`${CHOICES}[aria-pressed="true"]`, { state: 'detached' });
    assert.ok((await marked()).every(({ mark }) => mark === NO_MARK), 'a choice taken back kept its mark');

    // The turn comes: the line was no height the table paid for
    table.act(HOST, { type: 'call' });
    await page.waitForSelector('.controls .turn');
    assert.deepEqual(await boxes(page, '.stage'), [waitingTable], 'the table is not where it was while the viewer waited with the choices');
  },
];

const LATEST = '.feed-toggle .latest';
const UNREAD = '.feed-toggle .unread';

/** Writes down every line the chat's bar shows from now on, and when the buttons of a turn first came up, each by the page's own clock. */
const WATCH_THE_BAR = `(() => {
  const line = document.querySelector('${LATEST}');
  const said = (window.barSaid = []);
  const turn = () => {
    if (window.turnCameAt === undefined && document.querySelector('.controls .turn')) {
      window.turnCameAt = performance.now();
    }
  };

  new MutationObserver(() => said.push({ text: line.textContent, at: performance.now() })).observe(line, { childList: true, characterData: true, subtree: true });
  new MutationObserver(turn).observe(document.querySelector('.controls-slot'), { childList: true, subtree: true });
})()`;

const peopleAreHeard = (picturesIn: string): Check => [
  'with the chat shut on a phone its bar counts the lines people said since the viewer last had the list in sight, not the dealer’s and not their own, and says the count aloud; a person’s line that comes with the dealer’s next keeps the bar for some seconds while the turn it brought is drawn at once, then the newest line has the bar; the count stops at 99+, cuts nothing off, and goes when the list is seen',
  async (rig) => {
    const table = waitingForTheHost(rig);
    const page = await table.open(VIEWER, 'smallPhone');
    const counted = () => page.locator(`${UNREAD} .count`).textContent();
    const says = (who: string, text: string) => table.act(who, { type: 'chat', text });

    await table.heardBy(page);
    assert.ok(await page.locator(UNREAD).isHidden(), 'the bar counts lines when nobody has spoken');
    await page.evaluate(WATCH_THE_BAR);

    // A friend speaks and the host's call comes right behind, in the same news: the call brings the viewer's turn
    const question = `${FRIEND}: pizza is here, who owes me 12?`;
    const call = `${HOST} calls 20`;

    says(FRIEND, 'pizza is here, who owes me 12?');
    table.act(HOST, { type: 'call' });
    await page.waitForSelector(`${LATEST}:has-text("${call}")`);

    const said = (await page.evaluate('window.barSaid')) as { text: string; at: number }[];
    const turnCameAt = (await page.evaluate('window.turnCameAt')) as number;
    const questionAt = said.find(({ text }) => text === question)?.at;
    const callAt = said.find(({ text }) => text === call)!.at;

    assert.ok(questionAt !== undefined, `the bar never showed what ${FRIEND} said: ${JSON.stringify(said)}`);
    assert.ok(said.findIndex(({ text }) => text === question) < said.findIndex(({ text }) => text === call), 'the dealer’s line had the bar before the line a person said ahead of it');
    // A timer is never early, but the two clocks are read a moment apart
    assert.ok(callAt - questionAt >= SPOKEN_HOLDS_MS - 50, `the dealer’s line took the bar ${Math.round(callAt - questionAt)} ms after ${FRIEND}’s, which had no time to be read`);
    assert.ok(turnCameAt < callAt - SPOKEN_HOLDS_MS / 2, 'the buttons of the turn waited for the bar to give up the line it was holding');
    assert.equal(await counted(), '1', 'the dealer’s line was counted, or the friend’s was not');

    // The viewer's own line is the newest and takes the bar, uncounted
    says(VIEWER, 'on my way');
    await page.waitForSelector(`${LATEST}:has-text("${VIEWER}: on my way")`);
    assert.equal(await counted(), '1', 'the viewer’s own line was counted');

    says(FRIEND, 'bring cash');
    await page.waitForSelector(`${LATEST}:has-text("${FRIEND}: bring cash")`);
    assert.equal(await counted(), '2');
    assert.equal(await page.locator(UNREAD).textContent(), '2 unread. ', 'the count is not said in words');
    assert.deepEqual(await squeezed(page, `.feed-toggle .label, ${UNREAD}`), [], 'the bar’s name or its count is cut off');
    assert.deepEqual((await unreadable(page)).map(telling), [], 'something of the page cannot be read');
    await page.screenshot({ path: `${picturesIn}check-bar-small-chat-count-smallPhone.png` });

    // Out of their turn the viewer opens the chat, and has seen what was said
    table.act(VIEWER, { type: 'call' });
    await page.waitForSelector('.controls .turn', { state: 'detached' });
    await page.click('.feed-toggle');
    await page.waitForSelector(UNREAD, { state: 'hidden' });
    await page.click('.feed-toggle');
    await page.waitForSelector('.feed:not(.open)');
    assert.ok(await page.locator(UNREAD).isHidden(), 'shutting the chat brought the count back');

    // More lines than the bar has room to count
    for (let batch = 0; batch < 3; batch += 1) {
      for (let line = 0; line < 40; line += 1) {
        says(FRIEND, `and another thing, number ${batch * 40 + line + 1}`);
      }

      await table.heardBy(page);
    }

    assert.equal(await counted(), '99+');
    assert.deepEqual(await squeezed(page, `.feed-toggle .label, ${UNREAD}`), [], 'the bar’s name or its count is cut off at its most');
    assert.deepEqual((await unreadable(page)).map(telling), [], 'something of the page cannot be read with the count at its most');
  },
];

const SLIDER = '#raise-slider';
const BOX = '#raise-amount';
const RAISE = '.turn [data-action="raise"]';

/** What the button that raises says, on one line however its words are laid out. */
const raiseSays = async (page: Page): Promise<string> => (await page.innerText(RAISE)).replace(/\s+/g, ' ').trim();

/** Puts the slider on each of its stops in turn, as a drag across it does, and gives what the box beside it then reads: the amount as the table writes it, the box being at rest. */
const EVERY_STOP = `(() => {
  const slider = document.querySelector('${SLIDER}');
  const box = document.querySelector('${BOX}');
  const read = [];

  for (let stop = Number(slider.min); stop <= Number(slider.max); stop += 1) {
    slider.value = String(stop);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    read.push(box.value);
  }

  return read;
})()`;

/** The viewer's turn to raise with `stack` chips at the start of the hand, the host having called the big blind. */
async function sizing(rig: Rig, stack: number): Promise<{ table: RigTable; page: Page }> {
  const table = waitingForTheHost(rig, stack);

  table.act(HOST, { type: 'call' });

  const page = await table.open(VIEWER, 'smallPhone');

  await page.waitForSelector(SLIDER);

  return { table, page };
}

const sliderStopsAtWholeBlinds: Check = [
  'the bet slider stops at the least raise, at all in and at every big blind between them, however the two ends divide, and by the small blind when the range is short; the arrow keys go a stop at a time and the ends are a key away, each stop is said as its amount, the box still takes any amount and a size button its own, and the raise played is the stop’s',
  async (rig) => {
    const stopsOf = (least: number, most: number) => {
      const stops = betStops(least, most, STAKES);

      return Array.from({ length: stops.last + 1 }, (_, stop) => stops.amountAt(stop));
    };

    // 2,000 behind at 10/20: from 40 to 2,000, every one a whole big blind
    const { table, page } = await sizing(rig, 2000);
    const written = (amounts: number[]) => amounts.map((amount) => formatAmount(amount, table.view(VIEWER).config));
    const read = (await page.evaluate(EVERY_STOP)) as string[];

    assert.deepEqual(read, written(stopsOf(40, 2000)));
    assert.deepEqual([read[0], read[1], read.at(-2), read.at(-1)], ['40', '60', '1,980', '2,000']);
    assert.ok(
      stopsOf(40, 2000).every((amount) => amount % STAKES.bigBlind === 0),
      'a stop is no whole big blind',
    );
    assert.equal(await raiseSays(page), 'All in 2,000', 'the last stop is not all in');

    // By the keyboard: a stop at a time, and each end a key away
    await page.focus(SLIDER);
    await page.keyboard.press('Home');
    assert.equal(await page.inputValue(BOX), '40');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.inputValue(BOX), '60');
    assert.equal(await raiseSays(page), 'Raise to 60');
    assert.equal(await page.getAttribute(SLIDER, 'aria-valuetext'), '60 chips', 'the slider says its stop’s number, not the amount');
    await page.keyboard.press('End');
    assert.equal(await page.inputValue(BOX), '2,000');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.inputValue(BOX), '1,980');

    // The box takes any amount, and the slider stands at the stop nearest it and goes on from there in whole blinds
    await page.fill(BOX, '711');
    assert.equal(await raiseSays(page), 'Raise to 711');
    assert.equal(await page.inputValue(SLIDER), '34', '711 is nearest 720, the 34th stop after 40');
    await page.focus(SLIDER);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.inputValue(BOX), '740');

    // An amount with its comma, as the box reads one that is pasted: the slider follows it the same
    await page.fill(BOX, '1,255');
    assert.equal(await raiseSays(page), 'Raise to 1,255');
    assert.equal(await page.inputValue(SLIDER), '61', '1,255 is nearest 1,260, the 61st stop after 40');

    // A size button's amount is its own: half the pot here is 50, between two stops
    await page.click('.presets button:text-is("½ pot")');
    assert.equal(await page.inputValue(BOX), '50');
    assert.equal(await raiseSays(page), 'Raise to 50');

    // What is played is the amount of the stop
    await page.locator(SLIDER).fill('3');
    assert.equal(await raiseSays(page), 'Raise to 100');
    await answeredAfter(page, () => page.click(RAISE));
    assert.match(table.view(HOST).feed.at(-1)!.text, new RegExp(`^${VIEWER} raises to 100$`));

    // 1,007 behind: every stop but the last is a whole big blind, and the last is every chip
    const odd = await sizing(rig, 1007);
    const oddStops = (await odd.page.evaluate(EVERY_STOP)) as string[];

    assert.deepEqual(oddStops, written(stopsOf(40, 1007)));
    assert.deepEqual(oddStops.slice(-2), ['1,000', '1,007']);
    assert.equal(await raiseSays(odd.page), 'All in 1,007');

    // 150 behind: fewer than ten big blinds between the ends, so the small blind is the step
    const short = await sizing(rig, 150);

    assert.deepEqual(await short.page.evaluate(EVERY_STOP), ['40', '50', '60', '70', '80', '90', '100', '110', '120', '130', '140', '150']);
  },
];

/** The checks of the three small things in the bar. Pictures go into `picturesIn`, a folder ending in a slash. */
export function barSmallChecks(picturesIn: string): Check[] {
  return [choicesSayWhatTheyAreFor(picturesIn), peopleAreHeard(picturesIn), sliderStopsAtWholeBlinds];
}
