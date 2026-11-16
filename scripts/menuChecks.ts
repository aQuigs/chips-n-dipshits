/*
 * The checks of the table's menu: its parts under their headings, what each line says where the game
 * stands, who gets which, and that it fits the screens it was laid out to fit. They run with the other
 * browser checks (`screenChecks.ts`).
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import type { Check } from './checkRunner.ts';
import { menuStartsWith, openTheMenu, passive, playOut } from './layoutSweep.ts';
import { answeredTo } from './pageSpies.ts';
import { boxes, squeezed } from './rig.ts';
import type { Rig, RigTable } from './rig.ts';
import { tapsLive } from './underTheFinger.ts';

const [HOST, PLAYER, THIRD, WATCHER] = ['Quigs', 'Pam', 'Stu', 'Kibitz'];
const BONUS = 50;

/** The host's aces hold up at a showdown, which gives him the high hand of the night. */
const ACES_HOLD_UP = { button: 0, holes: { 0: 'As Ah', 1: 'Kd Kc', 2: '7h 2c' }, board: 'Qs Jh 4d 9c 3s' };

/** A table of three at 10/20 with a bonus on the high hand, nothing dealt, and someone watching. */
function threeAndAWatcher(rig: Rig): RigTable {
  const table = rig.table(
    [HOST, PLAYER, THIRD].map((name) => ({ name, stack: 2000 })),
    { highHandBonus: BONUS },
  );

  table.join(WATCHER);

  return table;
}

/** The hand on the table played down to its showdown and off the table, the game paused: between hands, with nothing dealt until it is resumed. */
const pausedAfterTheHand = (table: RigTable) => playOut(table, passive, HOST);

type Part = [heading: string, lines: string[]];

// Run in the page: the open menu part by part, each line as its label and, after a colon, how things stand behind it
const PARTS = `[...document.querySelectorAll('.menu > section')].map((part) => [
  part.querySelector('h3').textContent,
  [...part.querySelectorAll('.menu-item')].map((line) => [...line.children].map((piece) => piece.textContent).join(': ')),
])`;

const parts = (page: Page) => page.evaluate(PARTS) as Promise<Part[]>;

const SCORES: Part = ['Scores and history', ['Ledger', 'Tonight', 'Hand history', 'Standings']];
const YOU_SEATED: Part = ['You', ['Show or muck: Muck losers · muck when folded to', 'Mute players', 'Preferences', 'Who you are: Not on the list yet']];
const LEAVE_SEATED: Part = ['Leave', ['Stand up', 'Back to the lobby: Your seat stays yours']];

const partsByWhereTheGameStands: Check = [
  'the menu is in parts under headings, and its first line says what it will do: for a host Run the game comes first, with Start the game before the first hand, Pause the game while it runs, Call off the pause while a pause waits for the hand to end, which is what it does, Resume the game once paused, as the table’s own button says, and Keep playing when the night is over; the lines change while the menu is open, and none of them is for inviting',
  async (rig) => {
    const table = threeAndAWatcher(rig);
    const page = await table.open(HOST, 'tallPhone');
    const firstLine = (action: string, says: string) => page.waitForSelector(menuStartsWith(action, says));
    const run = async () => (await parts(page))[0];

    await openTheMenu(page);
    assert.deepEqual(await parts(page), [
      ['Run the game', ['Start the game', 'Players', 'Bomb pot next hand: 100 each', 'Last hands', 'Table settings: Blinds 10/20', 'Shuffle seats']],
      SCORES,
      YOU_SEATED,
      LEAVE_SEATED,
    ]);

    // Read out, a part is a heading and a line is one button: its label, then how things stand
    assert.deepEqual(await page.locator('.menu').getByRole('heading', { level: 3 }).allTextContents(), ['Run the game', 'Scores and history', 'You', 'Leave']);
    assert.equal(await page.getByRole('button', { name: 'Table settings Blinds 10/20', exact: true }).count(), 1, 'a line is not named by its label and how things stand');

    table.deal(ACES_HOLD_UP);
    await firstLine('pause', 'Pause the game');

    // Paused during a hand, which is played out: the line that starts the dealing can only take the pause back, and says so
    table.act(HOST, { type: 'pause' });
    await firstLine('start', 'Call off the pause');
    await tapsLive(page);
    await answeredTo(page, 'start', () => page.tap('.menu [data-action="start"]'));
    assert.equal(table.view(HOST).running, true, 'calling the pause off left the game paused');
    assert.ok(table.view(HOST).hand, 'calling the pause off ended the hand');
    await page.waitForSelector('.dialog', { state: 'detached' });

    pausedAfterTheHand(table);
    await page.waitForSelector('.message [data-action="start"]');
    assert.equal(await page.innerText('.message [data-action="start"]'), 'Resume the game');
    await openTheMenu(page);
    assert.deepEqual(await run(), [
      'Run the game',
      ['Resume the game', 'Players', 'Bomb pot next hand: 100 each', 'Last hands', `Pay the high hand: ${HOST}: ${BONUS} from everyone else`, 'Table settings: Blinds 10/20', 'Shuffle seats'],
    ]);

    // The night's end pays the bonus, and with no hand to come there is none to call a bomb pot or the last hands for
    table.act(HOST, { type: 'endNight' });
    await firstLine('keep-playing', 'Keep playing');
    assert.deepEqual(await run(), ['Run the game', ['Keep playing', 'Players', 'Table settings: Blinds 10/20', 'Shuffle seats']]);
  },
];

