/*
 * The checks of the Preferences dialog as a whole: its parts under their headings, what each device is
 * offered, that every choice says what it does in words on the screen, and the two choices that change
 * the look of everything read, the theme and the text size. They run with the other browser checks
 * (`screenChecks.ts`), which hold each single preference to what it switches.
 */
import assert from 'node:assert/strict';

import type { Page } from 'playwright';

import { THEMES } from '../src/client/themes.ts';
import type { Check } from './checkRunner.ts';
import { boxes, squeezed } from './rig.ts';
import type { Box, Rig, RigTable, ScreenName } from './rig.ts';
import { tapsLive } from './underTheFinger.ts';

const HOST = 'Quigs';

const twoHanded = (rig: Rig): RigTable => rig.table([HOST, 'Stu'].map((name) => ({ name, stack: 1000 })));

/** Opens Preferences as a player reaches it from the table: the menu, then its line. */
async function toPreferences(page: Page, screen: ScreenName): Promise<void> {
  const press = (selector: string) => (screen === 'desktop' ? page.click(selector) : page.tap(selector));

  await press('[data-action="menu"]');
  await press('.menu [data-action="preferences"]');
  await page.waitForSelector('.prefs #pref-sound');
}

/** The host's page with Preferences open. `kept` is what the browser has of an earlier visit, as a script. */
async function openPreferences(table: RigTable, screen: ScreenName, kept?: string): Promise<Page> {
  const page = await table.open(HOST, screen, kept);

  await toPreferences(page, screen);

  return page;
}

type Part = [heading: string, prefs: string[]];

// Run in the page: the open dialog part by part, each with the preferences it holds in the order drawn
const PARTS = `[...document.querySelectorAll('.prefs > section')].map((part) => [
  part.querySelector('h3').textContent,
  [...part.querySelectorAll('[data-pref]')].map((control) => control.dataset.pref),
])`;

// Run in the page: every switch with the words under its name, and whether those are drawn
const SWITCHES = `[...document.querySelectorAll('.prefs [role="switch"]')].map((row) => {
  const said = row.querySelector('small');

  return { pref: row.dataset.pref, says: said.textContent, drawn: said.getBoundingClientRect().height > 0 };
})`;

// Run in the page: how much of the dialog's list shows, as a box on the screen
const IN_SIGHT = `(() => {
  const { left, top, right, bottom } = document.querySelector('.dialog-body').getBoundingClientRect();

  return { left, top, right, bottom };
})()`;

const inside = (box: Box, around: Box) => box.left >= around.left - 1 && box.right <= around.right + 1 && box.top >= around.top - 1 && box.bottom <= around.bottom + 1;
const middle = (box: Box) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });

const LOOK: Part = ['Look', ['theme', 'textSize']];
const ON_THE_TABLE: Part = ['On the table', ['deck', 'cardBack', 'handHint', 'motion']];
const CHAT: Part = ['Chat', ['reactions', 'gifs']];

