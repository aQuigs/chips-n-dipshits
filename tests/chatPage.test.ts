/* What a page does with the chat: completing a name after an @, nudging whoever a line names, and muting a player. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Attention } from '../src/client/attention.ts';
import type { AttentionWay, AttentionWays, Call } from '../src/client/attention.ts';
import { completed, completionAt, MOST_OFFERED } from '../src/client/mentionCompletion.ts';
import type { TableMotion } from '../src/client/motion.ts';
import { Mutes } from '../src/client/mutes.ts';
import { nudge, nudged } from '../src/client/nudges.ts';
import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import type { AppPreferences } from '../src/client/prefs.ts';
import { reactionsShown } from '../src/client/reactions.ts';
import { chatLineShown, sendersShown } from '../src/client/senders.ts';
import { ShownTable } from '../src/client/shownTable.ts';
import { TableNews } from '../src/client/tableChange.ts';
import type { TableChange } from '../src/client/tableChange.ts';
import { LIMITS, NUDGE_GAP_MS } from '../src/engine/index.ts';
import type { Reaction, TableView } from '../src/engine/index.ts';
import { mapMemory, TestTable } from './helpers.ts';

const NAMES = ['Al', 'Al Smith', 'Ann', 'Sam'];

/** What is offered with the caret at the `|` in `typed`. */
function offered(typed: string, names = NAMES): string[] {
  const caret = typed.indexOf('|');

  return completionAt(typed.replace('|', ''), caret, names)?.names ?? [];
}

/** What the box holds after picking `name` with the caret at the `|`, with the caret where it lands. */
function picking(typed: string, name: string): string | null {
  const caret = typed.indexOf('|');
  const text = typed.replace('|', '');
  const result = completed(text, caret, completionAt(text, caret, NAMES)!, name);

  return result && `${result.text.slice(0, result.caret)}|${result.text.slice(result.caret)}`;
}

test('an @ offers everyone, and each letter typed after it narrows the names to those it starts, in any case', () => {
  assert.deepEqual(offered('@|'), NAMES);
  assert.deepEqual(offered('nice hand @a|'), ['Al', 'Al Smith', 'Ann']);
  assert.deepEqual(offered('@AL|'), ['Al', 'Al Smith']);
  assert.deepEqual(offered('@Al S|'), ['Al Smith'], 'a name with a space in it is still being typed after the space');
  assert.deepEqual(offered('@x|'), [], 'nobody fits');
});

test('nothing is offered mid-word, after an @ inside a word, or once the name typed has gone past every name', () => {
  assert.deepEqual(offered('@A|nn'), [], 'the caret in the middle of a word');
  assert.deepEqual(offered('mail ann@a|'), [], 'an @ inside a word, as in an email address');
  assert.deepEqual(offered('@Ann how are you |'), []);
  assert.deepEqual(offered('|@Ann'), [], 'the caret before the @');
});

test('the list holds a few names at most, so it never covers the chat', () => {
  const many = Array.from({ length: 12 }, (_name, index) => `Player ${index}`);

  assert.equal(offered('@|', many).length, MOST_OFFERED);
  assert.deepEqual(offered('@Player 1|', many), ['Player 1', 'Player 10', 'Player 11']);
});

test('picking a name writes it out whole after the @, with a space, and puts the caret after it', () => {
  assert.equal(picking('hey @a|', 'Al Smith'), 'hey @Al Smith |');
  assert.equal(picking('@an| you in?', 'Ann'), '@Ann |you in?', 'a space that follows already is kept, not doubled');
  assert.equal(picking('@|', 'Sam'), '@Sam |');
});

test('a pick that would make the line longer than the table takes leaves the box as it was', () => {
  const text = `${'x'.repeat(LIMITS.chatLength - 3)} @a|`;

  assert.equal(picking(text, 'Al Smith'), null);
});

// ---- Nudges ----

/** A way that writes down every call it is asked for. */
class Recording implements AttentionWay {
  readonly calls: Call[] = [];
  ability = () => 'yes' as const;
  call = (call: Call) => void this.calls.push(call);
  end = () => undefined;
}

/** Dana's page at a table with Lee and Sam: each view as it arrives, through its news and its nudges. */
class Page {
  readonly prefs: AppPreferences;
  readonly mutes: Mutes;
  readonly ways = { sound: new Recording(), buzz: new Recording(), flash: new Recording(), notify: new Recording(), tabTitle: new Recording() };
  readonly attention: Attention;
  private readonly news = new TableNews();
  private shown: TableView | null = null;
  private readonly t: TestTable;

  constructor(t: TestTable, memory = mapMemory()) {
    this.t = t;
    this.prefs = new Preferences(PREFERENCES, memory);
    this.mutes = new Mutes(memory, t.state.id);
    this.attention = new Attention(this.prefs, this.ways as AttentionWays);
  }

  /** `late` is how long the view took to reach the page. */
  arrive(late = 0): void {
    this.tell(this.news.change(this.shown, structuredClone(this.t.view(DANA)), this.t.now + late));
  }