const partsByWhoLooks: Check = [
  'a player who does not run the table has no Run the game in their menu, which starts with Scores and history; someone watching has neither Show or muck nor Stand up, and is not told a seat stays theirs; made a co-host with the menu open, a player gets Run the game above the rest',
  async (rig) => {
    const table = threeAndAWatcher(rig);

    table.deal(ACES_HOLD_UP);

    const player = await table.open(PLAYER, 'tallPhone');
    await openTheMenu(player);
    assert.deepEqual(await parts(player), [SCORES, YOU_SEATED, LEAVE_SEATED]);

    const watcher = await table.open(WATCHER, 'tallPhone');
    await openTheMenu(watcher);
    assert.deepEqual(await parts(watcher), [SCORES, ['You', ['Mute players', 'Preferences', 'Who you are: Not on the list yet']], ['Leave', ['Back to the lobby']]]);

    table.act(HOST, { type: 'setCohost', playerId: table.auth(PLAYER).id, on: true });
    await player.waitForSelector('.menu [data-action="pause"]');
    assert.deepEqual(await parts(player), [['Run the game', ['Pause the game', 'Players', 'Bomb pot next hand: 100 each', 'Last hands', 'Table settings: Blinds 10/20', 'Shuffle seats']], SCORES, YOU_SEATED, LEAVE_SEATED]);
  },
];

const LYING = { width: 740, height: 360 };

const inviteFromTheTopBar: Check = [
  'the top bar’s Invite button, which the menu leaves inviting to, is whole on the screen and opens the invite dialog for someone watching: before the first hand, during a hand, with the game paused and with the night over, on a 360 by 640 and a 390 by 844 phone, a phone lying down and the desktop',
  async (rig) => {
    const table = threeAndAWatcher(rig);
    const pages = await Promise.all(
      (['smallPhone', 'tallPhone', 'phoneSideways', 'desktop'] as const).map(async (screen) => {
        const page = await table.open(WATCHER, screen);

        if (screen === 'phoneSideways') {
          await page.setViewportSize(LYING);
        }

        return { page, press: (selector: string) => (screen === 'desktop' ? page.click(selector) : page.tap(selector)), where: screen };
      }),
    );

    const invites = async (when: string) => {
      for (const { page, press, where } of pages) {
        await table.heardBy(page);

        const { width, height } = page.viewportSize()!;
        const [button] = await boxes(page, '.topbar [data-action="invite"]');

        assert.ok(button, `${when}, ${where}: the top bar has no Invite button`);
        assert.ok(button.left >= 0 && button.top >= 0 && button.right <= width && button.bottom <= height, `${when}, ${where}: the Invite button runs off the screen: ${JSON.stringify(button)}`);
        assert.deepEqual(await squeezed(page, '.topbar [data-action="invite"]'), [], `${when}, ${where}: the Invite button is cut short`);

        await press('.topbar [data-action="invite"]');
        await page.waitForSelector('.dialog #table-link');
        assert.equal(await page.innerText('.dialog h2'), 'Invite players', `${when}, ${where}`);
        await press('.dialog [data-action="close"]');
        await page.waitForSelector('.dialog', { state: 'detached' });
      }
    };

    await invites('before the first hand');

    table.deal(ACES_HOLD_UP);
    await invites('during a hand');

    pausedAfterTheHand(table);
    await invites('with the game paused');

    // The night's recap opens by itself over the table, for someone watching too
    table.act(HOST, { type: 'endNight' });
    await Promise.all(
      pages.map(async ({ page, press }) => {
        await page.waitForSelector('.dialog[aria-label="Tonight"]');
        await press('.dialog [data-action="close"]');
        await page.waitForSelector('.dialog', { state: 'detached' });
      }),
    );
    await invites('with the night over');
  },
];

