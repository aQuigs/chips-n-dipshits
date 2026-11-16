/*
 * The checks of a question and of what a dialog opened from another gives way to: that Cancel, the ✕
 * and an answer bring a host back to the list they were working down, as they left it; that the second
 * tap of two presses nothing of the dialog that comes back; where the keyboard is then; and
 * that an answer which takes something from someone is drawn as one to stop at. They run with the other
 * browser checks (`screenChecks.ts`).
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { TAPS_SETTLE_MS } from '../src/client/tapGuard.ts';
import type { Command } from '../src/engine/index.ts';
import { focusIn } from './a11y.ts';
import { Sweep, tabTo } from './accessibilityChecks.ts';
import type { Check } from './checkRunner.ts';
import { letGoEarly, passive, playOut } from './layoutSweep.ts';
import { answeredTo, commandsSent } from './pageSpies.ts';
import { CANCEL, CLOSE, dialogNamed, EIGHT, fromMenu, HOST, keyboardOn, more, named, noDialog, on, playersFromTheKeyboard, row, seated, seatedAndWatched, WATCHER } from './playersDialog.ts';
import { Gate } from './rig.ts';
import type { RigTable } from './rig.ts';
import { namedByTheWatch, tapsLive, tellingOf, watched, watchTheBar } from './underTheFinger.ts';

const SHUFFLE = '.dialog [data-action="shuffle"]';
const ANSWER = '.dialog [data-action="confirm"]';
const END_NIGHT = '.dialog [data-action="end-night"]';

const scrolled = (page: Page) => page.evaluate(`document.querySelector('.dialog-body').scrollTop`) as Promise<number>;

const backToPlayers: Check = [
  'what a host opens from Players gives way to Players again, scrolled where they had it: a question on Cancel, the ✕, Escape, a tap beside it and its answer, and Set stack and Transfer chips closed or sent; Players itself closes to the table; a co-host is named and a player removed in six taps, on a 360 phone and the desktop',
  async (rig) => {
    for (const screen of ['smallPhone', 'desktop'] as const) {
      const table = seatedAndWatched(rig);
      const page = await table.open(HOST, screen);
      const sent = commandsSent(page);
      let taps = 0;

      const press = async (selector: string) => {
        taps += 1;
        await tapsLive(page);
        await (screen === 'desktop' ? page.click(selector) : page.tap(selector));
      };

      // Brings a row's button into sight as a host scrolling to it does, and says where the list then stands
      const reach = async (selector: string) => {
        await page.locator(selector).scrollIntoViewIfNeeded();

        return scrolled(page);
      };

      const backWhereItWas = async (at: number, after: string) => {
        await dialogNamed(page, 'Players');
        assert.equal(await scrolled(page), at, `${screen}: after ${after} the list of players is not where its reader had it`);
      };

      await fromMenu(page, press, 'players');
      await reach(more('Zed'));
      await press(more('Zed'));

      const far = await reach(on('Zed', 'make-cohost'));

      assert.ok(screen === 'desktop' || far > 0, 'eight rows fit a phone without scrolling: the check no longer shows that a reader’s place is kept');

      await press(on('Zed', 'make-cohost'));
      await dialogNamed(page, 'Make Zed a co-host?');
      await press(ANSWER);
      await page.waitForSelector(`${row('Zed')} .cohost`);
      await backWhereItWas(far, 'naming a co-host');

      await press(more('Mo'));
      await press(on('Mo', 'remove'));
      await dialogNamed(page, 'Remove Mo?');
      await press(ANSWER);
      await page.waitForSelector(seated('Mo'), { state: 'detached' });
      await dialogNamed(page, 'Players');
      assert.equal(taps, 8, `${screen}: naming a co-host and then removing a player takes ${taps} taps`);
      assert.deepEqual(sent, ['setCohost', 'kick']);

      const leaving: [how: string, leave: () => Promise<unknown>][] = [
        ['Cancel', () => press(CANCEL)],
        ['the ✕', () => press(CLOSE)],
        ['Escape', () => page.keyboard.press('Escape')],
        // The corner of the screen, which a question leaves bare on every screen
        ['a tap beside it', () => (screen === 'desktop' ? page.mouse.click(8, 8) : page.touchscreen.tap(8, 8))],
      ];

      // Unfolded once: the row is as its reader left it after every way out of the question
      await reach(more('Pocket Pam'));
      await press(more('Pocket Pam'));

      for (const [how, leave] of leaving) {
        const at = await reach(on('Pocket Pam', 'remove'));

        await press(on('Pocket Pam', 'remove'));
        await dialogNamed(page, 'Remove Pocket Pam?');
        await tapsLive(page);
        await leave();
        await backWhereItWas(at, `${how} on a question`);
      }

      const at = await reach(on('Pocket Pam', 'set-stack'));

      await press(on('Pocket Pam', 'set-stack'));
      await dialogNamed(page, 'Set Pocket Pam\'s stack');
      await press(CLOSE);
      await backWhereItWas(at, 'the ✕ on Set stack');

      await press(on('Pocket Pam', 'set-stack'));
      await page.fill('#new-stack', '1500');
      await press('.dialog button[type="submit"]');
      await page.waitForSelector(`${row('Pocket Pam')}:has-text("1,500")`);
      await backWhereItWas(at, 'a stack set');

      const top = await reach('.dialog [data-action="transfer"]');

      await press('.dialog [data-action="transfer"]');
      await dialogNamed(page, 'Transfer chips');
      await press(CLOSE);
      await backWhereItWas(top, 'the ✕ on Transfer chips');

      await press(SHUFFLE);
      await dialogNamed(page, 'Shuffle the seats?');
      await press(CANCEL);
      await backWhereItWas(top, 'Cancel on shuffling the seats');

      await press(CLOSE);
      await noDialog(page);
      assert.deepEqual(sent, ['setCohost', 'kick', 'setStack'], `${screen}: a way out of a question sent the table something`);
      assert.deepEqual(
        table.view(HOST).seats.flatMap((seat) => (seat ? [seat.name] : [])),
        EIGHT.filter((name) => name !== 'Mo'),
      );
      await page.context().close();
    }
  },
];

// Run in the page: writes down the name of every dialog the page draws from now on, null for none
const DIALOGS_DRAWN = `(() => {
  window.__dialogsDrawn = [];

  new MutationObserver(() => {
    window.__dialogsDrawn.push(document.querySelector('.overlay [role$="dialog"]')?.getAttribute('aria-label') ?? null);
  }).observe(document.querySelector('.overlay'), { childList: true });
})()`;

const lastHandsAndTheMenu: Check = [
  'Cancel, the ✕ and Escape on “End the night?” give way to Last hands again, and its answer leaves for the table, where the night’s numbers open by themselves, with Last hands never drawn in between; a question opened from the menu closes to the table whatever is answered: Shuffle the seats, Stand up; on a 360 phone and the desktop',
  async (rig) => {
    for (const screen of ['smallPhone', 'desktop'] as const) {
      const table = seatedAndWatched(rig);
      const page = await table.open(HOST, screen);
      const sent = commandsSent(page);

      const press = async (selector: string) => {
        await tapsLive(page);
        await (screen === 'desktop' ? page.click(selector) : page.tap(selector));
      };

      await fromMenu(page, press, 'stand');
      await dialogNamed(page, 'Stand up?');
      await press(CANCEL);
      await noDialog(page);

      await fromMenu(page, press, 'lastHands');

      for (const leave of [() => press(CANCEL), () => press(CLOSE), () => page.keyboard.press('Escape')]) {
        await press(END_NIGHT);
        await dialogNamed(page, 'End the night?');
        await leave();
        await dialogNamed(page, 'Last hands');
      }

      assert.deepEqual(sent, [], `${screen}: a way out of a question sent the table something`);

      await press(END_NIGHT);
      await dialogNamed(page, 'End the night?');
      await page.evaluate(DIALOGS_DRAWN);
      await press(ANSWER);
      await dialogNamed(page, 'Tonight');
      assert.equal(((await page.evaluate('window.__dialogsDrawn')) as (string | null)[]).includes('Last hands'), false, `${screen}: the night ended by way of Last hands`);

      await press(CLOSE);
      await noDialog(page);

      await fromMenu(page, press, 'stand');
      await dialogNamed(page, 'Stand up?');
      await answeredTo(page, 'standUp', () => press(ANSWER));
      await noDialog(page);
      assert.equal(table.view(HOST).you.seat, null, `${screen}: the host is still seated`);
      assert.deepEqual(sent, ['endNight', 'standUp']);
      await page.context().close();
    }
  },
];

const QUESTION = '.dialog .dialog-body p';
const ENDS = (also: string) => `No more hands are dealt.${also} Chips, the ledger and cashing out still work, and play can start again from the menu.`;

const nightsEndIsSaid: Check = [
  'the question before ending the night says what ending does that its button does not, and only what it will do: nothing more at a table with no high hand to pay and nobody waiting; that the high hand is paid and requests still waiting are dropped where they are, which is then what happens',
  async (rig) => {
    const quiet = seatedAndWatched(rig);
    const calm = await quiet.open(HOST, 'desktop');

    await fromMenu(calm, (selector) => calm.click(selector), 'lastHands');
    await calm.click(END_NIGHT);
    await dialogNamed(calm, 'End the night?');
    assert.equal(await calm.textContent(QUESTION), ENDS(''));

    // The host's aces hold up at a showdown, so the two others owe the bonus; and the watcher asks for a seat
    const table = rig.table(
      [HOST, 'Stu', 'Pam'].map((name) => ({ name, stack: 2000 })),
      { name: 'Friday Night', highHandBonus: 50 },
    );

    table.join(WATCHER);
    table.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kc', 2: '7h 2c' }, board: 'Qs Jh 4d 9c 3s' });
    playOut(table, passive, HOST);
    table.act(WATCHER, { type: 'requestSeat', seat: 5, buyIn: 500 });

    const stack = table.view(HOST).seats[0]!.stack;
    const page = await table.open(HOST, 'desktop');

    await fromMenu(page, (selector) => page.click(selector), 'lastHands');
    await page.click(END_NIGHT);
    await dialogNamed(page, 'End the night?');
    assert.equal(await page.textContent(QUESTION), ENDS(' The high hand is paid, and requests still waiting are dropped.'));

    await answeredTo(page, 'endNight', () => page.click(ANSWER));
    assert.equal(table.view(HOST).seats[0]!.stack, stack + 100, 'the high hand was not paid as the question said');
    assert.deepEqual(table.view(HOST).requests, [], 'the request still waiting was not dropped as the question said');
  },
];

// Run in the page: the color the open dialog's last button is drawn in, beside the colors of danger and of every other dialog's button
const ANSWER_DRAWN = `(() => {
  const dialog = document.querySelector('.overlay .dialog');
  const drawnAs = (token) => {
    const probe = dialog.appendChild(document.createElement('i'));

    probe.style.background = 'var(' + token + ')';
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();

    return color;
  };
  const buttons = [...dialog.querySelectorAll('.buttons .btn')];

  return { says: buttons.map((button) => button.textContent), drawn: getComputedStyle(buttons.at(-1)).backgroundColor, danger: drawnAs('--bad'), usual: drawnAs('--accent') };
})()`;

interface AnswerDrawn {
  says: string[];
  drawn: string;
  danger: string;
  usual: string;
}

interface Asked {
  title: string;
  /** The line of the menu a host comes to it by, and the buttons of the dialog that line opens, when it is asked from one. */
  by: [menu: string, ...buttons: string[]];
  /** What its two buttons say, the way out first. */
  says: [string, string];
  /** Whether yes takes a seat, chips or the table from someone that no one tap gives back. */
  danger: boolean;
}

