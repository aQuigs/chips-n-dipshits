/*
 * The checks of what the screen itself says: how the table stands, in the top bar's pill, and what
 * has just happened to the viewer alone, in a toast and in the bar under the table. They run with the
 * other browser checks (`screenChecks.ts`). Where a toast lies is the layout sweep's to say, which
 * puts one up itself (`layoutSweep.ts`): these ask what the page told (`toastTold`), and where.
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { LIMITS } from '../src/engine/index.ts';
import type { Command, TableView } from '../src/engine/index.ts';
import { heard, SPOKEN } from './a11y.ts';
import type { Check } from './checkRunner.ts';
import { NEXT_FRAME, TEXT_SIZES } from './layoutSweep.ts';
import { toasts, toastTold } from './pageSpies.ts';
import type { Toast } from './pageSpies.ts';
import { boxes, overlap, SCREENS, squeezed } from './rig.ts';
import type { Box, Rig, RigTable } from './rig.ts';

const HOST = 'Quigs';
const PLAYER = 'Danny';
const THIRD = 'Marge';
const WATCHER = 'Zed';
const LYING = { width: 740, height: 360 };

// The longest a table can be named, in letters as wide as they come
const LONGEST_NAME = 'W'.repeat(LIMITS.tableNameLength);
const VOICE = 'https://meet.google.com/abc-defg-hij';

const NOTE = '.controls .own-note';
// First in the bar, in the place of what everyone is waiting for
const TIMED_OUT = '.controls .waiting > .timed-out-note:first-child';
const TURNED_DOWN = '.controls .turned-down-note';

/** Three at 10/20, the host first. `seconds` is the table's action clock, and 0 a table with none. */
const tableOfThree = (rig: Rig, seconds = 0, config: Record<string, unknown> = {}): RigTable =>
  rig.table(
    [
      { name: HOST, stack: 2000 },
      { name: PLAYER, stack: 2000 },
      { name: THIRD, stack: 2000 },
    ],
    { smallBlind: 10, bigBlind: 20, minBuyIn: 100, maxBuyIn: 20_000, actionSeconds: seconds, ...config },
  );

const folding = (view: TableView): Command => ({ type: view.hand!.options!.canCheck ? 'check' : 'fold' });

/** A pill as a page shows it: its words, and whether it is drawn to stand out. */
interface Pill {
  says: string;
  news: boolean;
}

const PILL = `(() => {
  const pill = document.querySelector('.topbar .pill');

  return pill && { says: pill.textContent, news: pill.classList.contains('news') };
})()`;

type Pages = [who: string, page: Page][];

/** Every page shows the same pill once it has taken up the table as it stands. */
async function pillsSay(table: RigTable, pages: Pages, says: string, news = true): Promise<void> {
  for (const [who, page] of pages) {
    await table.heardBy(page);
    assert.deepEqual((await page.evaluate(PILL)) as Pill | null, { says, news }, who);
  }
}

