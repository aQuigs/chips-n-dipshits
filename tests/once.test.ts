/*
 * A command that moves chips is sent under a key the page makes, and asked again under it when no
 * answer came. These hold the page to asking again that way and no other, the server to doing such a
 * command once and answering every asking alike, and the Sheet to saving a key with what its command did.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ServerClock, ServerLine, sleep, TableConnection } from '../src/client/connection.ts';
import type { RefusalPlace, SendOutcome } from '../src/client/connection.ts';
import { ONCE, Once } from '../src/client/once.ts';
import type { Transport } from '../src/client/transport.ts';
import { isKey, seenOf } from '../src/engine/index.ts';
import type { Command, TableState, TableView } from '../src/engine/index.ts';
import { SheetStore } from '../src/gas/sheetStore.ts';
import type { ApiError, ApiRequest, ApiResponse, Auth, Built } from '../src/server/api.ts';
import { BuildGate } from '../src/server/build.ts';
import { MemoryErrorLog } from '../src/server/memoryErrorLog.ts';
import { MemoryPlayerStore } from '../src/server/memoryPlayerStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import type { TableStore } from '../src/server/store.ts';
import { Calls, FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import { failure, joined, seededRng, testKey, viewOf } from './helpers.ts';

const BUILD = 'aaaaaaaaaaaa';
const CHECKING = 'No answer from the table. Checking whether that went through…';
const WENT_THROUGH = 'That went through the first time, so it was not sent again';
const BUSY = 'The table is busy, try again';

/** A table with its host and Dana seated with 1,000 each, and what a test asks of it. */
function game(store: TableStore) {
  const clock = { now: () => Date.now() };
  const service = new PokerService({ store, presets: new MemoryPresetStore(), players: new MemoryPlayerStore(seededRng(12)), clock, rng: seededRng(11), errors: new MemoryErrorLog(clock) });
  const host = joined(service.handle({ op: 'create', name: 'Host', config: { minBuyIn: 100, maxBuyIn: 5000 } }));
  const tableId = host.view.id;
  const dana = joined(service.handle({ op: 'join', tableId, name: 'Dana' }));

  const act = (auth: Auth, command: Command, key?: unknown) => service.handle({ op: 'act', tableId, auth, command, key });
  const table = (auth: Auth = host.auth) => viewOf(service.handle({ op: 'poll', tableId, auth, since: -1 }));
  const stacks = () => table().seats.flatMap((seat) => (seat ? [seat.stack] : []));

  viewOf(act(host.auth, { type: 'requestSeat', seat: 0, buyIn: 1000 }));
  viewOf(act(dana.auth, { type: 'requestSeat', seat: 1, buyIn: 1000 }));
  viewOf(act(host.auth, { type: 'approve', playerId: dana.auth.id }));

  const give = (amount: number): Command => ({ type: 'transferChips', from: host.auth.id, to: dana.auth.id, amount });

  return { service, tableId, host, dana, act, table, stacks, give };
}

/** As it is deployed: tables in the Sheet behind the script lock, with every call to the Sheet and the cache noted. */
function inTheSheet() {
  const lock = new FakeLock();
  const calls = new Calls();
  const spreadsheet = new FakeSpreadsheet(lock, {}, calls);
  const cache = new FakeCache(calls);
  let failingFlush = 0;
  let flushes = 0;

  const store = new SheetStore({
    spreadsheet: () => spreadsheet,
    cache,
    lock,
    flush: () => {
      flushes += 1;

      if (flushes === failingFlush) {
        throw new Error('Service Spreadsheets failed');
      }
    },
  });

  /** The table as the Sheet has it, read by a run that finds nothing in the cache. */
  const saved = (tableId: string): TableState => {
    cache.entries.clear();

    return new SheetStore({ spreadsheet: () => spreadsheet, cache, lock, flush: () => undefined }).read(tableId)!;
  };

  /** The transfers on the Ledger tab, each as the chips it moved. */
  const transfers = () =>
    spreadsheet
      .getSheetByName('Ledger')!
      .cells.slice(1)
      .flatMap((row) => (row[3] === 'transfer' ? [row[7]] : []));

  return { store, calls, saved, transfers, failNextFlush: () => (failingFlush = flushes + 1) };
}