const QUESTIONS: Asked[] = [
  { title: 'Remove Stu?', by: ['players', more('Stu'), on('Stu', 'remove')], says: ['Cancel', 'Remove'], danger: true },
  { title: `Remove ${WATCHER}?`, by: ['players', more(WATCHER), on(WATCHER, 'remove')], says: ['Cancel', 'Remove'], danger: true },
  { title: 'Make Stu the host?', by: ['players', more('Stu'), on('Stu', 'make-host')], says: ['Cancel', 'Hand over'], danger: true },
  { title: 'Stand up?', by: ['stand'], says: ['Cancel', 'Stand up'], danger: true },
  { title: 'End the night?', by: ['lastHands', END_NIGHT], says: ['Cancel', 'End the night'], danger: true },
  { title: 'Pay the high hand?', by: ['highHand'], says: ['Cancel', 'Pay 100'], danger: true },
  { title: 'Make Stu a co-host?', by: ['players', more('Stu'), on('Stu', 'make-cohost')], says: ['Cancel', 'Make co-host'], danger: false },
  { title: 'Shuffle the seats?', by: ['players', SHUFFLE], says: ['Cancel', 'Shuffle'], danger: false },
];

const dangerIsDrawn = (picturesIn: string): Check => [
  `an answer that takes a seat, chips or the table from someone, which no one tap gives back, is drawn in the color of danger and every other in the color of every other dialog’s button, the way out first and the answer last, in the default theme and in High Contrast: ${QUESTIONS.map((asked) => `${asked.title} ${asked.danger ? 'is' : 'is not'}`).join(', ')}; on a 390 phone and the desktop`,
  async (rig) => {
    for (const screen of ['tallPhone', 'desktop'] as const) {
      const table = rig.table(
        [HOST, 'Stu', 'Pam'].map((name) => ({ name, stack: 2000 })),
        { name: 'Friday Night', highHandBonus: 50 },
      );

      // The host's aces hold up at a showdown, so there is a high hand to pay
      table.join(WATCHER);
      table.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kc', 2: '7h 2c' }, board: 'Qs Jh 4d 9c 3s' });
      playOut(table, passive, HOST);

      const page = await table.open(HOST, screen);
      const press = (selector: string) => (screen === 'desktop' ? page.click(selector) : page.tap(selector));

      for (const asked of QUESTIONS) {
        const [menu, ...buttons] = asked.by;

        await fromMenu(page, press, menu);

        for (const button of buttons) {
          await press(button);
        }

        await dialogNamed(page, asked.title);

        for (const theme of ['cardroom', 'contrast']) {
          await page.evaluate(`void (document.documentElement.dataset.theme = ${JSON.stringify(theme)})`);

          const answer = (await page.evaluate(ANSWER_DRAWN)) as AnswerDrawn;

          assert.notEqual(answer.danger, answer.usual, 'the theme draws danger as it draws everything else');
          assert.deepEqual(answer.says, asked.says, `${asked.title}: its buttons`);
          assert.equal(answer.drawn, asked.danger ? answer.danger : answer.usual, `${asked.title} (${theme}, ${screen}): its answer is drawn as ${asked.danger ? 'any other' : 'danger'}`);
        }

        await page.evaluate(`void (document.documentElement.dataset.theme = 'cardroom')`);

        if (asked.title === 'Remove Stu?') {
          await page.screenshot({ path: `${picturesIn}check-question-danger-${screen}.png` });
        }

        // Back to the table by as many steps as the question was opened in
        while ((await page.locator('.overlay .dialog').count()) > 0) {
          await page.keyboard.press('Escape');
        }
      }

      await page.context().close();
    }
  },
];

