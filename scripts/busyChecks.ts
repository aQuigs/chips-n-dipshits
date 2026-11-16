/*
 * Checks of a press that sends something: the pressed button is switched off and says what it is doing
 * until the table answers (`holdWhile` and `sends` in src/client/ui.ts), and is back, or gone with what it
 * did, however the answer comes. The server here answers at once, so each check stops the request at a
 * gate, looks at the page while it waits, and lets the answer go the way the path asks for.
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { ONCE } from '../src/client/once.ts';
import type { Command } from '../src/engine/index.ts';
import type { Check } from './checkRunner.ts';
import { buttonNow, commandsSent, keysSent, refusalTold, toasts, toastTold } from './pageSpies.ts';
import { ANSWER, CANCEL, CLOSE, dialogNamed, fromMenu, HOST, more, noDialog, on, seatedAndWatched } from './playersDialog.ts';
import { Gate } from './rig.ts';
import type { Rig, RigTable } from './rig.ts';

const SET_STACK = "Set Danny's stack";
const ASKING = 'Nana';

/** The name of the dialog over the table, or null with none. */
const over = (page: Page) => page.evaluate(`document.querySelector('.overlay [role$="dialog"]')?.getAttribute('aria-label') ?? null`) as Promise<string | null>;

/** Six seated, nothing dealt, and one more asking the host for a seat. */
function withOneAsking(rig: Rig): RigTable {
  const table = seatedAndWatched(rig, 6);

  table.join(ASKING);
  table.act(ASKING, { type: 'requestSeat', seat: 7, buyIn: 500 });

  return table;
}

async function opened(page: Page, action: string, name: string): Promise<void> {
  await fromMenu(page, (selector) => page.locator(selector).tap(), action);
  await dialogNamed(page, name);
}

/** A button that sends the table something at a press. */
interface Sending {
  what: string;
  build(rig: Rig): RigTable;
  /** From the table with nothing over it, brings the button up. */
  open?(page: Page): Promise<void>;
  button: string;
  says: string;
  /** What it says while the table has not answered: for a button with no words, what it says anyway. */
  doing: string;
  sends: Command['type'];
  /** The dialog the button is in, by its name. */
  inDialog: string | null;
  /** Whether it is a form's button: the form says a refusal itself, in the line by the button (`refusalLine`), and no toast says it again. */
  ofForm?: true;
  /** The buttons that answer the same thing, which take no press either until the table has answered (`heldTogether`). */
  beside?: string[];
  /** What else the page must show while the button is held. */
  whileHeld?(page: Page): Promise<void>;
  /**
   * Where a press that got no answer leaves the viewer: at the button, or past its dialog, at the dialog
   * named or at the table. The table may have taken it, and a second try could count twice.
   */
  unanswered: 'stays' | { leavesFor: string | null };
  /** Resolves once the page shows that the table took it. */
  taken(page: Page): Promise<unknown>;
}