  tell(change: TableChange): void {
    this.shown = change.view;
    nudge(change, this);
  }

  /** The reasons the chime was asked for, in order. */
  get calls(): string[] {
    return this.ways.sound.calls.map((call) => `${call.why} at ${call.table.name}`);
  }
}

const DANA = 0;
const LEE = 1;
const SAM = 2;

function table(): TestTable {
  return new TestTable({ stacks: [1000, 1000, 1000], names: ['Dana', 'Lee', 'Sam'], config: { name: 'Friday Night' } });
}

test('a line naming the viewer nudges them once, with the view that brings it, by the table and the reason alone', () => {
  const t = table();
  const page = new Page(t);
  page.arrive();

  t.cmd(LEE, { type: 'chat', text: '@Dana your go' });
  page.arrive();
  page.arrive();
  t.cmd(SAM, { type: 'chat', text: 'come on' });
  page.arrive();

  assert.deepEqual(page.calls, ['mention at Friday Night']);
  assert.deepEqual(page.ways.notify.calls, [{ why: 'mention', table: { id: t.state.id, name: 'Friday Night' } }], 'nothing of the line goes to a notification');
});

test('a line naming someone else, or said before the page opened, nudges nobody', () => {
  const t = table();
  t.cmd(LEE, { type: 'chat', text: '@Dana are you there' });

  const page = new Page(t);
  page.arrive();
  t.cmd(LEE, { type: 'chat', text: '@Sam your go' });
  page.arrive();

  assert.deepEqual(page.calls, []);
});

test('a line that reaches the page late has had its moment and nudges nothing, then or later', () => {
  const t = table();
  const page = new Page(t);
  page.arrive();

  t.cmd(LEE, { type: 'chat', text: '@Dana wake up' });
  page.arrive(11_000);
  page.arrive();

  assert.deepEqual(page.calls, []);
});

test('the viewer naming themselves, and a line the table quieted, nudge nothing', () => {
  const t = table();
  const page = new Page(t);
  page.arrive();

  t.cmd(DANA, { type: 'chat', text: '@Dana talking to myself' });
  page.arrive();
  assert.deepEqual(page.calls, []);

  t.cmd(LEE, { type: 'chat', text: '@Dana' });
  page.arrive();
  t.cmd(LEE, { type: 'chat', text: '@Dana!!' });
  page.arrive();
  t.cmd(LEE, { type: 'chat', text: '@Dana!!!' });
  page.arrive();
  assert.deepEqual(page.calls, ['mention at Friday Night'], 'one sender, once a minute');

  t.wait(NUDGE_GAP_MS);
  t.cmd(LEE, { type: 'chat', text: '@Dana a minute later' });
  page.arrive();
  assert.equal(page.calls.length, 2);
});

test('a muted sender nudges nothing, and someone else naming the viewer still does', () => {
  const t = table();
  const page = new Page(t);
  page.arrive();
  page.mutes.set(t.ids[LEE]!, true);

  t.cmd(LEE, { type: 'chat', text: '@Dana' });
  page.arrive();
  assert.deepEqual(page.calls, []);

  t.cmd(SAM, { type: 'chat', text: '@Dana' });
  page.arrive();
  assert.deepEqual(page.calls, ['mention at Friday Night']);
});

test('a nudge goes only by the ways the viewer has switched on', () => {
  const t = table();
  const page = new Page(t);
  page.arrive();
  page.prefs.set('sound', false);
  page.prefs.set('notify', false);

  t.cmd(LEE, { type: 'chat', text: '@Dana' });
  page.arrive();

  assert.deepEqual(page.ways.sound.calls, []);
  assert.deepEqual(page.ways.notify.calls, []);
  assert.equal(page.ways.buzz.calls.length, 1, 'a way still switched on is asked');
});

test('a view the page made up for the viewer’s own move brings no nudge, and the server’s next view does not bring one again', () => {
  const t = new TestTable({ stacks: [1000, 1000], names: ['Dana', 'Lee'] });
  t.deal({ button: DANA });
  const told: TableChange[] = [];
  const motion: TableMotion = { play: () => undefined, cancel: () => undefined, idle: () => Promise.resolve(), seen: () => false };
  const shown = new ShownTable(motion, () => t.now, () => 0, { now: () => 0, later: () => undefined }, { draw: () => undefined, tell: (change) => void told.push(change), say: () => undefined });
  const you = (change: TableChange) => nudged(change, () => true);

  shown.take(structuredClone(t.view(DANA)), false);
  t.cmd(LEE, { type: 'chat', text: '@Dana call or fold' });
  shown.take(structuredClone(t.view(DANA)), false);
  assert.deepEqual(told.map(you), [false, true]);

  shown.moveIs('sent', { type: 'call' });
  assert.equal(told.length, 3, 'the move made up on the page was told');
  assert.equal(you(told.at(-1)!), false);

  t.call(DANA);
  shown.take(structuredClone(t.view(DANA)), false);
  assert.deepEqual(told.slice(3).map(you), told.slice(3).map(() => false));
});

