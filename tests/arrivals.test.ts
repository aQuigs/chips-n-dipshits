/*
 * A join or a new table that got no answer is asked again by the page, under the key it made for the
 * first asking. These hold the server to answering both alike: one member, one table, however the two
 * requests fall, and never a member made for another request.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TableState } from '../src/engine/index.ts';
import { CacheArrivalKeys } from '../src/gas/cacheArrivalKeys.ts';
import { SheetPlayerStore } from '../src/gas/sheetPlayerStore.ts';
import { SheetStore } from '../src/gas/sheetStore.ts';
import type { ApiResponse, Auth, Who } from '../src/server/api.ts';
import { ARRIVAL_KEY_SECONDS, MemoryArrivalKeys } from '../src/server/arrivalKeys.ts';
import type { ArrivalKeys } from '../src/server/arrivalKeys.ts';
import { MemoryErrorLog } from '../src/server/memoryErrorLog.ts';
import { MemoryPlayerStore } from '../src/server/memoryPlayerStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import type { PlayerStore } from '../src/server/playerStore.ts';
import { NameOnList } from '../src/server/playerStore.ts';
import { PokerService } from '../src/server/service.ts';
import type { TableStore, Txn } from '../src/server/store.ts';
import { FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import { failure, joined, seededRng, viewOf } from './helpers.ts';

const NOW = 1_700_000_000_000;
const NEW: Who = { as: 'new' };
const KEY = 'k3Y-of_one-request-0001';
const OTHER_KEY = 'k3Y-of_one-request-0002';
const SAVE_FAILED = /Service Spreadsheets failed while accessing the document/;

// What a join asked twice was always told the second time: the first asking has the name
const NAME_TAKEN = /Someone at this table is already called Ann/;

/**
 * A store of tables with two things done to it that a test asks for: a save that fails after the
 * table was changed, as a write to the Sheet can, and a step taken just before a table is taken in
 * hand, which is where a second request slips in ahead of the first.
 */
class Meddled implements TableStore {
  failNextSave = false;
  beforeNext: (() => void) | null = null;
  readonly saved = new Set<string>();
  private readonly inner: TableStore;

  constructor(inner: TableStore) {
    this.inner = inner;
    this.read = inner.read.bind(inner);
    this.peek = inner.peek.bind(inner);
    this.recentHands = inner.recentHands.bind(inner);
    this.putAwayOld = inner.putAwayOld.bind(inner);
    this.settleIdle = inner.settleIdle.bind(inner);
    this.wasPutAway = inner.wasPutAway.bind(inner);
  }

  read: TableStore['read'];
  peek: TableStore['peek'];
  recentHands: TableStore['recentHands'];
  putAwayOld: TableStore['putAwayOld'];
  settleIdle: TableStore['settleIdle'];
  wasPutAway: TableStore['wasPutAway'];

  transact<T>(tableId: string, fn: (state: TableState | null) => Txn<T>): T {
    const first = this.beforeNext;
    this.beforeNext = null;
    first?.();

    return this.inner.transact(tableId, (state) => {
      const txn = fn(state);

      if (txn.save !== null && this.failNextSave) {
        this.failNextSave = false;
        throw new Error(SAVE_FAILED.source);
      }

      if (txn.save !== null) {
        this.saved.add(txn.save.id);
      }

      return txn;
    });
  }
}