// Run in the page: how the open menu lies in its list, with how much of the list shows. Each line is under the name the page
// knows it by: how far down it ends, how tall it is, and for one that says how things stand, how much room the line has
// left with that beside its label (less than none when it has not the room) and whether it is drawn there
const LAID_OUT = `(() => {
  const list = document.querySelector('.dialog-body');
  const top = list.getBoundingClientRect().top;
  const lines = Object.fromEntries([...document.querySelectorAll('.menu-item')].map((line) => {
    const [label, state] = [...line.children].map((piece) => piece.getBoundingClientRect());
    const { paddingLeft, paddingRight, columnGap } = getComputedStyle(line);
    const box = line.getBoundingClientRect();

    return [line.dataset.action, {
      bottom: Math.round(box.bottom - top),
      height: Math.round(box.height),
      spare: state ? line.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight) - label.width - parseFloat(columnGap) - state.width : null,
      beside: state ? state.top < label.bottom : null,
    }];
  }));

  return { shows: list.clientHeight, whole: list.scrollHeight, scrolled: list.scrollTop, lines };
})()`;

interface LaidOut {
  shows: number;
  whole: number;
  scrolled: number;
  lines: Record<string, { bottom: number; height: number; spare: number | null; beside: boolean | null }>;
}

const laidOut = (page: Page) => page.evaluate(LAID_OUT) as Promise<LaidOut>;

/**
 * How things stand is at the end of its line, which is then no taller than a line that says nothing,
 * wherever the line has room for it beside the label; where it has not, it goes under the label.
 * A pixel or two either way is the browser's to round.
 */
function assertStatesPlaced(menu: LaidOut, where: string): void {
  // Not the first line of its part, so the hairline over it counts in its height: none is taller for saying nothing
  const plain = menu.lines.tonight!.height;

  for (const [action, { height, spare, beside }] of Object.entries(menu.lines)) {
    if (spare !== null && spare >= 2) {
      assert.ok(beside && height <= plain, `${where}: the ${action} line is ${height} px tall, a line that says nothing ${plain}, with ${spare} px to spare beside its label`);
    }

    if (spare !== null && spare <= -2) {
      assert.ok(!beside && height > plain, `${where}: the ${action} line says how things stand beside its label, which leaves it ${-spare} px short`);
    }
  }
}

/** A hand in play at a table whose host has the high hand, with the last hands called, the seats to be shuffled after it and three players asking for seats: every line of the host's menu that can say how things stand does. */
function everyLineSaying(rig: Rig): RigTable {
  const table = threeAndAWatcher(rig);

  table.deal(ACES_HOLD_UP);
  pausedAfterTheHand(table);
  table.dealNext({ holes: ACES_HOLD_UP.holes });
  table.act(HOST, { type: 'setLastHands', hands: 2 });
  table.act(HOST, { type: 'shuffleSeats' });

  ['Alice', 'Bob'].forEach((name) => table.join(name));
  [WATCHER, 'Alice', 'Bob'].forEach((name, nth) => table.act(name, { type: 'requestSeat', seat: 5 + nth, buyIn: 2000 }));

  return table;
}