const SENDING: Sending[] = [
  {
    what: 'Start the game on the felt',
    build: (rig) => seatedAndWatched(rig, 6),
    button: '.stage [data-action="start"]',
    says: 'Start the game',
    doing: 'Starting…',
    sends: 'start',
    inDialog: null,
    unanswered: 'stays',
    taken: (page) => page.waitForSelector('.stage [data-action="start"]', { state: 'detached' }),
  },
  {
    // Held, a button of a banner only dims: its words have no room to grow on a phone
    what: 'Approve on a request’s banner',
    build: withOneAsking,
    button: '.banners [data-action="approve"]',
    says: 'Approve',
    doing: 'Approve',
    sends: 'approve',
    inDialog: null,
    beside: ['.banners [data-action="deny"]'],
    unanswered: 'stays',
    taken: (page) => page.waitForSelector('.banners [data-action="approve"]', { state: 'detached' }),
  },
  {
    what: 'Pause the game in the menu',
    build(rig) {
      const table = seatedAndWatched(rig, 6);

      table.act(HOST, { type: 'start' });

      return table;
    },
    open: async (page) => {
      await page.locator('[data-action="menu"]').tap();
      await page.waitForSelector('.menu [data-action="pause"]');
    },
    button: '.menu [data-action="pause"]',
    says: 'Pause the game',
    doing: 'Pausing…',
    sends: 'pause',
    inDialog: 'Friday Night',
    unanswered: { leavesFor: null },
    taken: noDialog,
  },
  {
    what: 'Remove on the question asked from Players',
    build: (rig) => seatedAndWatched(rig, 6),
    open: async (page) => {
      // Come back to from a question that got no answer, Players is open already, with the row as it was left
      if ((await over(page)) !== 'Players') {
        await opened(page, 'players', 'Players');
      }

      if ((await page.getAttribute(more('Marge'), 'aria-expanded')) === 'false') {
        await page.locator(more('Marge')).tap();
      }

      await page.locator(on('Marge', 'remove')).tap();
      await dialogNamed(page, 'Remove Marge?');
    },
    button: ANSWER,
    says: 'Remove',
    doing: 'Removing…',
    sends: 'kick',
    inDialog: 'Remove Marge?',
    // What was asked has gone out, and Cancel would cancel nothing
    beside: [CANCEL],
    unanswered: { leavesFor: 'Players' },
    taken: async (page) => {
      await dialogNamed(page, 'Players');
      await page.waitForSelector(on('Marge', 'set-stack'), { state: 'detached' });
    },
  },
  {
    what: 'a number in Last hands',
    build(rig) {
      const table = seatedAndWatched(rig, 6);

      table.act(HOST, { type: 'setLastHands', hands: 2, from: table.view(HOST).handCount });

      return table;
    },
    open: (page) => opened(page, 'lastHands', 'Last hands'),
    button: '.dialog [data-hands="3"]',
    says: '3',
    doing: '3',
    sends: 'setLastHands',
    inDialog: 'Last hands',
    // A second pick sent after the first could reach the table before it
    beside: ['.dialog [data-hands="2"]', '.dialog [data-hands="5"]', '.dialog [data-action="call-off-last-hands"]'],
    // A number has no words to say that it was pressed: it is painted as the one picked, and the one picked before no longer is
    async whileHeld(page) {
      const painted = await page.locator('.dialog .hand-counts button').evaluateAll((numbers) => {
        const paint = (number: (typeof numbers)[number]) => number.ownerDocument.defaultView!.getComputedStyle(number).backgroundColor;
        const pressed = numbers.find((number) => number.getAttribute('aria-busy') === 'true');

        return numbers.filter((number) => pressed !== undefined && paint(number) === paint(pressed)).map((number) => number.textContent);
      });

      assert.deepEqual(painted, ['3'], 'the number pressed is not the one number painted as picked');
    },
    unanswered: { leavesFor: null },
    taken: noDialog,
  },
  {
    what: 'Approve in Players',
    build: withOneAsking,
    open: (page) => opened(page, 'players', 'Players'),
    button: on(ASKING, 'approve'),
    says: 'Approve',
    doing: 'Approving…',
    sends: 'approve',
    inDialog: 'Players',
    beside: [on(ASKING, 'deny')],
    unanswered: 'stays',
    taken: (page) => page.waitForSelector(on(ASKING, 'approve'), { state: 'detached' }),
  },
  {
    what: 'Save in Table settings',
    build: (rig) => seatedAndWatched(rig, 6),
    open: async (page) => {
      await opened(page, 'settings', 'Table settings');
      await page.fill('#table-small-blind', '5');
    },
    button: '.dialog [data-action="save-settings"]',
    says: 'Save',
    doing: 'Saving…',
    sends: 'updateConfig',
    inDialog: 'Table settings',
    ofForm: true,
    unanswered: { leavesFor: null },
    taken: noDialog,
  },
];

