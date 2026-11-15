import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { Attention } from '../src/client/attention.ts';
import type { AttentionWay, AttentionWays, Call } from '../src/client/attention.ts';
import { celebrationMoves } from '../src/client/celebrations.ts';
import { MOVES, ServerClock, ServerLine, TableConnection } from '../src/client/connection.ts';
import type { SendOutcome } from '../src/client/connection.ts';
import { betSlide, followHand } from '../src/client/handMoves.ts';
import { soundsOf } from '../src/client/handSounds.ts';
import type { Move } from '../src/client/motion.ts';
import { choiceOn, PendingChoice } from '../src/client/pendingChoice.ts';
import { PendingMove, UNCONFIRMED_AFTER_MS } from '../src/client/pendingMove.ts';
import { AHEAD_ORDER, aheadLabel, aheadLines } from '../src/client/preActions.ts';
import { isTurnMove } from '../src/client/prediction.ts';
import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import type { Ability } from '../src/client/prefs.ts';
import { ShownTable } from '../src/client/shownTable.ts';
import { Sounds } from '../src/client/sound.ts';
import type { SoundName } from '../src/client/sound.ts';
import type { TableChange } from '../src/client/tableChange.ts';
import type { Transport } from '../src/client/transport.ts';
import { YourTurn } from '../src/client/yourTurn.ts';
import { boardsDealt, TOO_LATE_TO_SET } from '../src/engine/index.ts';
import type { Command, HandEvent, PreActionKind, TableConfig, TableState, TableView } from '../src/engine/index.ts';
import type { ApiRequest, ApiResponse, Auth, Built } from '../src/server/api.ts';
import { BuildGate } from '../src/server/build.ts';
import { MemoryPlayerStore } from '../src/server/memoryPlayerStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import { ACES, KINGS, mapMemory, seededRng, TestTable, withoutTheServersPart } from './helpers.ts';
import type { DealOptions } from './helpers.ts';

const BUILD = 'aaaaaaaaaaaa';
const NEWER_BUILD = 'cccccccccccc';

// What the Sheet's lock says when a request could not have the table in time: a refusal that leaves the decision open
const BUSY: ApiResponse & Built = { ok: false, code: 'busy', error: 'The table is busy, try again', build: BUILD };

type Op = 'act' | 'poll';

/** The game itself, on a clock the test moves, with everyone seated. The first player is the host. */
class Server {
  now = 1_800_000_000_000;
  private readonly store = new MemoryStore();
  private gate: BuildGate;
  private readonly game: PokerService;
  private readonly tableId: string;
  private readonly auths = new Map<string, Auth>();

  constructor(players: { name: string; stack: number }[], config: Partial<TableConfig> = {}) {
    this.game = new PokerService({ store: this.store, presets: new MemoryPresetStore(), players: new MemoryPlayerStore(seededRng(8)), clock: { now: () => this.now }, rng: seededRng(7) });
    this.gate = new BuildGate(this.game, BUILD);

    const [host, ...others] = players;
    const created = this.game.handle({ op: 'create', name: host!.name, config: { minBuyIn: 1, maxBuyIn: 1_000_000, actionSeconds: 0, ...config } });
    assert.ok(created.ok && created.kind === 'joined', JSON.stringify(created));

    this.tableId = created.view.id;
    this.auths.set(host!.name, created.auth);
    this.act(host!.name, { type: 'requestSeat', seat: 0, buyIn: host!.stack });

    others.forEach((player, index) => {
      const joined = this.game.handle({ op: 'join', tableId: this.tableId, name: player.name });
      assert.ok(joined.ok && joined.kind === 'joined', JSON.stringify(joined));

      this.auths.set(player.name, joined.auth);
      this.act(player.name, { type: 'requestSeat', seat: index + 1, buyIn: player.stack });
      this.act(host!.name, { type: 'approve', playerId: joined.auth.id });
    });
  }

  session(name: string): { tableId: string; auth: Auth } {
    return { tableId: this.tableId, auth: this.auths.get(name)! };
  }

  /** What the server makes of a request from a page. */
  answer(request: ApiRequest & Built): ApiResponse & Built {
    return this.gate.handle(request);
  }

  /** A player's command as from another device: it goes by no page's line. */
  act(name: string, command: Command): TableView {
    const answer = this.game.handle({ op: 'act', ...this.session(name), command });
    assert.ok(answer.ok && answer.kind === 'view', `${name} ${JSON.stringify(command)}: ${JSON.stringify(answer)}`);

    return answer.view;
  }

  /** The table as a player sees it. Like any poll, it lets whatever came due happen. */
  view(name: string): TableView {
    const answer = this.game.handle({ op: 'poll', ...this.session(name), since: -1 });
    assert.ok(answer.ok && answer.kind === 'view', JSON.stringify(answer));

    return answer.view;
  }

  /** Starts the game and deals a hand with the button and the cards fixed. */
  deal(deal: DealOptions): void {
    const host = [...this.auths.keys()][0]!;

    if (!this.view(host).running) {
      this.act(host, { type: 'start' });
    }

    this.alter((state) => {
      const dealer = TestTable.adopt(state);

      dealer.now = this.now;
      dealer.deal(deal);
    });
  }

  /** Puts the saved table back as it was at an earlier moment, as restoring the Sheet does. */
  saved(): TableState {
    return structuredClone(this.store.read(this.tableId)!);
  }

  restore(saved: TableState): void {
    this.store.transact(this.tableId, () => ({ save: structuredClone(saved), at: this.now, effects: [], result: null }));
  }

  /** The game is updated under the pages that are open. */
  deploy(): void {
    this.gate = new BuildGate(this.game, NEWER_BUILD);
  }

  private alter(change: (state: TableState) => void): void {
    this.store.transact(this.tableId, (state) => {
      change(state!);
      state!.version += 1;

      return { save: state!, at: this.now, effects: [], result: null };
    });
  }
}

interface OnTheWay {
  request: ApiRequest & Built;
  /** The server's answer, once it has heard the request. */
  answer: (ApiResponse & Built) | null;
  arrive(answer: ApiResponse & Built): void;
  fail(error: Error): void;
}

/** Lets what a page does in answer to an arrival run its course. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A page's line to the server, which writes down everything sent on it and carries nothing by itself:
 * the test says when the server hears a request, when the answer gets back, and what is lost on the way.
 */
class Wire implements Transport {
  readonly sent: (ApiRequest & Built)[] = [];
  private readonly server: Server;
  private readonly onTheWay: OnTheWay[] = [];

  constructor(server: Server) {
    this.server = server;
  }

  send(request: ApiRequest & Built): Promise<ApiResponse & Built> {
    this.sent.push(request);

    return new Promise((arrive, fail) => this.onTheWay.push({ request, answer: null, arrive, fail }));
  }

  /** The moves of a turn sent so far, by name. */
  get moves(): string[] {
    return this.sent.flatMap((request) => (request.op === 'act' && isTurnMove(request.command) ? [request.command.type] : []));
  }

  /** The server hears the request and acts on it. Its answer is on the way back until `answer`. */
  hear(op: Op): void {
    const next = this.next(op);

    next.answer ??= this.server.answer(next.request);
  }

  /** The answer reaches the page: the server's own, heard now if not before, or the one given. */
  async answer(op: Op, instead?: ApiResponse & Built): Promise<void> {
    const next = this.next(op);
    const answer = instead ?? next.answer ?? this.server.answer(next.request);

    // A poll answered "nothing new" has the page wait a second before it asks again, which no test should sit through
    assert.ok(!(answer.ok && answer.kind === 'unchanged'), 'the test answered a poll that had nothing to tell');

    this.onTheWay.splice(this.onTheWay.indexOf(next), 1);
    next.arrive(answer);
    await settled();
  }

  /** The page never gets an answer: the request is lost on the way there, or its answer on the way back if the server had heard it. */
  async lose(op: Op): Promise<void> {
    const next = this.next(op);

    this.onTheWay.splice(this.onTheWay.indexOf(next), 1);
    next.fail(new Error('lost'));
    await settled();
  }

