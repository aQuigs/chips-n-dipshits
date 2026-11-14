import assert from 'node:assert/strict';
import test from 'node:test';

import { Attention } from '../src/client/attention.ts';
import type { AttentionWay, AttentionWays, Call } from '../src/client/attention.ts';
import { BUZZ_PATTERN, TITLE_SWAP_MS, waysFor } from '../src/client/attentionWays.ts';
import type { Notices, Permission, WayParts } from '../src/client/attentionWays.ts';
import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import type { Ability, AppPreferences } from '../src/client/prefs.ts';
import { Sounds } from '../src/client/sound.ts';
import type { SoundName } from '../src/client/sound.ts';
import { tableChange } from '../src/client/tableChange.ts';
import { YourTurn } from '../src/client/yourTurn.ts';
import { addMember } from '../src/engine/index.ts';
import type { TableView } from '../src/engine/index.ts';
import { mapMemory, TestTable } from './helpers.ts';

type Key = keyof AttentionWays;

const KEYS: Key[] = ['sound', 'buzz', 'flash', 'notify', 'tabTitle'];

/** A way that writes down what it is asked to do, and can do whatever the test says. */
class RecordingWay implements AttentionWay {
  readonly calls: Call[] = [];
  readonly ends: Call[] = [];
  can: Ability = 'yes';

  ability(): Ability {
    return this.can;
  }

  call(call: Call): void {
    this.calls.push(call);
  }

  end(call: Call): void {
    this.ends.push(call);
  }
}

function recordingWays(): Record<Key, RecordingWay> {
  return Object.fromEntries(KEYS.map((key) => [key, new RecordingWay()])) as Record<Key, RecordingWay>;
}

/** One seat's page on a table named Friday Night: each view as it arrives, handed to the turn effect. */
class Page<W extends AttentionWays = Record<Key, RecordingWay>> {
  readonly prefs: AppPreferences = new Preferences(PREFERENCES, mapMemory());
  readonly ways: W;
  readonly attention: Attention;
  readonly turns: YourTurn;
  private shown: TableView | null = null;
  private readonly table: TestTable;
  private readonly seat: number;

  constructor(table: TestTable, seat: number, ways: W = recordingWays() as AttentionWays as W) {
    this.table = table;
    this.seat = seat;
    this.ways = ways;
    this.attention = new Attention(this.prefs, ways);
    this.turns = new YourTurn(this.attention);
  }

  /** `late` is how long the view took to arrive. */
  arrive(options: { late?: number; wentBack?: boolean } = {}): void {
    const view = structuredClone(this.table.view(this.seat));
    const change = tableChange(this.shown, view, this.table.now + (options.late ?? 0), options.wentBack);
    this.shown = change.view;
    this.turns.see(change);
  }

  calls(this: Page, key: Key = 'flash'): Call[] {
    return this.ways[key].calls;
  }

  ends(this: Page, key: Key = 'flash'): Call[] {
    return this.ways[key].ends;
  }
}

/** Heads-up at Friday Night, seat 0 on the button, which acts first before the flop. */
function headsUp(): TestTable {
  return new TestTable({ stacks: [1000, 1000], config: { name: 'Friday Night' } });
}

test('the turn beginning asks every way once, with the table and the reason and nothing else', () => {
  const table = headsUp();
  const page = new Page(table, 0);

  page.arrive();
  table.deal({ button: 0 });
  page.arrive();

  for (const key of KEYS) {
    assert.deepEqual(page.calls(key), [{ why: 'turn', table: { id: 'TEST01', name: 'Friday Night' } }], key);
  }
});

test('nothing is asked for a turn the viewer already had when the page opened', () => {
  const table = headsUp();
  const page = new Page(table, 0);

  table.deal({ button: 0 });
  page.arrive();
  table.cmd(1, { type: 'chat', text: 'your go' });
  page.arrive();

  assert.deepEqual(page.calls(), []);
});

test('a view that is late when it arrives asks nothing, and the first one on time that still shows the turn asks once', () => {
  const table = headsUp();
  const page = new Page(table, 0);

  page.arrive();
  table.deal({ button: 0 });
  page.arrive({ late: 60_000 });
  assert.deepEqual(page.calls(), [], 'the late view');

  table.cmd(1, { type: 'chat', text: 'your go' });
  page.arrive();
  assert.equal(page.calls().length, 1, 'the view on time');

  table.cmd(1, { type: 'chat', text: 'still your go' });
  page.arrive();
  assert.equal(page.calls().length, 1, 'a second view on time');
});