const everyPath = SENDING.map((sending): Check => [
  `a button that sends is switched off and says what it is doing until the table answers, and is back after a refusal and after no answer, and gone with what it did on the try after that: ${sending.what}, on a phone`,
  async (rig) => {
    const { build, open, button, says, doing, sends, inDialog, ofForm, beside = [], whileHeld, unanswered, taken } = sending;
    const table = build(rig);
    const page = await table.open(HOST, 'smallPhone');
    const sent = commandsSent(page);
    const keys = keysSent(page);
    const gate = await Gate.on(page, 'hosting');
    const polls = await Gate.on(page, 'polls');
    const before = table.version;

    // What goes under a key (`ONCE`) the page does not leave at one try: it asks the table how it stands and sends
    // the same once more, under the same key, with the button held all the while
    const keyed = ONCE.has(sends);
    const askedAgain = async (path: string, becomes: () => Promise<void>) => {
      if (!keyed) {
        return;
      }

      await gate.holding();
      assert.deepEqual(await buttonNow(page, button), { says: doing, held: true }, `${path}: the button came back while the page was asking again`);
      await becomes();
    };

    // Pressed, with the request stopped at the gate: the one thing on the page that says the press was heard
    const pressed = async (path: string) => {
      await page.locator(button).tap();
      await gate.holding();
      assert.deepEqual(await buttonNow(page, button), { says: doing, held: true }, `${path}: the button pressed does not show that it was`);
      assert.equal(await over(page), inDialog, `${path}: what the button is in went before the table had answered`);

      for (const other of beside) {
        assert.equal(await page.locator(other).isDisabled(), true, `${path}: ${other} can be pressed while the answer to the same thing is on its way`);
        assert.equal(await page.getAttribute(other, 'aria-busy'), null, `${path}: ${other} shows as pressed, and was not`);
      }

      await whileHeld?.(page);
    };

    const back = async (path: string) => {
      await page.waitForSelector(`${button}:enabled`);
      assert.deepEqual(await buttonNow(page, button), { says, held: false }, `${path}: the button did not come back as it was`);
      assert.equal(await over(page), inDialog, `${path}: the viewer was taken from what the button is in`);

      for (const other of beside) {
        assert.equal(await page.locator(other).isEnabled(), true, `${path}: ${other} did not come back with the button`);
      }
    };

    // Refused, as when the server could not get to the table in time: the button is back where it was, and the reason is told
    await gate.close('requests');
    await open?.(page);
    await pressed('refused');
    await gate.refuse();
    await askedAgain('refused', () => gate.refuse());
    await back('refused');
    await (ofForm ? refusalTold(page, 'The table is busy') : toastTold(page, 'The table is busy'));

    // No answer, as when a phone drops off the network: the page says it is asking what happened, and the button is back, or left behind
    const told = (await toasts(page)).length;

    await pressed('no answer');
    await gate.lose();
    await toastTold(page, 'No answer from the table', told);
    await askedAgain('no answer', () => gate.lose());

    if (unanswered === 'stays') {
      await back('no answer');
    } else if (unanswered.leavesFor === null) {
      await noDialog(page);
    } else {
      await dialogNamed(page, unanswered.leavesFor);
    }

    assert.equal(table.version, before, 'the table took a press the gate never let through');

    // The try after that is heard, and the button is held until the page has the answer: gone then with what it did.
    // The table's news is stopped too, or a poll would show the page what the answer is about to
    await gate.close('answers');

    if (unanswered !== 'stays') {
      await open?.(page);
    }

    await polls.close('requests');
    await pressed('answered');
    assert.ok(table.version > before, 'the table did not take the press the gate let through');
    await gate.open();
    await taken(page);
    await polls.open();
    assert.equal(sent.filter((type) => type === sends).length, keyed ? 5 : 3, 'something was sent that no press asked for, or a press was not sent');
    assert.equal(new Set(keys).size, 1, keyed ? 'the same press, asked again, went under another key' : 'a press went under a key that needs none');
    assert.equal(keys[0] !== undefined, keyed);
    assert.equal(await page.locator(`${button}[aria-busy]`).count(), 0, 'a button is left held after the answer');
  },
]);

const LURKER = 'Lurker';

/**
 * The table's news draws a part of the page anew while a press in it is on its way, and every button
 * in that part is a new element. The one that is held is held still: a host who sees Approve come
 * back live would press it again.
 */