const partsByDevice: Check = [
  'Preferences is in parts under headings: the look, what calls a player, what is on the table and the chat, and on a desktop the keyboard with its keys, which a phone is not shown at all; every switch says what it does in a sentence under its name and nothing is said only to a pointer resting on it; on a 360 by 640 phone the theme, the text size and the sound switch show without scrolling',
  async (rig) => {
    const table = twoHanded(rig);
    const phone = await openPreferences(table, 'smallPhone');

    assert.deepEqual(await phone.evaluate(PARTS), [LOOK, ['Your turn and @mentions', ['sound', 'volume', 'buzz', 'flash', 'tabTitle']], ON_THE_TABLE, CHAT]);
    assert.deepEqual(await phone.locator('.prefs').getByRole('heading', { level: 3 }).allTextContents(), ['Look', 'Your turn and @mentions', 'On the table', 'Chat']);
    assert.equal(await phone.locator('.dialog [data-glossary]').count(), 0, 'a phone is shown keys it has no keyboard for');

    const shows = (await phone.evaluate(IN_SIGHT)) as Box;
    const first = await boxes(phone, '#pref-theme .tile, #pref-textSize .tile, #pref-sound');

    assert.equal(first.length, THEMES.length + 3 + 1);
    assert.deepEqual(first.filter((box) => !inside(box, shows)), [], `the theme, the text size and the sound switch do not all show in ${JSON.stringify(shows)} before a player scrolls`);

    const desktop = await openPreferences(table, 'desktop');

    assert.deepEqual(await desktop.evaluate(PARTS), [LOOK, ['Your turn and @mentions', ['sound', 'volume', 'flash', 'notify', 'tabTitle']], ON_THE_TABLE, CHAT, ['Keyboard', ['hotkeys']]]);
    assert.match((await desktop.locator('[data-group="keyboard"] [data-glossary="hotkeys"]').textContent()) ?? '', /F\s*Fold/);

    for (const [page, where] of [[phone, 'a phone'], [desktop, 'the desktop']] as const) {
      const switches = (await page.evaluate(SWITCHES)) as { pref: string; says: string; drawn: boolean }[];

      assert.deepEqual(switches.filter(({ says, drawn }) => !drawn || !/^[A-Z].*\.$/.test(says)), [], `on ${where} a switch does not say what it does in a sentence under its name`);
      assert.equal(await page.locator('.dialog [title]').count(), 0, `on ${where} something is said only to a pointer resting on it`);
      assert.deepEqual(await page.locator('.prefs small').evaluateAll((hints) => hints.map((hint) => hint.textContent).filter((says) => !says!.endsWith('.'))), [], `on ${where} small print stops without its period`);
      assert.deepEqual(await squeezed(page, '.prefs h3, .prefs [data-pref], .prefs [data-pref] span, .prefs small, .prefs .tile > span:last-child, .prefs .note'), [], `on ${where} something in Preferences is cut short`);

      // A choice of tiles has its small print outside the tiles, where only the group can say it
      assert.deepEqual(
        await page.evaluate(`[...document.querySelectorAll('.prefs [role="radiogroup"]')]
          .filter((group) => group.querySelector('small') && document.getElementById(group.getAttribute('aria-describedby') ?? '') !== group.querySelector('small'))
          .map((group) => group.dataset.pref)`),
        [],
        `on ${where} a choice does not say its small print to a screen reader`,
      );

      // Whose these are and where they are kept is said once, in the words used wherever it is said
      assert.equal(await page.locator('.prefs .note').textContent(), 'These are yours alone, kept on this device.');
      assert.equal(((await page.locator('.dialog').textContent()) ?? '').match(/this device/g)?.length, 1, `on ${where} Preferences says more than once where its choices are kept`);
    }
  },
];

// Run in the page: the theme tiles as they are drawn, each with the ground and ink it is drawn in
const THEME_TILES = `[...document.querySelectorAll('#pref-theme .tile')].map((tile) => {
  const { backgroundColor, color } = getComputedStyle(tile);

  return { theme: tile.dataset.theme, says: tile.textContent.trim(), ground: backgroundColor, ink: color, picked: tile.querySelector('input').checked };
})`;

// Run in the page: the ground and ink of the theme the whole page is in
const PAGE_COLORS = `(() => {
  const probe = document.createElement('i');

  probe.style.cssText = 'background: var(--bg); color: var(--text)';
  document.body.append(probe);

  const { backgroundColor, color } = getComputedStyle(probe);

  probe.remove();

  return { ground: backgroundColor, ink: color };
})()`;

interface ThemeTile {
  theme: string;
  says: string;
  ground: string;
  ink: string;
  picked: boolean;
}

/** The option of `pref` whose tile is what a finger at this point is on, or nothing when it is on no tile of it. */
const tileAt = (page: Page, pref: string, { x, y }: { x: number; y: number }) =>
  page.evaluate(`document.elementFromPoint(${x}, ${y})?.closest('#pref-${pref} .tile')?.querySelector('input').value ?? null`) as Promise<string | null>;