  /** Ends everything still on its way, so nothing is left waiting when the test is over. */
  async hangUp(): Promise<void> {
    this.onTheWay.splice(0).forEach((request) => request.fail(new Error('hung up')));
    await settled();
  }

  /** The request the page is waiting on: its only move, or the poll it last sent, which is the one it still listens to. */
  private next(op: Op): OnTheWay {
    const next = this.onTheWay.filter((request) => request.request.op === op).at(-1);
    assert.ok(next, `no ${op} is on its way`);

    return next;
  }
}

type Key = keyof AttentionWays;

class RecordingWay implements AttentionWay {
  readonly calls: Call[] = [];
  readonly ends: Call[] = [];

  ability(): Ability {
    return 'yes';
  }

  call(call: Call): void {
    this.calls.push(call);
  }

  end(call: Call): void {
    this.ends.push(call);
  }
}

/**
 * One player's page without its screen: the line, the connection, what is shown (`ShownTable`) and what
 * each effect of a table screen does with a change, put together as `App` and `TableEffects` put them,
 * with everything that would be heard, moved or said written down.
 */
class Page {
  readonly wire: Wire;
  readonly connection: TableConnection;
  readonly shown: ShownTable;
  /** Everything the effects were told, in order. */
  readonly told: TableChange[] = [];
  readonly moved: Move[] = [];
  readonly heard: SoundName[] = [];
  readonly said: string[] = [];
  readonly flash = new RecordingWay();
  /** How many times the page was told it is out of date. */
  outdated = 0;
  /** How long views take to reach the page, as far as its clock can tell. */
  late = 0;
  /** This device's own clock. */
  device = 0;
  /** Motion is on, and what moves is seen. */
  moving = false;
  /** The page has the time to work out the chances of hands face up. Off, they stay pending, which no test but theirs reads. */
  worksOutChances = false;
  /** Whoever is waiting for the table to be still. */
  private readonly landing: (() => void)[] = [];
  private soundClock = 0;

  constructor(server: Server, name: string) {
    const prefs = new Preferences(PREFERENCES, mapMemory());
    const clock = new ServerClock();
    const ways = Object.fromEntries((['sound', 'buzz', 'notify', 'tabTitle'] as Key[]).map((key) => [key, new RecordingWay()])) as Record<Key, RecordingWay>;
    const motion = {
      play: (moves: readonly Move[]) => void this.moved.push(...moves),
      cancel: () => undefined,
      idle: () => new Promise<void>((resolve) => void this.landing.push(resolve)),
      seen: () => this.moving,
    };
    // Each sound asked for a long while after the last, so none is dropped for coming in a burst
    const sounds = new Sounds({ now: () => (this.soundClock += 60), play: (sound) => void this.heard.push(sound) }, prefs, { inView: () => true });
    const turns = new YourTurn(new Attention(prefs, { ...ways, flash: this.flash }));

    this.wire = new Wire(server);
    // A clock that stands still gets the whole of a spot worked out at once; one that runs ahead gets none of it
    let spent = 0;
    const pace = { now: () => (this.worksOutChances ? 0 : (spent += 1000)), later: () => undefined };

    this.shown = new ShownTable(motion, () => clock.now() + this.late, () => this.device, pace, {
      draw: () => undefined,
      tell: (change) => {
        const seat = change.view.you.seat;

        this.told.push(change);
        soundsOf(change, seat).forEach(({ sound }) => sounds.play(sound));
        this.said.push(...[aheadLines(change).shown].filter((line) => line !== null));
        followHand(change, seat, motion);
        motion.play(celebrationMoves(change, seat));
        turns.see(change);
      },
      say: (message) => void this.said.push(message),
    });
    this.connection = new TableConnection(new ServerLine(this.wire, BUILD, () => this.outOfDate()), server.session(name), clock, {
      view: (view, wentBack) => this.shown.take(view, wentBack),
      move: (lock, sent) => this.shown.moveIs(lock, sent),
      chose: (sent) => this.shown.choiceIs(sent),
      status: () => undefined,
      refused: () => assert.fail('the page was told its seat is gone'),
      notice: (message) => void this.said.push(message),
    });
  }

  /** Opens the table: the first view is on the page, and a poll is out for news. */
  async open(): Promise<this> {
    this.connection.refresh();
    await this.wire.answer('poll');

    return this;
  }

  /** The player taps a button of their turn, or presses its key. */
  tap(command: Command): Promise<SendOutcome> {
    return this.connection.send(command);
  }

  /** A button as the turn's panel sends it: with the number of the decision on screen. */
  move(type: 'fold' | 'check' | 'call'): Promise<SendOutcome> {
    return this.tap({ type, turn: this.view.hand!.turn });
  }

  raise(to: number): Promise<SendOutcome> {
    return this.tap({ type: 'raise', to, turn: this.view.hand!.turn });
  }

  /** A choice of a move ahead as its button sends it: for the spot on screen. With null, the one that is set is pressed again. */
  choose(what: PreActionKind | null): Promise<SendOutcome> {
    const choice = choiceOn(this.view, what);
    assert.ok(choice, 'the page offers no choice ahead');

    return this.tap(choice);
  }

  /** The choices ahead sent so far, by what was chosen. */
  get choices(): (PreActionKind | null)[] {
    return this.wire.sent.flatMap((request) => (request.op === 'act' && request.command.type === 'preAct' ? [request.command.what] : []));
  }

  /** Everything that was moving has landed. */
  async land(): Promise<void> {
    this.landing.splice(0).forEach((landed) => landed());
    await settled();
  }

  get view(): TableView {
    return this.shown.view()!;
  }

  /** What the table shows of the player's own seat and the hand, in a line. */
  get table(): string {
    const view = this.view;
    const me = view.seats[view.you.seat!]!;
    const hand = view.hand!;
    const turn = hand.options ? 'my turn' : hand.toAct === null ? 'nobody to act' : `waiting for ${view.seats[hand.toAct]!.name}`;

    return `${me.lastAction ?? 'no move'}, ${me.bet} in front, ${me.stack} behind, pot ${hand.pot}, ${turn}`;
  }

  /** What the effects were told happened in the hand, since `from` changes ago. */
  events(from = 0): HandEvent[] {
    return this.told.slice(from).flatMap((change) => change.events);
  }

  /** The moves that slid a bet in front of a seat. */
  get slides(): Move[] {
    return this.moved.filter((move) => move.name === 'bet');
  }

  async close(): Promise<void> {
    this.connection.close();
    this.shown.end();
    await this.wire.hangUp();
  }

  private outOfDate(): void {
    this.outdated += 1;
    this.shown.forget();
  }
}

const THREE = [
  { name: 'Quigs', stack: 1000 },
  { name: 'Stu', stack: 1000 },
  { name: 'Pam', stack: 1000 },
];

/** A player's page, open on the table until the test is over, however it ends. */
function pageOf(t: TestContext, server: Server, name: string): Promise<Page> {
  const page = new Page(server, name);

  // Left open, a page goes on asking the table for news, and the test run never ends
  t.after(() => page.close());

  return page.open();
}

/** Three-handed with the button on Quigs, who is first to act before the flop, and Quigs's page open on it. */
async function quigsToAct(t: TestContext, config: Partial<TableConfig> = {}): Promise<{ server: Server; page: Page }> {
  const server = new Server(THREE, config);
  server.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: '2c 7d 9h Jc 3s' });

  const page = await pageOf(t, server, 'Quigs');
  assert.equal(page.table, 'no move, 0 in front, 1000 behind, pot 30, my turn');

  return { server, page };
}

const CALLED = 'call, 20 in front, 980 behind, pot 50, waiting for Stu';