const heldThroughARedraw: Check = [
  'a button held for an answer is held still after the table’s news has drawn its part anew: Approve in Players and on a banner, as another request goes, on a phone',
  async (rig) => {
    for (const where of ['Players', 'a banner'] as const) {
      const table = withOneAsking(rig);

      table.join(LURKER);
      table.act(LURKER, { type: 'requestSeat', seat: 8, buyIn: 500 });

      const page = await table.open(HOST, 'smallPhone');
      const sent = commandsSent(page);
      const gate = await Gate.on(page, 'hosting');
      const answer = (name: string, action: 'approve' | 'deny') => (where === 'Players' ? on(name, action) : `.banners [data-action="${action}"][data-player="${table.auth(name).id}"]`);
      const approve = (name: string) => answer(name, 'approve');

      if (where === 'Players') {
        await opened(page, 'players', 'Players');
      }

      await gate.close('requests');
      await page.locator(approve(ASKING)).tap();
      await gate.holding();

      // The other request is taken back, and its row goes: the list is drawn anew around the button that is held
      const drawn = await page.locator(approve(ASKING)).elementHandle();

      table.act(LURKER, { type: 'cancelRequest' });
      await page.waitForSelector(approve(LURKER), { state: 'detached' });
      assert.equal(await drawn!.evaluate((button) => button.isConnected), false, `${where}: the button was not drawn anew: the step no longer shows what it is here for`);
      assert.deepEqual(await buttonNow(page, approve(ASKING)), { says: where === 'Players' ? 'Approving…' : 'Approve', held: true }, `${where}: drawn anew, the button that was pressed can be pressed again`);
      assert.equal(await page.locator(answer(ASKING, 'deny')).isDisabled(), true, `${where}: drawn anew, Deny can be pressed while Approve is on its way`);
      assert.equal(await page.getAttribute(answer(ASKING, 'deny'), 'aria-busy'), null, `${where}: drawn anew, Deny shows as pressed, and was not`);

      await gate.open();
      await page.waitForSelector(approve(ASKING), { state: 'detached' });
      assert.deepEqual(sent.filter((type) => type === 'approve'), ['approve'], `${where}: the one press was sent more than once`);
      assert.ok(table.view(HOST).seats.some((seat) => seat?.name === ASKING), `${where}: the player approved was not seated`);
      await page.context().close();
    }
  },
];

/**
 * No answer has two meanings the page cannot tell apart: the request was lost on its way, or the table
 * took it and what it said back was lost. So the page never sends the press again by itself: it asks how
 * the table stands, and what it is shown then is the answer.
 */
const takenUnanswered: Check = [
  'a press the table took, whose answer was lost, is sent once: the page asks how the table stands, Approve in Players goes with its player seated, and the question that removes is left for a list without the player, on a phone',
  async (rig) => {
    const table = withOneAsking(rig);
    const page = await table.open(HOST, 'smallPhone');
    const sent = commandsSent(page);
    const gate = await Gate.on(page, 'hosting');
    const polls = await Gate.on(page, 'polls');

    // Pressed and heard by the table, whose answer never reaches the page; nor does its news, until the page has said it is asking
    const lost = async (button: string, doing: string) => {
      const told = (await toasts(page)).length;

      await polls.close('requests');
      await page.locator(button).tap();
      await gate.holding();
      assert.deepEqual(await buttonNow(page, button), { says: doing, held: true });
      await gate.lose();
      await toastTold(page, 'No answer from the table', told);
      await polls.open();
    };

    await gate.close('answers');
    await opened(page, 'players', 'Players');
    await lost(on(ASKING, 'approve'), 'Approving…');
    await page.waitForSelector(on(ASKING, 'approve'), { state: 'detached' });
    assert.ok(table.view(HOST).seats.some((seat) => seat?.name === ASKING), 'the player approved was not seated');

    await page.locator(more('Marge')).tap();
    await page.locator(on('Marge', 'remove')).tap();
    await dialogNamed(page, 'Remove Marge?');
    await lost(ANSWER, 'Removing…');
    await dialogNamed(page, 'Players');
    await page.waitForSelector(on('Marge', 'set-stack'), { state: 'detached' });
    assert.deepEqual(sent.filter((type) => type === 'approve' || type === 'kick'), ['approve', 'kick'], 'a press whose answer was lost was sent again');
    assert.equal(await page.locator('button[aria-busy]').count(), 0, 'a button is left held');
  },
];