const themeInPreferences = (picturesIn: string): Check => [
  'the theme is picked in Preferences, where it is the first thing and three presses from the table: every theme has a tile drawn in its own colors whichever theme the page is in, three over two with each name whole; a press changes the whole page at once with the dialog left open and the tile still under the finger, the keyboard picks one with the arrows, and the choice is kept',
  async (rig) => {
    const table = twoHanded(rig);

    for (const screen of ['smallPhone', 'desktop'] as const) {
      const page = await openPreferences(table, screen);
      const drawn = (await page.evaluate(THEME_TILES)) as ThemeTile[];
      const tiles = await boxes(page, '#pref-theme .tile');
      const shows = (await page.evaluate(IN_SIGHT)) as Box;

      assert.deepEqual(drawn.map(({ theme, says, picked }) => [theme, says, picked]), THEMES.map((theme, nth) => [theme.id, theme.name, nth === 0]));
      assert.equal(new Set(drawn.map(({ ground }) => ground)).size, THEMES.length, 'two themes’ tiles are drawn on the same ground');
      assert.deepEqual(tiles.filter((tile) => !inside(tile, shows)), [], `${screen}: a theme has to be scrolled to`);
      assert.deepEqual(tiles.map(({ top }) => Math.round(top - tiles[0]!.top)).map((down) => (down === 0 ? 'first row' : 'second row')), ['first row', 'first row', 'first row', 'second row', 'second row'], `${screen}: the themes do not stand three over two`);
      assert.deepEqual(await squeezed(page, '#pref-theme .tile, #pref-theme .tile > span:last-child'), [], `${screen}: a theme’s name is cut short`);
      await page.screenshot({ path: `${picturesIn}check-preferences-look-${screen}.png` });

      // Every theme in turn, each press a change, the one the page came in among them and one that is not it last
      for (const theme of [THEMES[1]!, THEMES[0]!, ...THEMES.slice(2)]) {
        const tile = `#pref-theme .tile[data-theme="${theme.id}"]`;
        const [box] = await boxes(page, tile);
        const at = middle(box!);

        await (screen === 'desktop' ? page.mouse.click(at.x, at.y) : page.touchscreen.tap(at.x, at.y));
        await page.waitForSelector(`:root[data-theme="${theme.id}"]`);

        const now = (await page.evaluate(THEME_TILES)) as ThemeTile[];
        const own = now.find((one) => one.theme === theme.id)!;

        assert.deepEqual(await page.evaluate(PAGE_COLORS), { ground: own.ground, ink: own.ink }, `${screen}: the page in ${theme.name} is not in the colors its tile showed`);
        assert.deepEqual(now.map(({ ground, ink }) => [ground, ink]), drawn.map(({ ground, ink }) => [ground, ink]), `${screen}: a tile changed its colors when the page went to ${theme.name}`);
        assert.deepEqual(now.filter(({ picked }) => picked).map((one) => one.theme), [theme.id]);
        assert.equal(await tileAt(page, 'theme', at), theme.id, `${screen}: the tile for ${theme.name} moved from under the finger that picked it`);
        assert.equal(await page.evaluate(`localStorage.getItem('cnd.theme')`), theme.id);
      }

      if (screen === 'desktop') {
        const before = THEMES.at(-2)!.id;

        await page.focus('#pref-theme input:checked');
        await page.keyboard.press('ArrowLeft');
        await page.waitForSelector(`:root[data-theme="${before}"]`);
        assert.equal(await page.evaluate(`document.activeElement.matches('#pref-theme input[value="${before}"]:checked')`), true, 'picking a theme with the arrows loses the keyboard');
      }

      // The choice is the browser's from then on: the page comes back in it, and Preferences shows it picked
      const kept = (await page.evaluate(`localStorage.getItem('cnd.theme')`)) as string;

      await page.reload();
      await page.waitForSelector(`:root[data-theme="${kept}"] [data-action="menu"]`);
      await toPreferences(page, screen);
      await page.waitForSelector(`#pref-theme input[value="${kept}"]:checked`);
      await page.context().close();
    }
  },
];

// Run in the page: how large each text size's tile writes its name, in pixels
const NAME_SIZES = `[...document.querySelectorAll('#pref-textSize .tile > span:last-child')].map((name) => parseFloat(getComputedStyle(name).fontSize))`;

const textSizeInPreferences: Check = [
  'the text size is three tiles in Preferences, each with its name written at the size it stands for, and no list to open: a press changes the page at once and is kept, and the tile stays where it was under the finger while everything above it grows or shrinks, so a second press there picks nothing else, on a 360 by 640 phone from Standard to Largest and back and by way of Large',
  async (rig) => {
    const table = twoHanded(rig);
    const page = await openPreferences(table, 'smallPhone');
    const [standard, large, largest] = (await page.evaluate(NAME_SIZES)) as number[];

    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#pref-textSize input')].map((option) => option.value)`), ['standard', 'large', 'largest']);
    assert.equal(await page.locator('.dialog select').count(), 0, 'Preferences still has a list to open');
    assert.ok(standard! < large! && large! < largest!, `the names are written ${standard}, ${large} and ${largest} px high, which does not show which is larger`);

    // A tile comes up where the menu's line was pressed, and is kept from the second tap of two
    await tapsLive(page);

    for (const step of ['largest', 'standard', 'large', 'largest', 'standard']) {
      const [box] = await boxes(page, `#pref-textSize .tile[data-text-size="${step}"]`);
      const at = middle(box!);

      await page.touchscreen.tap(at.x, at.y);
      await page.waitForSelector(`#app[data-text-size="${step}"]`);

      const [after] = await boxes(page, `#pref-textSize .tile[data-text-size="${step}"]`);

      assert.ok(Math.abs(after!.top - box!.top) <= 1, `picking ${step} moved its tile ${Math.round(after!.top - box!.top)} px down from under the finger`);
      assert.equal(await tileAt(page, 'textSize', at), step, `after picking ${step} a second press at the same place is on something else`);
      assert.equal(await page.evaluate(`localStorage.getItem('cnd.textSize')`), step);
      assert.deepEqual(await page.evaluate(NAME_SIZES), [standard, large, largest], 'a tile’s name changed size with the page, and no longer shows its own');
    }
  },
];

