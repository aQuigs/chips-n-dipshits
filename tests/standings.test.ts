/*
 * The players' records as the service hands them out: who is in them, what an answer gives away, and
 * that reading them never fails for what could not be written.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ledgerOf, LIMITS, resultsOf, TIMING } from '../src/engine/index.ts';
import type { Command } from '../src/engine/index.ts';
import { SheetPlayerStore } from '../src/gas/sheetPlayerStore.ts';
import { RESULTS_TAB, SheetResultStore } from '../src/gas/sheetResultStore.ts';
import { SheetStore } from '../src/gas/sheetStore.ts';
import { SETTLE_AFTER_MS } from '../src/server/api.ts';
import type { ApiResponse, PlayerStanding, Who } from '../src/server/api.ts';
import { BuildGate } from '../src/server/build.ts';
import { MemoryErrorLog } from '../src/server/memoryErrorLog.ts';
import { MemoryPlayerStore } from '../src/server/memoryPlayerStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryResultStore } from '../src/server/memoryResultStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import type { PlayerStore } from '../src/server/playerStore.ts';
import { PUT_AWAY_AFTER_MS } from '../src/server/putAway.ts';
import type { ResultStore } from '../src/server/resultStore.ts';
import { PokerService } from '../src/server/service.ts';
import { restoreState } from '../src/server/store.ts';
import type { TableStore } from '../src/server/store.ts';
import { Calls, FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import { failure, joined, seededRng, viewOf } from './helpers.ts';
import { RESULTS_TEXT_LIMIT } from './resultHelpers.ts';

const NOW = Date.UTC(2026, 10, 14, 20);
const NEW: Who = { as: 'new' };
const as = (id: string): Who => ({ as: 'known', id });

type Standings = Extract<ApiResponse, { kind: 'standings' }>;

/** The players of an answer by name: the order they come in is the page's to choose. */
const byName = (players: PlayerStanding[]): PlayerStanding[] => [...players].sort((a, b) => (a.name < b.name ? -1 : 1));

interface Stores {
  store: TableStore;
  players: PlayerStore;
  results: ResultStore;
}

/** The game over the stores given, or over ones in memory, with what a test does to it. */
function setup(make: (clock: { now(): number }, errors: MemoryErrorLog) => Stores = inMemory) {
  const clock = { time: NOW, now: () => clock.time };
  const errors = new MemoryErrorLog(clock);
  const stores = make(clock, errors);
  const service = new PokerService({ ...stores, presets: new MemoryPresetStore(), clock, rng: seededRng(21), errors });

  const standings = (): Standings => {
    const response = service.handle({ op: 'standings' });
    assert.ok(response.ok && response.kind === 'standings', JSON.stringify(response));

    return response;
  };

  const nights = (playerId: unknown, unit: unknown = 'chips') => service.handle({ op: 'nights', playerId, unit });

  /** A table of the players named, each seated with 1,000: someone new to the list, someone on it, or (null) nobody it knows. */
  const table = (who: Record<string, Who | null>, config: object = {}) => {
    const [[hostName, hostWho], ...others] = Object.entries(who) as [[string, Who | null], ...[string, Who | null][]];
    const host = joined(service.handle({ op: 'create', name: hostName, who: hostWho ?? undefined, config: { minBuyIn: 100, ...config } }));
    const tableId = host.view.id;
    const members = [host, ...others.map(([name, said]) => joined(service.handle({ op: 'join', tableId, name, who: said ?? undefined })))];
    const act = (member: number, command: Command) => viewOf(service.handle({ op: 'act', tableId, auth: members[member]!.auth, command }));

    members.forEach((member, seat) => {
      act(seat, { type: 'requestSeat', seat, buyIn: 1000 });

      if (seat > 0) {
        act(0, { type: 'approve', playerId: member.auth.id });
      }
    });

    const poll = () => viewOf(service.handle({ op: 'poll', tableId, auth: host.auth, since: -1 }));

    /** A hand everyone folds to the big blind, after which the game is paused. Each member sits at the seat of their place in the list. */
    const hand = () => {
      act(0, { type: 'start' });
      clock.time += TIMING.startDelayMs;

      let view = poll();
      while (view.hand!.stage === 'betting') {
        view = act(view.hand!.toAct!, { type: 'fold' });
      }

      act(0, { type: 'pause' });
      clock.time = view.hand!.deadline!;
      assert.equal(poll().hand, null);
    };

    return { tableId, members, act, hand, identities: members.map((member) => member.view.you.identity) };
  };

  return { ...stores, service, clock, errors, standings, nights, table };
}