const pillSaysTheState = (picturesIn: string): Check => [
  'the top bar’s pill says how the table stands, to the host and to a player alike: not started, waiting with nobody to deal to, pausing, a bomb pot next, the hands left, the last hand and the night over, each drawn to stand out, and the hand’s number plainly when there is nothing else to say',
  async (rig) => {
    const table = tableOfThree(rig);
    const host = await table.open(HOST, 'smallPhone');
    const pages: Pages = [
      ['the host on a 360 phone', host],
      ['a player on the desktop', await table.open(PLAYER, 'desktop')],
    ];
    const says = (words: string, news = true) => pillsSay(table, pages, words, news);
    const picture = (name: string) => host.screenshot({ path: `${picturesIn}check-table-says-${name}-smallPhone.png` });

    await says('Not started');

    for (const name of [PLAYER, THIRD]) {
      table.act(name, { type: 'sitOut' });
    }

    table.act(HOST, { type: 'start' });
    await says('Waiting');
    await picture('waiting');

    for (const name of [PLAYER, THIRD]) {
      table.act(name, { type: 'sitIn' });
    }

    await says('Next hand', false);

    table.deal({ button: 0 });
    await says('Hand #1', false);

    table.act(HOST, { type: 'pause' });
    await says('Pausing');
    await picture('pausing');

    table.act(HOST, { type: 'start' });
    await says('Hand #1', false);

    table.act(HOST, { type: 'setLastHands', hands: 2 });
    await says('2 hands left');

    // Of two things that hold, the one that changes what happens soonest: the next hand before the ones after it, and no next hand at all before either
    table.act(HOST, { type: 'setBombPot', on: true });
    await says('Bomb pot next');
    await picture('bomb-pot-next');

    table.act(HOST, { type: 'pause' });
    await says('Pausing');

    table.act(HOST, { type: 'start' });
    table.act(HOST, { type: 'setBombPot', on: false });
    await says('2 hands left');

    table.act(HOST, { type: 'setLastHands', hands: 0 });
    await says('Last hand');

    table.act(HOST, { type: 'pause' });
    await says('Last hand');
    await picture('last-hand');

    table.play(folding, (view) => view.nightEndedAt !== null);
    await says('Night over');
  },
];

/** The top bar as a page shows it, with what its pill has to keep clear of. */
interface TopBar {
  says: string;
  height: number;
  pill: Box;
  /** The table's name, as much of it as shows, and the size of its letters. */
  name: Box;
  nameSize: number;
  menu: Box;
  invite: Box;
  voice: Box;
  table: number;
}

const TOP_BAR = `(() => {
  const box = (element) => {
    const { left, top, right, bottom } = element.getBoundingClientRect();

    return { left, top, right, bottom };
  };
  const bar = document.querySelector('.topbar');
  const name = bar.querySelector('.title b');

  return {
    says: bar.querySelector('.pill').textContent,
    height: bar.getBoundingClientRect().height,
    pill: box(bar.querySelector('.pill')),
    name: box(name),
    nameSize: parseFloat(getComputedStyle(name).fontSize),
    menu: box(bar.querySelector('.menu-button')),
    invite: box(bar.querySelector('[data-action="invite"]')),
    voice: box(bar.querySelector('.voice-link')),
    table: document.querySelector('.stage').getBoundingClientRect().height,
  };
})()`;

// The least of a table's name that is left to read beside the pill, in its own letters: `LEAST_OF_A_NAME_EM` in covered.ts
const LEAST_OF_THE_NAME_EM = 3;