const KINDS = [
  ['in memory', () => new MemoryStore() as TableStore],
  ['in the Sheet', () => inTheSheet().store as TableStore],
] as const;

for (const [kind, store] of KINDS) {
  test(`${kind}: a command asked again under its key is answered with the table as it stands, and its chips move once`, () => {
    const { host, dana, act, stacks, give, table } = game(store());

    const first = viewOf(act(host.auth, give(300), testKey(1)));
    const again = viewOf(act(host.auth, give(300), testKey(1)));

    assert.deepEqual(stacks(), [700, 1300]);
    assert.deepEqual(again.seats, first.seats, 'the second asking was answered with another table than the first');
    assert.deepEqual(again.feed, first.feed, 'the second asking was told to the table');
    assert.deepEqual(again.you.asked, [testKey(1)]);
    assert.deepEqual(table(dana.auth).you.asked, [], 'a member is told a key of someone else\'s');

    // Under another key, or under none as a page sent before commands had keys, the same words are a new command
    viewOf(act(host.auth, give(300), testKey(2)));
    viewOf(act(host.auth, give(300)));
    assert.deepEqual(stacks(), [100, 1900]);
  });

  test(`${kind}: what is sent as a key and is not one is a bad request: nothing is done, and nothing of it is kept`, () => {
    const { host, act, stacks, give, table } = game(store());
    const before = table().version;

    for (const key of ['', 'short', testKey(1).slice(1), `${testKey(1)}k`, `${testKey(1).slice(1)}!`, `${testKey(1).slice(1)}é`, 'k'.repeat(60_000), 7, true, {}, [testKey(1)]]) {
      assert.deepEqual(failure(act(host.auth, give(300), key)), { ok: false, code: 'invalid', error: 'Malformed request' }, JSON.stringify(key).slice(0, 40));
    }

    assert.deepEqual(stacks(), [1000, 1000]);
    assert.deepEqual(table().you.asked, []);
    assert.equal(table().version, before, 'a bad request was saved');
  });

}

test('in the Sheet, a key is saved in the one write that moves the chips: when the request fails right after it the Sheet has both, and asked again under the key the command is answered, with the chips and the ledger having it once', () => {
  const { store, calls, saved, transfers, failNextFlush } = inTheSheet();
  const { tableId, host, act, give, stacks } = game(store);

  calls.made = [];
  failNextFlush();
  assert.throws(() => act(host.auth, give(300), testKey(1)), /Spreadsheets failed/);

  assert.equal(calls.count('.setValues'), 1, 'the command was saved in more writes than one, or in none');
  assert.deepEqual(saved(tableId).asked, [{ key: testKey(1), by: host.auth.id }]);
  assert.deepEqual(saved(tableId).seats.flatMap((seat) => (seat ? [seat.stack] : [])), [700, 1300]);

  const again = viewOf(act(host.auth, give(300), testKey(1)));

  assert.deepEqual(again.you.asked, [testKey(1)]);
  assert.deepEqual(stacks(), [700, 1300]);
  assert.deepEqual(transfers(), [-300, 300]);
});

test('in the Sheet, a write that never reaches it saves neither the chips nor the key: asked again under the key, the command is done, once', () => {
  const { store, calls, saved, transfers } = inTheSheet();
  const { tableId, host, act, give, stacks } = game(store);

  // The same command at a table like this one, to learn which call of the store's is the write of the table's row
  const like = inTheSheet();
  const likeGame = game(like.store);
  like.calls.made = [];
  viewOf(likeGame.act(likeGame.host.auth, likeGame.give(300), testKey(1)));
  const write = like.calls.made.indexOf('Tables.setValues') + 1;
  assert.ok(write > 0);

  calls.made = [];
  calls.failNth(write);
  assert.throws(() => act(host.auth, give(300), testKey(1)), /Service failed at Tables\.setValues/);

  assert.deepEqual(saved(tableId).asked, []);
  assert.deepEqual(saved(tableId).seats.flatMap((seat) => (seat ? [seat.stack] : [])), [1000, 1000]);

  viewOf(act(host.auth, give(300), testKey(1)));
  viewOf(act(host.auth, give(300), testKey(1)));

  assert.deepEqual(stacks(), [700, 1300]);
  assert.deepEqual(transfers(), [-300, 300]);
});