function game(stores: { store: TableStore; players: PlayerStore; arrivals?: (clock: { now(): number }) => ArrivalKeys }) {
  const clock = { time: NOW, now: () => clock.time };
  const errors = new MemoryErrorLog(clock);
  const store = new Meddled(stores.store);
  const arrivals = stores.arrivals?.(clock) ?? new MemoryArrivalKeys(clock);
  const service = new PokerService({ store, presets: new MemoryPresetStore(), players: stores.players, arrivals, clock, rng: seededRng(11), errors });

  const create = (name: string, key?: unknown, who?: Who, config?: object) => service.handle({ op: 'create', name, who, config, key });
  const join = (tableId: string, name: string, key?: unknown, who?: Who) => service.handle({ op: 'join', tableId, name, who, key });
  const table = (tableId: string, auth: Auth) => viewOf(service.handle({ op: 'poll', tableId, auth, since: -1 }));
  const act = (tableId: string, auth: Auth, command: object) => service.handle({ op: 'act', tableId, auth, command });
  const listed = () => {
    const answer = service.handle({ op: 'players' });
    assert.ok(answer.ok && answer.kind === 'players');

    return answer.players.map((player) => player.name);
  };

  return { service, store, players: stores.players, clock, errors, create, join, table, act, listed };
}

const inMemory = () => ({ ...game({ store: new MemoryStore(), players: new MemoryPlayerStore(seededRng(12)) }), cache: null });

/** As it is deployed: tables and players in the Sheet, and the keys in the script cache, all behind the one lock. */
function deployed() {
  const lock = new FakeLock();
  const sheet = new FakeSpreadsheet(lock);
  const cache = new FakeCache();
  const deps = { spreadsheet: () => sheet, cache, lock, flush: () => undefined };

  return { ...game({ store: new SheetStore(deps), players: new SheetPlayerStore({ ...deps, rng: seededRng(77) }), arrivals: () => new CacheArrivalKeys({ cache }) }), cache };
}

const KINDS = [
  ['in memory', inMemory],
  ['in the Sheet', deployed],
] as const;

const sameMember = (a: ApiResponse, b: ApiResponse) => assert.deepEqual(joined(b).auth, joined(a).auth);
const names = (view: { members: { name: string }[] }) => view.members.map((member) => member.name);

