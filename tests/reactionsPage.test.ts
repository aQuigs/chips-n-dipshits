/* What a page does with reactions and throws: which it shows and how, its own at the tap, and a request for one that gets no answer. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ServerClock, ServerLine, TableConnection } from '../src/client/connection.ts';
import type { Move, TableMotion } from '../src/client/motion.ts';
import { MOVE_MS } from '../src/client/motion.ts';
import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import { reactionsShown, showReactions } from '../src/client/reactions.ts';
import type { ReactionShown, SeatMark, SeatMarks } from '../src/client/reactions.ts';
import { sendersShown } from '../src/client/senders.ts';
import { ShownTable } from '../src/client/shownTable.ts';
import { Sounds } from '../src/client/sound.ts';
import type { SoundName } from '../src/client/sound.ts';
import { REACTION_FRESH_MS, TableNews } from '../src/client/tableChange.ts';
import type { TableChange } from '../src/client/tableChange.ts';
import type { Transport } from '../src/client/transport.ts';
import { REACTION_GAP_MS } from '../src/engine/index.ts';
import type { Command, Reaction, TableView } from '../src/engine/index.ts';
import type { ApiRequest, ApiResponse, Built } from '../src/server/api.ts';
import { mapMemory, TestTable } from './helpers.ts';

/** Dana, Lee and Sam seated, and a watcher. The views are Dana's unless said. */
function table(): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Dana', 'Lee', 'Sam'] });
  t.sitDown('Kit', 5);

  return t;
}

const DANA = 0;
const LEE = 1;
const SAM = 2;
const KIT = 3;

const seenBy = (t: TestTable, player = DANA): TableView => structuredClone(t.view(player));

/** A page's news, one view after another, each arriving `late` ms after the table made it. */
class News {
  private readonly news = new TableNews();
  private shown: TableView | null = null;

  arrive(t: TestTable, late = 0, wentBack = false): Reaction[] {
    const change = this.news.change(this.shown, seenBy(t), t.now + late, wentBack);

    this.shown = change.view;

    return change.reactions;
  }
}

test('each reaction is news once: with the view that brings it, never again from a view polled or redrawn after', () => {
  const t = table();
  const page = new News();
  page.arrive(t);

  t.cmd(LEE, { type: 'react', kind: 'laugh' });
  assert.deepEqual(page.arrive(t), t.state.reactions);

  assert.deepEqual(page.arrive(t), []);
  t.cmd(SAM, { type: 'chat', text: 'ha' });
  assert.deepEqual(page.arrive(t), [], 'a later view that still carries it');

  t.cmd(SAM, { type: 'react', kind: 'tomato', to: t.ids[LEE] });
  assert.deepEqual(page.arrive(t), [t.state.reactions[1]], 'only the new one');
});

test('a view that brings a reaction past its moment shows it to nobody, and the next view does not bring it back', () => {
  const t = table();
  const page = new News();
  page.arrive(t);

  t.cmd(LEE, { type: 'react', kind: 'laugh' });
  t.cmd(SAM, { type: 'react', kind: 'cry' });
  assert.deepEqual(page.arrive(t, REACTION_FRESH_MS + 1), []);
  assert.deepEqual(page.arrive(t), []);

  // Just in time is in time, and each reaction is judged by its own time
  t.wait(REACTION_GAP_MS);
  t.cmd(LEE, { type: 'react', kind: 'clap' });
  assert.deepEqual(page.arrive(t, REACTION_FRESH_MS - REACTION_GAP_MS), [t.state.reactions.at(-1)]);
});

test('a page opened, or a table gone back, after a reaction has none of it to show', () => {
  const t = table();
  t.cmd(LEE, { type: 'react', kind: 'laugh' });

  assert.deepEqual(new News().arrive(t), [], 'the first view is where things stand');

  const page = new News();
  page.arrive(t);
  t.cmd(SAM, { type: 'react', kind: 'cry' });
  assert.deepEqual(page.arrive(t, 0, true), []);
});

test('the viewer’s own reactions are never news from the server: the page showed them when they were made', () => {
  const t = table();
  const page = new News();
  page.arrive(t);

  t.cmd(DANA, { type: 'react', kind: 'laugh' });
  t.cmd(LEE, { type: 'react', kind: 'fish', to: t.ids[DANA] });

  assert.deepEqual(page.arrive(t).map((reaction) => reaction.from), [t.ids[LEE]]);
});

/** A page's shown table over a recording of what it tells its effects. */
function shownTable(clock: () => number): { shown: ShownTable; told: TableChange[] } {
  const told: TableChange[] = [];
  const motion: TableMotion = { play: () => undefined, cancel: () => undefined, idle: () => Promise.resolve(), seen: () => false };
  const shown = new ShownTable(motion, clock, () => 0, { now: () => 0, later: () => undefined }, { draw: () => undefined, tell: (change) => void told.push(change), say: () => undefined });

  return { shown, told };
}

