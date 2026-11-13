import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TIMING, viewFor } from '../src/engine/index.ts';
import type { Command, Rng, TableView } from '../src/engine/index.ts';
import { SheetStore } from '../src/gas/sheetStore.ts';
import type { ApiResponse, Auth } from '../src/server/api.ts';
import { ByteRng } from '../src/server/byteRng.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import type { TableStore } from '../src/server/store.ts';
import { FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import { seededRng } from './helpers.ts';

function setup(store: TableStore = new MemoryStore()) {
  const clock = { time: 1_000_000, now: () => clock.time };
  const service = new PokerService({ store, clock, rng: seededRng(11) });

  return { service, store, clock };
}

type Joined = Extract<ApiResponse, { kind: 'joined' }>;

function joined(response: ApiResponse): Joined {
  assert.ok(response.ok && response.kind === 'joined', JSON.stringify(response));

  return response;
}

function viewOf(response: ApiResponse): TableView {
  assert.ok(response.ok && response.kind === 'view', JSON.stringify(response));

  return response.view;
}

function failure(response: ApiResponse) {
  assert.equal(response.ok, false, JSON.stringify(response));

  return response as Extract<ApiResponse, { ok: false }>;
}

/** A table with the host and two more players seated, ready to start. */
function seatedTable(store?: TableStore) {
  const context = setup(store);
  const { service } = context;

  const host = joined(service.handle({ op: 'create', name: 'Host', config: { minBuyIn: 100 } }));
  const tableId = host.view.id;
  const players = [host.auth, joined(service.handle({ op: 'join', tableId, name: 'Ann' })).auth, joined(service.handle({ op: 'join', tableId, name: 'Bob' })).auth];

  const act = (who: number, command: Command) => service.handle({ op: 'act', tableId, auth: players[who], command });
  const poll = (who: number, since = -1) => service.handle({ op: 'poll', tableId, auth: players[who], since });

  players.forEach((auth, seat) => {
    viewOf(act(seat, { type: 'requestSeat', seat, buyIn: 1000 }));

    if (seat > 0) {
      viewOf(act(0, { type: 'approve', playerId: auth.id }));
    }
  });

  return { ...context, tableId, players, act, poll };
}

test('creating a table makes the creator its host and hands back their credentials', () => {
  const { service, store } = setup();

  const response = joined(service.handle({ op: 'create', name: 'Quigs', config: { smallBlind: 1, bigBlind: 2 } }));

  assert.match(response.view.id, /^[A-Z2-9]{6}$/);
  assert.equal(response.view.version, 1);
  assert.deepEqual(response.view.you, { id: response.auth.id, name: 'Quigs', isHost: true, seat: null });
  assert.equal(response.view.config.bigBlind, 2);
  assert.equal(store.read(response.view.id)!.members[0]!.token, response.auth.token);
});

test('anyone with the table id can look it up and join under a free name', () => {
  const { service } = setup();
  const tableId = joined(service.handle({ op: 'create', name: 'Quigs' })).view.id;

  const info = service.handle({ op: 'info', tableId: tableId.toLowerCase() });
  assert.deepEqual(info, { ok: true, kind: 'info', table: { id: tableId, name: "Chips n' Dipshits", smallBlind: 10, bigBlind: 20, players: [] } });

  const ann = joined(service.handle({ op: 'join', tableId: ` ${tableId.toLowerCase()} `, name: 'Ann' }));
  assert.equal(ann.view.you.isHost, false);
  assert.equal(ann.view.version, 2);

  assert.deepEqual(failure(service.handle({ op: 'join', tableId, name: 'ann' })), {
    ok: false,
    code: 'invalid',
    error: 'Someone at this table is already called ann',
  });
});

test('bad requests come back as errors, not exceptions', () => {
  const { service } = setup();
  const host = joined(service.handle({ op: 'create', name: 'Quigs' }));
  const tableId = host.view.id;

  assert.equal(failure(service.handle(null)).code, 'invalid');
  assert.equal(failure(service.handle('poll')).code, 'invalid');
  assert.equal(failure(service.handle({ op: 'dance' })).code, 'invalid');
  assert.equal(failure(service.handle({ op: 'poll' })).code, 'invalid');
  assert.equal(failure(service.handle({ op: 'create', name: '' })).code, 'invalid');
  assert.equal(failure(service.handle({ op: 'info', tableId: 'NOPE22' })).code, 'not_found');
  assert.equal(failure(service.handle({ op: 'join', tableId: 'NOPE22', name: 'Ann' })).code, 'not_found');
  assert.equal(failure(service.handle({ op: 'info', tableId: 'X'.repeat(300) })).code, 'not_found', 'an id no table could have never reaches storage');
  assert.equal(failure(service.handle({ op: 'info', tableId: 'ab:c/4' })).code, 'not_found');
  assert.equal(service.hasNews('X'.repeat(300), 0), true, 'and a poll for one is answered at once');
  assert.equal(viewOf(service.handle({ op: 'poll', tableId: ` ${tableId.toLowerCase()} `, auth: host.auth, since: -1 })).id, tableId, 'a code typed loosely still finds its table');
  assert.equal(failure(service.handle({ op: 'poll', tableId, since: 0 })).code, 'invalid');
  assert.equal(failure(service.handle({ op: 'poll', tableId, auth: { id: host.auth.id }, since: 0 })).code, 'unauthorized');
  assert.equal(failure(service.handle({ op: 'act', tableId, auth: host.auth })).code, 'invalid');
  assert.equal(failure(service.handle({ op: 'act', tableId, auth: host.auth, command: { type: 'nonsense' } })).code, 'invalid');
});

test('a wrong token is refused everywhere a token is needed', () => {
  const { service } = setup();
  const host = joined(service.handle({ op: 'create', name: 'Quigs' }));
  const tableId = host.view.id;
  const forged: Auth = { id: host.auth.id, token: 'WRONGTOKEN' };

  for (const request of [
    { op: 'poll', tableId, auth: forged, since: 0 },
    { op: 'act', tableId, auth: forged, command: { type: 'start' } },
    { op: 'history', tableId, auth: forged },
  ]) {
    assert.equal(failure(service.handle(request)).code, 'unauthorized', request.op);
  }

  assert.equal(service.handle({ op: 'poll', tableId, auth: host.auth, since: 0 }).ok, true);
});

test('a poll returns the table only when it has changed', () => {
  const { service, clock } = setup();
  const host = joined(service.handle({ op: 'create', name: 'Quigs' }));
  const tableId = host.view.id;
  const poll = (since: number) => service.handle({ op: 'poll', tableId, auth: host.auth, since });

  assert.deepEqual(poll(1), { ok: true, kind: 'unchanged', now: clock.time });
  assert.equal(service.hasNews(tableId, 1), false);
  assert.equal(viewOf(poll(0)).version, 1);

  viewOf(service.handle({ op: 'act', tableId, auth: host.auth, command: { type: 'chat', text: 'hello' } }));

  assert.equal(service.hasNews(tableId, 1), true);
  assert.equal(viewOf(poll(1)).feed.at(-1)!.text, 'hello');
  assert.equal(service.hasNews('NOPE22', 1), true, 'a missing table is news: the poll must report it');
});

test('a command that breaks a rule changes nothing', () => {
  const { tableId, store, act } = seatedTable();
  const before = store.read(tableId)!;

  assert.deepEqual(failure(act(1, { type: 'start' })), { ok: false, code: 'invalid', error: 'Only the host can do that' });
  assert.deepEqual(store.read(tableId), before);
});

test('buy-ins reach the ledger and each player sees their own seat', () => {
  const { store, poll, players } = seatedTable();
  const memory = store as MemoryStore;

  assert.deepEqual(memory.ledger.map((entry) => [entry.name, entry.kind, entry.amount]), [
    ['Host', 'buy-in', 1000],
    ['Ann', 'buy-in', 1000],
    ['Bob', 'buy-in', 1000],
  ]);
  assert.equal(viewOf(poll(2)).you.seat, 2);
  assert.equal(viewOf(poll(1)).you.id, players[1]!.id);
});

test('polling is what moves time forward: the deal, the clock and the next hand', () => {
  const { service, tableId, store, clock, act, poll } = seatedTable();
  const memory = store as MemoryStore;
  viewOf(act(0, { type: 'updateConfig', config: { actionSeconds: 10 } }));
  const started = viewOf(act(0, { type: 'start' }));

  assert.equal(started.hand, null);
  assert.equal(service.hasNews(tableId, started.version), false);

  clock.time += TIMING.startDelayMs;
  assert.equal(service.hasNews(tableId, started.version), true, 'the deal is due');

  const dealt = viewOf(poll(1, started.version));
  assert.equal(dealt.hand!.number, 1);
  assert.equal(dealt.version, started.version + 1);
  assert.deepEqual(poll(2, dealt.version), { ok: true, kind: 'unchanged', now: clock.time }, 'the second poller finds it already done');

  // Nobody acts: each player times out in turn until the hand is over, then the next one is dealt
  let view = dealt;
  for (let i = 0; i < 20 && view.hand?.number === 1; i++) {
    clock.time = view.hand.deadline!;
    view = viewOf(poll(0, view.version));
  }

  assert.equal(memory.hands.length, 1);
  assert.equal(memory.hands[0]!.number, 1);
  assert.equal(view.hand, null, 'only the big blind is still playing, so no hand follows');
  assert.equal(view.seats.filter((seat) => seat?.away).length, 2, 'the two players who let the clock run out are away');

  const history = service.handle({ op: 'history', tableId, auth: { ...viewOf(poll(0)).you, token: '' } });
  assert.equal(failure(history).code, 'unauthorized');
});

test('history returns the finished hands of the table', () => {
  const { service, tableId, players, clock, act, poll } = seatedTable();
  viewOf(act(0, { type: 'start' }));
  clock.time += TIMING.startDelayMs;

  let view = viewOf(poll(0));
  while (view.hand!.stage === 'betting') {
    view = viewOf(act(view.hand!.toAct!, { type: 'fold' }));
  }

  clock.time = view.hand!.deadline!;
  viewOf(poll(0));

  const history = service.handle({ op: 'history', tableId, auth: players[2] });
  assert.ok(history.ok && history.kind === 'history');
  assert.equal(history.hands.length, 1);
  assert.match(history.hands[0]!.summary, /^Hand #1 · blinds 10\/20/);
});

/** Plays a table through the service with every player polling, the way browsers would. */
function playThroughService(store: TableStore, steps: number, rng: Rng, beforeStep: () => void = () => {}): number {
  const { service, tableId, players, clock, act } = seatedTable(store);
  viewOf(act(0, { type: 'updateConfig', config: { actionSeconds: 15, allowRunItTwice: true, sevenDeuceBounty: 20 } }));
  viewOf(act(0, { type: 'start' }));

  const versions = players.map(() => 0);
  let handsSeen = 0;

  for (let step = 0; step < steps; step++) {
    beforeStep();

    const who = rng.int(players.length);
    const response = service.handle({ op: 'poll', tableId, auth: players[who], since: versions[who] });
    assert.ok(response.ok, JSON.stringify(response));

    const saved = store.read(tableId)!;
    if (response.kind === 'unchanged') {
      assert.equal(saved.version, versions[who]);
    } else {
      assert.ok(response.kind === 'view');
      assert.deepEqual(response.view, viewFor(saved, players[who]!.id, clock.time), 'a poll must show exactly the saved table');
      versions[who] = response.view.version;
    }

    const hand = saved.hand;
    handsSeen = Math.max(handsSeen, saved.handCount);

    if (hand?.stage === 'betting' && rng.int(10) < 8) {
      const actor = players.findIndex((auth) => auth.id === saved.seats[hand.toAct!]!.playerId);
      const options = viewFor(saved, players[actor]!.id, clock.time).hand!.options!;
      const roll = rng.int(10);

      let command: Command = options.canCheck ? { type: 'check' } : roll < 3 ? { type: 'fold' } : { type: 'call' };
      if (options.canRaise && roll >= 8) {
        command = { type: 'raise', to: roll === 9 ? options.maxRaiseTo : options.minRaiseTo };
      }

      viewOf(act(actor, command));
    } else if (hand?.stage === 'ritVote' && rng.int(10) < 7) {
      const voter = hand.players.find((p) => !p.folded && p.ritVote === null)!;
      viewOf(act(players.findIndex((auth) => auth.id === voter.playerId), { type: 'ritVote', agree: true }));
    } else {
      // Busted or timed-out players come back so the game keeps going
      saved.seats.forEach((seat, index) => {
        if (seat && seat.stack === 0 && !hand) {
          act(index, { type: 'requestRebuy', amount: 1000 });
          act(0, { type: 'approve', playerId: seat.playerId });
        }

        if (seat?.sittingOut) {
          act(index, { type: 'sitIn' });
        }
      });

      clock.time += 500 + rng.int(4000);
    }
  }

  return handsSeen;
}

test('a whole game played through polls and actions stays consistent', () => {
  const store = new MemoryStore();
  const hands = playThroughService(store, 1500, seededRng(5));

  assert.ok(hands > 40, `only ${hands} hands`);
  assert.ok(store.hands.length >= hands - 1);
  assert.equal(store.ledger.filter((entry) => entry.kind === 'buy-in').length >= 3, true);
});

test('the same game on the sheet store survives the cache being emptied at any moment', () => {
  const spreadsheet = new FakeSpreadsheet();
  const cache = new FakeCache();
  const lock = new FakeLock();
  const store = new SheetStore({ spreadsheet: () => spreadsheet, cache, lock, flush: () => {} });
  const rng = seededRng(6);

  const hands = playThroughService(store, 1500, seededRng(5), () => {
    assert.equal(lock.held, false, 'the lock was left held between requests');

    if (rng.int(10) === 0) {
      cache.entries.clear();
    }
  });

  assert.ok(hands > 40, `only ${hands} hands`);
  assert.ok(spreadsheet.getSheetByName('Hands')!.getLastRow() >= hands - 1);
  assert.equal(spreadsheet.getSheetByName('Tables')!.getLastRow(), 2);
});

test('unbiased integers come out of random bytes in order, and out-of-range draws are thrown away', () => {
  const batches = [
    [5, 0, 0, 0],
    [255, 255, 255, 255, 7, 0, 0, 0],
  ];
  const rng = new ByteRng(() => batches.shift() ?? []);

  assert.equal(rng.int(52), 5);
  assert.equal(rng.int(52), 7, 'a draw at the very top of the range would favor low cards, so it is skipped');
  assert.throws(() => rng.int(52), /no bytes/);
  assert.throws(() => new ByteRng(() => [1]).int(0), /Cannot draw/);
});

test('integers from random bytes cover the whole range evenly', () => {
  const source = seededRng(99);
  const rng = new ByteRng(() => Array.from({ length: 64 }, () => source.int(256)));
  const counts = Array.from({ length: 52 }, () => 0);
  const draws = 104_000;

  for (let i = 0; i < draws; i++) {
    counts[rng.int(52)]! += 1;
  }

  // Each count is about 2000 with a standard deviation near 44, so 300 is far beyond chance
  for (const count of counts) {
    assert.ok(Math.abs(count - draws / 52) < 300, `a value came up ${count} times`);
  }
});
