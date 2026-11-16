/*
 * The checks of a form that is turned down and of how its boxes write an amount: that the reason stands
 * in a line by the button pressed until the next try and in no toast, with the box it is about marked
 * and in sight; and that an amount is written in its box as the table writes it. They run with the other
 * browser checks (`screenChecks.ts`).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { Page } from 'playwright';

import { SPOKEN, spoken } from './a11y.ts';
import { Sweep } from './accessibilityChecks.ts';
import type { Check } from './checkRunner.ts';
import { telling, unreadable } from './covered.ts';
import { letGoEarly, NEXT_FRAME } from './layoutSweep.ts';
import { answeredAfter, opsSent, refusalTold, toasts, toastTold } from './pageSpies.ts';
import { boxes, Gate, pressOn, squeezed, unfolded } from './rig.ts';
import { tellingOf, watched, watchTheBar } from './underTheFinger.ts';

const BLINDS = "The big blind can't be smaller than the small blind";
const CREATE = '[data-action="create-table"]';
const FIND = '[data-action="find-table"]';

const marked = (page: Page) => page.evaluate(`[...document.querySelectorAll('[aria-invalid="true"]')].map((box) => box.id)`) as Promise<string[]>;
const alerts = async (page: Page, words: string) => (await spoken(page)).filter((line) => line.startsWith('alert: ') && line.includes(words));

/** What a screen reader says a box is described by, a line to each thing that describes it. */
const describing = (page: Page, box: string) =>
  page.evaluate(`(document.querySelector(${JSON.stringify(box)}).getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '')`) as Promise<string[]>;

/** Whether a form's line stands right before or right after a control, with nothing between them. */
const lineBy = (page: Page, control: string, side: 'previous' | 'next') =>
  page.evaluate(`document.querySelector(${JSON.stringify(control)}).${side}ElementSibling?.matches('.refusal:not(.stale)') === true`) as Promise<boolean>;