test('the viewer’s own reaction is told the moment it is made, with nothing else and as no news of the table, and not again when the server sends it back', () => {
  const t = table();
  const { shown, told } = shownTable(() => t.now);
  shown.take(seenBy(t), false);
  const before = shown.view();

  const own: Reaction = { from: t.ids[DANA]!, kind: 'tomato', at: t.now, to: t.ids[SAM] };
  shown.react(own);

  const tap = told.at(-1)!;
  assert.deepEqual(tap.reactions, [own]);
  assert.deepEqual([tap.events, tap.feed, tap.earned, tap.nightEnded, tap.wentBack], [[], [], [], false, false]);
  // Were it news, a turn a late view brought and nothing announced would be announced by the tap
  assert.equal(tap.current, false);
  assert.equal(tap.view, before, 'the table shown is as it was');

  t.cmd(DANA, { type: 'react', kind: 'tomato', to: t.ids[SAM] });
  shown.take(seenBy(t), false);
  assert.deepEqual(told.at(-1)!.reactions, []);
});

/** What a page does with reactions, written down: the marks over the seats, what moved and what was heard. */
class Stage {
  readonly marks: { mark: SeatMark; after: number }[] = [];
  readonly moved: Move[] = [];
  readonly heard: SoundName[] = [];
  readonly prefs = new Preferences(PREFERENCES, mapMemory());
  moving = false;

  readonly seatMarks: SeatMarks = { show: (mark, after) => void this.marks.push({ mark, after }), follow: () => undefined };
  readonly motion: TableMotion = { play: (moves) => void this.moved.push(...moves), cancel: () => undefined, idle: () => Promise.resolve(), seen: () => this.moving };
  private soundClock = 0;
  readonly sounds = new Sounds({ now: () => (this.soundClock += 60), play: (sound) => void this.heard.push(sound) }, this.prefs, { inView: () => true });

  show(change: TableChange): void {
    showReactions(reactionsShown(change, sendersShown(this.prefs, change.view.you.id)), { marks: this.seatMarks, motion: this.motion, sounds: this.sounds });
  }
}

/** A change that brings `reactions`, on the table as Dana sees it now. */
function bringing(t: TestTable, reactions: Reaction[]): TableChange {
  const view = seenBy(t);

  return { before: view, view, feed: [], events: [], current: true, wentBack: false, nightEnded: false, earned: [], tookHighHand: false, reactions, now: t.now };
}

const where = (shown: ReactionShown[]) => shown.map(({ kind, seat, from, label }) => `${kind.id} ${from ?? '-'}>${seat}: ${label}`);

test('a reaction shows over its sender’s seat and a throw over its target’s, from the thrower’s, each named in words', () => {
  const t = table();
  const reactions: Reaction[] = [
    { from: t.ids[LEE]!, kind: 'laugh', at: t.now },
    { from: t.ids[SAM]!, kind: 'fish', at: t.now, to: t.ids[KIT] },
  ];

  assert.deepEqual(where(reactionsShown(bringing(t, reactions), () => true)), ['laugh ->1: Lee is laughing', 'fish 2>5: Sam threw a fish at Kit']);
});

test('a throw at a player gone by the time it lands shows nowhere; one from a thrower gone lands without a flight', () => {
  const t = table();
  const reactions: Reaction[] = [
    { from: t.ids[LEE]!, kind: 'tomato', at: t.now, to: t.ids[SAM] },
    { from: t.ids[SAM]!, kind: 'beer', at: t.now, to: t.ids[KIT] },
    { from: t.ids[SAM]!, kind: 'laugh', at: t.now },
  ];
  t.cmd(SAM, { type: 'standUp' });

  assert.deepEqual(where(reactionsShown(bringing(t, reactions), () => true)), ['beer ->5: Sam threw a beer at Kit']);
  assert.deepEqual(where(reactionsShown(bringing(t, [{ from: t.ids[LEE]!, kind: 'dance', at: t.now }]), () => true)), [], 'a kind this page does not know');
});

test('with others’ reactions switched off, only the viewer’s own show, thrown ones included', () => {
  const t = table();
  const stage = new Stage();
  const reactions: Reaction[] = [
    { from: t.ids[LEE]!, kind: 'laugh', at: t.now },
    { from: t.ids[SAM]!, kind: 'fish', at: t.now, to: t.ids[DANA] },
    { from: t.ids[DANA]!, kind: 'rose', at: t.now, to: t.ids[LEE] },
  ];

  stage.prefs.set('reactions', false);
  stage.show(bringing(t, reactions));
  assert.deepEqual(stage.marks.map(({ mark }) => mark.kind.id), ['rose']);

  stage.prefs.set('reactions', true);
  stage.show(bringing(t, reactions));
  assert.deepEqual(stage.marks.slice(1).map(({ mark }) => mark.kind.id), ['laugh', 'fish', 'rose']);
});