/**
 * A viewer who closes a dialog while its answer is on the way has left it: the answer, when it comes,
 * takes them nowhere and closes nothing they have opened since.
 */
const leftBeforeTheAnswer: Check = [
  'a question closed by its viewer while the answer is on its way stays closed, and the answer closes nothing they opened since, on a phone',
  async (rig) => {
    const table = seatedAndWatched(rig, 6);
    const page = await table.open(HOST, 'smallPhone');
    const gate = await Gate.on(page, 'hosting');

    await opened(page, 'players', 'Players');
    await page.locator(more('Marge')).tap();
    await page.locator(on('Marge', 'remove')).tap();
    await dialogNamed(page, 'Remove Marge?');
    await gate.close('answers');
    await page.locator(ANSWER).tap();
    await gate.holding();

    const answer = await page.locator(ANSWER).elementHandle();

    // What was asked has gone out, so Cancel is off with the answer; the dialog can be closed all the while, and a table that never answers keeps nobody in a question
    assert.equal(await page.locator(CANCEL).isDisabled(), true, 'Cancel can be pressed on a question whose answer has gone out, and would cancel nothing');
    await page.locator(CLOSE).tap();
    await dialogNamed(page, 'Players');
    await page.locator(on('Danny', 'set-stack')).tap();
    await dialogNamed(page, SET_STACK);

    // The table's news is no sign of it, since a poll brings that too: the button, long off the page, is let go once its answer has been dealt with
    await gate.open();
    await page.waitForFunction((button) => !button!.hasAttribute('aria-busy'), answer);
    assert.equal(await over(page), SET_STACK, 'the answer to a question its viewer had left closed the dialog they opened since');
    assert.ok(!table.view(HOST).seats.some((seat) => seat?.name === 'Marge'), 'the answer was not taken at the table');
  },
];

/** The first screen's forms are held the same way, and theirs is the request that may be asked again as it was: the table is made once. */
const firstScreen: Check = [
  'Create table on the first screen is switched off and says “Setting up…” until the server answers, is back after a refusal and after no answer with what was typed, and the try after that opens the one table made, on a phone',
  async (rig) => {
    const page = await rig.lobby('smallPhone');
    const gate = await Gate.on(page, 'creates');
    const button = '[data-action="create-table"]';

    const pressed = async (path: string) => {
      await page.locator(button).tap();
      await gate.holding();
      assert.deepEqual(await buttonNow(page, button), { says: 'Setting up…', held: true }, `${path}: the button pressed does not show that it was`);
    };

    const back = async (path: string) => {
      await page.waitForSelector(`${button}:enabled`);
      assert.deepEqual(await buttonNow(page, button), { says: 'Create table', held: false }, `${path}: the button did not come back as it was`);
      assert.equal(await page.inputValue('#host-name'), 'Quigs', `${path}: what was typed is gone`);
    };

    await page.fill('#host-name', 'Quigs');
    await gate.close('requests');
    await pressed('refused');
    await gate.refuse();
    await back('refused');
    await refusalTold(page, 'The table is busy');

    // Asked again as it was, the table is made once: so this form says no answer where it says a refusal, by its button until the next try
    await pressed('no answer');
    await gate.lose();
    await back('no answer');
    await refusalTold(page, 'Could not create the table');

    await gate.close('answers');
    await pressed('answered');
    await gate.open();
    await dialogNamed(page, 'Invite players');
    assert.equal(await page.locator(button).count(), 0, 'the first screen is still up after its table was made');
  },
];

/** The checks of a press that sends something. */
export const BUSY_CHECKS: Check[] = [...everyPath, takenUnanswered, heldThroughARedraw, leftBeforeTheAnswer, firstScreen];