test('the page makes a key for each command that must be done once, keeps it for the same words until it knows what became of them, and for no other command', () => {
  let made = 0;
  const once = new Once((bytes) => new Uint8Array(bytes).fill(made++));
  const give: Command = { type: 'transferChips', from: 'A', to: 'B', amount: 5 };

  const key = once.keyFor('TABLE1', give)!;
  assert.ok(isKey(key), key);
  assert.equal(once.keyFor('TABLE1', { ...give }), key, 'the same words asked again went under another key');
  assert.notEqual(once.keyFor('TABLE1', { ...give, amount: 6 }), key);
  assert.notEqual(once.keyFor('TABLE2', give), key);

  once.settled(once.keyFor('TABLE2', give)!);
  assert.equal(once.keyFor('TABLE1', give), key, 'a key was given up with another one');

  once.settled(key);
  assert.notEqual(once.keyFor('TABLE1', give), key, 'the same command made on purpose, once the first is known, went under the first one\'s key');

  // Every command that moves chips between players or buys them, and the answers to a request for them
  assert.deepEqual([...ONCE].sort(), ['approve', 'deny', 'requestRebuy', 'transferChips']);
  assert.equal(once.keyFor('TABLE1', { type: 'start' }), undefined);
});

/** What becomes of a command the page sends: heard and answered, or one of the ways an answer goes missing. */
type Fate = 'answered' | 'request lost' | 'answer lost' | 'busy' | 'internal';

/**
 * The host's page at a table in memory: its connection, what it sent as commands, what it was told,
 * and the fate of each command it sends next, in order. Polls are always answered.
 */
function page() {
  const table = game(new MemoryStore());
  const gate = new BuildGate(table.service, BUILD);
  const acts: Extract<ApiRequest, { op: 'act' }>[] = [];
  const fates: Fate[] = [];
  const told: string[] = [];
  const said = (code: ApiError['code'], error: string): ApiResponse & Built => ({ ok: false, code, error, build: BUILD });

  const transport: Transport = {
    send: async (request) => {
      if (request.op !== 'act') {
        return gate.handle(request);
      }

      acts.push(request);
      const fate = fates.shift() ?? 'answered';

      if (fate === 'request lost') {
        throw new Error('The request was lost');
      }

      if (fate === 'busy') {
        return said('busy', 'The table is busy, try again');
      }

      const answer = gate.handle(request);

      if (fate === 'answer lost') {
        throw new Error('The answer was lost');
      }

      return fate === 'internal' ? said('internal', 'Something went wrong on the server, try again') : answer;
    },
  };

  let made = 0;
  const once = new Once((bytes) => new Uint8Array(bytes).fill(made++));
  let shown = 0;
  const listener = { view: (view: TableView) => void (shown = view.version), move: () => undefined, chose: () => undefined, status: () => undefined, refused: () => undefined, notice: (message: string) => told.push(message) };
  const connection = new TableConnection(new ServerLine(transport, BUILD, () => undefined), { tableId: table.tableId, auth: table.host.auth }, new ServerClock(), listener, once);

  connection.take(table.table());

  /**
   * Sends commands one after another, each with its fate, and leaves the table when done so that no poll
   * outlives the test. `refused` is where a form would have a refusal told, in place of a toast.
   */
  const sending = async (run: (send: (command: Command, ...next: Fate[]) => Promise<SendOutcome>) => Promise<void>, refused?: RefusalPlace): Promise<void> => {
    try {
      await run((command, ...next) => {
        fates.push(...next);

        return connection.send(command, refused);
      });
    } finally {
      connection.close();
    }
  };

  /** Resolves once the page has drawn the table as it stands. */
  const heardFromTheTable = async (): Promise<void> => {
    while (shown < table.table().version) {
      await sleep(5);
    }
  };

  return { ...table, acts, told, sending, heardFromTheTable, keys: () => acts.map((request) => request.key) };
}