test('a turn shown only by a late view, and gone by the next, is never asked for', () => {
  const table = headsUp();
  const page = new Page(table, 0);

  page.arrive();
  table.deal({ button: 0 });
  page.arrive({ late: 60_000 });
  table.call(0);
  page.arrive();

  assert.deepEqual(page.calls(), []);
  assert.deepEqual(page.ends(), []);
});

test('nothing is asked when the table went back to a turn of the viewer', () => {
  const table = headsUp();
  const page = new Page(table, 0);

  page.arrive();
  table.deal({ button: 0 });
  page.arrive({ wentBack: true });

  assert.deepEqual(page.calls(), []);
});

test('two views of one turn arriving close together ask once', () => {
  const table = headsUp();
  const page = new Page(table, 0);

  page.arrive();
  table.deal({ button: 0 });
  page.arrive();
  table.cmd(1, { type: 'chat', text: 'hurry up' });
  page.arrive();
  page.arrive();

  assert.equal(page.calls().length, 1);
  assert.deepEqual(page.ends(), []);
});

test('acting ends the call in every way, and the action coming back on the same street calls again', () => {
  const table = headsUp();
  const page = new Page(table, 0);

  table.deal({ button: 0 });
  table.call(0);
  table.check(1);
  page.arrive();

  // On the flop the big blind acts first, then the button
  table.check(1);
  page.arrive();
  assert.equal(page.calls().length, 1);

  table.raise(0, 40);
  page.arrive();
  for (const key of KEYS) {
    assert.deepEqual(page.ends(key), page.calls(key), `${key} was told the turn is over`);
  }

  table.raise(1, 120);
  page.arrive();
  assert.equal(page.calls().length, 2, 'the raise brings the action back');
});

test('the turn passing on without the viewer, as when their clock runs out, ends the call', () => {
  const table = new TestTable({ stacks: [1000, 1000], config: { name: 'Friday Night', actionSeconds: 30 } });
  const page = new Page(table, 0);

  page.arrive();
  table.deal({ button: 0 });
  page.arrive();
  table.wait(table.state.hand!.deadline! - table.now);
  page.arrive();

  assert.equal(page.ends().length, 1);
});

test('leaving the table ends a call that still stands', () => {
  const table = headsUp();
  const page = new Page(table, 0);

  page.arrive();
  table.deal({ button: 0 });
  page.arrive();
  page.turns.end();

  assert.equal(page.ends().length, 1);
});

test('someone only watching is never called', () => {
  const table = headsUp();
  table.ids.push(addMember(table.state, 'Kibitzer', table.ctx()).id);
  const page = new Page(table, 2);

  page.arrive();
  table.deal({ button: 0 });
  page.arrive();

  assert.deepEqual(page.calls(), []);
});

test('a way switched off is not asked, and the others still are', () => {
  for (const off of KEYS) {
    const table = headsUp();
    const page = new Page(table, 0);

    page.prefs.set(off, false);
    page.arrive();
    table.deal({ button: 0 });
    page.arrive();

    for (const key of KEYS) {
      assert.equal(page.calls(key).length, key === off ? 0 : 1, `${key} with ${off} switched off`);
    }
  }
});

test('a way the device cannot do, or the browser was told no for, is not asked', () => {
  for (const can of ['no', 'ask', 'blocked'] as const) {
    const table = headsUp();
    const page = new Page(table, 0);

    page.ways.notify.can = can;
    page.arrive();
    table.deal({ button: 0 });
    page.arrive();

    assert.equal(page.calls('notify').length, 0, can);
    assert.equal(page.calls('flash').length, 1, can);
  }
});

test('a way that throws does not keep the others from being asked', () => {
  const prefs = new Preferences(PREFERENCES, mapMemory());
  const ways = recordingWays();
  const call: Call = { why: 'turn', table: { id: 'T', name: 'T' } };
  const error = console.error;

  ways.buzz.call = () => {
    throw new Error('refused');
  };

  console.error = () => undefined;
  try {
    new Attention(prefs, ways).call(call);
  } finally {
    console.error = error;
  }

  assert.equal(ways.tabTitle.calls.length, 1);
});