test('a move shows the moment it is made, and the answer that confirms it changes nothing and tells nothing twice', async (t) => {
  const { page } = await quigsToAct(t);
  const before = page.told.length;

  const sending = page.move('call');
  assert.equal(page.table, CALLED, 'before anything came back from the server');
  assert.equal(page.shown.waiting, null);
  assert.deepEqual(page.events(before), [['call', 0, 20, 980]], 'the effects hear of the move as of any other');
  assert.deepEqual(page.slides, [betSlide(0)]);
  assert.deepEqual(page.heard, [], 'a player’s own move makes no sound');

  const shown = structuredClone(page.view);
  await page.wire.answer('act');
  assert.equal(await sending, 'taken');

  assert.equal(page.table, CALLED);
  assert.deepEqual(withoutTheServersPart(page.view), withoutTheServersPart(shown), 'the confirmed table is the one that was showing');
  assert.deepEqual(page.events(before), [['call', 0, 20, 980]], 'the move was told once');
  assert.deepEqual(page.slides, [betSlide(0)], 'the bet did not slide in again');
  assert.deepEqual(page.heard, []);
  assert.deepEqual(page.said, []);
  assert.deepEqual(page.wire.moves, ['call']);
});

test('the turn’s call for attention ends at the tap, once, and a confirmed move calls for none', async (t) => {
  const server = new Server(THREE);
  const page = await pageOf(t, server, 'Stu');

  server.deal({ button: 0 });
  server.act('Quigs', { type: 'call' });
  await page.wire.answer('poll');
  assert.deepEqual([page.flash.calls.length, page.flash.ends.length], [1, 0], 'the action reached the player');

  const sending = page.move('fold');
  assert.deepEqual([page.flash.calls.length, page.flash.ends.length], [1, 1], 'it ended when they tapped, not when the server answered');

  await page.wire.answer('act');
  await sending;
  assert.deepEqual([page.flash.calls.length, page.flash.ends.length], [1, 1]);
  assert.equal(page.view.seats[1]!.folded, true);
});

test('a move the server refuses comes off the table, which is as it was, with the server’s reason and no second call to the turn', async (t) => {
  const { page } = await quigsToAct(t);
  const before = structuredClone(page.view);
  const calls = page.flash.calls.length;

  const sending = page.raise(137);
  assert.equal(page.table, 'raise, 137 in front, 863 behind, pot 167, waiting for Stu');

  await page.wire.answer('act', BUSY);
  assert.equal(await sending, 'refused');

  assert.deepEqual(page.view, before, 'the table is back exactly as it was');
  assert.deepEqual(page.said, ['The table is busy, try again']);
  assert.equal(page.shown.waiting, null);
  assert.equal(page.flash.calls.length, calls, 'the turn they already knew of was not announced again');
  assert.deepEqual(page.slides, [betSlide(0)], 'nothing slid for the bet that came off');
  assert.deepEqual(page.heard, []);
  assert.equal(page.connection.turnLocked, false, 'the buttons are free for another try');

  // The second try is a move of its own, sent once
  const again = page.raise(137);
  await page.wire.answer('act');
  assert.equal(await again, 'taken');
  assert.equal(page.table, 'raise, 137 in front, 863 behind, pot 167, waiting for Stu');
  assert.deepEqual(page.wire.moves, ['raise', 'raise']);
  assert.deepEqual(page.slides, [betSlide(0), betSlide(0)]);
});

test('a move that got no answer stays shown and is marked, and the lookup that finds it played confirms it', async (t) => {
  const { page } = await quigsToAct(t);

  const sending = page.move('call');
  page.wire.hear('act');
  await page.wire.lose('act');
  assert.equal(await sending, 'unanswered');

  assert.equal(page.table, CALLED, 'still shown as made');
  assert.equal(page.shown.waiting, 'unconfirmed', 'and marked at once: the request failed');
  assert.deepEqual(page.said, ['No answer from the table. Checking whether that was played…']);
  assert.equal(page.connection.turnLocked, true);

  await page.wire.answer('poll');
  assert.equal(page.table, CALLED);
  assert.equal(page.shown.waiting, null);
  assert.equal(page.connection.turnLocked, false);
  assert.deepEqual(page.said, ['No answer from the table. Checking whether that was played…'], 'nothing more to say: it was played');
  assert.deepEqual(page.slides, [betSlide(0)]);
  assert.deepEqual(page.wire.moves, ['call'], 'looked up, never sent again');
});

test('a move that got no answer and is found not played is put back, with a sentence that says so', async (t) => {
  const { page } = await quigsToAct(t);
  const before = structuredClone(page.view);
  const calls = page.flash.calls.length;

  const sending = page.move('call');
  await page.wire.lose('act');
  assert.equal(await sending, 'unanswered');
  assert.equal(page.table, CALLED);
  assert.equal(page.shown.waiting, 'unconfirmed');

  await page.wire.answer('poll');
  assert.deepEqual(page.view, before, 'the table is back exactly as it was');
  assert.deepEqual(page.said, ['No answer from the table. Checking whether that was played…', 'The table has no sign of your call, so it is still your turn.']);
  assert.equal(page.shown.waiting, null);
  assert.equal(page.flash.calls.length, calls, 'the turn was not announced again');
  assert.equal(page.connection.turnLocked, false);
  assert.deepEqual(page.wire.moves, ['call'], 'the page did not send it again on its own');
});

test('a view from before the move, arriving during it, never puts the table back', async (t) => {
  const { server, page } = await quigsToAct(t);

  // The server answers the poll with a chat line, and the answer is still on its way when the player moves
  server.act('Pam', { type: 'chat', text: 'come on then' });
  page.wire.hear('poll');

  const sending = page.move('call');
  await page.wire.answer('poll');

  assert.equal(page.table, CALLED, 'the older view is drawn with the move on it');
  assert.equal(page.view.feed.at(-1)!.text, 'come on then', 'and what it brought is shown');
  assert.equal(page.view.hand!.options, null);
  assert.deepEqual(page.slides, [betSlide(0)]);

  await page.wire.answer('act');
  assert.equal(await sending, 'taken');
  assert.equal(page.table, CALLED);
  assert.deepEqual(page.slides, [betSlide(0)]);
  assert.deepEqual(page.events(), [['call', 0, 20, 980]]);
});

test('a newer view from a poll retires the move before its answer, and the answer after it changes nothing', async (t) => {
  const { server, page } = await quigsToAct(t);

  const sending = page.move('call');
  page.wire.hear('act');

  // Stu acts on the table the server has, and the poll's answer overtakes the answer to the move
  server.act('Stu', { type: 'call' });
  await page.wire.answer('poll');

  assert.equal(page.table, 'call, 20 in front, 980 behind, pot 60, waiting for Pam', 'the server’s word is what shows');
  assert.equal(page.connection.turnLocked, true, 'the move is still on its way as far as the line knows');
  assert.equal(page.shown.waiting, null);
  assert.deepEqual(page.events(), [['call', 0, 20, 980], ['call', 1, 10, 980]], 'the player’s own call once, then Stu’s');
  assert.deepEqual(page.slides, [betSlide(0), betSlide(1)]);
  assert.deepEqual(page.heard, ['chips'], 'Stu’s chips, not their own');

  const told = page.told.length;
  await page.wire.answer('act');
  assert.equal(await sending, 'taken');
  assert.equal(page.table, 'call, 20 in front, 980 behind, pot 60, waiting for Pam');
  assert.equal(page.told.length, told, 'the answer was older than what shows, and is not drawn or told');
  assert.equal(page.connection.turnLocked, false);
  assert.deepEqual(page.said, []);
});

test('a move that closes the street shows no card until the server deals it, and the chips then go to the pot from where they were shown', async (t) => {
  const server = new Server(THREE);
  server.deal({ button: 0, board: '2c 7d 9h Jc 3s' });
  server.act('Quigs', { type: 'call' });
  server.act('Stu', { type: 'call' });

  const page = await pageOf(t, server, 'Pam');
  page.moving = true;

  const sending = page.move('check');
  assert.equal(page.table, 'check, 20 in front, 980 behind, pot 60, nobody to act');
  assert.deepEqual(page.view.hand!.boards, [[]]);
  assert.equal(page.moved.length, 0, 'a check is not seen');

  await page.wire.answer('act');
  await sending;
  assert.deepEqual(page.view.hand!.boards, [['2c', '7d', '9h']]);
  assert.deepEqual(page.events().map((event) => event[0]), ['check', 'street']);
  assert.deepEqual(page.moved.filter((move) => move.name === 'chips').map((move) => [move.from, move.amount]), [0, 1, 2].map((seat) => [{ at: 'bet', seat }, 20]));
});