test('a keyed command whose answer is lost is looked up, found done and told as taken, with nothing sent a second time', async () => {
  const { sending, acts, told, give, stacks } = page();

  await sending(async (send) => {
    assert.equal(await send(give(300), 'answer lost'), 'taken');
  });

  assert.equal(acts.length, 1);
  assert.deepEqual(stacks(), [700, 1300]);
  assert.deepEqual(told, [CHECKING]);
});

test('a keyed command whose request is lost is asked once more under the same key, and that answer decides', async () => {
  const { sending, keys, told, give, stacks } = page();

  await sending(async (send) => {
    assert.equal(await send(give(300), 'request lost'), 'taken');
    assert.equal(await send(give(5000), 'request lost'), 'refused');
  });

  const [first, again, tooMany, tooManyAgain] = keys();

  assert.ok(isKey(first));
  assert.deepEqual([again, tooManyAgain], [first, tooMany]);
  assert.notEqual(tooMany, first);
  assert.deepEqual(stacks(), [700, 1300]);
  assert.deepEqual(told, [CHECKING, CHECKING, 'The amount must be a whole number from 1 to 700']);
});

test('under a key, an answer that only says to try again is no refusal: the page looks the command up and tries again itself, so nobody is invited to send it twice', async () => {
  const { sending, keys, told, give, stacks } = page();

  await sending(async (send) => {
    // The Sheet took the write and then the request failed: the table has the chips where they were sent
    assert.equal(await send(give(300), 'internal'), 'taken');
    assert.deepEqual(stacks(), [700, 1300]);

    // The table could not be had in time, so nothing was done
    assert.equal(await send(give(200), 'busy'), 'taken');
    assert.deepEqual(stacks(), [500, 1500]);
  });

  const [first, second, secondAgain] = keys();

  assert.equal(keys().length, 3);
  assert.equal(secondAgain, second);
  assert.notEqual(second, first);
  assert.deepEqual(told, [CHECKING, CHECKING], 'the server\'s "try again" was shown to the player');
});

test('with no answer to the second asking either, the form is told so and the key is kept: filled in again in the same words it goes under that key, and the chips move once', async () => {
  const { sending, keys, give, stacks } = page();

  await sending(async (send) => {
    assert.equal(await send(give(300), 'request lost', 'request lost'), 'unanswered');
    assert.equal(await send(give(300), 'busy', 'request lost'), 'unanswered');
    assert.deepEqual(stacks(), [1000, 1000]);

    assert.equal(await send(give(300), 'request lost'), 'taken');
    assert.deepEqual(stacks(), [700, 1300]);
  });

  assert.equal(keys().length, 6);
  assert.equal(new Set(keys()).size, 1, 'the same words went under more than one key while nothing was known of them');
});

test('told to try again both times, with the table showing nothing done, the command is known not to be done: the player is told what the server said and keeps the form, and the next try goes under the same key', async () => {
  const { sending, keys, told, give, stacks } = page();

  await sending(async (send) => {
    assert.equal(await send(give(300), 'busy', 'busy'), 'refused');
    assert.deepEqual(stacks(), [1000, 1000]);
    assert.deepEqual(told, [CHECKING, BUSY]);

    // The second try was saved before it went wrong, which the table shows when asked once more
    assert.equal(await send(give(300), 'busy', 'internal'), 'taken');
    assert.deepEqual(stacks(), [700, 1300]);

    // With the first asking still out, a "try again" to the second settles nothing
    assert.equal(await send(give(200), 'request lost', 'busy'), 'unanswered');
    assert.deepEqual(stacks(), [700, 1300]);
  });

  assert.deepEqual([new Set(keys().slice(0, 4)).size, keys().length], [1, 6], 'the tries at one command went under more than one key');
  assert.deepEqual(told, [CHECKING, BUSY, CHECKING, CHECKING]);
});

