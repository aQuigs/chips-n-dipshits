import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STATE_SCHEMA, TIMING, viewFor } from '../src/engine/index.ts';
import type { Command, Rng } from '../src/engine/index.ts';
import { SheetStore } from '../src/gas/sheetStore.ts';
import type { Auth } from '../src/server/api.ts';
import { ByteRng } from '../src/server/byteRng.ts';
import { MemoryErrorLog } from '../src/server/memoryErrorLog.ts';
import { MemoryPlayerStore } from '../src/server/memoryPlayerStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PUT_AWAY_MESSAGE } from '../src/server/putAway.ts';
import { PokerService } from '../src/server/service.ts';
import type { TableStore } from '../src/server/store.ts';
import { FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import { DAY_MS, failure, joined, seededRng, sevenDeuceBounty, viewOf } from './helpers.ts';

function setup(store: TableStore = new MemoryStore()) {
  const clock = { time: 1_000_000, now: () => clock.time };
  const presets = new MemoryPresetStore();
  const service = new PokerService({ store, presets, players: new MemoryPlayerStore(seededRng(12)), clock, rng: seededRng(11) });

  return { service, store, presets, clock };
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
  assert.deepEqual(response.view.you, { id: response.auth.id, name: 'Quigs', role: 'host', seat: null, identity: null });
  assert.equal(response.view.config.bigBlind, 2);
  assert.equal(store.read(response.view.id)!.members[0]!.token, response.auth.token);
});

test('anyone with the table id can look it up and join under a free name', () => {
  const { service } = setup();
  const tableId = joined(service.handle({ op: 'create', name: 'Quigs' })).view.id;

  const info = service.handle({ op: 'info', tableId: tableId.toLowerCase() });
  assert.deepEqual(info, { ok: true, kind: 'info', table: { id: tableId, name: "Chips n' Dipshits", unit: 'chips', smallBlind: 10, bigBlind: 20, ante: 0, anteFrom: 'everyone', bounties: [], players: [] } });

  const ann = joined(service.handle({ op: 'join', tableId: ` ${tableId.toLowerCase()} `, name: 'Ann' }));
  assert.equal(ann.view.you.role, 'member');
  assert.equal(ann.view.version, 2);

  assert.deepEqual(failure(service.handle({ op: 'join', tableId, name: 'ann' })), {
    ok: false,
    code: 'invalid',
    error: 'Someone at this table is already called ann',
  });
});

test('someone looking a table up is told its ante and who pays it', () => {
  const { service } = setup();
  const tableId = joined(service.handle({ op: 'create', name: 'Quigs', config: { ante: 20, anteFrom: 'bigBlind' } })).view.id;

  const info = service.handle({ op: 'info', tableId });
  assert.ok(info.ok && info.kind === 'info');
  assert.deepEqual([info.table.ante, info.table.anteFrom], [20, 'bigBlind']);
});