const fitsAPhone = (picturesIn: string): Check => [
  'on a 390 by 844 phone a host sees all of Run the game and of Scores and history without scrolling, with every line that can say how things stand saying it, and a player’s whole menu shows at once; on a 360 by 640 phone all of Run the game shows; how things stand is at the end of its line, which is then one line high, wherever it has room beside the label, and whole under the label where it has not; nothing in a line is cut short',
  async (rig) => {
    const table = everyLineSaying(rig);
    const inSight = (menu: LaidOut, action: string) => menu.scrolled === 0 && menu.lines[action]!.bottom <= menu.shows;

    const host = await table.open(HOST, 'tallPhone');
    await openTheMenu(host);
    const hosts = await laidOut(host);

    assert.deepEqual((await parts(host))[0], [
      'Run the game',
      ['Pause the game', 'Players: 3 waiting for you', 'Bomb pot next hand: 100 each', 'Last hands: 2 more hands after this one', 'Pay the high hand: Between hands only', 'Table settings: Blinds 10/20', 'Shuffle seats: Set for when this hand ends'],
    ]);
    assert.ok(inSight(hosts, 'standings'), `the host scrolls to the end of Scores and history, which is ${hosts.lines.standings!.bottom} px down a list that shows ${hosts.shows}`);
    assert.equal(hosts.lines.players!.beside, true, 'word of who waits is not at the end of the Players line');
    assertStatesPlaced(hosts, 'the host on a phone');
    assert.deepEqual(await squeezed(host, '.menu-item, .menu-item > *'), [], 'a line of the host’s menu is cut short');
    await host.screenshot({ path: `${picturesIn}check-menu-host-390.png` });

    const player = await table.open(PLAYER, 'tallPhone');
    await openTheMenu(player);
    const players = await laidOut(player);

    assert.ok(players.whole <= players.shows, `a player scrolls their menu: ${players.whole} px in a list that shows ${players.shows}`);
    assertStatesPlaced(players, 'a player on a phone');
    await player.screenshot({ path: `${picturesIn}check-menu-player-390.png` });

    const small = await table.open(HOST, 'smallPhone');
    await openTheMenu(small);
    const smalls = await laidOut(small);

    assertStatesPlaced(smalls, 'the host on a small phone');
    assert.ok(inSight(smalls, 'shuffle'), `on a small phone the host scrolls to the end of Run the game, which is ${smalls.lines.shuffle!.bottom} px down a list that shows ${smalls.shows}`);
    assert.deepEqual(await squeezed(small, '.menu-item, .menu-item > *'), [], 'a line of the menu is cut short on a small phone');
    await small.screenshot({ path: `${picturesIn}check-menu-host-360.png` });
  },
];

const requestMovesNoLine: Check = [
  'a request for a seat that comes in while the host has the menu open is told on the Players line, and no line of the menu moves for it: on a 360 phone the word of it has room beside the label',
  async (rig) => {
    const table = threeAndAWatcher(rig);
    const page = await table.open(HOST, 'smallPhone');

    await openTheMenu(page);
    const before = await boxes(page, '.menu-item');

    table.act(WATCHER, { type: 'requestSeat', seat: 5, buyIn: 2000 });
    await page.waitForSelector('.menu [data-action="players"] small');

    assert.equal(await page.innerText('.menu [data-action="players"] small'), '1 waiting for you');
    assert.deepEqual(await boxes(page, '.menu-item'), before, 'the lines of the menu moved under the host’s finger');
  },
];

/** The menu's checks. Pictures of the menu as it was checked go into `picturesIn`, a folder ending in a slash. */
export const menuChecks = (picturesIn: string): Check[] => [partsByWhereTheGameStands, partsByWhoLooks, inviteFromTheTopBar, fitsAPhone(picturesIn), requestMovesNoLine];
