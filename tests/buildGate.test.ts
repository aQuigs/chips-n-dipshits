import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ApiError, ApiRequest, ApiResponse, Auth, Built } from '../src/server/api.ts';
import { BuildGate, OUTDATED_MESSAGE } from '../src/server/build.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import { seededRng } from './helpers.ts';

const THIS_BUILD = 'aaaaaaaaaaaa';
const OLDER_BUILD = 'bbbbbbbbbbbb';

/** A table with its host seated, behind the gate of one build. */
function setup() {
  const store = new MemoryStore();
  const gate = new BuildGate(new PokerService({ store, clock: { now: () => 1_000_000 }, rng: seededRng(7) }), THIS_BUILD);

  const created = gate.handle({ op: 'create', name: 'Host', build: THIS_BUILD });
  assert.ok(created.ok && created.kind === 'joined', JSON.stringify(created));

  const tableId = created.view.id;
  const auth: Auth = created.auth;
  const saved = () => JSON.stringify(store.read(tableId));

  return { gate, store, tableId, auth, saved };
}

function refusal(response: ApiResponse & Built): ApiError & Built {
  assert.equal(response.ok, false, JSON.stringify(response));

  return response as ApiError & Built;
}

/** Everything a page can ask that would change something, as a page at `tableId` would send it. */
function changes(tableId: string, auth: Auth): ApiRequest[] {
  return [
    { op: 'create', name: 'Another host' },
    { op: 'join', tableId, name: 'Guest' },
    { op: 'act', tableId, auth, command: { type: 'requestSeat', seat: 0, buyIn: 1000 } },
    { op: 'act', tableId, auth, command: { type: 'chat', text: 'hello' } },
    // The moves the page never repeats on a guess
    { op: 'act', tableId, auth, command: { type: 'fold' } },
    { op: 'act', tableId, auth, command: { type: 'check' } },
    { op: 'act', tableId, auth, command: { type: 'call' } },
    { op: 'act', tableId, auth, command: { type: 'raise', to: 100 } },
    { op: 'act', tableId, auth, command: { type: 'ritVote', agree: true } },
  ];
}

test('a page of the same build is answered as ever, and every answer says which build the server is', () => {
  const { gate, tableId, auth } = setup();

  const seated = gate.handle({ op: 'act', tableId, auth, command: { type: 'requestSeat', seat: 0, buyIn: 1000 }, build: THIS_BUILD });
  assert.ok(seated.ok && seated.kind === 'view');
  assert.equal(seated.view.you.seat, 0);
  assert.equal(seated.build, THIS_BUILD);

  const unchanged = gate.handle({ op: 'poll', tableId, auth, since: seated.view.version, build: THIS_BUILD });
  assert.ok(unchanged.ok && unchanged.kind === 'unchanged');
  assert.equal(unchanged.build, THIS_BUILD);

  // A refusal that is the game's own says so too, or the page would take the server for another build
  const refused = refusal(gate.handle({ op: 'act', tableId, auth, command: { type: 'fold' }, build: THIS_BUILD }));
  assert.equal(refused.code, 'invalid');
  assert.equal(refused.build, THIS_BUILD);

  assert.deepEqual(gate.waitFor({ op: 'poll', tableId, auth, since: 3, holdMs: 20_000, build: THIS_BUILD }), { tableId, since: 3, ms: 20_000 });
});

test('a page of another build gets nothing changed: every command, joining and creating are refused as stale', () => {
  const { gate, store, tableId, auth, saved } = setup();
  const before = saved();
  const tablesBefore = store.read(tableId)!.version;

  for (const request of changes(tableId, auth)) {
    const refused = refusal(gate.handle({ ...request, build: OLDER_BUILD }));

    assert.equal(refused.code, 'stale', JSON.stringify(request));
    assert.equal(refused.error, OUTDATED_MESSAGE);
    assert.equal(refused.build, THIS_BUILD, 'the refusal says which build refused it');
  }

  assert.equal(saved(), before, 'the table is as it was');
  assert.equal(store.read(tableId)!.version, tablesBefore);
});

test('a page of another build is still shown the table, and learns from the answer which build the server is', () => {
  const { gate, tableId, auth, saved } = setup();
  const before = saved();

  const poll = gate.handle({ op: 'poll', tableId, auth, since: -1, build: OLDER_BUILD });
  assert.ok(poll.ok && poll.kind === 'view', JSON.stringify(poll));
  assert.equal(poll.build, THIS_BUILD);

  const info = gate.handle({ op: 'info', tableId, build: OLDER_BUILD });
  assert.ok(info.ok && info.kind === 'info');
  assert.equal(info.build, THIS_BUILD);

  const history = gate.handle({ op: 'history', tableId, auth, build: OLDER_BUILD });
  assert.ok(history.ok && history.kind === 'history');
  assert.equal(history.build, THIS_BUILD);

  // It may wait for news like any other member's
  assert.deepEqual(gate.waitFor({ op: 'poll', tableId, auth, since: 1, holdMs: 20_000, build: OLDER_BUILD }), { tableId, since: 1, ms: 20_000 });
  assert.equal(saved(), before);
});