/** The screens a host answers on: a small phone, a phone, and a phone lying down. */
const SIZES = [
  { name: '360 by 640', width: 360, height: 640 },
  { name: '390 by 844', width: 390, height: 844 },
  { name: '740 by 360', width: 740, height: 360 },
];

/** An answer, and the dialog it gives way to. */
interface Answered {
  what: string;
  /** The dialog the question is opened from, by its line in the menu and its name. */
  from: [action: string, name: string];
  /** The "More" of the row the asking button is behind, for one that is behind one. */
  unfolds?: string;
  /** The button of that dialog that asks, and the question. */
  asks: [button: string, title: string];
  /** The button tapped. */
  tap: string;
  /** What the tap sends the table, for an answer that sends something. */
  sends?: Command['type'];
  /** Resolves once the page shows the table's answer. */
  answered?(page: Page): Promise<unknown>;
}

const PLAYERS: Answered['from'] = ['players', 'Players'];
const LAST_HANDS: Answered['from'] = ['lastHands', 'Last hands'];
const removing = (name: string): Pick<Answered, 'unfolds' | 'asks'> => ({ unfolds: more(name), asks: [on(name, 'remove'), `Remove ${name}?`] });
const gone = (name: string) => (page: Page) => page.waitForSelector(seated(name), { state: 'detached' });