test('the hand ending under a move: the server’s word shows, and its refusal of the move is told', async (t) => {
  const server = new Server(
    [
      { name: 'Quigs', stack: 1000 },
      { name: 'Stu', stack: 1000 },
    ],
    { actionSeconds: 20 },
  );
  server.deal({ button: 0 });

  const page = await pageOf(t, server, 'Quigs');
  const deadline = page.view.hand!.deadline!;

  const sending = page.move('call');
  assert.equal(page.table, 'call, 20 in front, 980 behind, pot 40, waiting for Stu');
  assert.equal(page.view.hand!.deadline, null, 'their clock stopped');

  // The move is still on its way when the clock runs out on them, and the poll says so first
  server.now = deadline + 1;
  await page.wire.answer('poll');

  const me = page.view.seats[0]!;
  assert.deepEqual([me.folded, me.bet, page.view.hand!.stage], [true, 0, 'done'], 'folded by the clock, and the hand is over');
  assert.equal(me.stack, 990);
  assert.deepEqual(page.events().map((event) => event[0]), ['call', 'timeout', 'fold', 'return', 'win'], 'the call as it was shown, then all that truly happened instead');

  await page.wire.answer('act');
  assert.equal(await sending, 'refused');
  assert.deepEqual(page.said, ["It's not your turn"]);
  assert.equal(page.view.seats[0]!.stack, 990, 'nothing was put back: there was no move left on the table');
});

test('a view that confirms the move late is drawn and tells nothing, the move included', async (t) => {
  const { page } = await quigsToAct(t);

  const sending = page.move('call');
  page.wire.hear('act');

  // The answer takes longer to arrive than anything on the table may be old and still be news
  page.late = 11_000;
  await page.wire.answer('act');
  await sending;

  assert.equal(page.table, CALLED);
  assert.equal(page.told.at(-1)!.current, false);
  assert.deepEqual(page.events(), [['call', 0, 20, 980]], 'only the move, told when it was made');
  assert.deepEqual(page.slides, [betSlide(0)]);
  assert.equal(page.shown.waiting, null);
});

test('the last card of an all-in runout is held back from the view that confirms the player’s own call', async (t) => {
  const server = new Server(
    [
      { name: 'Quigs', stack: 1000 },
      { name: 'Stu', stack: 1000 },
    ],
    { maxRuns: 1 },
  );
  server.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: '2c 7d 9h Jc 3s' });
  server.act('Quigs', { type: 'call' });
  server.act('Stu', { type: 'check' });
  server.act('Stu', { type: 'check' });
  server.act('Quigs', { type: 'check' });
  server.act('Stu', { type: 'raise', to: 980 });

  const page = await pageOf(t, server, 'Quigs');
  page.moving = true;

  const sending = page.move('call');
  assert.equal(page.table, 'call, 980 in front, 0 behind, pot 2000, nobody to act');
  page.wire.hear('act');

  // The answer is slow, and the first the page hears is a poll after the river came and the hand was settled
  server.now = server.view('Quigs').hand!.deadline!;
  await page.wire.answer('poll');

  assert.equal(page.shown.turning.length, 1, 'the river is being turned over');
  assert.equal(page.view.hand!.result, null, 'and who won is not said yet');
  assert.deepEqual([page.view.seats[0]!.stack, page.view.seats[0]!.bet], [0, 0], 'the chips went to the pot, and nobody has them yet');
  assert.ok(!page.events().some((event) => event[0] === 'win'));
  assert.equal(page.events().filter((event) => event[0] === 'call').length, 1, 'the call was told once');
  assert.deepEqual(page.slides, [betSlide(0)]);

  await page.wire.answer('act');
  await sending;
  assert.equal(page.view.hand!.result, null, 'the late answer to the call does not end the hold');

  await page.land();
  assert.equal(page.view.hand!.result!.winnings[0]!.seat, 0);
  assert.equal(page.view.seats[0]!.stack, 2000);
  assert.equal(page.events().filter((event) => event[0] === 'win').length, 1);
  assert.equal(page.events().filter((event) => event[0] === 'call').length, 1);
});

test('a move shown early tells no badge: the badges of the hand it ends come from the server, once, in the view that clears it', async (t) => {
  const server = new Server(
    [
      { name: 'Quigs', stack: 1000 },
      { name: 'Stu', stack: 1000 },
    ],
    { maxRuns: 1 },
  );
  server.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: '2c 7d 9h Jc 3s' });
  server.act('Quigs', { type: 'call' });
  server.act('Stu', { type: 'raise', to: 1000 });

  const page = await pageOf(t, server, 'Quigs');
  page.moving = true;
  const before = page.told.length;

  // The call that will take every chip of Stu's shows at once, and with it no badge
  const sending = page.move('call');
  assert.equal(page.table, 'call, 1000 in front, 0 behind, pot 2000, nobody to act');
  await page.wire.answer('act');
  await sending;

  // The board comes a card at a time, and the hand is cleared once the result has been on the table its while
  const told = () => page.told.slice(before).flatMap((change) => change.earned);
  for (let steps = 0; server.view('Quigs').hand; steps++) {
    assert.deepEqual(told(), [], 'a badge was told before the hand was cleared');
    assert.ok(steps < 10, 'the hand was never cleared');

    server.now = server.view('Quigs').hand!.deadline!;
    await page.wire.answer('poll');
    await page.land();
  }

  assert.deepEqual(told(), [{ id: 'bigPot', times: 1 }, { id: 'felted', times: 1 }]);
});

test('a fold shown early into two blinds who always chop tells no badge, nor does the chop the server makes of it', async (t) => {
  const server = new Server(THREE, { allowChop: true });
  server.act('Stu', { type: 'setAlwaysChop', on: true });
  server.act('Pam', { type: 'setAlwaysChop', on: true });
  server.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: '2c 7d 9h Jc 3s' });

  const page = await pageOf(t, server, 'Quigs');
  assert.equal(page.view.hand!.foldChops, true);
  const before = page.told.length;

  const sending = page.move('fold');
  assert.equal(page.table, 'fold, 0 in front, 1000 behind, pot 30, nobody to act');
  await page.wire.answer('act');
  await sending;
  assert.deepEqual(server.view('Quigs').hand!.result!.chopped, [1, 2]);

  // Cleared once its result has been on the table its while, and the next hand is dealt
  const chopped = page.view.hand!.number;
  server.now = server.view('Quigs').hand!.deadline!;
  await page.wire.answer('poll');
  assert.notEqual(page.view.hand?.number, chopped, 'the chopped hand was not cleared');

  assert.deepEqual(page.told.slice(before).flatMap((change) => change.earned), []);
  assert.ok(!page.view.feed.some((entry) => entry.text.includes(' earned ')), 'a badge line came with the chop');
});

test('the hands’ chances are those of the cards face up: unchanged until a card has landed and while the last is held face down, and gone with the result', async (t) => {
  const server = new Server(
    [
      { name: 'Quigs', stack: 1000 },
      { name: 'Stu', stack: 1000 },
    ],
    { maxRuns: 1 },
  );
  server.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: '2c 7d 9h Jc 3s' });
  server.act('Quigs', { type: 'raise', to: 1000 });
  server.act('Stu', { type: 'call' });

  const page = new Page(server, 'Quigs');
  t.after(() => page.close());
  page.worksOutChances = true;
  page.moving = true;
  await page.open();

  const figures = () => page.shown.chances?.boards.map((board) => board?.map((figure) => figure.text) ?? null) ?? null;
  const nextStreet = async () => {
    server.now = server.view('Quigs').hand!.deadline!;
    await page.wire.answer('poll');
  };

  assert.deepEqual([figures(), page.shown.chancesPending], [[null], true], 'the hands are on their way over');
  await page.land();
  assert.deepEqual([figures(), page.shown.chancesPending], [[['~83', '~17']], false]);

  await nextStreet();
  assert.deepEqual([page.view.hand!.boards[0]!.length, figures(), page.shown.chancesPending], [3, [['~83', '~17']], true], 'the flop is dealt and has not landed');
  await page.land();
  assert.deepEqual([figures(), page.shown.chancesPending], [[['92', '8']], false]);

  await nextStreet();
  await page.land();
  assert.deepEqual(figures(), [['95', '5']]);

  // The river comes with the result, and the page holds it face down
  await nextStreet();
  assert.equal(page.shown.turning.length, 1, 'the river is being turned over');
  assert.deepEqual([figures(), page.shown.chancesPending], [[['95', '5']], false], 'the hands read as on the turn, and wait for nothing');

  await page.land();
  assert.ok(page.view.hand!.result, 'the result is up');
  assert.deepEqual([page.shown.chances, page.shown.chancesPending], [null, false]);
});