for (const [kind, setup] of KINDS) {
  test(`${kind}: a join asked again under its key is answered with the member the first asking made, and adds nobody`, () => {
    const { create, join, table, listed } = setup();
    const host = joined(create('Host'));
    const first = join(host.view.id, 'Ann', KEY, NEW);

    const again = join(host.view.id, 'Ann', KEY, NEW);

    sameMember(first, again);
    assert.equal(joined(again).view.you.identity, joined(first).view.you.identity, 'known as the same player');
    assert.deepEqual(names(table(host.view.id, host.auth)), ['Host', 'Ann']);
    assert.equal(table(host.view.id, host.auth).feed.filter((line) => /Ann joined/.test(line.text)).length, 1);
    assert.deepEqual(listed(), ['Ann'], 'and is not told that their own name is taken');
  });

  test(`${kind}: a new table asked for again under its key is the table the first asking made`, () => {
    const { store, create, listed } = setup();
    const first = create('Quigs', KEY, NEW, { name: 'Friday' });

    const again = create('Quigs', KEY, NEW, { name: 'Friday' });

    sameMember(first, again);
    assert.equal(joined(again).view.id, joined(first).view.id);
    assert.equal(store.saved.size, 1, 'one table was made');
    assert.deepEqual(listed(), ['Quigs']);
  });

  test(`${kind}: a join whose table could not be saved is made anew by the asking that follows, once, and never answered with a member the table does not hold`, () => {
    const { store, create, join, table } = setup();
    const host = joined(create('Host'));

    store.failNextSave = true;
    assert.throws(() => join(host.view.id, 'Ann', KEY), SAVE_FAILED);
    assert.deepEqual(names(table(host.view.id, host.auth)), ['Host'], 'nobody was let in');

    const again = joined(join(host.view.id, 'Ann', KEY));
    assert.deepEqual(names(table(host.view.id, again.auth)), ['Host', 'Ann'], 'the member in the answer is one the table holds');

    sameMember(again, join(host.view.id, 'Ann', KEY));
    assert.deepEqual(names(table(host.view.id, host.auth)), ['Host', 'Ann']);
  });

  test(`${kind}: a new table that could not be saved is made by the asking that follows, once`, () => {
    const { store, create, table } = setup();

    store.failNextSave = true;
    assert.throws(() => create('Quigs', KEY), SAVE_FAILED);
    assert.equal(store.saved.size, 0);

    const again = joined(create('Quigs', KEY));
    assert.deepEqual(names(table(again.view.id, again.auth)), ['Quigs'], 'the table in the answer is there');

    sameMember(again, create('Quigs', KEY));
    assert.equal(store.saved.size, 1);
  });

  test(`${kind}: two askings of one join that arrive together, each before the other has let anyone in, make one member and are answered alike`, () => {
    const { store, create, join, table } = setup();
    const host = joined(create('Host'));
    let ahead: ApiResponse | null = null;

    // The second asking gets to the table while the first, which has already looked for its key, is still on its way there
    store.beforeNext = () => {
      ahead = join(host.view.id, 'Ann', KEY, NEW);
    };
    const first = join(host.view.id, 'Ann', KEY, NEW);

    sameMember(first, ahead!);
    assert.deepEqual(names(table(host.view.id, host.auth)), ['Host', 'Ann']);
  });

  test(`${kind}: two askings for one new table that arrive together make one table`, () => {
    const { store, create } = setup();
    let ahead: ApiResponse | null = null;

    store.beforeNext = () => {
      ahead = create('Quigs', KEY);
    };
    const first = create('Quigs', KEY);

    sameMember(first, ahead!);
    assert.equal(joined(first).view.id, joined(ahead!).view.id);
    assert.equal(store.saved.size, 1);
  });

  test(`${kind}: a key that names a member of another table is a plain arrival at this one, with nothing of the other in the answer`, () => {
    const { create, join, table } = setup();
    const here = joined(create('Host'));
    const there = joined(create('Elsewhere'));
    const atTheOther = joined(join(there.view.id, 'Ann', KEY));

    const arrived = joined(join(here.view.id, 'Ann', KEY));

    assert.equal(arrived.view.id, here.view.id);
    assert.deepEqual(names(arrived.view), ['Host', 'Ann']);
    assert.notDeepEqual(arrived.auth, atTheOther.auth);
    assert.deepEqual(names(table(here.view.id, arrived.auth)), ['Host', 'Ann'], 'a member of this table');
    assert.deepEqual(names(table(there.view.id, there.auth)), ['Elsewhere', 'Ann'], 'and the other table is as it was');

    // The key is this arrival's from now on
    sameMember(arrived, join(here.view.id, 'Ann', KEY));
  });

  test(`${kind}: someone the host removed from the table who asks again under their key arrives as any newcomer does`, () => {
    const { create, join, act, table } = setup();
    const host = joined(create('Host'));
    const first = joined(join(host.view.id, 'Ann', KEY));

    assert.equal(act(host.view.id, host.auth, { type: 'kick', playerId: first.auth.id }).ok, true);
    assert.deepEqual(names(table(host.view.id, host.auth)), ['Host']);

    const back = joined(join(host.view.id, 'Ann', KEY));

    assert.notEqual(back.auth.id, first.auth.id, 'a new member, not the one who was removed');
    assert.equal(back.view.you.seat, null);
    assert.equal(table(host.view.id, host.auth).feed.filter((line) => /Ann joined/.test(line.text)).length, 2);
  });

  test(`${kind}: someone the host took out of their seat who asks again under their key is the member they are, without the seat`, () => {
    const { create, join, act, table } = setup();
    const host = joined(create('Host'));
    const ann = joined(join(host.view.id, 'Ann', KEY));

    assert.equal(act(host.view.id, ann.auth, { type: 'requestSeat', seat: 3, buyIn: 1000 }).ok, true);
    assert.equal(act(host.view.id, host.auth, { type: 'approve', playerId: ann.auth.id }).ok, true);
    assert.equal(table(host.view.id, ann.auth).you.seat, 3);

    assert.equal(act(host.view.id, host.auth, { type: 'kick', playerId: ann.auth.id }).ok, true);
    const back = joined(join(host.view.id, 'Ann', KEY));

    assert.deepEqual(back.auth, ann.auth);
    assert.equal(back.view.you.seat, null, 'what the key gives back is who they are, not where they sat');
  });

  test(`${kind}: a key is one request's: sent with other words, it finds nobody and is that request's from then on`, () => {
    const { create, join, table } = setup();
    const host = joined(create('Host'));
    const ann = joined(join(host.view.id, 'Ann', KEY));

    const bob = joined(join(host.view.id, 'Bob', KEY));
    assert.notEqual(bob.auth.id, ann.auth.id, 'Bob is not answered with the member made for Ann');
    assert.deepEqual(names(table(host.view.id, host.auth)), ['Host', 'Ann', 'Bob']);
    sameMember(bob, join(host.view.id, 'Bob', KEY));

    // Nor is a new table answered with a member who joined one, or with a table of other settings
    const made = joined(create('Bob', KEY));
    assert.notEqual(made.view.id, host.view.id);
    const other = joined(create('Bob', KEY, undefined, { name: 'Another' }));
    assert.notEqual(other.view.id, made.view.id);
  });

  test(`${kind}: a key is forgotten after ten minutes, and the asking that follows is a second arrival as it always was`, () => {
    const { clock, cache, create, join, table } = setup();
    const host = joined(create('Host'));
    const first = joined(join(host.view.id, 'Ann', KEY));

    assert.equal(ARRIVAL_KEY_SECONDS, 600);
    if (cache) {
      assert.deepEqual([...cache.seconds].filter(([key]) => key.includes(KEY)), [[`arrival:${KEY}`, ARRIVAL_KEY_SECONDS]]);
    }

    sameMember(first, join(host.view.id, 'Ann', KEY));

    clock.time += ARRIVAL_KEY_SECONDS * 1000;
    if (cache) {
      cache.entries.delete(`arrival:${KEY}`);
    }

    assert.match(failure(join(host.view.id, 'Ann', KEY)).error, NAME_TAKEN);
    assert.deepEqual(names(table(host.view.id, host.auth)), ['Host', 'Ann']);
  });

  test(`${kind}: something that is not a key is refused before anyone is let in or anything is kept under it`, () => {
    const { store, cache, create, join, table } = setup();
    const host = joined(create('Host'));

    for (const notOne of ['', 'short', 'has a space in it, which no key has', 'k'.repeat(300), 'state:7:ABC234-and-more', 12345678901234567890, { key: KEY }]) {
      const refusal = failure(join(host.view.id, 'Ann', notOne));
      assert.deepEqual([refusal.code, refusal.error], ['invalid', 'Malformed request'], JSON.stringify(notOne));
      assert.equal(failure(create('Ann', notOne)).code, 'invalid', JSON.stringify(notOne));
    }

    assert.deepEqual(names(table(host.view.id, host.auth)), ['Host']);
    assert.equal(store.saved.size, 1);
    assert.deepEqual([...(cache?.entries.keys() ?? [])].filter((key) => key.startsWith('arrival')), []);

    assert.deepEqual(names(joined(join(host.view.id, 'Ann')).view), ['Host', 'Ann'], 'with no key at all, an arrival is what it always was');
    assert.match(failure(join(host.view.id, 'Ann')).error, NAME_TAKEN);
  });

  test(`${kind}: an asking that finds its name on the list because the other asking has just put it there is answered as that one was`, () => {
    const { players, create, join, table } = setup();
    const host = joined(create('Host'));
    let ahead: ApiResponse | null = null;

    // The first asking has looked for its key and found nothing; the second is let in whole before the first asks the list about the name
    const list = players.list.bind(players);
    players.list = () => {
      if (!ahead) {
        ahead = join(host.view.id, 'Ann', KEY, NEW);
      }

      return list();
    };
    const first = join(host.view.id, 'Ann', KEY, NEW);

    sameMember(first, ahead!);
    assert.deepEqual(names(table(host.view.id, host.auth)), ['Host', 'Ann']);
  });

  test(`${kind}: an asking in more words than a page ever sends is an arrival as it always was, and nothing is kept for it`, () => {
    const { service, cache, create, table } = setup();
    const host = joined(create('Host'));
    const wordy = { op: 'join', tableId: host.view.id, name: 'Ann', key: KEY, config: { name: 'x'.repeat(30_000) } };

    joined(service.handle(wordy));
    assert.match(failure(service.handle(wordy)).error, NAME_TAKEN);

    assert.deepEqual(names(table(host.view.id, host.auth)), ['Host', 'Ann']);
    assert.deepEqual([...(cache?.entries.keys() ?? [])].filter((key) => key.startsWith('arrival')), []);
  });

  test(`${kind}: a known player's name is still refused to someone new who asks under a key of their own`, () => {
    const { create, join } = setup();
    const host = joined(create('Host'));
    joined(join(host.view.id, 'Ann', KEY, NEW));

    assert.equal(failure(join(host.view.id, 'Ann', OTHER_KEY, NEW)).error, new NameOnList('Ann').message);
  });
}