const ANSWERS: Answered[] = [
  { what: 'Remove, answered for the fifth of eight', from: PLAYERS, ...removing('Big Al'), tap: ANSWER, sends: 'kick', answered: gone('Big Al') },
  { what: 'Cancel on removing the fifth of eight', from: PLAYERS, ...removing('Big Al'), tap: CANCEL },
  { what: 'Remove, answered for the last of eight with the list at its end', from: PLAYERS, ...removing('Mo'), tap: ANSWER, sends: 'kick', answered: gone('Mo') },
  { what: 'the ✕ on removing the last of eight with the list at its end', from: PLAYERS, ...removing('Mo'), tap: CLOSE },
  {
    what: 'Make co-host, answered for the second of eight',
    from: PLAYERS,
    unfolds: more('Danny'),
    asks: [on('Danny', 'make-cohost'), 'Make Danny a co-host?'],
    tap: ANSWER,
    sends: 'setCohost',
    answered: (page) => page.waitForSelector(on('Danny', 'end-cohost')),
  },
  {
    what: 'Hand over, answered for the second of eight, after which no row offers a role',
    from: PLAYERS,
    unfolds: more('Danny'),
    asks: [on('Danny', 'make-host'), 'Make Danny the host?'],
    tap: ANSWER,
    sends: 'transferHost',
    answered: (page) => page.waitForSelector('.dialog [data-action="make-host"]', { state: 'detached' }),
  },
  // Lying down, the numbers of Last hands lie under Cancel, and each of them sets the count at a tap
  { what: 'Cancel on ending the night', from: LAST_HANDS, asks: [END_NIGHT, 'End the night?'], tap: CANCEL },
];