export const formChecks = (out: string): Check[] => {
  const shot = async (page: Page, name: string): Promise<void> => {
    await page.screenshot({ path: join(out, `${name}.png`) });
  };

  return [
    [
      'a new table that is turned down says why in a line over Create table and in no toast, the box it is about marked and in sight with it on a 360 phone, a phone lying down and the desktop, breaking no rule in any theme; the reason is read out once, stays when the box is typed over, and goes out of sight with nothing moved as the next try goes out; a code no table has is said under its own row, with the form for a new table as it was, and one of nothing but spaces is never looked up; a marked box the form takes away leaves the line in its place',
      async (rig) => {
        const sweep = new Sweep();

        for (const screen of ['smallPhone', 'phoneSideways', 'desktop'] as const) {
          const page = await rig.lobby(screen, SPOKEN);
          const press = pressOn(page, screen);

          await page.fill('#host-name', 'Quigs');
          await page.fill('#new-table-big-blind', '5');
          await page.locator(CREATE).scrollIntoViewIfNeeded();
          await press(CREATE);

          const refused = await refusalTold(page, BLINDS);

          assert.deepEqual(refused.marked, ['new-table-big-blind'], `${screen}: of the two blinds, the one that was changed`);
          assert.equal(refused.squeezed, false, `${screen}: the reason is cut off`);
          assert.equal(await lineBy(page, CREATE, 'previous'), true, `${screen}: the reason is not right over Create table`);
          assert.deepEqual(await alerts(page, 'big blind'), [`alert: ${BLINDS}`], `${screen}: the reason was not read out once`);
          assert.deepEqual(await describing(page, '#new-table-big-blind'), [BLINDS], `${screen}: a reader that comes to the box is not told why it is marked`);
          assert.equal(await page.inputValue('#host-name'), 'Quigs', `${screen}: a refusal cost what was typed`);
          await shot(page, `new-table-refused-${screen}`);
          await sweep.over(page, `a new table turned down, ${screen}`);

          // Typed over, the box is no longer what was refused. The reason stays over the button until the next try
          await page.fill('#new-table-big-blind', '6');
          assert.deepEqual(await marked(page), [], `${screen}: a box typed over is still marked`);
          assert.deepEqual(await describing(page, '#new-table-big-blind'), [''], `${screen}: a box typed over is still described by the reason`);
          assert.equal(await lineBy(page, CREATE, 'previous'), true, `${screen}: the reason went before the next try`);

          // The next try: the words go out of sight while it is out, and neither the line nor the button moves
          const creates = await Gate.on(page, 'creates');

          await page.locator(CREATE).scrollIntoViewIfNeeded();

          const lay = await boxes(page, `.start-table .refusal, ${CREATE}`);

          await creates.close('requests');
          await press(CREATE);
          await page.waitForSelector('.start-table .refusal.stale', { state: 'attached' });
          assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.start-table .refusal')).visibility`), 'hidden', `${screen}: the last try's reason is still in sight`);
          assert.deepEqual(await boxes(page, `.start-table .refusal, ${CREATE}`), lay, `${screen}: the line or the button moved under the finger as the next try went out`);

          await creates.open();
          await refusalTold(page, BLINDS);
          assert.equal((await alerts(page, 'big blind')).length, 2, `${screen}: a second refusal in the same words was not read out`);

          // Nothing but spaces is no code, and no table is asked for: the browser says of the box what it says of an empty one
          const asked = opsSent(page);

          await page.fill('#table-code', '   ');
          await press(FIND);
          await page.evaluate(NEXT_FRAME);
          assert.deepEqual(asked.filter((op) => op === 'info'), [], `${screen}: a code of nothing but spaces was looked up`);
          assert.deepEqual([await page.inputValue('#table-code'), await page.evaluate(`document.querySelector('#table-code').matches(':invalid')`)], ['', true], `${screen}: a code of nothing but spaces`);
          assert.equal(await page.locator('.join-strip .refusal').count(), 0);

          // A code no table has, with the form for a new table half filled in
          await page.fill('#table-code', 'nosuchtable1');
          await press(FIND);

          const notFound = await refusalTold(page, 'There is no table with the code NOSUCHTABLE1.');

          assert.deepEqual(notFound.marked, ['table-code']);
          assert.equal(notFound.squeezed, false, `${screen}: the reason is cut off`);
          assert.equal(await lineBy(page, FIND, 'next'), true, `${screen}: the reason is not right under the row of the code`);
          assert.deepEqual([await page.inputValue('#table-code'), await page.inputValue('#host-name'), await page.inputValue('#new-table-big-blind')], ['nosuchtable1', 'Quigs', '6'], `${screen}: a code no table has cost what was typed`);
          assert.equal(new URL(page.url()).searchParams.get('table'), null, `${screen}: the address names a table that is not there`);
          assert.deepEqual(await toasts(page), [], `${screen}: a form's reason was told in a toast`);
          await shot(page, `code-refused-${screen}`);

          // The table is to play dollars, and every amount is a new box: the line over Create table has no box left to point at, and keeps to its place
          assert.equal(await page.locator('.start-table .refusal.pointing').count(), 1, `${screen}: the reason does not keep in sight with the box it marks`);
          await press(await unfolded(page, '#new-table-unit label:has-text("Dollars and cents")'));
          await page.waitForFunction(`document.querySelector('#new-table-big-blind').value.includes('.')`);
          assert.equal(await page.locator('.start-table .refusal.pointing').count(), 0, `${screen}: the reason floats over a form whose marked box is gone`);
          assert.deepEqual(await marked(page), ['table-code'], `${screen}: a box that took a marked one's place is marked`);
          assert.equal(await lineBy(page, CREATE, 'previous'), true, `${screen}: the reason went before the next try`);
          await page.context().close();
        }

        sweep.done(3);
      },
    ],
    [
      'a seat, chips, a stack, a name and a preset asked for and turned down are each said in a line by the button pressed and in no toast, on a 360 phone and the desktop, breaking no rule in any theme: the box at fault is marked where the words name it and none where they do not, nothing the line moves takes a tap as it comes, what was typed is still there after the table’s next news, the reason is read out once, and word of news looks unlike word that something went wrong',
      async (rig) => {
        const sweep = new Sweep();

        rig.players.add('Big Al', rig.now());

        for (const screen of ['smallPhone', 'desktop'] as const) {
          const table = rig.table(['Quigs', 'Stu', 'Pam'].map((name) => ({ name, stack: 2000 })), { minBuyIn: 400, maxBuyIn: 4000 });

          table.join('Marge');

          // A seat, at a table whose host raises the least buy-in while the dialog is open
          const marge = await table.open('Marge', screen, SPOKEN);
          const press = pressOn(marge, screen);

          await press('[data-sit]');
          await marge.waitForSelector('#buy-in');
          table.act('Quigs', { type: 'updateConfig', config: { minBuyIn: 3000 } });
          await marge.fill('#buy-in', '2500');
          await watchTheBar(marge);
          await press('[data-action="confirm-sit"]');

          const seat = await refusalTold(marge, 'Your buy-in must be a whole number from 3,000 to 4,000');

          // The line makes the dialog taller, and its controls come to lie where others lay with the answer and not with a tap
          const moved = await watched(marge);

          assert.ok(moved.found.length > 0, `${screen}: nothing came up where something else lay: the check no longer shows what it is here for`);
          assert.deepEqual(moved.found.flatMap(tellingOf), [], `${screen}: a tap lands on what the reason moved`);
          assert.deepEqual(moved.liveAtOnce, [], `${screen}: what the reason moved takes a tap at once`);
          assert.deepEqual(letGoEarly(moved.held), [], `${screen}: what the reason moved was let go early`);

          assert.deepEqual(seat.marked, ['buy-in'], `${screen}: the buy-in is what was refused`);
          assert.equal(seat.squeezed, false);
          assert.equal(await lineBy(marge, '[data-action="confirm-sit"]', 'previous'), true, `${screen}: the reason is not right over Sit down`);
          assert.ok((await describing(marge, '#buy-in')).includes(seat.text), `${screen}: a reader that comes to the box is not told why it is marked`);
          await shot(marge, `seat-refused-${screen}`);
          await sweep.over(marge, `a seat turned down, ${screen}`);

          // The table's next news draws the page again: the dialog is as it was, and the reason is not said again
          table.act('Pam', { type: 'chat', text: 'any day now' });
          await table.heardBy(marge);
          assert.equal(await marge.inputValue('#buy-in'), '2,500', `${screen}: what was typed went with the table's next news`);
          assert.deepEqual((await refusalTold(marge, 'Your buy-in')).marked, ['buy-in']);
          assert.deepEqual(await alerts(marge, 'Your buy-in'), ['alert: Your buy-in must be a whole number from 3,000 to 4,000'], `${screen}: the reason was not read out once`);

          await marge.fill('#buy-in', '3000');
          await press('[data-action="confirm-sit"]');
          await marge.waitForSelector('.dialog', { state: 'detached' });
          assert.deepEqual(await toasts(marge), [], `${screen}: a form's reason was told in a toast`);
          await marge.context().close();

          // Chips, with less room at the seat than when the dialog opened
          const stu = await table.open('Stu', screen);
          const pressStu = pressOn(stu, screen);

          await pressStu('.controls [data-action="rebuy"]');
          await stu.waitForSelector('#rebuy-amount');
          table.act('Quigs', { type: 'transferChips', from: table.auth('Pam').id, to: table.auth('Stu').id, amount: 1900 });
          await stu.fill('#rebuy-amount', '500');
          await pressStu('[data-action="confirm-rebuy"]');
          assert.deepEqual((await refusalTold(stu, 'The chips you add must be a whole number from 1 to 100')).marked, ['rebuy-amount'], `${screen}: the chips to add are what was refused`);
          assert.equal(await lineBy(stu, '[data-action="confirm-rebuy"]', 'previous'), true);
          await stu.context().close();

          // A stack, for a player a hand has been dealt to since: words about the hand, which are no box's
          const host = await table.open('Quigs', screen, SPOKEN);
          const pressHost = pressOn(host, screen);

          await pressHost('[data-action="menu"]');
          await pressHost('.menu [data-action="players"]');
          await pressHost('.dialog li:has-text("Pam") [data-action="set-stack"]');
          await host.waitForSelector('#new-stack');
          table.deal({ button: 0 });
          await host.fill('#new-stack', '2500');
          await pressHost('.dialog button[type="submit"]');
          assert.deepEqual((await refusalTold(host, 'Pam is in the current hand, so wait until it is over')).marked, [], `${screen}: a box is marked for a reason that names none`);
          assert.equal(await host.inputValue('#new-stack'), '2,500');
          await shot(host, `stack-refused-${screen}`);
          await pressHost('.dialog [data-action="close"]');
          await pressHost('.dialog [data-action="close"]');
          await host.waitForSelector('.dialog', { state: 'detached' });

          // A preset under a name too long for one, which only a page that lets it be typed can send
          await pressHost('[data-action="menu"]');
          await pressHost('.menu [data-action="settings"]');
          await host.evaluate(`document.querySelector(${JSON.stringify(await unfolded(host, '#preset-name'))}).removeAttribute('maxlength')`);
          await host.fill('#preset-name', 'A name that goes on for far too long to be one');
          await pressHost('[data-action="save-preset"]');

          const preset = await refusalTold(host, 'The preset name must be 1 to 30 characters');

          assert.deepEqual(preset.marked, ['preset-name']);
          assert.equal(await lineBy(host, '[data-action="save-preset"]', 'next'), true, `${screen}: the reason is not right under the row of the name`);
          assert.deepEqual(rig.presets.list(), []);
          await shot(host, `preset-refused-${screen}`);
          await pressHost('.dialog [data-action="close"]');
          await host.waitForSelector('.dialog', { state: 'detached' });

          // Who you are, under a name the list of players has
          await pressHost('[data-action="menu"]');
          await pressHost('.menu [data-action="who"]');
          await host.waitForSelector('[data-action="say-who"]:enabled');
          await pressHost('[data-action="someone-new"]');
          await host.fill('#who-name', 'big al');
          await pressHost('[data-action="say-who"]');

          const who = await refusalTold(host, 'Big Al is already on the list of players');

          assert.deepEqual(who.marked, ['who-name'], `${screen}: the name is what was refused`);
          assert.equal(who.squeezed, false);
          assert.equal(await lineBy(host, '[data-action="say-who"]', 'previous'), true);
          assert.equal((await alerts(host, 'Big Al is already')).length, 1, `${screen}: the reason was not read out once`);
          assert.deepEqual(await toasts(host), [], `${screen}: a form's reason was told in a toast`);
          await shot(host, `who-refused-${screen}`);
          await sweep.over(host, `a name turned down, ${screen}`);

          // Said as that player, it is taken: news, in a toast that has no edge of bad news. The name is put away with the pick, and the line lets go of it
          await pressHost('[data-action="pick-alike"]');
          assert.deepEqual([await host.locator('.dialog .refusal.pointing').count(), await marked(host)], [0, []], `${screen}: the reason still points at a name that was put away`);
          await pressHost('[data-action="say-who"]');
          assert.equal((await toastTold(host, 'Noted: on the list of players you are Big Al.')).edge, null, `${screen}: news has the edge of bad news`);
          await host.context().close();
        }

        // Word that something went wrong and belongs to no form: a link to a table that is not there
        const lost = await rig.page('smallPhone', 'a visitor');

        await lost.goto(`${rig.url}?table=NOSUCHTABLE1`);
        const { edge } = await toastTold(lost, 'There is no table with the code NOSUCHTABLE1.');
        const bad = await lost.evaluate(`(() => {
          const probe = Object.assign(document.createElement('i'), { style: 'color: var(--bad)' });

          document.body.append(probe);

          const { color } = getComputedStyle(probe);

          probe.remove();

          return color;
        })()`);

        assert.ok(edge !== null && edge.color === bad && edge.width >= 4, `word that something went wrong has no edge of bad news: ${JSON.stringify(edge)} where bad news is ${bad}`);
        await shot(lost, 'toast-failed-smallPhone');
        await sweep.over(lost, 'word that something went wrong');
        sweep.done(5);
      },
    ],
    [
      'the table settings turned down on a phone lying down, where a dialog says what it says beside its button: the reason has the row over the two to itself, with word that a change waits for the next hand and Save whole under it, and nothing in the dialog covered',
      async (rig) => {
        const table = rig.table(['Quigs', 'Stu', 'Pam'].map((name) => ({ name, stack: 2000 })));

        // A hand in play, so the foot says when a change to the blinds applies
        table.deal({ button: 0 });

        const page = await table.open('Quigs', 'phoneSideways');
        const waits = '.dialog-foot [data-says="next-hand"]';
        const save = '[data-action="save-settings"]';

        await page.tap('[data-action="menu"]');
        await page.tap('.menu [data-action="settings"]');
        await page.fill(await unfolded(page, '#table-big-blind'), '5');
        await page.waitForSelector(`${waits}:visible`);
        await page.tap(save);
        assert.deepEqual((await refusalTold(page, BLINDS)).marked, ['table-big-blind']);

        const boxOf = async (selector: string) => (await boxes(page, selector))[0]!;
        const line = await boxOf('.dialog-foot .refusal');
        const note = await boxOf(waits);
        const button = await boxOf(save);

        assert.ok(line.bottom <= Math.min(note.top, button.top), 'the reason is beside the note or the button, in a row with no room for it');
        assert.ok(note.right <= button.left, 'the note and Save are no longer side by side');
        assert.deepEqual(await squeezed(page, `.dialog-foot .refusal, ${waits}, ${save}`), [], 'something in the foot is cut off');
        assert.deepEqual((await unreadable(page)).map(telling), [], 'something in the dialog is covered');
        await shot(page, 'settings-refused-phoneSideways');
      },
    ],
    [
      'an amount stands in its box as the table writes it, in bare digits while it is typed over and all of it selected when the Tab key enters the box, and written again once the box is left: the buy-in, the bet beside the slider and what Max fills in; a loss in the ledger and in Tonight has a minus sign, not a hyphen',
      async (rig) => {
        const table = rig.table(['Quigs', 'Stu', 'Pam'].map((name) => ({ name, stack: 5000 })), { minBuyIn: 400, maxBuyIn: 9000 });

        table.join('Marge');

        const marge = await table.open('Marge', 'desktop');

        await marge.click('[data-sit]');
        await marge.waitForSelector('#buy-in');

        const held = await marge.inputValue('#buy-in');

        assert.match(held, /^\d,\d{3}$/, 'the buy-in a table suggests is written without its comma');
        await marge.click('#buy-in');
        assert.equal(await marge.inputValue('#buy-in'), held.replace(',', ''), 'a box being typed in keeps a comma no number pad can put back');
        await marge.keyboard.press('Backspace');
        await marge.keyboard.type('5');
        await marge.keyboard.press('Tab');
        assert.equal(await marge.inputValue('#buy-in'), `${held.slice(0, -1)}5`, 'a box that was left does not write its amount as the table does');

        // Back in by the keyboard: all of it selected, to be typed over, and the keyboard goes on from it as from any box
        const selected = `[document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd, document.activeElement.value.length]`;

        await marge.keyboard.press('Shift+Tab');
        assert.deepEqual(await marge.evaluate(selected), ['buy-in', 0, 4, 4]);
        await marge.keyboard.press('Tab');
        assert.notEqual(await marge.evaluate('document.activeElement.id'), 'buy-in', 'the Tab key does not leave a box whose amount is written again');
        assert.equal(await marge.inputValue('#buy-in'), `${held.slice(0, -1)}5`);
        await marge.keyboard.press('Shift+Tab');
        assert.deepEqual(await marge.evaluate(selected), ['buy-in', 0, 4, 4]);
        await marge.keyboard.type('1234');
        await marge.keyboard.press('Tab');
        assert.equal(await marge.inputValue('#buy-in'), '1,234');
        await marge.context().close();

        // The bet beside the slider: a size button's amount, then one typed
        table.deal({ button: 0 });

        const quigs = await table.open('Quigs', 'desktop');

        await quigs.waitForSelector('#raise-amount');
        await quigs.click('.presets .chip-btn:has-text("All in")');
        assert.equal(await quigs.inputValue('#raise-amount'), '5,000', 'the bet a size button sets is written without its comma');
        await quigs.click('#raise-amount');
        assert.equal(await quigs.inputValue('#raise-amount'), '5000');
        await quigs.fill('#raise-amount', '1500');
        await quigs.focus('[data-action="raise"]');
        assert.equal(await quigs.inputValue('#raise-amount'), '1,500');
        assert.match(await quigs.innerText('[data-action="raise"]'), /1,500/);

        // A hand lost, in the ledger and in Tonight
        table.act('Quigs', { type: 'raise', to: 1500 });
        table.play((view) => ({ type: view.hand!.options!.canCheck ? 'check' : 'fold' }), (view) => view.hand === null || view.hand.stage === 'done');
        await table.heardBy(quigs);
        await quigs.click('[data-action="menu"]');
        await quigs.click('.menu [data-action="ledger"]');

        const down = await quigs.locator('.ledger td.down').allInnerTexts();

        assert.ok(down.length > 0 && down.every((net) => /^−[\d,]+$/.test(net)), `a loss is written ${JSON.stringify(down)}`);
        await shot(quigs, 'ledger-loss-desktop');
        await quigs.click('.dialog [data-action="close"]');
        await quigs.click('[data-action="menu"]');
        await quigs.click('.menu [data-action="tonight"]');

        const nets = await quigs.locator('.tonight-players .net.down').allInnerTexts();

        assert.ok(nets.length > 0 && nets.every((net) => /^−[\d,]+$/.test(net)), `a loss is written ${JSON.stringify(nets)}`);
      },
    ],
    [
      'a bet being typed outlasts the table drawing the bar again, in whole chips and in dollars and cents, on a phone and the desktop: it stands as it was typed, half an amount too, and the next digit goes on after it; left, the box writes it as the table does, and entered again holds bare digits; a pasted “2,000” is read as two thousand and played as that',
      async (rig) => {
        const kinds = [
          { config: { maxBuyIn: 20_000 }, stack: 9000, half: '150', halfSays: 'Raise to 150', whole: '1500', atRest: '1,500', says: 'Raise to 1,500', pastedSays: 'Raise to 2,000', played: 2000 },
          { config: { unit: 'cents', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 2_000_000 }, stack: 900_000, half: '1234.5', halfSays: 'Raise to 1,234.50', whole: '1234.50', atRest: '1,234.50', says: 'Raise to 1,234.50', pastedSays: 'Raise to 2,000.00', played: 200_000 },
        ] as const;

        for (const kind of kinds) {
          for (const screen of ['phone', 'desktop'] as const) {
            const table = rig.table(['Quigs', 'Pam', 'Stu'].map((name) => ({ name, stack: kind.stack })), kind.config);

            table.deal({ button: 0 });

            const page = await table.open('Quigs', screen);
            const where = `${kind.config.maxBuyIn === 20_000 ? 'chips' : 'cents'}, ${screen}`;
            const press = pressOn(page, screen);
            const named = () => page.getAttribute('[data-action="raise"]', 'aria-label');
            const keyboardIn = () => page.evaluate(`document.activeElement?.id === 'raise-amount'`);

            // A chip moved between two other stacks and a setting changed: no news to anyone, and the bar is built again from nothing
            const drawnAgain = async () => {
              await page.evaluate(`void (document.querySelector('#raise-amount').old = true)`);
              table.alter((state) => {
                state.seats[2]!.stack -= 1;
                state.seats[1]!.stack += 1;
                state.config.maxBuyIn += 1;
              });
              await page.waitForFunction(`document.querySelector('#raise-amount').old !== true`);
            };

            await page.waitForSelector('#raise-amount');
            await press('#raise-amount');
            await page.keyboard.press('ControlOrMeta+a');
            await page.keyboard.type(kind.half);
            await drawnAgain();
            assert.deepEqual([await page.inputValue('#raise-amount'), await keyboardIn(), await named()], [kind.half, true, kind.halfSays], `${where}: half an amount, the keyboard in the box, after the bar was drawn again`);

            await page.keyboard.type('0');
            assert.deepEqual([await page.inputValue('#raise-amount'), await named()], [kind.whole, kind.says], `${where}: the next digit did not go on after what was typed`);

            // Left: written as the table writes it, and still the bet the button names
            await page.locator('#raise-amount').blur();
            assert.deepEqual([await page.inputValue('#raise-amount'), await named()], [kind.atRest, kind.says], `${where}: a box that was left`);

            await press('#raise-amount');
            assert.equal(await page.inputValue('#raise-amount'), kind.whole, `${where}: a box entered again keeps a comma no number pad can put back`);

            // Pasted with its comma, as a phone's clipboard or a chat line has it
            await page.keyboard.press('ControlOrMeta+a');
            await page.keyboard.insertText('2,000');
            assert.equal(await named(), kind.pastedSays, `${where}: a pasted 2,000`);
            await drawnAgain();
            assert.deepEqual([await keyboardIn(), await named()], [true, kind.pastedSays], `${where}: a pasted 2,000 after the bar was drawn again`);

            await answeredAfter(page, () => press('[data-action="raise"]'));
            assert.equal(table.view('Quigs').hand!.currentBet, kind.played, `${where}: what a pasted 2,000 played`);
            await page.context().close();
          }
        }
      },
    ],
  ];
};