function inMemory(clock: { now(): number }): Stores {
  const results = new MemoryResultStore(clock.now);

  return { store: new MemoryStore(results), players: new MemoryPlayerStore(seededRng(22)), results };
}

/** The game as it is deployed: tables, players and results in the Sheet, behind one cache and the one script lock. */
function deployed() {
  const lock = new FakeLock();
  const calls = new Calls();
  const spreadsheet = new FakeSpreadsheet(lock, { Players: 1 + LIMITS.knownPlayers }, calls, [], { Players: LIMITS.nameLength, [RESULTS_TAB]: RESULTS_TEXT_LIMIT });
  const cache = new FakeCache(calls);
  const flush = () => calls.note('flush');

  const game = setup((clock, errors) => {
    const results = new SheetResultStore({ spreadsheet: () => spreadsheet, cache, lock, flush, clock, errors });

    return {
      results,
      store: new SheetStore({ spreadsheet: () => spreadsheet, cache, lock, flush, errors, results }),
      players: new SheetPlayerStore({ spreadsheet: () => spreadsheet, cache, lock, flush, rng: seededRng(23), errors }),
    };
  });

  return { ...game, lock, calls, spreadsheet, cache };
}

const GAMES: [string, () => ReturnType<typeof setup>][] = [['in memory', setup], ['in the Sheet', deployed]];