test('a refusal of a command sent under a key is told where its form asked for it, at the first asking and after the page asked again', async () => {
  const { sending, told, give } = page();
  const byTheButton: string[] = [];

  await sending(
    async (send) => {
      assert.equal(await send(give(5000)), 'refused');
      assert.equal(await send(give(5000), 'request lost'), 'refused');
      assert.equal(await send(give(300), 'busy', 'busy'), 'refused');
    },
    (reason) => byTheButton.push(reason) > 0,
  );

  assert.deepEqual(byTheButton, ['The amount must be a whole number from 1 to 1,000', 'The amount must be a whole number from 1 to 1,000', BUSY]);
  assert.deepEqual(told, [CHECKING, CHECKING], 'a refusal its form had a place for was told in a toast as well');
});

test('a key is given up when whoever asked is told what became of the command, never at the table\'s news alone: filled in again after the table showed it done, the form is told so and nothing is sent', async () => {
  const { sending, keys, told, give, stacks, heardFromTheTable } = page();

  await sending(async (send) => {
    // The second asking is done by the table, and its answer lost: the form goes with nothing known
    assert.equal(await send(give(300), 'request lost', 'answer lost'), 'unanswered');
    assert.deepEqual(stacks(), [700, 1300]);
    await heardFromTheTable();

    assert.equal(await send(give(300)), 'taken');
    assert.deepEqual(stacks(), [700, 1300], 'filled in again once the table had shown the chips moved, the form moved them a second time');
    assert.equal(keys().length, 2, 'what the table had shown done was sent again');
    assert.deepEqual(told, [CHECKING, WENT_THROUGH]);

    // Told that, whoever sends the same again means it
    assert.equal(await send(give(300)), 'taken');
    assert.deepEqual(stacks(), [400, 1600]);
  });

  assert.deepEqual([keys()[1] === keys()[0], keys()[2] === keys()[0]], [true, false]);
});

test('once whoever asked has an answer, the same words are a new command: sent on purpose, they are done again', async () => {
  const { sending, keys, give, stacks, heardFromTheTable } = page();

  await sending(async (send) => {
    assert.equal(await send(give(300)), 'taken');
    await heardFromTheTable();
    assert.equal(await send(give(300)), 'taken');
    assert.equal(await send(give(300), 'answer lost'), 'taken');
    assert.equal(await send(give(300)), 'refused');
    assert.equal(await send(give(300)), 'refused');
  });

  assert.deepEqual(stacks(), [100, 1900]);
  assert.equal(new Set(keys()).size, 5);
});

test('a command that asking twice does not do twice goes without a key, and no answer to it is told as before: looked up, never sent again', async () => {
  const { sending, acts, told, table } = page();

  await sending(async (send) => {
    assert.equal(await send({ type: 'pause' }, 'answer lost'), 'unanswered');
    assert.equal(await send({ type: 'chat', text: 'gl' }, 'busy'), 'refused');
  });

  assert.deepEqual(acts.map((request) => [request.command.type, 'key' in request]), [['pause', false], ['chat', false]]);
  assert.deepEqual(told, [CHECKING, 'The table is busy, try again']);
  assert.ok(!table().feed.some((entry) => entry.text === 'gl'));
});

test('Approve and Deny go under a key and say what the page showed of the request: with its answer lost a request is granted once, and one changed since is refused with the reason', async () => {
  const { sending, acts, told, act, dana, table, stacks } = page();
  const ask = (amount: number) => viewOf(act(dana.auth, { type: 'requestRebuy', amount }));

  await sending(async (send) => {
    ask(200);
    const approve: Command = { type: 'approve', playerId: dana.auth.id, saw: seenOf(table().requests[0]!) };

    assert.equal(await send(approve, 'answer lost'), 'taken');
    assert.deepEqual(stacks(), [1000, 1200]);
    assert.equal(acts.length, 1);

    // The player asks again, and then for more before the host's page has drawn it: neither answer is for a request the page never showed
    ask(200);
    ask(3000);
    assert.equal(await send({ ...approve, type: 'deny' }), 'refused');
    assert.equal(await send(approve), 'refused');
    assert.deepEqual(table().requests.map((request) => request.amount), [3000]);
    assert.deepEqual(stacks(), [1000, 1200]);
  });

  assert.ok(acts.every((request) => isKey(request.key)));
  assert.deepEqual(told, [CHECKING, 'That request has changed', 'That request has changed']);
});