test('a move is marked as not confirmed once it has waited long enough, by this device’s clock', async (t) => {
  const { page } = await quigsToAct(t);

  const sending = page.move('call');
  page.device += UNCONFIRMED_AFTER_MS - 1;
  assert.equal(page.shown.waiting, null);

  page.device += 1;
  assert.equal(page.shown.waiting, 'unconfirmed');
  assert.equal(page.table, CALLED, 'the mark changes nothing of the table');

  await page.wire.answer('act');
  await sending;
  assert.equal(page.shown.waiting, null);
});

test('while a move is on its way, a second tap or key shows nothing and sends nothing', async (t) => {
  const { page } = await quigsToAct(t);

  const sending = page.move('call');
  assert.equal(await page.tap({ type: 'fold', turn: 0 }), 'refused');
  assert.equal(await page.raise(200), 'refused');
  assert.equal(page.table, CALLED);
  assert.deepEqual(page.wire.moves, ['call']);

  await page.wire.answer('act');
  await sending;
  assert.deepEqual(page.wire.moves, ['call']);
});

test('a move the page could know is not allowed is shown as nothing, and sent for the server to refuse in its own words', async (t) => {
  const { page } = await quigsToAct(t);
  const before = structuredClone(page.view);

  const told = page.told.length;
  const sending = page.tap({ type: 'check', turn: before.hand!.turn });
  assert.deepEqual(page.view, before);
  assert.equal(page.shown.waiting, 'sent', 'it is out, which is all the page shows of it');
  assert.deepEqual([page.told.length, page.moved.length], [told, 0], 'and nothing was told of it');

  await page.wire.answer('act');
  assert.equal(await sending, 'refused');
  assert.deepEqual(page.said, ["You can't check, there is a bet of 20 to you"]);
  assert.deepEqual(page.view, before);
  assert.equal(page.shown.waiting, null, 'the buttons are back');
});

test('a kind of move the page does not know shows as sent and nothing else, until the table has accounted for it', async (t) => {
  const { server, page } = await quigsToAct(t);
  const before = structuredClone(page.view);
  const told = page.told.length;

  // As the connection tells of any move of the hand it sends, whatever kind is added to those it knows
  const unknown = { type: 'chopBlinds' } as unknown as Command;
  page.shown.moveIs('sent', unknown);

  assert.equal(page.shown.waiting, 'sent', 'the buttons that made it are gone');
  assert.deepEqual(page.view, before, 'and the table is as the server last told it');
  assert.deepEqual([page.told.length, page.moved.length, page.heard.length, page.flash.ends.length], [told, 0, 0, 0], 'nothing was told, moved, heard or ended for it');

  // No view ends it: the page cannot tell which view has it in
  server.act('Pam', { type: 'chat', text: 'well?' });
  await page.wire.answer('poll');
  assert.equal(page.shown.waiting, 'sent');
  assert.deepEqual(page.view, structuredClone(server.view('Quigs')), 'a view shows as it is');

  // However long it waits, it is marked as nothing: there is nothing of it on the table to mark
  page.device += UNCONFIRMED_AFTER_MS;
  page.shown.moveIs('unanswered');
  assert.equal(page.shown.waiting, 'sent');

  page.shown.moveIs('open');
  assert.equal(page.shown.waiting, null, 'the table has answered, and whatever buttons the view offers are back');
  assert.deepEqual(page.said, [], 'nothing is said of a move the page never showed as played');
  assert.deepEqual(page.view, structuredClone(server.view('Quigs')));
});

test('an offer to chop and its answer are moves the page shows only as sent: the buttons go, and the table is as the server last told it', () => {
  // Folded round to the blinds: seat 1 has the small blind and the Chop button, then seat 2 the question
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], config: { allowChop: true } });
  t.deal({ button: 0 });
  t.fold(3);
  t.fold(0);

  const asked = (seat: number, move: Command): void => {
    const view = t.view(seat);
    const pending = new PendingMove();

    assert.ok(MOVES.has(move.type), `${move.type} is not a move: a lost one would be sent again`);
    assert.equal(pending.begin(move, view, 0), false, `${move.type} shows as played`);
    assert.equal(pending.out, 'sent');
    assert.equal(pending.shown(view), view, `${move.type} changed the table shown`);
  };

  assert.ok(t.view(1).hand!.canOfferChop);
  asked(1, { type: 'offerChop', turn: t.state.turn });

  t.cmd(1, { type: 'offerChop' });
  assert.ok(t.view(2).hand!.canAnswerChop);
  asked(2, { type: 'answerChop', agree: true, turn: t.state.turn });
  asked(2, { type: 'answerChop', agree: false, turn: t.state.turn });
});

test('a table that went back under a move keeps the move on it while the same decision is open', async (t) => {
  const { server, page } = await quigsToAct(t);
  const saved = server.saved();

  server.act('Pam', { type: 'chat', text: 'said and then undone' });
  await page.wire.answer('poll');

  const sending = page.move('call');
  server.restore(saved);
  await page.wire.answer('poll');

  assert.equal(page.told.at(-1)!.wentBack, true);
  assert.equal(page.table, CALLED);

  await page.wire.answer('act');
  await sending;
  assert.equal(page.table, CALLED);
  assert.deepEqual(page.wire.moves, ['call']);
});

test('a move that comes off after the table went back under it does not announce the turn again', async (t) => {
  const { server, page } = await quigsToAct(t);
  const saved = server.saved();

  server.act('Pam', { type: 'chat', text: 'said and then undone' });
  await page.wire.answer('poll');
  const calls = page.flash.calls.length;

  const sending = page.move('call');
  server.restore(saved);
  await page.wire.answer('poll');
  assert.equal(page.told.at(-1)!.wentBack, true);

  await page.wire.answer('act', BUSY);
  assert.equal(await sending, 'refused');
  assert.equal(page.flash.calls.length, calls);
});

test('a turn first shown by a late view, and so never announced, is not announced once the player has moved on it', async (t) => {
  const server = new Server(THREE);
  const page = await pageOf(t, server, 'Stu');

  server.deal({ button: 0 });
  server.act('Quigs', { type: 'call' });
  page.late = 11_000;
  await page.wire.answer('poll');
  page.late = 0;
  assert.equal(page.view.hand!.toAct, page.view.you.seat);
  assert.equal(page.flash.calls.length, 0);

  const sending = page.move('call');
  await page.wire.answer('act', BUSY);
  assert.equal(await sending, 'refused');
  assert.equal(page.flash.calls.length, 0, 'the refusal announced the turn');

  // A view that is on time and still shows the turn would announce one the player had not seen
  server.act('Pam', { type: 'chat', text: 'take your time' });
  await page.wire.answer('poll');
  assert.equal(page.flash.calls.length, 0, 'the next view announced the turn');
});

test('a page told it is out of date takes its move off the table, and sends nothing more', async (t) => {
  const { server, page } = await quigsToAct(t);
  const before = structuredClone(page.view);

  server.deploy();
  void page.move('call');
  assert.equal(page.table, CALLED);

  await page.wire.answer('act');
  assert.equal(page.outdated, 1);
  assert.deepEqual(page.view, before, 'what stays behind the notice is the server’s last word');
  assert.equal(page.connection.turnLocked, true, 'and no button is free to play on it');
  assert.deepEqual(page.said, []);
});