/** The browser as the real ways see it, every part a stand-in that writes down what it was asked. */
class Browser {
  hidden = false;
  touched = false;
  permission: Permission = 'granted';
  answer: Permission = 'granted';
  readonly buzzes: number[][] = [];
  readonly shown: { title: string; tag: string; open: boolean; click: () => void }[] = [];
  requests = 0;
  readonly played: SoundName[] = [];
  readonly root = { dataset: {} as Record<string, string | undefined>, offsetWidth: 0 };
  readonly tab = { title: "Chips n' Dipshits" };
  focused = 0;
  private readonly shownListeners: (() => void)[] = [];
  private ticking: (() => void) | null = null;

  parts(overrides: Partial<WayParts> = {}): WayParts {
    const notices: Notices = {
      permission: () => this.permission,
      request: async () => {
        this.requests += 1;
        this.permission = this.answer;

        return this.permission;
      },
      show: (title, tag, click) => {
        const notice = { title, tag, open: true, click };
        this.shown.filter((other) => other.tag === tag).forEach((other) => (other.open = false));
        this.shown.push(notice);

        return () => void (notice.open = false);
      },
    };

    return {
      sounds: new Sounds({ play: (sound) => void this.played.push(sound) }, new Preferences(PREFERENCES, mapMemory()), { now: () => 0, inView: () => !this.hidden }),
      touch: this,
      root: this.root,
      sight: { away: () => this.hidden, onBack: (listener) => this.shownListeners.push(listener) },
      ownsTab: true,
      handheld: false,
      vibrate: (pattern) => void this.buzzes.push(pattern),
      notices,
      tab: this.tab,
      focus: () => void (this.focused += 1),
      timers: {
        every: (ms, act) => {
          assert.equal(ms, TITLE_SWAP_MS);
          this.ticking = act;

          return () => void (this.ticking = null);
        },
      },
      ...overrides,
    };
  }

  onTouch(): void {}

  tick(): void {
    this.ticking?.();
  }

  get ticks(): boolean {
    return this.ticking !== null;
  }

  comeBack(): void {
    this.hidden = false;
    this.shownListeners.forEach((listener) => listener());
  }
}

const FRIDAY: Call = { why: 'turn', table: { id: 'TEST01', name: 'Friday Night' } };

const abilities = (ways: AttentionWays) => Object.fromEntries(KEYS.map((key) => [key, ways[key].ability()]));

test('on a computer that owns its tab every way but the buzz can be had', () => {
  const browser = new Browser();

  assert.deepEqual(abilities(waysFor(browser.parts())), { sound: 'yes', buzz: 'no', flash: 'yes', notify: 'yes', tabTitle: 'yes' });
});

test('on a phone the buzz can be had and a notification cannot', () => {
  const browser = new Browser();

  assert.deepEqual(abilities(waysFor(browser.parts({ handheld: true }))), { sound: 'yes', buzz: 'yes', flash: 'yes', notify: 'no', tabTitle: 'yes' });
  assert.equal(waysFor(browser.parts({ handheld: true, vibrate: null })).buzz.ability(), 'no', 'a phone with no vibration');
});

test('in Google’s frame neither a notification nor the tab’s title is offered, so neither is asked for nor touched', async () => {
  const browser = new Browser();
  browser.permission = 'default';

  const ways = waysFor(browser.parts({ ownsTab: false }));
  const attention = new Attention(new Preferences(PREFERENCES, mapMemory()), ways);

  assert.equal(ways.notify.ability(), 'no');
  assert.equal(ways.tabTitle.ability(), 'no');

  browser.hidden = true;
  attention.call(FRIDAY);
  assert.equal(await attention.ask('notify'), 'no', 'a tap on a switch that is not there');

  assert.equal(browser.requests, 0);
  assert.deepEqual(browser.shown, []);
  assert.equal(browser.tab.title, "Chips n' Dipshits");
  assert.equal(browser.ticks, false);
});

test('a browser with no notifications leaves them out', () => {
  const browser = new Browser();

  assert.equal(waysFor(browser.parts({ notices: null })).notify.ability(), 'no');
});