for (const [kind, make] of GAMES) {
  test(`${kind}: nobody has a record until a night is on record; then each known player has theirs under the list's name, and a member nobody knows is in none`, () => {
    const game = make();
    assert.deepEqual(game.standings(), { ok: true, kind: 'standings', asOf: NOW, units: [] });

    const friday = game.table({ Ann: NEW, Bob: NEW, Guest: null }, { name: 'Friday' });
    const [ann, bob] = friday.identities as [string, string];
    friday.hand();
    assert.deepEqual(game.standings().units, [], 'a night nobody ended, at a table still being played');

    friday.act(0, { type: 'endNight' });
    const state = game.store.read(friday.tableId)!;
    const net = Object.fromEntries(ledgerOf(state).map((row) => [row.name, row.net]));

    const { units, asOf } = game.standings();
    assert.equal(asOf, game.clock.time);
    assert.deepEqual(units.map((of) => of.unit), ['chips']);
    const players = byName(units[0]!.players);
    assert.deepEqual(
      players.map((player) => [player.id, player.name, player.nights, player.net, player.hands]),
      [[ann, 'Ann', 1, net['Ann'], 1], [bob, 'Bob', 1, net['Bob'], 1]],
    );
    assert.equal(net['Ann']! + net['Bob']! + net['Guest']!, 0, 'what the guest won or lost is in nobody’s record');

    assert.deepEqual(game.nights(ann), { ok: true, kind: 'nights', nights: [{ at: state.createdAt, table: 'Friday', net: net['Ann'], hands: 1, won: players[0]!.won, biggest: players[0]!.biggest, best: null, badges: {}, highHand: false }] });
    assert.deepEqual(game.nights(ann, 'cents'), { ok: true, kind: 'nights', nights: [] });
  });

  test(`${kind}: a guest who says who they are from the table's menu before the night's rows are written is in them, with the whole of their night`, () => {
    const game = make();
    const friday = game.table({ Ann: NEW, Bob: NEW, Cy: null });
    friday.hand();

    const cy = viewOf(game.service.handle({ op: 'identify', tableId: friday.tableId, auth: friday.members[2]!.auth, who: NEW, name: 'Cy' })).you.identity!;
    friday.act(0, { type: 'endNight' });

    const players = game.standings().units[0]!.players;
    assert.deepEqual(players.map((player) => player.name).sort(), ['Ann', 'Bob', 'Cy']);
    assert.equal(players.reduce((sum, player) => sum + player.net, 0), 0, 'with everyone known, a table comes to nothing');
    assert.equal(players.find((player) => player.id === cy)!.hands, 1);
  });

  test(`${kind}: a night nobody ended is on record once the table has been left alone for three hours and someone asks, and stays when the table is put away`, () => {
    const game = make();
    const friday = game.table({ Ann: NEW, Bob: NEW });
    friday.hand();
    friday.hand();

    game.clock.time += SETTLE_AFTER_MS - 1;
    assert.deepEqual(game.standings().units, []);

    game.clock.time += 5 * 60_000;
    const settled = game.standings().units;
    assert.deepEqual(byName(settled[0]!.players).map((player) => [player.name, player.nights, player.hands]), [['Ann', 1, 2], ['Bob', 1, 2]]);

    // Two weeks on, the next table made puts this one away, and its night is still theirs, once
    game.clock.time += PUT_AWAY_AFTER_MS;
    const later = game.table({ Dee: NEW, Eve: NEW });
    assert.equal(failure(game.service.handle({ op: 'info', tableId: friday.tableId })).code, 'not_found');
    assert.deepEqual(game.standings().units, settled);

    later.hand();
    later.act(0, { type: 'endNight' });
    assert.deepEqual(byName(game.standings().units[0]!.players).map((player) => [player.name, player.nights]), [['Ann', 1], ['Bob', 1], ['Dee', 1], ['Eve', 1]]);
  });

  test(`${kind}: the same people at a second table are two nights, and chips are never added to dollars`, () => {
    const game = make();
    const first = game.table({ Ann: NEW, Bob: NEW });
    const [ann, bob] = first.identities as [string, string];
    first.hand();
    first.act(0, { type: 'endNight' });

    game.clock.time += 60 * 60_000;
    const second = game.table({ Ann: as(ann), Bob: as(bob) });
    second.hand();
    second.hand();
    second.act(0, { type: 'endNight' });

    const cash = game.table({ Ann: as(ann), Bob: as(bob) }, { unit: 'cents', smallBlind: 25, bigBlind: 50, minBuyIn: 100, maxBuyIn: 100_000 });
    cash.hand();
    cash.act(0, { type: 'endNight' });

    const { units } = game.standings();
    assert.deepEqual(units.map((of) => [of.unit, byName(of.players).map((player) => [player.name, player.nights, player.hands])]), [
      ['chips', [['Ann', 2, 3], ['Bob', 2, 3]]],
      ['cents', [['Ann', 1, 1], ['Bob', 1, 1]]],
    ]);

    for (const of of units) {
      assert.equal(of.players.reduce((sum, player) => sum + player.net, 0), 0);
    }

    const nights = game.nights(ann);
    assert.ok(nights.ok && nights.kind === 'nights');
    assert.deepEqual(nights.nights.map((night) => night.hands), [2, 1], 'the latest night first');
  });

  test(`${kind}: the check of the deployed game, one known player in two browsers, leaves nothing in anyone's record however often it runs`, () => {
    const game = make();
    const check = joined(game.service.handle({ op: 'create', name: 'Live check', who: NEW })).view.you.identity!;

    for (let run = 0; run < 10; run++) {
      const played = game.table({ 'Live check': as(check), 'Live check 2': as(check) });
      played.hand();
      played.hand();
      game.clock.time += SETTLE_AFTER_MS;
      game.standings();
    }

    game.clock.time += PUT_AWAY_AFTER_MS;
    game.table({ 'Live check': as(check), 'Live check 2': as(check) });

    assert.deepEqual(game.standings().units, []);
    assert.deepEqual(game.nights(check), { ok: true, kind: 'nights', nights: [] });
    assert.deepEqual(game.errors.rows, []);
  });
}