/** What the table holds that a stray tap in the list of players could change. */
const standing = (table: RigTable) => {
  const view = table.view(HOST);

  return { seated: view.seats.flatMap((seat) => (seat ? [`${seat.name} ${seat.stack}`] : [])), members: view.members.map((member) => member.name), host: view.hostId, cohosts: view.cohostIds, handsLeft: view.handsLeft, over: view.nightEndedAt !== null };
};

/**
 * The dialog that comes back lays its buttons where the question had its own a moment before, and the
 * second tap of two is on its way to where the first one landed (`holdsUnderTap` in src/client/tapGuard.ts).
 * The watch notes every control that comes up where a different one lay, asks what a tap there reaches,
 * and taps each control the page holds back the moment it does, which is that second tap
 * (underTheFinger.ts): nothing may come of it under the button that was tapped.
 */
const secondTapOnAnAnswer = ANSWERS.map((answered): Check => [
  `the second tap of two on a question’s button presses nothing of the dialog that comes back, with eight players seated: ${answered.what}, at ${SIZES.map((size) => size.name).join(', ')}`,
  async (rig) => {
    let cameUpAnywhere = 0;

    for (const size of SIZES) {
      const table = seatedAndWatched(rig);
      const page = await table.open(HOST, 'smallPhone');
      const [action, from] = answered.from;
      const [button, title] = answered.asks;

      await page.setViewportSize(size);
      await fromMenu(page, (selector) => page.tap(selector), action);
      await dialogNamed(page, from);

      if (answered.unfolds) {
        await page.locator(answered.unfolds).scrollIntoViewIfNeeded();
        await page.locator(answered.unfolds).tap();
        await tapsLive(page);
      }

      await page.locator(button).scrollIntoViewIfNeeded();
      await page.locator(button).tap();
      await dialogNamed(page, title);
      await tapsLive(page);

      // The answer is stopped on its way, as a slow line stops it: what the page then shows is what the tap alone brought
      const sent = commandsSent(page);
      const before = standing(table);
      const tapped = await namedByTheWatch(page, answered.tap);
      const gate = answered.sends ? await Gate.on(page, 'hosting') : null;

      await gate?.close('requests');
      await watchTheBar(page, true);
      await page.locator(answered.tap).tap();
      await dialogNamed(page, from);
      await gate?.holding();

      // The dialog is back and the table has heard nothing yet: what lies under the tapped button now is what a second tap finds
      const back = await watched(page);
      const under = back.found.filter((one) => one.aimedAt === tapped);
      const waited = back.held.filter((one) => under.some((came) => came.cameUp === one.what));

      cameUpAnywhere += under.length;
      assert.deepEqual(under.flatMap(tellingOf), [], `${size.name}: a second tap lands on what the first one brought back`);
      assert.deepEqual(under.filter((came) => !waited.some((one) => one.what === came.cameUp)), [], `${size.name}: something under ${tapped} was not held back`);
      assert.deepEqual(letGoEarly(waited), [], `${size.name}: something under ${tapped} was let go before ${TAPS_SETTLE_MS} ms were over`);
      assert.deepEqual(standing(table), before, `${size.name}: the table changed before the answer reached it`);

      await gate?.open();
      await answered.answered?.(page);

      // The table's answer draws the list anew, with a row gone or a button changed. That is the game's doing, and nothing it moves takes a tap
      const moved = (await watched(page)).found.slice(back.found.length);

      assert.deepEqual(moved.flatMap(tellingOf), [], `${size.name}: a tap lands on what the table’s answer moved`);
      assert.equal(await page.getAttribute('.overlay [role$="dialog"]', 'aria-label'), from, `${size.name}: a tap held back opened something all the same`);
      assert.deepEqual(sent, answered.sends ? [answered.sends] : [], `${size.name}: the table was sent something other than the one answer`);
      await page.context().close();
    }

    // On a screen where only words lie under the tapped button there is nothing to hold back
    assert.ok(cameUpAnywhere > 0, `no control came up where the tapped button lay, on any screen: the answer no longer shows what it is here for`);
  },
]);