test('the browser’s word on notifications is what the switch shows, and only a tap asks it', async () => {
  const browser = new Browser();
  browser.permission = 'default';

  const table = headsUp();
  const page = new Page(table, 0, waysFor(browser.parts()));
  const attention = page.attention;
  const arrive = () => page.arrive();

  assert.equal(attention.of('notify'), 'ask');

  browser.hidden = true;
  arrive();
  table.deal({ button: 0 });
  arrive();
  assert.equal(browser.requests, 0, 'the turn asked the browser');
  assert.deepEqual(browser.shown, []);

  browser.answer = 'denied';
  assert.equal(await attention.ask('notify'), 'blocked');
  assert.equal(attention.of('notify'), 'blocked', 'the refusal is the browser’s to remember');
  assert.equal(browser.requests, 1);

  table.call(0);
  table.check(1);
  table.check(1);
  arrive();
  assert.deepEqual(browser.shown, [], 'a blocked notification');
});

test('a notification says whose table and that it is their turn, only while the page is out of sight, and goes when the turn does', () => {
  const browser = new Browser();
  const ways = waysFor(browser.parts());

  ways.notify.call(FRIDAY);
  assert.equal(browser.shown.length, 0, 'shown with the page in front');

  browser.hidden = true;
  ways.notify.call(FRIDAY);
  assert.deepEqual(browser.shown.map(({ title, tag, open }) => ({ title, tag, open })), [{ title: 'Your turn at Friday Night', tag: 'cnd-TEST01', open: true }]);

  ways.notify.end({ why: 'turn', table: { id: 'OTHER', name: 'Other' } });
  assert.equal(browser.shown[0]!.open, true, 'another table’s turn ending closed it');

  ways.notify.end(FRIDAY);
  assert.equal(browser.shown[0]!.open, false);
});

test('a second notification for the table takes the place of the first, and coming back or tapping it closes it', () => {
  const browser = new Browser();
  const ways = waysFor(browser.parts());

  browser.hidden = true;
  ways.notify.call(FRIDAY);
  ways.notify.call(FRIDAY);
  assert.deepEqual(browser.shown.map((notice) => notice.open), [false, true]);

  browser.comeBack();
  assert.equal(browser.shown[1]!.open, false, 'coming back to the page');

  browser.hidden = true;
  ways.notify.call(FRIDAY);
  browser.shown[2]!.click();
  assert.equal(browser.focused, 1, 'tapping it brings the tab forward');
  assert.equal(browser.shown[2]!.open, false);
});

test('the tab’s title blinks that it is the player’s turn while they are away, and is put back when the turn ends or they come back', () => {
  const browser = new Browser();
  const ways = waysFor(browser.parts());
  const own = browser.tab.title;

  ways.tabTitle.call(FRIDAY);
  assert.equal(browser.tab.title, own, 'changed with the page in front');
  assert.equal(browser.ticks, false);

  browser.hidden = true;
  ways.tabTitle.call(FRIDAY);
  const seen = [browser.tab.title];
  for (let swap = 0; swap < 3; swap++) {
    browser.tick();
    seen.push(browser.tab.title);
  }
  assert.deepEqual(seen, ['● Your turn at Friday Night', '○ Your turn at Friday Night', '● Your turn at Friday Night', '○ Your turn at Friday Night'], 'every swap says it is the player’s turn');

  ways.tabTitle.end(FRIDAY);
  assert.equal(browser.tab.title, own);
  assert.equal(browser.ticks, false);

  ways.tabTitle.call(FRIDAY);
  browser.tick();
  browser.comeBack();
  assert.equal(browser.tab.title, own, 'after coming back');
  assert.equal(browser.ticks, false);
});

test('the buzz waits for the first touch and for the page to be in sight', () => {
  const browser = new Browser();
  const ways = waysFor(browser.parts({ handheld: true }));

  ways.buzz.call(FRIDAY);
  assert.deepEqual(browser.buzzes, [], 'before a touch');

  browser.touched = true;
  browser.hidden = true;
  ways.buzz.call(FRIDAY);
  assert.deepEqual(browser.buzzes, [], 'out of sight');

  browser.hidden = false;
  ways.buzz.call(FRIDAY);
  assert.deepEqual(browser.buzzes, [BUZZ_PATTERN]);
});

test('the flash marks the app with the reason until the call ends, and the chime plays the turn’s sound', () => {
  const browser = new Browser();
  const ways = waysFor(browser.parts());

  ways.flash.call(FRIDAY);
  ways.sound.call(FRIDAY);
  assert.equal(browser.root.dataset.attention, 'turn');
  assert.deepEqual(browser.played, ['turn']);

  ways.flash.end(FRIDAY);
  assert.equal(browser.root.dataset.attention, undefined);
});