test('what is kept under a key in the script cache is which table and member, and what was asked, never the member\'s token', () => {
  const { cache, create, join } = deployed();
  const host = joined(create('Host', OTHER_KEY));
  const ann = joined(join(host.view.id, 'Ann', KEY));

  const kept = [...cache.entries].filter(([key]) => key.startsWith('arrival:'));
  assert.deepEqual(kept.map(([key]) => key).sort(), [`arrival:${KEY}`, `arrival:${OTHER_KEY}`].sort());
  assert.deepEqual(Object.keys(JSON.parse(cache.entries.get(`arrival:${KEY}`)!) as object).sort(), ['asked', 'memberId', 'tableId']);

  for (const [, value] of kept) {
    assert.ok(!value.includes(ann.auth.token) && !value.includes(host.auth.token));
  }
});

test('a cache that cannot be asked or written to stops no arrival: the member is let in as before, and the failure is told', () => {
  const { cache, errors, create, join, table } = deployed();
  const host = joined(create('Host'));

  cache.failNextWrite = true;
  const first = joined(join(host.view.id, 'Ann', KEY));
  assert.deepEqual(names(table(host.view.id, first.auth)), ['Host', 'Ann']);
  assert.deepEqual(errors.rows.map((row) => row.where), ['server keep arrival']);

  // Nothing was kept, so the asking that follows is a second arrival, as every one was before there were keys
  assert.match(failure(join(host.view.id, 'Ann', KEY)).error, NAME_TAKEN);

  const get = cache.get.bind(cache);
  cache.get = (key) => {
    if (key.startsWith('arrival:')) {
      throw new Error('The cache is unavailable');
    }

    return get(key);
  };
  assert.deepEqual(names(joined(join(host.view.id, 'Bob', OTHER_KEY)).view), ['Host', 'Ann', 'Bob']);
  assert.deepEqual([...new Set(errors.rows.slice(1).map((row) => row.where))], ['server find arrival']);
});

test('what the cache holds under a key that is not an arrival, as after a version that kept something else there, is nobody', () => {
  const { cache, create, join } = deployed();
  const host = joined(create('Host'));

  const left = ['not json', 'null', '{"tableId":"ABC234"}', JSON.stringify({ tableId: host.view.id, memberId: 7, asked: 'x' })];

  for (const [index, name] of ['Ann', 'Bob', 'Cat', 'Dee'].entries()) {
    cache.entries.set(`arrival:${KEY}`, left[index]!);
    assert.equal(joined(join(host.view.id, name, KEY)).view.you.name, name, left[index]!);
  }
});