/** Each way a move's request can go wrong that a page has to live with, and what the line shows was sent by the end of it. */
const FAILURES: { name: string; fail(page: Page, server: Server): Promise<void>; played: boolean }[] = [
  { name: 'a slow answer', played: true, fail: async (page) => page.wire.hear('act') },
  {
    name: 'an answer lost on the way back',
    played: true,
    fail: async (page) => {
      page.wire.hear('act');
      await page.wire.lose('act');
      await page.wire.answer('poll');
    },
  },
  {
    name: 'a request lost on the way there',
    played: false,
    fail: async (page) => {
      await page.wire.lose('act');
      await page.wire.answer('poll');
    },
  },
  { name: 'a refusal', played: false, fail: (page) => page.wire.answer('act', BUSY) },
  {
    name: 'an answer overtaken by a poll',
    played: true,
    fail: async (page, server) => {
      page.wire.hear('act');
      server.act('Stu', { type: 'call' });
      await page.wire.answer('poll');
      await page.wire.answer('act');
    },
  },
  {
    name: 'a server updated under the page',
    played: false,
    fail: async (page, server) => {
      server.deploy();
      await page.wire.answer('act');
    },
  },
];

for (const failure of FAILURES) {
  test(`nothing sends a move twice: ${failure.name}`, async (t) => {
    const { server, page } = await quigsToAct(t);

    void page.move('call');
    // Taps and keys go on while the move is on its way, as an impatient player's do
    void page.move('call');
    void page.move('fold');

    await failure.fail(page, server);

    assert.deepEqual(page.wire.moves, ['call'], 'one move was made, and one was sent');
    assert.equal(server.view('Quigs').seats[0]!.bet, failure.played ? 20 : 0, 'the server played it once, or not at all');
  });
}

test('a pick that ends the picking tells no badge: the hand it runs out comes from the server, and its badges once, in the view that clears it', async (t) => {
  const server = new Server(
    [
      { name: 'Quigs', stack: 1000 },
      { name: 'Stu', stack: 1000 },
    ],
    { maxRuns: 3 },
  );
  server.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: '2c 7d 9h Jc 3s', secondBoard: '4d 8s Ts Qh 5c', thirdBoard: '6c 2h 3d 9s Th' });
  server.act('Quigs', { type: 'call' });
  server.act('Stu', { type: 'raise', to: 1000 });
  server.act('Quigs', { type: 'call' });
  server.act('Stu', { type: 'ritVote', runs: 3 });

  const page = await pageOf(t, server, 'Quigs');
  page.moving = true;
  const before = page.told.length;
  const told = () => page.told.slice(before).flatMap((change) => change.earned);

  // Shown as sent and nothing more: the picking is still open on the page, and nothing is told
  const sending = page.tap({ type: 'ritVote', runs: 3 });
  assert.equal(page.view.hand!.stage, 'ritVote');
  assert.deepEqual(told(), []);
  await page.wire.answer('act');
  await sending;

  for (let steps = 0; server.view('Quigs').hand; steps++) {
    assert.deepEqual(told(), [], 'a badge was told before the hand was cleared');
    assert.ok(steps < 20, 'the hand was never cleared');

    server.now = server.view('Quigs').hand!.deadline!;
    await page.wire.answer('poll');
    await page.land();
  }

  assert.deepEqual(told(), [{ id: 'bigPot', times: 1 }, { id: 'felted', times: 1 }, { id: 'scoop', times: 1 }]);
});

// ---- A move chosen ahead of a turn ----

/** Three-handed with the button on Quigs, who is on the clock before the flop, and the page of one of the blinds open on it. */
async function waitingFor(t: TestContext, name: 'Stu' | 'Pam', config: Partial<TableConfig> = {}): Promise<{ server: Server; page: Page }> {
  const server = new Server(THREE, config);
  server.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: '2c 7d 9h Jc 3s' });

  const page = await pageOf(t, server, name);
  assert.notEqual(page.view.hand!.ahead, null, 'the page offers a choice ahead');

  return { server, page };
}

const TOO_LATE_FOLD = 'That came too late: your fold was already made.';

/** The player has made no move in the hand, as far as the server knows. */
const untouched = (server: Server, name: string, seat: number) => ['small blind', 'big blind'].includes(server.view(name).seats[seat]!.lastAction ?? '');

test('a move chosen ahead shows as chosen at the tap, a poll from before the table heard of it leaves it showing, and the answer changes nothing', async (t) => {
  const { server, page } = await waitingFor(t, 'Pam');
  const told = page.told.length;

  const sending = page.choose('checkFold');
  assert.deepEqual(page.view.preAction, ['checkFold'], 'before anything came back from the server');
  assert.deepEqual(page.wire.sent.at(-1), { op: 'act', ...server.session('Pam'), build: BUILD, command: { type: 'preAct', what: 'checkFold', hand: 1, street: 'preflop', facing: 20 } });
  assert.equal(page.told.length, told, 'nothing happened in the hand, so the effects hear nothing');

  // Someone says something, and the poll that brings it was answered before the table heard of the choice
  server.act('Stu', { type: 'chat', text: 'hi' });
  await page.wire.answer('poll');
  assert.equal(page.shown.heard!.preAction, null, 'the table has not heard of it');
  assert.deepEqual(page.view.preAction, ['checkFold'], 'and the page shows it all the same');

  await page.wire.answer('act');
  assert.equal(await sending, 'taken');
  assert.deepEqual(page.view.preAction, ['checkFold']);
  assert.deepEqual(page.shown.heard!.preAction, ['checkFold']);
  assert.deepEqual(page.said, []);
  assert.deepEqual(page.heard, []);
  assert.equal(page.connection.turnLocked, false, 'a choice ahead never holds the buttons of a turn');
});

test('the move chosen ahead is made for the player with no turn announced, and they hear it as they hear anyone\'s', async (t) => {
  const { server, page } = await waitingFor(t, 'Stu');

  const sending = page.choose('call');
  await page.wire.answer('act');
  await sending;
  assert.deepEqual(page.view.preAction, ['call', 10]);

  server.act('Quigs', { type: 'call' });
  await page.wire.answer('poll');

  assert.equal(page.table, 'call, 20 in front, 980 behind, pot 60, waiting for Pam');
  assert.equal(page.view.preAction, null);
  assert.equal(page.view.hand!.ahead, null);
  assert.deepEqual(page.events(-1), [['call', 0, 20, 980], ['call', 1, 10, 980]]);
  assert.equal(page.flash.calls.length, 0, 'it was never their turn');
  assert.deepEqual(page.heard, ['chips'], 'one sound for the two calls, the last of which was their own');
  assert.equal(aheadLines(page.told.at(-1)!).spoken, null, 'a move that was made did not come off');

  // Another player hears the same two calls, and sees the action where it now is
  const pam = await pageOf(t, server, 'Pam');
  assert.equal(pam.view.hand!.options !== null, true);
});

test('a raise takes a call chosen ahead off just before the turn: the turn is announced, its buttons are there and nothing shows as chosen', async (t) => {
  const { server, page } = await waitingFor(t, 'Stu');

  const sending = page.choose('call');
  await page.wire.answer('act');
  await sending;

  server.act('Quigs', { type: 'raise', to: 60 });
  await page.wire.answer('poll');

  assert.equal(page.table, 'small blind, 10 in front, 990 behind, pot 90, my turn');
  assert.equal(page.view.preAction, null);
  assert.equal(page.flash.calls.length, 1);
  assert.equal(aheadLines(page.told.at(-1)!).spoken, 'Call 10 is no longer set for your turn.');
  assert.deepEqual(page.said, []);
});

test('a choice still on its way when the action arrives is refused: the player is asked, and the page shows their turn with nothing chosen', async (t) => {
  const { server, page } = await waitingFor(t, 'Stu');

  // Held on the way: the table has not heard it when Quigs calls
  const sending = page.choose('fold');
  assert.deepEqual(page.view.preAction, ['fold']);

  server.act('Quigs', { type: 'call' });
  await page.wire.answer('poll');
  assert.equal(page.table, 'small blind, 10 in front, 990 behind, pot 50, my turn');
  assert.equal(page.view.preAction, null, 'on their turn nothing shows as chosen, whatever is still on its way');
  assert.equal(page.flash.calls.length, 1);

  await page.wire.answer('act');
  assert.equal(await sending, 'refused');
  assert.deepEqual(page.said, [TOO_LATE_TO_SET]);
  assert.equal(page.table, 'small blind, 10 in front, 990 behind, pot 50, my turn');
  assert.ok(untouched(server, 'Stu', 1), 'the table made no move for them');
  assert.deepEqual(page.choices, ['fold'], 'and it was not sent again');
});