const pillHoldsOnAPhone = (picturesIn: string): Check => [
  'on a 360 phone, with the longest table name, a voice button and Invite, the pill is whole on the row of the name whatever it says and leaves the name a few letters, and the top bar and the table are as tall as with the hand’s number, at every size of text',
  async (rig) => {
    const table = tableOfThree(rig, 0, { name: LONGEST_NAME, voiceLink: VOICE });
    const page = await table.open(HOST, 'smallPhone');
    let plain: TopBar | null = null;

    /** The top bar with this on its pill, at every size of text, held to the bar with the hand's number on it. */
    const holds = async (says: string): Promise<void> => {
      await table.heardBy(page);

      for (const size of TEXT_SIZES) {
        await page.evaluate(`document.querySelector('#app').setAttribute('data-text-size', ${JSON.stringify(size)})`);
        await page.evaluate(NEXT_FRAME);

        const bar = (await page.evaluate(TOP_BAR)) as TopBar;
        const where = `“${says}”, ${size} text`;

        assert.equal(bar.says, says, where);
        assert.deepEqual(await squeezed(page, '.topbar .pill, .topbar [data-action="invite"], .topbar .voice-link'), [], `${where}: a part of the top bar is cut off`);
        assert.ok(bar.pill.top >= bar.invite.top - 0.5 && bar.pill.bottom <= bar.invite.bottom + 0.5, `${where}: the pill is not on the row of Invite: ${JSON.stringify(bar)}`);
        assert.ok(bar.pill.left >= bar.name.right - 0.5 && bar.pill.right <= bar.invite.left + 0.5, `${where}: the pill is not between the name and Invite: ${JSON.stringify(bar)}`);
        assert.ok(bar.name.left >= bar.menu.right - 0.5 && bar.name.right - bar.name.left >= LEAST_OF_THE_NAME_EM * bar.nameSize, `${where}: the name is left fewer than a few letters: ${JSON.stringify(bar)}`);
        assert.ok(bar.voice.top >= bar.invite.bottom - 0.5 && bar.invite.right <= SCREENS.smallPhone.width + 0.5, `${where}: the voice button is not under a row that fits the screen: ${JSON.stringify(bar)}`);

        // Whatever the pill says, nothing under it moves for it: against the same size of text with the hand's number
        if (plain && size === TEXT_SIZES[0]) {
          assert.deepEqual({ bar: bar.height, table: bar.table }, { bar: plain.height, table: plain.table }, `${where}: the top bar or the table changed height with the pill`);
        }
      }
    };

    table.deal({ button: 0 });
    await table.heardBy(page);
    await page.evaluate(NEXT_FRAME);
    plain = (await page.evaluate(TOP_BAR)) as TopBar;
    await holds('Hand #1');

    table.act(HOST, { type: 'pause' });
    await holds('Pausing');

    table.act(HOST, { type: 'start' });
    table.act(HOST, { type: 'setLastHands', hands: LIMITS.lastHands });
    await holds(`${LIMITS.lastHands} hands left`);

    table.act(HOST, { type: 'setBombPot', on: true });
    await holds('Bomb pot next');
    await page.screenshot({ path: `${picturesIn}check-table-says-longest-name-smallPhone.png` });

    table.act(HOST, { type: 'setBombPot', on: false });
    table.act(HOST, { type: 'setLastHands', hands: 0 });
    await holds('Last hand');
  },
];

/** A toast lay over the chat's bar, and on nothing of the top bar or of a turn's buttons. */
async function assertOverTheChatsBar(page: Page, toast: Toast, where: string): Promise<void> {
  const [bar] = await boxes(page, '.feed-bar');

  assert.ok(bar && overlap(toast.box, bar), `${where}: the toast was not over the chat’s bar: ${JSON.stringify({ toast: toast.box, bar })}`);
  assert.equal(toast.squeezed, false, `${where}: the toast had less room than its words need`);

  for (const kept of await boxes(page, '.topbar > *, .turn .buttons button, .stage')) {
    assert.ok(!overlap(toast.box, kept), `${where}: the toast lay on the top bar, the table or a move: ${JSON.stringify({ toast: toast.box, kept })}`);
  }
}

/** Nobody else's page says a word of it: no toast, and no line for the viewer alone in the bar. */
async function assertNotTold(table: RigTable, others: Pages, words: string): Promise<void> {
  for (const [who, page] of others) {
    await table.heardBy(page);
    assert.deepEqual((await toasts(page)).filter((toast) => toast.text.includes(words)), [], `${who} was told in a toast`);
    assert.equal(await page.locator(NOTE).count(), 0, `${who} has a line for the viewer alone in the bar`);
  }
}

const noteSays = async (page: Page, selector: string) => ((await page.locator(selector).textContent()) ?? '').trim();

const FOLDED = 'You ran out of time. Your hand was folded and you are sitting out.';
const PLAYED_FOR_THEM = 'You ran out of time. Your hand is checked or folded until you are back.';
const SITTING_OUT = 'You ran out of time. You are sitting out.';