test('every member sees the voice chat link, and someone who has not joined learns nothing of it', () => {
  const { service, act, poll, tableId, players } = seatedTable();
  const link = 'https://meet.google.com/abc-defg-hij';

  viewOf(act(0, { type: 'updateConfig', config: { voiceLink: link } }));
  const watcher = joined(service.handle({ op: 'join', tableId, name: 'Cat' }));

  assert.deepEqual(
    [0, 1, 2].map((who) => viewOf(poll(who)).config.voiceLink),
    [link, link, link],
  );
  assert.equal(watcher.view.config.voiceLink, link, 'a member who is only watching');
  assert.equal(players.length, 3);

  const info = service.handle({ op: 'info', tableId });
  assert.ok(info.ok && info.kind === 'info');
  assert.ok(!JSON.stringify(info).includes('meet.google.com'), 'the join screen is not handed the call');
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

test('only a poll from a member of the table is kept waiting for news', () => {
  const { service } = setup();
  const host = joined(service.handle({ op: 'create', name: 'Quigs' }));
  const tableId = host.view.id;
  const poll = { op: 'poll', tableId, auth: host.auth, since: 1, holdMs: 20_000 };

  assert.deepEqual(service.waitFor(poll), { tableId, since: 1, ms: 20_000 });
  assert.deepEqual(service.waitFor({ ...poll, tableId: tableId.toLowerCase() })?.tableId, tableId, 'the wait is for the table as it is stored');

  // Each of these gets its answer, or its refusal, at once: holding it would spend a request slot on a stranger
  for (const [why, request] of Object.entries({
    'a wrong token': { ...poll, auth: { id: host.auth.id, token: 'WRONGTOKEN' } },
    'someone who never joined': { ...poll, auth: { id: 'NOBODY12', token: host.auth.token } },
    'no credentials': { ...poll, auth: undefined },
    'a table that is not there': { ...poll, tableId: 'NOPE22' },
    'no table': { ...poll, tableId: undefined },
    'a poll that does not ask to wait': { ...poll, holdMs: undefined },
    'a wait of nothing': { ...poll, holdMs: 0 },
    'a wait that is not a number': { ...poll, holdMs: Number.NaN },
    'another kind of request': { ...poll, op: 'history' },
    'nothing at all': null,
    'a list': [poll],
  })) {
    assert.equal(service.waitFor(request), null, why);
  }
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

  assert.deepEqual(failure(act(1, { type: 'start' })), { ok: false, code: 'invalid', error: 'Only the host or a co-host can do that' });
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

test('the end of a night reaches the store once each time, whether the last hand ends it as a poll comes in or the host does', () => {
  const { tableId, store, clock, act, poll } = seatedTable();
  const memory = store as MemoryStore;
  viewOf(act(0, { type: 'start' }));
  viewOf(act(0, { type: 'setLastHands', hands: 1 }));

  // The hand is folded around and its result left up until a poll after the pause finds it over
  clock.time += TIMING.startDelayMs;
  let view = viewOf(poll(1));
  while (view.hand!.stage === 'betting') {
    view = viewOf(act(view.hand!.toAct!, { type: 'fold' }));
  }
  clock.time = view.hand!.deadline!;
  view = viewOf(poll(2, view.version));

  assert.equal(view.nightEndedAt, clock.time);
  assert.deepEqual(memory.nightsEnded, [{ at: clock.time, tableId }]);

  // Polls and refusals change nothing, and play started again and ended again is another night
  viewOf(poll(0));
  assert.equal(failure(act(0, { type: 'endNight' })).error, 'The night is already over');
  viewOf(act(0, { type: 'playOn' }));
  viewOf(act(0, { type: 'endNight' }));
  assert.equal(memory.nightsEnded.length, 2);
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
  viewOf(act(0, { type: 'updateConfig', config: { actionSeconds: 15, maxRuns: 2, bounties: sevenDeuceBounty(20) } }));
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
      viewOf(act(players.findIndex((auth) => auth.id === voter.playerId), { type: 'ritVote', runs: 2 }));
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

// ---- Old tables put away ----

function sheetStore(): TableStore {
  const lock = new FakeLock();
  const spreadsheet = new FakeSpreadsheet(lock);

  return new SheetStore({ spreadsheet: () => spreadsheet, cache: new FakeCache(), lock, flush: () => {} });
}

const EITHER_STORE: [string, () => TableStore][] = [
  ['in memory', () => new MemoryStore()],
  ['in the Sheet', sheetStore],
];

for (const [kind, makeStore] of EITHER_STORE) {
  test(`tables ${kind}: one left two weeks is put away when the next table is made, and everything asked of it gets one plain answer`, () => {
    const { service, clock, tableId, players, poll } = seatedTable(makeStore());
    const spare = joined(service.handle({ op: 'join', tableId, name: 'Cy' })).auth;

    clock.time += 14 * DAY_MS - 1;
    const young = joined(service.handle({ op: 'create', name: 'Dee' }));
    assert.equal(viewOf(poll(0)).id, tableId, 'a millisecond short of two weeks, a new table moves nothing');

    clock.time += 1;
    const next = joined(service.handle({ op: 'create', name: 'Eve' }));

    const asked: [string, unknown][] = [
      ['info', { op: 'info', tableId }],
      ['join', { op: 'join', tableId, name: 'Flo' }],
      ['poll', { op: 'poll', tableId, auth: players[0], since: 3 }],
      ['poll by another member', { op: 'poll', tableId, auth: spare, since: -1 }],
      ['poll with a wrong token', { op: 'poll', tableId, auth: { id: players[0]!.id, token: 'WRONG' }, since: -1 }],
      ['act', { op: 'act', tableId, auth: players[0], command: { type: 'start' } }],
      ['history', { op: 'history', tableId, auth: players[0] }],
      ['savePreset', { op: 'savePreset', tableId, auth: players[0], name: 'Fridays', settings: {}, replace: false }],
      ['deletePreset', { op: 'deletePreset', tableId, auth: players[0], name: 'Fridays' }],
    ];

    for (const [what, request] of [...asked, ...asked]) {
      assert.deepEqual(service.handle(request), { ok: false, code: 'not_found', error: PUT_AWAY_MESSAGE, putAway: true }, what);
    }

    assert.equal(service.hasNews(tableId, 3), true, 'a poll for it is answered at once, not held');

    const never = failure(service.handle({ op: 'info', tableId: 'NEVER2' }));
    assert.deepEqual([never.code, 'putAway' in never], ['not_found', false], 'a table that never was is still only that');

    for (const other of [young, next]) {
      assert.equal(viewOf(service.handle({ op: 'poll', tableId: other.view.id, auth: other.auth, since: -1 })).id, other.view.id, 'the tables made since are untouched');
    }
  });

  test(`tables ${kind}: a page left open and asking does not keep a table, and a move at it does`, () => {
    const { service, clock, tableId, act, poll } = seatedTable(makeStore());
    const played = joined(service.handle({ op: 'create', name: 'Dee' }));
    const version = viewOf(poll(0)).version;

    // Three weeks of a tab left open on one table, and of a game now and then at the other
    for (let hour = 0; hour < 21 * 24; hour++) {
      clock.time += DAY_MS / 24;
      assert.equal(poll(0, version).ok, true);
      assert.equal(service.handle({ op: 'info', tableId }).ok, true);

      if (hour % (5 * 24) === 0) {
        joined(service.handle({ op: 'join', tableId: played.view.id, name: `Guest ${hour}` }));
      }
    }

    joined(service.handle({ op: 'create', name: 'Eve' }));

    assert.equal(failure(poll(0, version)).putAway, true);
    assert.equal(failure(act(0, { type: 'start' })).putAway, true);
    assert.equal(service.handle({ op: 'poll', tableId: played.view.id, auth: played.auth, since: -1 }).ok, true);
  });
}

test('a new table is made and handed back whatever becomes of putting the old ones away', () => {
  const broken = new MemoryStore();
  let asked = 0;
  broken.putAwayOld = () => {
    asked += 1;
    throw new Error('a store that breaks its word never to throw');
  };
  const { service } = setup(broken);

  const host = joined(service.handle({ op: 'create', name: 'Host' }));

  assert.equal(asked, 1);
  assert.equal(viewOf(service.handle({ op: 'poll', tableId: host.view.id, auth: host.auth, since: -1 })).id, host.view.id);
});

test('old tables are seen to when a table is made and at no other time, by the clock the game is played on', () => {
  const watched = new MemoryStore();
  const sweeps: number[] = [];
  const putAwayOld = watched.putAwayOld.bind(watched);
  watched.putAwayOld = (now, lastWords) => {
    sweeps.push(now);
    putAwayOld(now, lastWords);
  };

  const { service, clock, tableId, players, act, poll } = seatedTable(watched);
  assert.deepEqual(sweeps, [clock.time], 'once, for the table that was made');

  clock.time += 20 * DAY_MS;
  poll(0);
  act(0, { type: 'start' });
  service.handle({ op: 'info', tableId });
  service.handle({ op: 'history', tableId, auth: players[0] });
  service.handle({ op: 'presets' });
  service.handle({ op: 'join', tableId, name: 'Cy' });
  service.handle({ op: 'info', tableId: 'NEVER2' });
  assert.equal(sweeps.length, 1);

  assert.equal(failure(service.handle({ op: 'create', name: '' })).code, 'invalid');
  assert.equal(sweeps.length, 1, 'a table that was not made sweeps nothing');

  joined(service.handle({ op: 'create', name: 'Dee' }));
  assert.deepEqual(sweeps, [clock.time - 20 * DAY_MS, clock.time]);
});

for (const [kind, storeOf] of EITHER_STORE) {
  test(`${kind}: a table saved by a newer version of the game is not opened, says so in words its players and whoever runs the game can act on, and is left as it was`, () => {
    const clock = { time: 1_000_000, now: () => clock.time };
    const errors = new MemoryErrorLog(clock);
    const store = storeOf();
    const service = new PokerService({ store, presets: new MemoryPresetStore(), players: new MemoryPlayerStore(seededRng(12)), clock, rng: seededRng(11), errors });
    const host = joined(service.handle({ op: 'create', name: 'Host' }));
    const tableId = host.view.id;

    // A later version of the game saved the table, and then this one was put back
    const newer = STATE_SCHEMA + 1;
    store.transact(tableId, (state) => ({ save: { ...state!, schema: newer, version: state!.version + 1 }, at: clock.time, effects: [], result: null }));

    const requests = [
      { op: 'poll', tableId, auth: host.auth, since: -1 },
      { op: 'info', tableId },
      { op: 'join', tableId, name: 'Latecomer' },
      { op: 'act', tableId, auth: host.auth, command: { type: 'chat', text: 'hello' } },
    ];

    for (const request of requests) {
      const answer = failure(service.handle(request));

      // Not a refusal: the seat stays in the address and the browser's memory for when the newer version is back
      assert.equal(answer.code, 'internal', request.op);
      assert.equal(answer.error, "This table was saved by a newer version of the game than the one running now, so it can't be opened. Whoever runs the game needs to put the newer version back.", request.op);
    }

    // A page asks again every few seconds: the log has a row for each kind of request that met it, not one for each time
    service.handle(requests[0]);
    assert.deepEqual(errors.rows.map((row) => row.where), ['server poll', 'server info', 'server join', 'server act']);

    for (const row of errors.rows) {
      assert.equal(row.tableId, tableId);
      assert.match(row.message, new RegExp(`saved by a newer version of the game \\(schema ${newer}; this version reads up to schema ${STATE_SCHEMA}\\)\\. Deploy that version again, or restore the Sheet to before it was deployed`));
    }

    // Nothing was saved over it: it is still the newer version's table
    assert.throws(() => store.transact(tableId, (state) => ({ save: null, effects: [], result: state })), /saved by a newer version/);
  });
}