test('a choice that gets no answer is looked up and never sent again: it shows until the table has been heard from, and then the table\'s word shows', async (t) => {
  // Lost on the way there: the table never heard it
  const lost = await waitingFor(t, 'Stu');
  const sending = lost.page.choose('fold');

  await lost.page.wire.lose('act');
  assert.deepEqual(lost.page.said, ['No answer from the table. Checking whether that went through…']);
  assert.deepEqual(lost.page.view.preAction, ['fold'], 'nobody knows yet, and the page goes on showing what the player chose');

  await lost.page.wire.answer('poll');
  assert.equal(await sending, 'unanswered');
  assert.equal(lost.page.view.preAction, null, 'the table has no such choice');
  assert.deepEqual(lost.page.choices, ['fold']);

  // The player sees that, and chooses again
  const again = lost.page.choose('fold');
  await lost.page.wire.answer('act');
  assert.equal(await again, 'taken');
  assert.deepEqual(lost.page.view.preAction, ['fold']);

  // Lost on the way back: the table set it
  const kept = await waitingFor(t, 'Stu');
  const unanswered = kept.page.choose('callAny');

  kept.page.wire.hear('act');
  await kept.page.wire.lose('act');
  await kept.page.wire.answer('poll');
  assert.equal(await unanswered, 'unanswered');
  assert.deepEqual(kept.page.view.preAction, ['callAny']);
  assert.deepEqual(kept.page.choices, ['callAny']);
});

test('a choice the table could not take up leaves nothing chosen on the page, with the table\'s reason', async (t) => {
  const { server, page } = await waitingFor(t, 'Stu');

  const sending = page.choose('callAny');
  await page.wire.answer('act', BUSY);

  assert.equal(await sending, 'refused');
  assert.equal(page.view.preAction, null);
  assert.deepEqual(page.said, ['The table is busy, try again']);
  assert.deepEqual(page.choices, ['callAny']);

  server.act('Quigs', { type: 'call' });
  await page.wire.answer('poll');
  assert.equal(page.table, 'small blind, 10 in front, 990 behind, pot 50, my turn');
});

test('the latest choice is the one that counts: made while another is on its way, it shows at once, goes after it, and takes the place of any that was waiting', async (t) => {
  const { page } = await waitingFor(t, 'Stu');

  const first = page.choose('fold');
  void page.choose('call');
  const last = page.choose('callAny');
  assert.deepEqual(page.view.preAction, ['callAny']);
  assert.deepEqual(page.choices, ['fold'], 'one is out at a time');

  // The answer to the first says Fold is set, which is not what the player last chose
  await page.wire.answer('act');
  assert.deepEqual(page.shown.heard!.preAction, ['fold']);
  assert.deepEqual(page.view.preAction, ['callAny']);
  assert.deepEqual(page.choices, ['fold', 'callAny'], 'the call that was waiting was never sent');

  await page.wire.answer('act');
  assert.deepEqual([await first, await last], ['taken', 'taken']);
  assert.deepEqual(page.shown.heard!.preAction, ['callAny']);
  assert.deepEqual(page.view.preAction, ['callAny']);
  assert.deepEqual(page.said, []);
});

test('taking a choice back shows at once, and one that reaches the table after the move was made is answered with the table as it is, and a line saying so', async (t) => {
  const taken = await waitingFor(t, 'Stu');
  await Promise.all([taken.page.choose('fold'), taken.page.wire.answer('act')]);

  const back = taken.page.choose(null);
  assert.equal(taken.page.view.preAction, null, 'before anything came back from the server');
  await taken.page.wire.answer('act');
  assert.equal(await back, 'taken');
  assert.equal(taken.page.view.preAction, null);
  assert.deepEqual(taken.page.said, []);

  // Here the take-back is still on its way when Quigs calls, and the table folds for Stu as he had chosen
  const { server, page } = await waitingFor(t, 'Stu');
  await Promise.all([page.choose('fold'), page.wire.answer('act')]);

  const late = page.choose(null);
  assert.equal(page.view.preAction, null);

  server.act('Quigs', { type: 'call' });
  await page.wire.answer('poll');
  assert.equal(page.view.seats[1]!.folded, true);
  assert.deepEqual(page.said, [TOO_LATE_FOLD]);
  assert.deepEqual(page.heard, ['chips', 'fold'], 'a fold they did not tap is heard');

  await page.wire.answer('act');
  assert.equal(await late, 'taken', 'no refusal: the table answers with what happened');
  assert.deepEqual(page.said.length, 1);
  assert.equal(page.view.seats[1]!.folded, true);
});

test('a choice taken back before its own answer came, and made by the table all the same, is told and heard: the news of it overtook the answer that would have shown it set', async (t) => {
  const { server, page } = await waitingFor(t, 'Stu');

  // The fold is out and the take-back waits behind it. The table hears the fold, and Quigs calls before its answer is back
  const first = page.choose('fold');
  const back = page.choose(null);
  assert.equal(page.view.preAction, null);

  page.wire.hear('act');
  server.act('Quigs', { type: 'call' });
  await page.wire.answer('poll');

  assert.equal(page.view.seats[1]!.folded, true);
  assert.deepEqual(page.said, [TOO_LATE_FOLD], 'the page never saw the fold set, and still says what became of it');
  assert.deepEqual(page.heard, ['chips', 'fold']);
  assert.equal(page.flash.calls.length, 0, 'it was never their turn');

  await page.wire.answer('act');
  await page.wire.answer('act');
  assert.deepEqual([await first, await back], ['taken', 'taken']);
  assert.deepEqual(page.said, [TOO_LATE_FOLD]);
});

test('a choice changed too late is told as one taken back too late is: the screen showed Call any, and the fold it replaced was made', async (t) => {
  const { server, page } = await waitingFor(t, 'Stu');
  await Promise.all([page.choose('fold'), page.wire.answer('act')]);

  const change = page.choose('callAny');
  assert.deepEqual(page.view.preAction, ['callAny']);

  server.act('Quigs', { type: 'call' });
  await page.wire.answer('poll');
  assert.equal(page.view.seats[1]!.folded, true);
  assert.deepEqual(page.said, [TOO_LATE_FOLD]);
  assert.deepEqual(page.heard, ['chips', 'fold']);

  // The change gets there after the fold, and the table's refusal says the same thing its own way
  await page.wire.answer('act');
  assert.equal(await change, 'refused');
  assert.deepEqual(page.said, [TOO_LATE_FOLD, TOO_LATE_TO_SET]);
});

test('a fold made where the screen showed Check/Fold is told only when checking was free: a fold to a bet is what the screen said', async (t) => {
  const asShown = await waitingFor(t, 'Pam');
  await Promise.all([asShown.page.choose('checkFold'), asShown.page.wire.answer('act')]);

  asShown.server.act('Quigs', { type: 'raise', to: 60 });
  asShown.server.act('Stu', { type: 'call' });
  await asShown.page.wire.answer('poll');
  assert.equal(asShown.page.view.seats[2]!.folded, true);
  assert.deepEqual(asShown.page.said, []);

  // Here Fold is set and the change to Check/Fold is still on its way when the action comes around unraised
  const { server, page } = await waitingFor(t, 'Pam');
  await Promise.all([page.choose('fold'), page.wire.answer('act')]);

  const change = page.choose('checkFold');
  assert.deepEqual(page.view.preAction, ['checkFold']);

  server.act('Quigs', { type: 'call' });
  server.act('Stu', { type: 'call' });
  await page.wire.answer('poll');
  assert.equal(page.view.seats[2]!.folded, true, 'the fold that was set, with a check free');
  assert.deepEqual(page.said, [TOO_LATE_FOLD]);

  await page.wire.answer('act');
  assert.equal(await change, 'refused');
});