test('with motion on a throw flies from the thrower’s seat to the target’s and shows as it lands; with motion off it is simply there', () => {
  const t = table();
  const reactions: Reaction[] = [
    { from: t.ids[LEE]!, kind: 'laugh', at: t.now },
    { from: t.ids[SAM]!, kind: 'chicken', at: t.now, to: t.ids[DANA] },
  ];

  const moving = new Stage();
  moving.moving = true;
  moving.show(bringing(t, reactions));
  assert.deepEqual(moving.moved, [{ name: 'throw', from: { at: 'seat', seat: SAM }, to: { at: 'seat', seat: DANA }, mark: '🐔', after: 0 }]);
  assert.deepEqual(
    moving.marks.map(({ mark, after }) => [mark.kind.id, mark.seat, mark.moving, after]),
    [
      ['laugh', LEE, true, 0],
      ['chicken', DANA, true, MOVE_MS.throw],
    ],
  );

  const still = new Stage();
  still.show(bringing(t, reactions));
  assert.deepEqual(still.moved, []);
  assert.deepEqual(
    still.marks.map(({ mark, after }) => [mark.kind.id, mark.seat, mark.moving, after]),
    [
      ['laugh', LEE, false, 0],
      ['chicken', DANA, false, 0],
    ],
  );
});

test('a throw makes its sound as it is thrown, a reaction makes none, and with sound off neither does', () => {
  const t = table();
  const reactions: Reaction[] = [
    { from: t.ids[LEE]!, kind: 'laugh', at: t.now },
    { from: t.ids[SAM]!, kind: 'poop', at: t.now, to: t.ids[DANA] },
  ];

  const stage = new Stage();
  stage.show(bringing(t, reactions));
  assert.deepEqual(stage.heard, ['whoosh']);

  stage.prefs.set('sound', false);
  stage.show(bringing(t, reactions));
  assert.deepEqual(stage.heard, ['whoosh']);
});

/** A line to the server that keeps every request and answers only when told. */
class Line implements Transport {
  readonly sent: (ApiRequest & Built)[] = [];
  private readonly waiting: { request: ApiRequest & Built; arrive(answer: ApiResponse & Built): void; fail(error: Error): void }[] = [];

  send(request: ApiRequest & Built): Promise<ApiResponse & Built> {
    this.sent.push(request);

    return new Promise((arrive, fail) => this.waiting.push({ request, arrive, fail }));
  }

  get commands(): string[] {
    return this.sent.flatMap((request) => (request.op === 'act' ? [request.command.type] : []));
  }

  get polls(): number {
    return this.sent.filter((request) => request.op === 'poll').length;
  }

  /** The reaction on its way: lost, or answered with `answer`. */
  async settle(answer: (ApiResponse & Built) | 'lost'): Promise<void> {
    const out = this.waiting.find((waiting) => waiting.request.op === 'act')!;
    this.waiting.splice(this.waiting.indexOf(out), 1);

    if (answer === 'lost') {
      out.fail(new Error('lost'));
    } else {
      out.arrive(answer);
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  hangUp(): void {
    this.waiting.splice(0).forEach((waiting) => waiting.fail(new Error('hung up')));
  }
}

function connected(): { line: Line; connection: TableConnection; said: string[]; refused: string[] } {
  const line = new Line();
  const said: string[] = [];
  const refused: string[] = [];
  const connection = new TableConnection(new ServerLine(line, 'b', () => undefined), { tableId: 'TEST01', auth: { id: 'A', token: 'T' } }, new ServerClock(), {
    view: () => undefined,
    move: () => assert.fail('a reaction is not a move'),
    status: () => undefined,
    refused: (error) => void refused.push(error.code),
    notice: (message) => void said.push(message),
  });

  return { line, connection, said, refused };
}

const REACT: Command = { type: 'react', kind: 'laugh' };

test('a reaction that gets no answer is dropped: not sent again, not looked up, nothing said and the seat left alone', async () => {
  const { line, connection, said, refused } = connected();

  const outcome = connection.send(REACT);
  assert.equal(connection.reacting, true);
  await line.settle('lost');

  assert.equal(await outcome, 'unanswered');
  assert.equal(connection.reacting, false);
  assert.deepEqual([line.commands, line.polls, said, refused], [['react'], 0, [], []]);
});

test('one reaction at a time: a second while the first is out is not sent', async () => {
  const { line, connection } = connected();

  const first = connection.send(REACT);
  assert.equal(await connection.send(REACT), 'refused');
  assert.deepEqual(line.commands, ['react']);

  await line.settle('lost');
  await first;
  void connection.send(REACT);
  assert.deepEqual(line.commands, ['react', 'react']);
  line.hangUp();
});

test('a refused reaction says nothing, since the player saw it at the tap, and leaves the seat alone, the poll being what hears of a seat gone', async () => {
  for (const code of ['invalid', 'busy', 'unauthorized', 'not_found'] as const) {
    const { line, connection, said, refused } = connected();
    const outcome = connection.send(REACT);

    await line.settle({ ok: false, code, error: 'Plenty flying already: try again in a moment', build: 'b' });

    assert.equal(await outcome, 'refused');
    assert.deepEqual([said, refused, line.polls], [[], [], 0], code);
  }
});