const keyboardComesBack: Check = [
  'a host who answers a question from the keyboard has the keyboard back in Players on the button that opened it, on Escape, Cancel and an answer; Enter held down on the answer asks nothing again; once that button is gone, with the player removed, the keyboard is on the next row, at the button that unfolds it, and on the row before when the last one goes, never on the button that took its place; a click that leaves the keyboard on another button, as some browsers’ do, still brings it back to the one clicked; the question breaks no rule of the rule engine in any theme',
  async (rig) => {
    const table = seatedAndWatched(rig);
    const page = await table.open(HOST, 'desktop');
    const inPlayers = () => focusIn(page, '.dialog[aria-label="Players"]');

    await playersFromTheKeyboard(page);

    const unfolded = (name: string) => page.getAttribute(named('More', name), 'aria-expanded');

    // Unfolds the row from the keyboard when it is folded, then asks from the button "More" kept
    const asks = async (name: string, says = 'Remove') => {
      if ((await unfolded(name)) === 'false') {
        await tabTo(page, named('More', name));
        await page.keyboard.press('Enter');
        assert.equal(await keyboardOn(page), `More, ${name}`, 'unfolding a row took the keyboard off the button that unfolds it');
      }

      await tabTo(page, named(says, name));
      await page.keyboard.press('Enter');
      await page.waitForSelector(ANSWER);
      assert.equal(await focusIn(page, '.dialog'), true, 'the question opened with the keyboard left behind it');
    };

    await asks('Stu');

    const sweep = new Sweep();

    await sweep.over(page, 'the question that removes a player');
    sweep.done(1);

    await page.keyboard.press('Escape');
    await dialogNamed(page, 'Players');
    assert.equal(await keyboardOn(page), 'Remove, Stu', 'Escape on the question left the keyboard elsewhere than on the button that opened it');
    assert.equal(await inPlayers(), true, 'the keyboard is back outside the dialog a screen reader should name');

    await asks('Stu');
    await tabTo(page, CANCEL);
    await page.keyboard.press('Enter');
    await dialogNamed(page, 'Players');
    assert.equal(await keyboardOn(page), 'Remove, Stu', 'Cancel left the keyboard elsewhere than on the button that opened the question');

    // Answered, with the answer stopped on its way to the table: the row is there yet, and the keyboard on its button
    const gate = await Gate.on(page, 'hosting');

    await gate.close('requests');
    await asks('Stu');
    await tabTo(page, ANSWER);
    await page.keyboard.down('Enter');
    await gate.holding();
    await dialogNamed(page, 'Players');

    // The key is still down, and repeats on the button the keyboard came back to
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    assert.equal(await page.getAttribute('.overlay [role$="dialog"]', 'aria-label'), 'Players', 'Enter held down on the answer asked the question again');
    assert.equal(await keyboardOn(page), 'Remove, Stu', 'the answer left the keyboard elsewhere than on the button that opened the question');

    // The next row is folded, and its own button to remove takes no keyboard: the one that unfolds it stands for it
    await gate.open();
    await page.waitForSelector(seated('Stu'), { state: 'detached' });
    assert.equal(await keyboardOn(page), 'More, Big Al', 'with the player gone the keyboard is not on the next row');
    assert.equal(await unfolded('Big Al'), 'false', 'the next row unfolded by itself');
    assert.equal(await inPlayers(), true);

    // From there the list is worked down with no trip back to its top: the next row is unfolded with Enter, and its button is the next stop
    await page.keyboard.press('Enter');
    assert.equal(await unfolded('Big Al'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await keyboardOn(page), 'Make co-host, Big Al', 'what a row unfolds is not what the keyboard comes to after the button that unfolds it');
    await asks('Big Al');
    await dialogNamed(page, 'Remove Big Al?');
    await tabTo(page, ANSWER);
    await page.keyboard.press('Enter');
    await page.waitForSelector(seated('Big Al'), { state: 'detached' });
    assert.equal(await keyboardOn(page), 'More, Pocket Pam');

    // The watcher's row is the last with such a button, and with it gone the row before has the keyboard
    await asks(WATCHER);
    await tabTo(page, ANSWER);
    await page.keyboard.press('Enter');
    await page.waitForSelector(row(WATCHER), { state: 'detached' });
    assert.equal(await keyboardOn(page), 'More, Mo', 'with the last row gone the keyboard is not on the row before');

    // A co-host named: the row stays and its button becomes the one that ends it, which sends at a press and so never gets the keyboard
    await asks('Danny', 'Make co-host');
    await tabTo(page, ANSWER);
    await page.keyboard.press('Enter');
    await page.waitForSelector(on('Danny', 'end-cohost'));
    assert.equal(await keyboardOn(page), 'More, Marge', 'with its button gone for End co-host the keyboard is not on the next row');

    // A click that moves no keyboard, as in a browser that leaves it where it was: here on a button that sends at a press
    await page.click(named('More', 'Pocket Pam'));
    await page.focus(named('End co-host', 'Danny'));
    await page.evaluate(`document.querySelector(${JSON.stringify(named('Remove', 'Pocket Pam'))}).click()`);
    await dialogNamed(page, 'Remove Pocket Pam?');
    await page.keyboard.press('Escape');
    await dialogNamed(page, 'Players');
    assert.equal(await keyboardOn(page), 'Remove, Pocket Pam', 'the keyboard came back to what it was on before the click, not to the button clicked');
    assert.deepEqual(table.view(HOST).cohostIds, [table.auth('Danny').id]);
    assert.deepEqual(
      table.view(HOST).seats.flatMap((seat) => (seat ? [seat.name] : [])),
      EIGHT.filter((name) => name !== 'Stu' && name !== 'Big Al'),
    );
  },
];

/** The checks of questions and of where a dialog goes back to. Pictures go into `picturesIn`, a folder ending in a slash. */
export const confirmChecks = (picturesIn: string): Check[] => [backToPlayers, lastHandsAndTheMenu, nightsEndIsSaid, dangerIsDrawn(picturesIn), ...secondTapOnAnAnswer, keyboardComesBack];