test('in the Sheet, a run of the check leaves no Results tab, and a real night makes it', () => {
  const game = deployed();
  const check = joined(game.service.handle({ op: 'create', name: 'Live check', who: NEW })).view.you.identity!;
  const played = game.table({ 'Live check': as(check), 'Live check 2': as(check) });
  played.hand();
  played.act(0, { type: 'endNight' });
  game.clock.time += SETTLE_AFTER_MS;
  game.standings();
  assert.equal(game.spreadsheet.sheets.has(RESULTS_TAB), false);

  const night = game.table({ Ann: NEW, Bob: NEW });
  night.hand();
  night.act(0, { type: 'endNight' });
  assert.equal(game.spreadsheet.sheets.get(RESULTS_TAB)!.getLastRow(), 3);
});

test('an answer holds what the page shows and no more: no table’s id, no member’s id and no token, and nobody the list of players does not name', () => {
  const game = setup();
  const friday = game.table({ Ann: NEW, Bob: NEW, Guest: null }, { name: 'Friday' });
  const [ann, bob] = friday.identities as [string, string];
  friday.hand();
  friday.act(0, { type: 'endNight' });

  // Someone the list no longer has, as when whoever runs the game deleted their row of the Players tab
  (game.results as MemoryResultStore).write([{ ...resultsOf(game.store.read(friday.tableId)!), tableId: 'OTHER2', players: [{ playerId: 'GONE234', name: 'Gone', net: 5, hands: 1, won: 0, biggest: 0, best: null, badges: {}, highHand: false }, { playerId: ann, name: 'Ann', net: -5, hands: 1, won: 0, biggest: 0, best: null, badges: {}, highHand: false }] }]);

  const answers = JSON.stringify([game.standings(), game.nights(ann), game.nights(bob), game.nights('GONE234')]);
  const secrets = [friday.tableId, 'OTHER2', 'GONE234', 'Gone', ...friday.members.flatMap((member) => [member.auth.id, member.auth.token])];

  for (const secret of secrets) {
    assert.ok(!answers.includes(secret), `an answer holds ${secret}`);
  }

  assert.deepEqual(byName(game.standings().units[0]!.players).map((player) => [player.name, player.nights]), [['Ann', 2], ['Bob', 1]]);
  assert.deepEqual(game.nights('GONE234'), { ok: true, kind: 'nights', nights: [] });
  assert.deepEqual(Object.keys(game.standings().units[0]!.players[0]!).sort(), ['badges', 'best', 'biggest', 'hands', 'highHands', 'id', 'name', 'net', 'nights', 'nightsUp', 'won']);
});

test('a request for nights that names no player or no kind of money is refused, and both requests are held to the page’s own build', () => {
  const game = setup();

  for (const [playerId, unit] of [[undefined, 'chips'], ['ann', 'chips'], [7, 'chips'], ['ANN2345', 'euros'], ['ANN2345', null], [{ id: 'ANN2345' }, 'chips']] as [unknown, unknown][]) {
    assert.deepEqual(failure(game.nights(playerId, unit)), { ok: false, code: 'invalid', error: 'Malformed request' }, JSON.stringify([playerId, unit]));
  }

  const gate = new BuildGate(game.service, 'aaaaaaaaaaaa');
  for (const request of [{ op: 'standings' }, { op: 'nights', playerId: 'ANN2345', unit: 'chips' }]) {
    assert.equal(failure(gate.handle({ ...request, build: 'bbbbbbbbbbbb' })).code, 'stale');
    assert.equal(gate.handle({ ...request, build: 'aaaaaaaaaaaa' }).ok, true);
  }
});

test('a look at the idle tables that throws, or a lock that is taken, costs the standings nothing: they answer with what is on record', () => {
  const game = deployed();
  const friday = game.table({ Ann: NEW, Bob: NEW });
  friday.hand();
  friday.act(0, { type: 'endNight' });
  const before = game.standings().units;

  const broken: TableStore = { ...game.store, settleIdle: () => { throw new Error('the look broke'); }, transact: game.store.transact.bind(game.store), read: game.store.read.bind(game.store), peek: game.store.peek.bind(game.store), recentHands: game.store.recentHands.bind(game.store), putAwayOld: game.store.putAwayOld.bind(game.store), wasPutAway: game.store.wasPutAway.bind(game.store) };
  const service = new PokerService({ store: broken, players: game.players, results: game.results, presets: new MemoryPresetStore(), clock: game.clock, rng: seededRng(1), errors: game.errors });

  const answer = service.handle({ op: 'standings' });
  assert.ok(answer.ok && answer.kind === 'standings');
  assert.deepEqual(answer.units, before);
  assert.deepEqual(game.errors.rows.map((row) => [row.where, row.message]), [['server settle results', 'the look broke']]);
});