test('a call made at another price than the screen showed is told: Call any was set, and the change to a call of 10 was still on its way when a raise came', async (t) => {
  const asShown = await waitingFor(t, 'Stu');
  await Promise.all([asShown.page.choose('callAny'), asShown.page.wire.answer('act')]);

  asShown.server.act('Quigs', { type: 'raise', to: 60 });
  await asShown.page.wire.answer('poll');
  assert.deepEqual(asShown.page.events(-1).at(-1), ['call', 1, 50, 940]);
  assert.deepEqual(asShown.page.said, []);

  const { server, page } = await waitingFor(t, 'Stu');
  await Promise.all([page.choose('callAny'), page.wire.answer('act')]);

  const change = page.choose('call');
  assert.deepEqual(page.view.preAction, ['call', 10]);

  server.act('Quigs', { type: 'raise', to: 60 });
  await page.wire.answer('poll');
  assert.deepEqual(page.events(-1).at(-1), ['call', 1, 50, 940]);
  assert.deepEqual(page.said, ['That came too late: your call was already made.']);

  await page.wire.answer('act');
  assert.equal(await change, 'refused');
});

test('a player whose choice came off with their seat is not told anything came too late when the hand folds them: the fold is that of a player who left, and they changed nothing', async (t) => {
  for (const leaves of ['is removed by the host', 'stands up on another device'] as const) {
    const { server, page } = await waitingFor(t, 'Stu');
    await Promise.all([page.choose('callAny'), page.wire.answer('act')]);
    assert.deepEqual(page.view.preAction, ['callAny']);

    // Both between two of the page's updates: the seat is given up, and the next bet reaches a player the hand does not wait for
    if (leaves === 'is removed by the host') {
      server.act('Quigs', { type: 'kick', playerId: server.session('Stu').auth.id });
    } else {
      server.act('Stu', { type: 'standUp' });
    }

    server.act('Quigs', { type: 'raise', to: 60 });
    await page.wire.answer('poll');

    assert.deepEqual(page.events(-1).filter((event) => event[1] === 1).at(-1), ['fold', 1, true], leaves);
    assert.equal(page.view.preAction, null, leaves);
    assert.deepEqual(page.said, [], `a player who ${leaves}`);

    // Their own fold is heard, since no tap of theirs made it
    assert.deepEqual(page.heard, ['chips', 'fold'], leaves);
  }
});

test('a choice the table has that the screen did not show is told in a sentence: one made on another device, never one tapped here', async (t) => {
  const { server, page } = await waitingFor(t, 'Stu');
  const hand = page.view.hand!;

  await Promise.all([page.choose('call'), page.wire.answer('act')]);
  assert.deepEqual(page.said, [], 'a choice tapped on this page is not told to it');

  server.act('Stu', { type: 'preAct', what: 'fold', hand: hand.number, street: hand.street, facing: hand.currentBet });
  await page.wire.answer('poll');
  assert.deepEqual(page.view.preAction, ['fold']);
  assert.deepEqual(page.said, ['Fold is set for your turn.']);

  server.act('Stu', { type: 'preAct', what: 'call', hand: hand.number, street: hand.street, facing: hand.currentBet });
  await page.wire.answer('poll');
  assert.deepEqual(page.said, ['Fold is set for your turn.', 'Call 10 is set for your turn.']);
});

test('a choice taken back stays off the screen while the take-back is on its way, whatever news of the table comes first: a raise does not bring it back, and nothing is said', async (t) => {
  const { server, page } = await waitingFor(t, 'Pam');
  await Promise.all([page.choose('fold'), page.wire.answer('act')]);

  const back = page.choose(null);
  server.act('Quigs', { type: 'raise', to: 60 });
  await page.wire.answer('poll');

  assert.deepEqual(server.view('Pam').preAction, ['fold'], 'the table has not heard of the take-back yet');
  assert.equal(page.view.preAction, null);
  assert.deepEqual(page.said, []);

  await page.wire.answer('act');
  assert.equal(await back, 'taken');
  assert.equal(page.view.preAction, null);

  server.act('Stu', { type: 'call' });
  await page.wire.answer('poll');
  assert.equal(page.view.hand!.options !== null, true, 'she is asked');
  assert.deepEqual(page.said, []);
});

test('a change of choice that arrives after a raise takes the old one off: the page never goes back to showing a choice the player had replaced', async (t) => {
  const { server, page } = await waitingFor(t, 'Pam');
  await Promise.all([page.choose('checkFold'), page.wire.answer('act')]);

  // Pam changes her mind as Quigs raises: her new choice was made for the bet as it was
  const sending = page.choose('callAny');
  server.act('Quigs', { type: 'raise', to: 60 });
  page.wire.hear('act');
  await page.wire.answer('act');

  assert.equal(await sending, 'taken');
  assert.equal(page.view.preAction, null, 'neither the old choice nor the new one');

  server.act('Stu', { type: 'fold' });
  await page.wire.answer('poll');
  assert.equal(page.view.hand!.options !== null, true, 'she is asked');
  assert.ok(untouched(server, 'Pam', 2));
});

test('each choice says what it does for what the player faces, and all five have a place in one order', () => {
  const free = { canCheck: true, callAmount: 0, callCost: 0 };
  const bet = { canCheck: false, callAmount: 40, callCost: 40 };

  assert.deepEqual(AHEAD_ORDER, ['fold', 'checkFold', 'check', 'call', 'callAny']);

  // The ones not on offer are drawn too, dimmed: a call names no amount while there is nothing to call
  assert.deepEqual(AHEAD_ORDER.map((what) => aheadLabel(what, free, 1000)), [
    { move: 'Fold', amount: null },
    { move: 'Check/Fold', amount: null },
    { move: 'Check', amount: null },
    { move: 'Call', amount: null },
    { move: 'Check/Call any', amount: null },
  ]);
  assert.deepEqual(AHEAD_ORDER.map((what) => aheadLabel(what, bet, 1000)), [
    { move: 'Fold', amount: null },
    { move: 'Check/Fold', amount: null },
    { move: 'Check', amount: null },
    { move: 'Call', amount: 40 },
    { move: 'Call any', amount: null },
  ]);
  // A call that takes the whole stack says so, and names what it ends up costing
  assert.deepEqual(aheadLabel('call', { canCheck: false, callAmount: 25, callCost: 20 }, 25), { move: 'Call all in', amount: 20 });
});

test('until the table has answered, a choice shows on views of the spot it was made in and nothing shows as set on any other; the view offers none to a player with no turn to come', async (t) => {
  const { server, page } = await waitingFor(t, 'Stu');
  const view = structuredClone(page.view);
  const pending = new PendingChoice();

  pending.begin(choiceOn(view, 'fold')!);
  assert.deepEqual(pending.shown(view).preAction, ['fold']);
  assert.deepEqual(pending.shown({ ...view, hand: { ...view.hand!, currentBet: 60 } }).preAction, null, 'the bet changed');
  assert.deepEqual(pending.shown({ ...view, hand: { ...view.hand!, street: 'flop' } }).preAction, null, 'the street moved on');
  assert.deepEqual(pending.shown({ ...view, hand: { ...view.hand!, number: 2 } }).preAction, null, 'another hand');
  assert.deepEqual(pending.shown({ ...view, hand: { ...view.hand!, ahead: null } }).preAction, null, 'the action reached them');

  // Out of its spot the table sets nothing, and takes off the choice it was to replace: nothing shows as set meanwhile
  assert.equal(pending.shown({ ...view, preAction: ['checkFold'], hand: { ...view.hand!, currentBet: 60 } }).preAction, null);

  // Taking back shows on a view that has the choice set, in its spot or out of it
  pending.begin(choiceOn(view, null)!);
  assert.equal(pending.shown({ ...view, preAction: ['fold'] }).preAction, null);
  assert.equal(pending.shown({ ...view, preAction: ['fold'], hand: { ...view.hand!, currentBet: 60 } }).preAction, null);
  assert.equal(pending.settle(), true);
  assert.deepEqual(pending.shown({ ...view, preAction: ['fold'] }).preAction, ['fold']);

  // On their own turn, and once they are out of the hand, there is nothing to choose
  server.act('Quigs', { type: 'call' });
  await page.wire.answer('poll');
  assert.equal(choiceOn(page.view, 'fold'), null);
});
