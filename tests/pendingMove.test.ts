import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { Attention } from '../src/client/attention.ts';
import type { AttentionWay, AttentionWays, Call } from '../src/client/attention.ts';
import { celebrationMoves } from '../src/client/celebrations.ts';
import { MOVES, ServerClock, ServerLine, TableConnection } from '../src/client/connection.ts';
import type { SendOutcome } from '../src/client/connection.ts';
import { betSlide, followHand } from '../src/client/handMoves.ts';
import { soundsHeard } from '../src/client/handSounds.ts';
import type { Move } from '../src/client/motion.ts';
import { PendingMove, UNCONFIRMED_AFTER_MS } from '../src/client/pendingMove.ts';
import { isTurnMove } from '../src/client/prediction.ts';
import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import type { Ability } from '../src/client/prefs.ts';
import { ShownTable } from '../src/client/shownTable.ts';
import { Sounds } from '../src/client/sound.ts';
import type { SoundName } from '../src/client/sound.ts';
import type { TableChange } from '../src/client/tableChange.ts';
import type { Transport } from '../src/client/transport.ts';
import { YourTurn } from '../src/client/yourTurn.ts';
import { boardsDealt } from '../src/engine/index.ts';
import type { Command, HandEvent, TableConfig, TableState, TableView } from '../src/engine/index.ts';
import type { ApiRequest, ApiResponse, Auth, Built } from '../src/server/api.ts';
import { BuildGate } from '../src/server/build.ts';
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
    this.game = new PokerService({ store: this.store, presets: new MemoryPresetStore(), clock: { now: () => this.now }, rng: seededRng(7) });
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
    this.store.transact(this.tableId, () => ({ save: structuredClone(saved), effects: [], result: null }));
  }

  /** The game is updated under the pages that are open. */
  deploy(): void {
    this.gate = new BuildGate(this.game, NEWER_BUILD);
  }

  private alter(change: (state: TableState) => void): void {
    this.store.transact(this.tableId, (state) => {
      change(state!);
      state!.version += 1;

      return { save: state!, effects: [], result: null };
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
  private landed: () => void = () => undefined;
  private soundClock = 0;

  constructor(server: Server, name: string) {
    const prefs = new Preferences(PREFERENCES, mapMemory());
    const clock = new ServerClock();
    const ways = Object.fromEntries((['sound', 'buzz', 'notify', 'tabTitle'] as Key[]).map((key) => [key, new RecordingWay()])) as Record<Key, RecordingWay>;
    const motion = {
      play: (moves: readonly Move[]) => void this.moved.push(...moves),
      cancel: () => undefined,
      idle: () => new Promise<void>((resolve) => (this.landed = resolve)),
      seen: () => this.moving,
    };
    // Each sound asked for a long while after the last, so none is dropped for coming in a burst
    const sounds = new Sounds({ play: (sound) => void this.heard.push(sound) }, prefs, { now: () => (this.soundClock += 60_000), inView: () => true });
    const turns = new YourTurn(new Attention(prefs, { ...ways, flash: this.flash }));

    this.wire = new Wire(server);
    this.shown = new ShownTable(motion, () => clock.now() + this.late, () => this.device, {
      draw: () => undefined,
      tell: (change) => {
        const seat = change.view.you.seat;

        this.told.push(change);
        soundsHeard(change.events, seat, boardsDealt(change.view.hand?.bombPot ?? null)).forEach((sound) => sounds.play(sound));
        followHand(change, seat, motion);
        motion.play(celebrationMoves(change, seat));
        turns.see(change);
      },
      say: (message) => void this.said.push(message),
    });
    this.connection = new TableConnection(new ServerLine(this.wire, BUILD, () => this.outOfDate()), server.session(name), clock, {
      view: (view, wentBack) => this.shown.take(view, wentBack),
      move: (lock, sent) => this.shown.moveIs(lock, sent),
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

  /** Everything that was moving has landed. */
  async land(): Promise<void> {
    this.landed();
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
    { allowRunItTwice: false },
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
    { allowRunItTwice: false },
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