test('being out of date is never answered as the seat or the table being gone', () => {
  const { gate, tableId, auth } = setup();
  const stranger: Auth = { id: 'NOBODY00', token: 'wrong' };

  // From a page of this build these are "unauthorized" and "not_found", the two answers that take a
  // seat out of a page's address and its browser's memory
  const gone: [ApiRequest, string][] = [
    [{ op: 'act', tableId, auth: stranger, command: { type: 'chat', text: 'hi' } }, 'unauthorized'],
    [{ op: 'act', tableId: 'NOPE99', auth, command: { type: 'chat', text: 'hi' } }, 'not_found'],
    [{ op: 'join', tableId: 'NOPE99', name: 'Guest' }, 'not_found'],
  ];

  for (const [request, code] of gone) {
    assert.equal(refusal(gate.handle({ ...request, build: THIS_BUILD })).code, code);
  }

  for (const request of [...gone.map(([request]) => request), ...changes(tableId, stranger), ...changes('NOPE99', auth)]) {
    assert.equal(refusal(gate.handle({ ...request, build: OLDER_BUILD })).code, 'stale', JSON.stringify(request));
    assert.equal(refusal(gate.handle(request)).code, 'stale', JSON.stringify(request));
  }

  for (const poll of [
    { op: 'poll', tableId, auth: stranger, since: -1, holdMs: 20_000 },
    { op: 'poll', tableId: 'NOPE99', auth, since: -1, holdMs: 20_000 },
  ]) {
    assert.equal(refusal(gate.handle(poll)).code, 'stale', JSON.stringify(poll));
  }
});

/*
 * The page from before pages named their build, which is every page that is open when this is first
 * deployed. Its requests are written out here as that page sends them (src/client/app.ts on main at
 * 2877774), and each answer is checked for what that page's code does with it:
 *
 * - poll: anything not ok, other than the two refusals, puts up "The table is slow to answer. Trying
 *   again…" over the table as it last was and asks again after 1, 2, 4, 8 and then every 10 seconds.
 *   An ok answer of a kind it doesn't know would have it ask again at once, without end.
 * - act, create, join: anything not ok, other than the two refusals, is shown as a toast in the
 *   server's own words, and nothing is sent again.
 * - info: anything but the table or a refusal keeps its join screen asking, every 10 seconds at most.
 * - history: anything but the hands shows "Could not load the hand history."
 * - "unauthorized" or "not_found" to any of them takes the seat out of the address and the browser.
 */
test('the page from before pages named their build is told to reload, keeps its seat and does not hammer the server', () => {
  const { gate, tableId, auth, saved } = setup();
  const before = saved();
  const logsThePlayerOut = (response: ApiResponse) => !response.ok && (response.code === 'unauthorized' || response.code === 'not_found');

  const poll = { op: 'poll', tableId, auth, since: 1, holdMs: 20_000 };
  const polled = refusal(gate.handle(poll));
  assert.equal(polled.code, 'stale', 'it is sent no table to draw wrongly');
  assert.equal(gate.waitFor(poll), null, 'and is turned away at once, not after holding a place among the requests the script may serve');

  const firstPoll = refusal(gate.handle({ op: 'poll', tableId, auth, since: -1 }));
  assert.equal(firstPoll.code, 'stale');

  const commands = [
    { op: 'act', tableId, auth, command: { type: 'fold' } },
    { op: 'act', tableId, auth, command: { type: 'chat', text: 'anyone there?' } },
    { op: 'act', tableId, auth, command: { type: 'requestSeat', seat: 2, buyIn: 500 } },
    { op: 'create', name: 'Host', config: { smallBlind: 5, bigBlind: 10 } },
    { op: 'join', tableId, name: 'Guest' },
  ];

  for (const command of commands) {
    const refused = refusal(gate.handle(command));

    assert.equal(refused.code, 'stale', JSON.stringify(command));
    assert.equal(refused.error, 'The game was updated. Reload to keep playing.', 'the words its toast shows');
    assert.equal(logsThePlayerOut(refused), false);
  }

  const info = gate.handle({ op: 'info', tableId });
  assert.ok(info.ok && info.kind === 'info', 'its join screen is answered, or it would ask without end');
  assert.equal(info.table.id, tableId);

  assert.equal(refusal(gate.handle({ op: 'history', tableId, auth })).code, 'stale');

  for (const response of [polled, firstPoll]) {
    assert.equal(logsThePlayerOut(response), false);
  }

  assert.equal(saved(), before, 'the table is as it was');
});

test('a request that is no request at all is refused, not a crash', () => {
  const { gate } = setup();

  for (const request of [null, [], 'poll', 7, {}, { op: 'launch' }, { op: 'constructor', build: OLDER_BUILD }, { op: '__proto__', build: OLDER_BUILD }]) {
    assert.equal(refusal(gate.handle(request)).code, 'stale', JSON.stringify(request));
    assert.equal(gate.waitFor(request), null);
  }

  assert.equal(refusal(gate.handle({ op: 'launch', build: THIS_BUILD })).code, 'invalid');
});