const timedOutIsTold = (picturesIn: string): Check => [
  'a player the clock ran out on is told so in a toast over the chat’s bar and by the bar under the table until they are back, standing, lying and on the desktop: that their hand was folded, or is played for them, and afterwards that they are sitting out; nobody else’s page says it',
  async (rig) => {
    const table = tableOfThree(rig, 30);
    const standing = await table.open(PLAYER, 'smallPhone', SPOKEN);
    const lying = await table.open(PLAYER, 'smallPhone');
    const desktop = await table.open(PLAYER, 'desktop');
    const mine: Pages = [
      ['a 360 phone standing', standing],
      ['a 360 phone lying', lying],
      ['the desktop', desktop],
    ];
    const others: Pages = [
      ['the host', await table.open(HOST, 'smallPhone')],
      ['another player', await table.open(THIRD, 'desktop')],
    ];
    const runOut = (): void => {
      rig.advance(table.view(PLAYER).hand!.deadline! - rig.now() + 1);
      assert.equal(table.view(PLAYER).seats[1]!.away, true, 'the clock did not run out on the player');
    };
    /** Every page of the player's says `words` first in its bar, and was told them in a toast over the chat's bar. */
    const told = async (words: string, toasted = true): Promise<void> => {
      for (const [where, page] of mine) {
        await page.waitForSelector(`${TIMED_OUT}:text-is(${JSON.stringify(words)})`);

        if (toasted) {
          await assertOverTheChatsBar(page, await toastTold(page, words), where);
        }
      }
    };
    const backAtTheTable = async (): Promise<void> => {
      for (const [, page] of mine) {
        await page.waitForSelector(TIMED_OUT, { state: 'detached' });
      }

      assert.equal(table.view(PLAYER).seats[1]!.away, false);
    };

    await lying.setViewportSize(LYING);

    // The button on the player, who is first to act with the big blind to call
    table.deal({ button: 1, holes: { 1: '7s 2d' } });
    assert.equal(table.view(PLAYER).hand!.toAct, 1);

    for (const [, page] of [...mine, ...others]) {
      await table.heardBy(page);
    }

    const before = table.version;

    runOut();
    await told(FOLDED);
    await heard(standing, `status: ${FOLDED}`, before);
    assert.equal(await standing.locator(NOTE).count(), 1, 'more than one line for the viewer alone');
    await assertNotTold(table, others, 'ran out of time');
    await standing.screenshot({ path: `${picturesIn}check-table-says-timed-out-smallPhone.png` });
    await lying.screenshot({ path: `${picturesIn}check-table-says-timed-out-lying.png` });
    await desktop.screenshot({ path: `${picturesIn}check-table-says-timed-out-desktop.png` });

    // The hand after, which they are dealt out of: the toast is not told again, and the bar still says why they are out
    table.play((view, name) => (name === PLAYER ? null : folding(view)), (view) => view.hand?.number === 2);
    await told(SITTING_OUT, false);

    for (const [where, page] of mine) {
      assert.equal((await toasts(page)).filter((toast) => toast.text.includes('ran out of time')).length, 1, `${where}: told in a toast more than once`);
    }

    await assertNotTold(table, others, 'ran out of time');

    // Back at the table, the bar says what everyone is waiting for again
    table.act(PLAYER, { type: 'sitIn' });
    await backAtTheTable();

    // The clock runs out with a check open to them: the hand goes on, played for them, and is theirs again the moment they are back
    table.act(HOST, { type: 'pause' });
    table.play(folding, (view) => view.hand === null);
    // The button so that the player is the big blind, who may check once the others have called
    table.deal({ button: 2, holes: { 1: 'As Kd' } });
    table.play((_view, name) => (name === PLAYER ? null : { type: 'call' }), (view) => view.hand!.toAct === 1);

    for (const [, page] of mine) {
      await page.waitForSelector('.turn [data-action="check"]:enabled');
    }

    runOut();
    await told(PLAYED_FOR_THEM);
    await standing.screenshot({ path: `${picturesIn}check-table-says-played-for-them-smallPhone.png` });

    await standing.click('.controls [data-action="sit-in"]');
    await backAtTheTable();
  },
];

const SEAT_TURNED_DOWN = 'Your request for a seat was turned down';
const CHIPS_TURNED_DOWN = 'Your request for chips was turned down';