// ---- Muting ----

test('a muted player’s chat lines, nudges, reactions and throws are hidden on the muter’s page, and nothing else is', () => {
  const t = table();
  t.sitDown('Kit', 5);
  const page = new Page(t);
  const dana = t.ids[DANA]!;
  const lee = t.ids[LEE]!;
  const sam = t.ids[SAM]!;
  page.mutes.set(lee, true);

  const shown = (what: Parameters<typeof sendersShown>[3]) => sendersShown(page.prefs, page.mutes, dana, what);
  for (const what of ['chat', 'nudges', 'reactions'] as const) {
    assert.deepEqual([lee, sam, dana].map(shown(what)), [false, true, true], what);
  }

  t.cmd(LEE, { type: 'chat', text: 'from Lee' });
  t.cmd(SAM, { type: 'chat', text: 'from Sam' });
  t.cmd(LEE, { type: 'chat', text: 'more from Lee' });
  const lines = t.view(DANA).feed.filter((line) => chatLineShown(line, shown('chat'))).map((line) => line.text);
  assert.ok(lines.includes('from Sam') && !lines.includes('from Lee') && !lines.includes('more from Lee'), lines.join(' | '));
  assert.ok(lines.includes('Lee sits down with 1,000'), 'the play-by-play of what the muted player does still shows');

  const view = t.view(DANA);
  const reactions: Reaction[] = [
    { from: lee, kind: 'laugh', at: t.now },
    { from: lee, kind: 'tomato', at: t.now, to: sam },
    { from: sam, kind: 'fish', at: t.now, to: lee },
  ];
  const change = { before: view, view, feed: [], events: [], current: true, wentBack: false, nightEnded: false, earned: [], tookHighHand: false, reactions, now: t.now };
  assert.deepEqual(
    reactionsShown(change, shown('reactions')).map((reaction) => reaction.label),
    ['Sam threw a fish at Lee'],
    'a throw at the muted player still shows: it is someone else’s',
  );
});

test('a line kept from before chat lines had a sender always shows, and so does the viewer’s own when they muted themselves somehow', () => {
  const t = table();
  const page = new Page(t);
  page.mutes.set(t.ids[DANA]!, true);
  const shown = sendersShown(page.prefs, page.mutes, t.ids[DANA]!, 'chat');

  assert.equal(chatLineShown({ seq: 1, at: 0, kind: 'chat', from: 'Lee', text: 'old' }, shown), true);
  assert.equal(chatLineShown({ seq: 2, at: 0, kind: 'chat', from: 'Dana', text: 'mine', by: t.ids[DANA] }, shown), true);
});

test('the mutes survive a reload, are kept per table, and never touch what the browser remembers of the seat', () => {
  const memory = mapMemory({ 'cnd.seat.TEST01': 'me.secret', 'cnd.name': 'Dana', 'cnd.sound': 'off' });
  const before = { ...memory.kept };

  new Mutes(memory, 'TEST01').set('lee', true);
  new Mutes(memory, 'TEST01').set('sam', true);
  new Mutes(memory, 'OTHER1').set('kim', true);

  const reloaded = new Mutes(memory, 'TEST01');
  assert.deepEqual(reloaded.ids(), ['lee', 'sam']);
  assert.equal(new Mutes(memory, 'OTHER1').has('lee'), false, 'another table has its own');

  reloaded.set('lee', false);
  assert.deepEqual(new Mutes(memory, 'TEST01').ids(), ['sam']);

  for (const [key, value] of Object.entries(before)) {
    assert.equal(memory.kept[key], value, key);
  }
  assert.deepEqual(Object.keys(memory.kept).sort(), [...Object.keys(before), 'cnd.mute.OTHER1', 'cnd.mute.TEST01'].sort());
});

test('a browser that keeps nothing keeps the mutes for the visit, and one kept in a shape it never wrote mutes nobody', () => {
  const forgetful = new Mutes(
    {
      get: () => null,
      set: () => {
        throw new Error('The quota has been exceeded');
      },
    },
    'TEST01',
  );
  forgetful.set('lee', true);
  assert.deepEqual(forgetful.ids(), ['lee']);

  assert.deepEqual(new Mutes(mapMemory({ 'cnd.mute.TEST01': '{"lee":true}' }), 'TEST01').ids(), []);
  assert.deepEqual(new Mutes(mapMemory({ 'cnd.mute.TEST01': 'not json' }), 'TEST01').ids(), []);
});

test('muting or unmuting tells whoever follows the list', () => {
  const mutes = new Mutes(mapMemory(), 'TEST01');
  let told = 0;
  const stop = mutes.watch(() => (told += 1));

  mutes.set('lee', true);
  mutes.set('lee', false);
  stop();
  mutes.set('lee', true);

  assert.equal(told, 2);
});