test('every call of a request for the standings failed in turn, at a moment when an idle table is due and nothing is cached: only reading the list of players or the Results tab can fail the answer, never the look at idle tables, and whatever failed is in the error log', () => {
  const prepare = () => {
    const game = deployed();
    const friday = game.table({ Ann: NEW, Bob: NEW });
    friday.hand();
    friday.act(0, { type: 'endNight' });
    const idle = game.table({ Ann: as(friday.identities[0]!), Bob: as(friday.identities[1]!) });
    idle.hand();
    game.clock.time += SETTLE_AFTER_MS;
    game.cache.entries.clear();

    return game;
  };

  const clean = prepare();
  clean.calls.made = [];
  const expected = clean.standings().units;
  const steps = [...clean.calls.made];
  assert.deepEqual(expected[0]!.players.map((player) => player.nights), [2, 2]);

  // The look at the idle tables comes first and ends by noting what it saw; the answer is made from what is read after it
  const looked = steps.indexOf('cache.put') + 1;
  const reads = steps.flatMap((call, index) => (index >= looked && /^(spreadsheet|Players|Results)\./.test(call) ? [index + 1] : []));
  assert.ok(looked > 10 && reads.length >= 4, steps.join(' '));

  for (let failing = 1; failing <= steps.length; failing++) {
    const game = prepare();
    const step = `call ${failing}, ${steps[failing - 1]}`;
    const from = game.calls.made.length;

    game.calls.failNth(failing);
    let response: ApiResponse | null = null;

    try {
      response = game.service.handle({ op: 'standings' });
    } catch {
      // What the service cannot answer it throws, and the host tells the page that something went wrong
      assert.ok(reads.includes(failing), `${step} failed the answer`);
    }

    assert.equal(game.lock.held, false, step);
    assert.equal(game.errors.rows.length, 1, `${step}: ${JSON.stringify(game.errors.rows)}`);

    if (response) {
      assert.ok(response.ok && response.kind === 'standings', step);
      const nights = response.units[0]!.players.map((player) => player.nights);
      assert.ok(JSON.stringify(nights) === '[2,2]' || JSON.stringify(nights) === '[1,1]', `${step}: ${JSON.stringify(nights)}`);
    }

    assert.ok(game.calls.made.length > from);

    // Asked again a little later, the answer is whole
    game.clock.time += 6 * 60_000;
    game.cache.entries.clear();
    assert.deepEqual(game.standings().units, expected, step);
  }
});

// Tables as older code saved them, written once by scripts/goldenTables.ts
const FOLDER = new URL('./fixtures/tables/', import.meta.url);
const FILES = readdirSync(FOLDER).filter((file) => file.endsWith('.json')).sort();

test('every saved table from the code before this still gives its rows: none while nobody at it is known, and once they say who they are a row each with the ledger’s money', () => {
  assert.ok(FILES.length >= 7);

  for (const file of FILES) {
    const state = restoreState(readFileSync(new URL(file, FOLDER), 'utf8'));
    const stillThere = state.members.filter((member) => member.identity === null);
    assert.deepEqual(resultsOf(state).players.filter((player) => !state.members.some((member) => member.identity === player.playerId)), [], file);

    state.members.forEach((member, index) => {
      member.identity = `PLAYER${index}`;
    });

    const results = resultsOf(state);
    const ledger = ledgerOf(state);
    assert.ok(stillThere.length > 0 && ledger.length >= 2, file);
    assert.deepEqual(results.players.map((player) => player.net).sort(), ledger.map((row) => row.net).sort(), file);
    assert.equal(results.players.reduce((sum, player) => sum + player.net, 0), 0, file);

    // And they are kept and read back like any night's
    const kept = new MemoryResultStore(() => NOW);
    kept.write([results]);
    assert.equal(kept.standings().records[results.unit].length, results.players.length, file);
  }
});