const turnedDownIsTold = (picturesIn: string): Check => [
  'someone whose request for a seat or for chips is turned down is told so in a toast over the chat’s bar and by the bar under the table, until they ask again; a request they take back themselves says nothing, and nobody else’s page says a word of either',
  async (rig) => {
    const table = tableOfThree(rig);

    table.join(WATCHER);
    table.deal({ button: 0, holes: { 1: 'As Kd' } });

    const watcher = await table.open(WATCHER, 'smallPhone', SPOKEN);
    const player = await table.open(PLAYER, 'smallPhone');
    const others: Pages = [
      ['the host', await table.open(HOST, 'smallPhone')],
      ['another player', await table.open(THIRD, 'desktop')],
    ];
    const deny = (name: string) => table.act(HOST, { type: 'deny', playerId: table.auth(name).id });
    const asksForASeat = async (): Promise<void> => {
      table.act(WATCHER, { type: 'requestSeat', seat: 5, buyIn: 2000 });
      await watcher.waitForSelector('.controls [data-action="cancel-request"]');
    };

    // Taken back by the one who asked: nobody turned anything down
    await asksForASeat();
    await watcher.click('.controls [data-action="cancel-request"]');
    await watcher.waitForSelector('.controls [data-action="cancel-request"]', { state: 'detached' });
    assert.equal(await watcher.locator(NOTE).count(), 0, 'a request taken back is said to be turned down');
    assert.deepEqual(await toasts(watcher), []);

    await asksForASeat();

    const before = table.version;

    deny(WATCHER);
    await watcher.waitForSelector(`${TURNED_DOWN}:text-is(${JSON.stringify(`${SEAT_TURNED_DOWN}. Pick an open seat to ask again.`)})`);
    await assertOverTheChatsBar(watcher, await toastTold(watcher, `${SEAT_TURNED_DOWN}.`), 'someone watching on a 360 phone');
    await heard(watcher, `status: ${SEAT_TURNED_DOWN}.`, before);
    assert.deepEqual(await squeezed(watcher, TURNED_DOWN), [], 'what the bar says is cut off');
    await assertNotTold(table, [...others, ['a player with nothing asked', player]], 'turned down');
    await watcher.screenshot({ path: `${picturesIn}check-table-says-seat-turned-down-smallPhone.png` });

    // Asking again takes the line with it
    await asksForASeat();
    assert.equal(await watcher.locator(NOTE).count(), 0, 'the bar still says the last request was turned down');

    // Chips, asked for by a player whose turn it is: the toast is clear of their moves, and the line is under what the bar says of the hand
    table.play((_view, name) => (name === PLAYER ? null : { type: 'call' }), (view) => view.hand!.toAct === 1);
    table.act(PLAYER, { type: 'requestRebuy', amount: 500 });
    await player.waitForSelector('.controls [data-action="chips-asked"]');
    await player.waitForSelector('.turn [data-action="call"]:enabled');
    deny(PLAYER);

    await assertOverTheChatsBar(player, await toastTold(player, `${CHIPS_TURNED_DOWN}.`), 'a player on their turn on a 360 phone');
    await player.waitForSelector('.controls [data-action="rebuy"]');
    await player.screenshot({ path: `${picturesIn}check-table-says-chips-turned-down-my-turn-smallPhone.png` });

    table.act(PLAYER, { type: 'call' });
    await player.waitForSelector(`${TURNED_DOWN}:text-is(${JSON.stringify(CHIPS_TURNED_DOWN)})`);
    assert.equal(await player.locator(NOTE).count(), 1);
    assert.deepEqual(await squeezed(player, TURNED_DOWN), [], 'what the bar says is cut off');
    await player.screenshot({ path: `${picturesIn}check-table-says-chips-turned-down-smallPhone.png` });
    await assertNotTold(table, others, 'turned down');
  },
];

/** The checks of what the table says of itself and to the viewer alone. Pictures go into `picturesIn`, a folder ending in a slash. */
export function tableSaysChecks(picturesIn: string): Check[] {
  return [pillSaysTheState(picturesIn), pillHoldsOnAPhone(picturesIn), timedOutIsTold(picturesIn), turnedDownIsTold(picturesIn)];
}