/**
 * Run in the page before a press on a text size at `at`: notes what a press reaches at points all over the
 * dialog's list, and at the press, once the tile's own listener has made the choice, what each reaches then,
 * with a second press made at `at` there and then. That is the page as the second press of two comes to it,
 * asked in the same turn of the page, however slow the machine.
 */
const noteWhatAPressReaches = ({ x, y }: { x: number; y: number }) => `(() => {
  const keyOf = (control) => control.id || Object.entries(control.dataset).map(([mark, value]) => mark + '=' + value).join(' ');
  const reached = (spot) => {
    const control = document.elementFromPoint(spot.x, spot.y)?.closest('button, label.tile, input');

    return control ? keyOf(control) : null;
  };
  const list = document.querySelector('.dialog-body').getBoundingClientRect();
  const spots = [];

  for (let down = list.top + 6; down < list.bottom; down += 12) {
    for (const across of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      spots.push({ x: list.left + list.width * across, y: down });
    }
  }

  const was = spots.map(reached);

  window.__reachedNow = () => spots.map((spot, nth) => ({ was: was[nth], reaches: reached(spot) }));
  document.querySelector('#pref-textSize').addEventListener('click', (event) => {
    if (!event.target.matches('input') || window.__reachedAtOnce) {
      return;
    }

    window.__reachedAtOnce = window.__reachedNow();

    const under = document.elementFromPoint(${x}, ${y});

    for (const kind of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      under?.dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true, composed: true, view: window, clientX: ${x}, clientY: ${y} }));
    }
  });
})()`;

interface Reached {
  was: string | null;
  reaches: string | null;
}

/** The points where a press reaches a control other than the one that lay there. One that came up over words alone takes its press at once, as everywhere. */
const onAnother = (spots: Reached[]) => spots.filter(({ was, reaches }) => was !== null && reaches !== null && reaches !== was);

const smallerTextAtTheTop: Check = [
  'a smaller text size picked with Preferences at its top, where the dialog cannot scroll to keep the tile under the finger: on a 360 by 640 phone at Largest, Standard is picked and its tile moves up and away; in that moment no press anywhere in the dialog reaches a control that came up where another lay, and a second press right behind the first switches nothing; once the moment is over the controls that came up take their presses',
  async (rig) => {
    const table = twoHanded(rig);
    const page = await openPreferences(table, 'smallPhone', `localStorage.setItem('cnd.textSize', 'largest')`);

    await page.waitForSelector('#pref-textSize input[value="largest"]:checked');
    assert.equal(await page.evaluate(`document.querySelector('.dialog-body').scrollTop`), 0);

    const kept = (await page.evaluate(`JSON.stringify(Object.entries(localStorage).filter(([key]) => key !== 'cnd.textSize').sort())`)) as string;
    const [box] = await boxes(page, '#pref-textSize .tile[data-text-size="standard"]');
    const at = middle(box!);

    await page.evaluate(noteWhatAPressReaches(at));
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForSelector('#app[data-text-size="standard"]');

    const [after] = await boxes(page, '#pref-textSize .tile[data-text-size="standard"]');
    const atOnce = (await page.evaluate('window.__reachedAtOnce')) as Reached[];

    assert.ok(box!.top - after!.top > (box!.bottom - box!.top) / 2, `the tile moved ${Math.round(box!.top - after!.top)} px up, not out from under the finger: this no longer shows what it is here for`);
    assert.deepEqual(onAnother(atOnce), [], 'a press right behind the one that picked a smaller text reaches a control that came up where another lay');

    await tapsLive(page);
    assert.ok(onAnother((await page.evaluate('window.__reachedNow()')) as Reached[]).length > 0, 'no control came up where another lay: this no longer shows what it is here for');

    assert.equal(await page.evaluate(`localStorage.getItem('cnd.textSize')`), 'standard');
    assert.equal(await page.evaluate(`JSON.stringify(Object.entries(localStorage).filter(([key]) => key !== 'cnd.textSize').sort())`), kept, 'the second press changed something the browser keeps');
    assert.equal(await page.getAttribute('#pref-sound', 'aria-checked'), 'true');
  },
];

/** The checks of Preferences. Pictures of it as it was checked go into `picturesIn`, a folder ending in a slash. */
export const preferencesChecks = (picturesIn: string): Check[] => [partsByDevice, themeInPreferences(picturesIn), textSizeInPreferences, smallerTextAtTheTop];
