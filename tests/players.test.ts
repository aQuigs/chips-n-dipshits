import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LIMITS } from '../src/engine/index.ts';
import type { Command, KnownPlayer } from '../src/engine/index.ts';
import { SheetPlayerStore } from '../src/gas/sheetPlayerStore.ts';
import { SheetStore } from '../src/gas/sheetStore.ts';
import type { ApiResponse, Auth, Who } from '../src/server/api.ts';
import { BuildGate } from '../src/server/build.ts';
import { MemoryPlayerStore } from '../src/server/memoryPlayerStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { ListFull, SEEN_EVERY_MS } from '../src/server/playerStore.ts';
import type { PlayerStore } from '../src/server/playerStore.ts';
import { PokerService } from '../src/server/service.ts';
import { StoreBusyError } from '../src/server/store.ts';
import type { TableStore } from '../src/server/store.ts';
import { Calls, FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import { DAY_MS, failure, joined, seededRng, viewOf } from './helpers.ts';

const NOW = 1_700_000_000_000;

function setup(players: PlayerStore = new MemoryPlayerStore(seededRng(12)), store: TableStore = new MemoryStore()) {
  const clock = { time: NOW, now: () => clock.time };
  const service = new PokerService({ store, presets: new MemoryPresetStore(), players, clock, rng: seededRng(11) });

  const listed = (): KnownPlayer[] => {
    const response = service.handle({ op: 'players' });
    assert.ok(response.ok && response.kind === 'players', JSON.stringify(response));

    return response.players;
  };

  const create = (name: string, who?: Who, config?: object) => service.handle({ op: 'create', name, who, config });
  const join = (tableId: string, name: string, who?: Who) => service.handle({ op: 'join', tableId, name, who });
  const poll = (tableId: string, auth: Auth) => service.handle({ op: 'poll', tableId, auth, since: -1 });
  const act = (tableId: string, auth: Auth, command: Command) => service.handle({ op: 'act', tableId, auth, command });
  const identify = (tableId: string, auth: Auth, who: Who, name?: string) => service.handle({ op: 'identify', tableId, auth, who, name });

  return { service, store, players, clock, listed, create, join, poll, act, identify };
}

/**
 * The game as it is deployed: tables and players both in the Sheet, behind the script cache and the
 * one script lock. Each store's calls are told apart, so that those made for the list of players can
 * be counted, and failed, without touching those made for the table.
 */
function deployed() {
  const lock = new FakeLock();
  const calls = { tables: new Calls(), players: new Calls() };
  const sheet = new FakeSpreadsheet(lock, { Players: 1 + LIMITS.knownPlayers }, calls.players, [], { Players: LIMITS.nameLength });
  const cache = new FakeCache(calls.players);
  const tableSheet = new FakeSpreadsheet(lock, {}, calls.tables);
  const tables = new SheetStore({ spreadsheet: () => tableSheet, cache: new FakeCache(calls.tables), lock, flush: () => calls.tables.note('flush') });
  const players = new SheetPlayerStore({ spreadsheet: () => sheet, cache, lock, flush: () => calls.players.note('flush'), rng: seededRng(77) });

  return { ...setup(players, tables), lock, calls, sheet, cache, tab: () => sheet.sheets.get('Players')! };
}

const NEW: Who = { as: 'new' };
const known = (id: string): Who => ({ as: 'known', id });

test('someone new who makes a table or joins one goes on the list of players, and is that player at every table from then on', () => {
  const { listed, create, join } = setup();
  assert.deepEqual(listed(), []);

  const quigs = joined(create('Quigs', NEW));
  const [onList] = listed();
  assert.deepEqual(listed(), [{ id: quigs.view.you.identity, name: 'Quigs' }]);

  const bob = joined(join(quigs.view.id, ' Bob ', NEW));
  assert.equal(bob.view.you.name, 'Bob');
  assert.deepEqual(listed().map((player) => player.name).sort(), ['Bob', 'Quigs']);
  assert.deepEqual(bob.view.members, [
    { id: quigs.auth.id, name: 'Quigs', identity: onList!.id },
    { id: bob.auth.id, name: 'Bob', identity: bob.view.you.identity },
  ]);

  // Another night, another table: picked from the list, they are the same player under the list's name for them
  const next = joined(create('Bob', known(bob.view.you.identity!)));
  const again = joined(join(next.view.id, 'whatever the page had', known(onList!.id)));

  assert.equal(next.view.you.identity, bob.view.you.identity);
  assert.deepEqual(again.view.you, { id: again.auth.id, name: 'Quigs', role: 'member', seat: null, identity: onList!.id });
  assert.equal(listed().length, 2, 'picking a player adds nobody');
});

test('a request that does not say who its sender is makes a member nobody knows, and asks nothing of the list', () => {
  const asked: string[] = [];
  const untouched: PlayerStore = {
    list: () => (asked.push('list'), []),
    seen: () => (asked.push('seen'), null),
    add: () => {
      throw new Error('asked to add');
    },
  };
  const { create, join, poll } = setup(untouched);

  const host = joined(create('Host'));
  const guest = joined(join(host.view.id, 'Guest'));

  assert.deepEqual([host.view.you.identity, guest.view.you.identity], [null, null]);
  assert.deepEqual(viewOf(poll(host.view.id, host.auth)).members.map((member) => member.identity), [null, null]);
  assert.deepEqual(asked, []);
});

test('a player the list does not have, as after their row was removed, gets in under the name the page had for them, known to nobody', () => {
  const { listed, create, join } = setup();
  const host = joined(create('Host'));

  const gone = joined(join(host.view.id, 'Bob', known('GONE234')));
  assert.deepEqual(gone.view.you, { id: gone.auth.id, name: 'Bob', role: 'member', seat: null, identity: null });

  // The name was the list's and not theirs to change, so a table that has it makes room all the same
  assert.equal(joined(join(host.view.id, 'Bob', known('GONE234'))).view.you.name, 'Bob 2');
  assert.equal(joined(create('Bob', known('GONE234'))).view.you.identity, null);
  assert.deepEqual(listed(), []);
});

test('a request that says who its sender is in a shape the game does not know is refused, and makes nothing', () => {
  const { service, store, listed, create } = setup();
  const host = joined(create('Host'));

  for (const who of ['Bob', 7, [], {}, { as: 'known' }, { as: 'known', id: 7 }, { as: 'someone else' }, { id: 'ABCDEFG' }]) {
    for (const request of [{ op: 'create', name: 'Ann', who }, { op: 'join', tableId: host.view.id, name: 'Ann', who }, { op: 'identify', tableId: host.view.id, auth: host.auth, who }]) {
      assert.deepEqual(service.handle(request), { ok: false, code: 'invalid', error: 'Malformed request' }, JSON.stringify(request));
    }
  }

  assert.deepEqual(listed(), []);
  assert.equal(store.read(host.view.id)!.members.length, 1);
});

test('someone new under a name the list has is told whose it is and how to go on, and is neither listed nor let in', () => {
  const { store, listed, create, join } = setup();
  const host = joined(create('Big Al', NEW));
  const message = 'Big Al is already on the list of players. If that is you, pick Big Al from the list. If not, add something to your name';

  for (const name of ['Big Al', 'big al', 'BIG  AL', 'BigAl', 'Big AI', 'BIG AI']) {
    assert.deepEqual(join(host.view.id, name, NEW), { ok: false, code: 'invalid', error: message }, name);
    assert.deepEqual(create(name, NEW), { ok: false, code: 'invalid', error: message }, name);
  }

  assert.equal(listed().length, 1);
  assert.equal(store.read(host.view.id)!.members.length, 1);
  assert.equal(joined(join(host.view.id, 'Big Al K', NEW)).view.you.name, 'Big Al K');
});

test('a name the list has is said to be the list\'s even where the table has it too, since picking from the list is what gets its holder in', () => {
  const { listed, create, join } = setup();
  const host = joined(create('Host'));
  const al = joined(join(host.view.id, 'Big Al', NEW));

  assert.match(failure(join(host.view.id, 'Big Al', NEW)).error, /^Big Al is already on the list of players/);
  assert.equal(joined(join(host.view.id, 'Big Al', known(al.view.you.identity!))).view.you.name, 'Big Al 2');
  assert.equal(listed().length, 1);
});

test('someone new the table would turn away is not put on the list by trying', () => {
  const { listed, create, join } = setup();
  const host = joined(create('Host'));
  joined(join(host.view.id, 'Guest'));

  assert.match(failure(join(host.view.id, 'guest', NEW)).error, /Someone at this table is already called guest/);
  assert.match(failure(join(host.view.id, '=1+1', NEW)).error, /Names start with/);
  assert.match(failure(join(host.view.id, 'x'.repeat(LIMITS.nameLength + 1), NEW)).error, /1 to 16 characters/);
  assert.equal(failure(join('NOSUCH', 'Ann', NEW)).code, 'not_found');
  assert.equal(failure(create('Ann', NEW, { minBuyIn: 500, maxBuyIn: 100 })).code, 'invalid');
  assert.equal(failure(create('', NEW)).code, 'invalid');
  assert.deepEqual(listed(), []);

  for (let watching = 2; watching < LIMITS.members; watching++) {
    joined(join(host.view.id, `Watcher ${watching}`));
  }

  assert.match(failure(join(host.view.id, 'Ann', NEW)).error, /This table is full/);
  assert.deepEqual(listed(), []);
});

test('picking a player who is already at the table makes a second member of their own: it gives nothing of the first one\'s seat, token or cards', () => {
  const { service, store, clock, create, join, poll, act } = setup();
  const host = joined(create('Host', NEW, { minBuyIn: 100 }));
  const tableId = host.view.id;
  const bob = joined(join(tableId, 'Bob', NEW));

  for (const [seat, auth] of [host.auth, bob.auth].entries()) {
    viewOf(act(tableId, auth, { type: 'requestSeat', seat, buyIn: 1000 }));
  }
  viewOf(act(tableId, host.auth, { type: 'approve', playerId: bob.auth.id }));
  viewOf(act(tableId, host.auth, { type: 'start' }));

  // Polled until the cards are out, then from another browser someone says they are Bob
  const state = () => store.read(tableId)!;
  for (let waited = 0; !state().hand && waited < 50; waited++) {
    clock.time += 1000;
    poll(tableId, host.auth);
  }
  const bobsCards = state().hand!.players.find((player) => player.playerId === bob.auth.id)!.cards;
  assert.equal(bobsCards.length, 2);

  const other = joined(join(tableId, 'Bob', known(bob.view.you.identity!)));

  assert.equal(other.view.you.identity, bob.view.you.identity);
  assert.equal(other.view.you.name, 'Bob 2');
  assert.equal(other.view.you.seat, null);
  assert.notEqual(other.auth.id, bob.auth.id);
  assert.notEqual(other.auth.token, bob.auth.token);

  // Nothing they are ever sent holds the first Bob's token or either of his cards
  const sent = [other, poll(tableId, other.auth), service.handle({ op: 'history', tableId, auth: other.auth }), act(tableId, other.auth, { type: 'chat', text: 'hello' })];
  for (const answer of sent) {
    const text = JSON.stringify(answer);

    assert.equal(answer.ok, true, text);
    assert.ok(!text.includes(bob.auth.token), 'an answer held another member\'s token');
    assert.ok(bobsCards.every((card) => !text.includes(JSON.stringify(card))), 'an answer held another member\'s cards');
  }
  assert.deepEqual(viewOf(poll(tableId, other.auth)).seats[1]!.cards, [null, null]);

  // Nor can they act for him: a move is the mover's own, and his id opens nothing without his token
  const toAct = state().hand!.toAct;
  assert.match(failure(act(tableId, other.auth, { type: 'fold' })).error, /./);
  assert.equal(state().hand!.toAct, toAct);
  assert.equal(failure(poll(tableId, { id: bob.auth.id, token: other.auth.token })).code, 'unauthorized');
  assert.equal(failure(act(tableId, { id: bob.auth.id, token: other.auth.token }, { type: 'fold' })).code, 'unauthorized');
  assert.equal(failure(act(tableId, other.auth, { type: 'requestSeat', seat: 1, buyIn: 1000 })).code, 'invalid');

  // The first Bob is where he was, with what he had
  const first = viewOf(poll(tableId, bob.auth));
  assert.deepEqual(first.you, { id: bob.auth.id, name: 'Bob', role: 'member', seat: 1, identity: bob.view.you.identity });
  assert.deepEqual(first.seats[1]!.cards, bobsCards);
});

test('when the list of players cannot be asked or written to, everyone still gets in, as nobody it knows', () => {
  const failures: [string, () => never][] = [
    ['an outage', () => { throw new Error('Service Spreadsheets failed'); }],
    ['the lock being busy', () => { throw new StoreBusyError('The list of players is busy, try again'); }],
    ['the list being full', () => { throw new ListFull(); }],
  ];

  for (const [what, fail] of failures) {
    const { create, join, poll } = setup({ list: fail, seen: fail, add: fail });

    const host = joined(create('Host', NEW));
    const ann = joined(join(host.view.id, 'Ann', NEW));
    const bob = joined(join(host.view.id, 'Bob', known('ABCDEFG')));
    const second = joined(join(host.view.id, 'Bob', known('ABCDEFG')));

    assert.deepEqual([host, ann, bob, second].map((member) => member.view.you.identity), [null, null, null, null], what);
    assert.deepEqual(viewOf(poll(host.view.id, host.auth)).members.map((member) => member.name), ['Host', 'Ann', 'Bob', 'Bob 2'], what);
  }
});

test('whichever call for the list of players fails while someone makes a table or joins one, they get in, and the list is left whole', () => {
  const arrivals: Record<string, (game: ReturnType<typeof deployed>, tableId: string, ann: KnownPlayer) => ApiResponse> = {
    'someone new joins': ({ join }, tableId) => join(tableId, 'Quigs', NEW),
    'someone new makes a table': ({ create }) => create('Quigs', NEW),
    'a known player joins on a new night': ({ join, clock }, tableId, ann) => {
      clock.time += DAY_MS;
      return join(tableId, 'Ann', known(ann.id));
    },
    'a known player joins when the list is not cached': ({ join, cache }, tableId, ann) => {
      cache.entries.clear();
      return join(tableId, 'Ann', known(ann.id));
    },
  };

  for (const [what, arrive] of Object.entries(arrivals)) {
    const fresh = () => {
      const game = deployed();
      const host = joined(game.create('Host'));
      const ann = game.players.add('Ann', NOW);
      game.calls.players.made = [];

      return { game, tableId: host.view.id, ann };
    };

    const clean = fresh();
    joined(arrive(clean.game, clean.tableId, clean.ann));
    const steps = [...clean.game.calls.players.made];
    assert.ok(steps.length >= 3, `${what} makes only ${steps.length} calls for the list`);

    for (let failing = 1; failing <= steps.length; failing++) {
      const { game, tableId, ann } = fresh();
      const step = `${what}, call ${failing}, ${steps[failing - 1]}`;

      game.calls.players.failNth(failing);
      const arrived = joined(arrive(game, tableId, ann));

      assert.equal(game.lock.held, false, step);
      assert.equal(arrived.view.you.name, what.startsWith('someone new') ? 'Quigs' : 'Ann', step);

      // Known or not, they are whoever the list says, never someone else and never someone it does not have
      const said = game.listed();
      game.cache.entries.clear();
      assert.deepEqual(said, game.listed(), `${step}: the cache was behind the tab`);

      const identity = arrived.view.you.identity;
      assert.ok(identity === null || said.some((player) => player.id === identity && player.name === arrived.view.you.name), `${step}: joined as ${identity}`);
      assert.deepEqual(viewOf(game.poll(arrived.view.id, arrived.auth)).you, arrived.view.you, step);
    }
  }
});

test('the table lets someone new in before the list hears of them: whichever of the table\'s calls fails, nobody is on the list for a join that came to nothing, and whoever did get in can be who the list says', () => {
  const fresh = () => {
    const game = deployed();
    const host = joined(game.create('Host'));

    game.listed();
    game.calls.tables.made = [];

    return { game, tableId: host.view.id };
  };

  const clean = fresh();
  joined(clean.game.join(clean.tableId, 'Quigs', NEW));
  const steps = [...clean.game.calls.tables.made];
  assert.equal(steps.filter((call) => call === 'Tables.setValues').length, 2, 'the row is written once to let them in and once to say who they are');

  const outcomes = { turnedAway: 0, known: 0, unknown: 0 };

  for (let failing = 1; failing <= steps.length; failing++) {
    const { game, tableId } = fresh();
    const step = `call ${failing}, ${steps[failing - 1]}`;

    game.calls.tables.failNth(failing);

    // A failure of the Sheet itself is no answer at all, which the page takes as one to ask again
    let answer: ApiResponse | null = null;
    try {
      answer = game.join(tableId, 'Quigs', NEW);
    } catch {
      answer = null;
    }

    assert.equal(game.lock.held, false, step);

    if (!answer?.ok) {
      outcomes.turnedAway += 1;
      assert.deepEqual(game.listed(), [], `${step}: on the list without having got in`);

      // The same request sent again finds no name of its own in its way on the list
      const again = game.join(tableId, 'Quigs', NEW);
      assert.ok(again.ok || /already called Quigs/.test(again.error), `${step}: ${JSON.stringify(again)}`);
      continue;
    }

    const [listedAs] = game.listed();
    const you = viewOf(game.poll(tableId, joined(answer).auth)).you;
    assert.equal(you.name, 'Quigs', step);
    assert.deepEqual(listedAs?.name, 'Quigs', step);

    if (you.identity === null) {
      outcomes.unknown += 1;
      assert.equal(viewOf(game.identify(tableId, joined(answer).auth, known(listedAs!.id))).you.identity, listedAs!.id, step);
    } else {
      outcomes.known += 1;
      assert.equal(you.identity, listedAs!.id, step);
    }
  }

  assert.ok(outcomes.turnedAway > 0 && outcomes.unknown > 0, JSON.stringify(outcomes));
});

test('what the list of players costs a join in calls to the Sheet: none without it or for a player seen tonight, and the same few for someone new whether nobody is known or fifty are', () => {
  const READ = ['spreadsheet.getSheetByName', 'Players.getLastRow', 'Players.getValues'];
  const WRITE = ['Players.setNumberFormats', 'Players.setValues', 'flush'];

  for (const knownAlready of [0, 50]) {
    const { create, join, listed, players, calls, cache, clock } = deployed();
    const host = joined(create('Host'));
    const listedPlayers = Array.from({ length: knownAlready }, (_player, index) => players.add(`Player ${index}`, NOW));
    const at = `with ${knownAlready} known`;

    // The page asks for the list as it opens, which is what leaves it in the cache for the join that follows
    listed();

    const counted = (work: () => ApiResponse) => {
      calls.players.made = [];
      joined(work());

      const sheetCalls = calls.players.made.filter((name) => !name.startsWith('cache.'));
      return { sheet: sheetCalls.length, cache: calls.players.made.length - sheetCalls.length, made: sheetCalls };
    };

    assert.deepEqual(counted(() => join(host.view.id, 'Nobody')), { sheet: 0, cache: 0, made: [] }, `${at}: a join that does not say who`);

    if (knownAlready > 0) {
      const seenTonight = counted(() => join(host.view.id, 'Player 7', known(listedPlayers[7]!.id)));
      assert.deepEqual(seenTonight, { sheet: 0, cache: 1, made: [] }, `${at}: a known player seen tonight`);

      clock.time += SEEN_EVERY_MS;
      const newNight = counted(() => join(host.view.id, 'Player 8', known(listedPlayers[8]!.id)));
      assert.deepEqual(newNight.made, [...READ, ...WRITE], `${at}: a known player on a new night`);
    }

    const someoneNew = counted(() => join(host.view.id, 'Someone new', NEW));
    // The first player ever also makes the tab and writes its headers
    assert.deepEqual(someoneNew.made, knownAlready > 0 ? [...READ, ...WRITE] : ['spreadsheet.getSheetByName', 'spreadsheet.insertSheet', 'Players.setValues', 'Players.getLastRow', 'Players.getValues', ...WRITE], `${at}: someone new`);
    assert.equal(someoneNew.cache, 2, `${at}: someone new asks the cache for the list and leaves it the new one`);

    // After five minutes on the page the cache has let the list go, and a join reads it once more
    cache.entries.clear();
    assert.deepEqual(counted(() => join(host.view.id, 'Slow to join', NEW)).made, [...READ, ...READ, ...WRITE], `${at}: someone new, the list not cached`);

    const someone = listed().find((player) => player.name === 'Someone new')!;
    cache.entries.clear();
    assert.deepEqual(counted(() => join(host.view.id, someone.name, known(someone.id))).made, READ, `${at}: a known player, the list not cached`);
  }
});

test('the list anyone with the address may ask for holds each player\'s id and name and nothing else: not when they were seen, nor anything of a table', () => {
  const { service, create, join, clock } = deployed();
  const host = joined(create('Host', NEW));
  const bob = joined(join(host.view.id, 'Bob', NEW));

  // Seen again on another night, at a table of his own
  clock.time += DAY_MS;
  const again = joined(create('Bob', known(bob.view.you.identity!)));

  const response = service.handle({ op: 'players' });
  assert.deepEqual(response, { ok: true, kind: 'players', players: [{ id: bob.view.you.identity, name: 'Bob' }, { id: host.view.you.identity, name: 'Host' }] });

  const said = JSON.stringify(response);
  for (const theirs of [host.view.id, again.view.id, host.auth.id, host.auth.token, bob.auth.id, bob.auth.token, again.auth.id, again.auth.token]) {
    assert.ok(!said.includes(theirs), `the list held ${theirs}`);
  }
});

test('a name gets on the list only with a table made, a table joined, or a member saying who they are: no other request puts one there, whatever it says of itself', () => {
  const { service, create, join, identify, listed } = setup();
  const host = joined(create('Host'));
  const tableId = host.view.id;
  const stranger = { id: 'STRANGER', token: 'X'.repeat(24) };
  const asNew = { name: 'Mallory', who: NEW };

  const tries: object[] = [
    { op: 'players', ...asNew },
    { op: 'info', tableId, ...asNew },
    { op: 'presets', ...asNew },
    { op: 'poll', tableId, auth: stranger, since: -1, ...asNew },
    { op: 'history', tableId, auth: stranger, ...asNew },
    { op: 'act', tableId, auth: stranger, command: { type: 'chat', text: 'hi' }, ...asNew },
    { op: 'act', tableId, auth: host.auth, command: { type: 'chat', text: 'hi' }, ...asNew },
    { op: 'identify', tableId, auth: stranger, ...asNew },
    { op: 'identify', tableId, auth: { id: host.auth.id, token: stranger.token }, ...asNew },
    { op: 'identify', tableId: 'NOSUCH', auth: host.auth, ...asNew },
    { op: 'join', tableId: 'NOSUCH', ...asNew },
    { op: 'join', tableId, name: 'host', who: NEW },
    { op: 'create', config: { minBuyIn: 500, maxBuyIn: 100 }, ...asNew },
    { op: 'nonsense', ...asNew },
  ];

  for (const request of tries) {
    service.handle(request);
    assert.deepEqual(listed(), [], JSON.stringify(request));
  }

  // Each of the three ways adds the one name, once
  joined(create('Ann', NEW));
  assert.deepEqual(listed().map((player) => player.name), ['Ann']);
  joined(join(tableId, 'Bob', NEW));
  assert.deepEqual(listed().map((player) => player.name).sort(), ['Ann', 'Bob']);
  viewOf(identify(tableId, host.auth, NEW));
  assert.deepEqual(listed().map((player) => player.name).sort(), ['Ann', 'Bob', 'Host']);
});

test('a member whose player was taken off the list by hand, or renamed there, goes on playing under the name the table has for them', () => {
  const { store, clock, create, join, poll, act, identify, listed, cache, tab } = deployed();
  const host = joined(create('Host', NEW, { minBuyIn: 100 }));
  const tableId = host.view.id;
  const bob = joined(join(tableId, 'Bob', NEW));
  const bobWas = bob.view.you.identity!;

  // Whoever runs the game renames the host and clears Bob's row
  tab().cells[1]![1] = 'Hostess';
  tab().cells[2] = ['', '', '', ''];
  cache.entries.clear();
  assert.deepEqual(listed(), [{ id: host.view.you.identity, name: 'Hostess' }]);

  assert.equal(viewOf(poll(tableId, bob.auth)).you.identity, bobWas);
  assert.equal(viewOf(act(tableId, bob.auth, { type: 'chat', text: 'still here' })).members[1]!.identity, bobWas);
  assert.equal(joined(join(tableId, 'Cy', NEW)).view.members.length, 3);

  // Both sit and play a hand, each shown by the name they joined under
  for (const [seat, auth] of [host.auth, bob.auth].entries()) {
    viewOf(act(tableId, auth, { type: 'requestSeat', seat, buyIn: 1000 }));
  }
  viewOf(act(tableId, host.auth, { type: 'approve', playerId: bob.auth.id }));
  viewOf(act(tableId, host.auth, { type: 'start' }));

  for (let waited = 0; !store.read(tableId)!.hand && waited < 50; waited++) {
    clock.time += 1000;
    poll(tableId, host.auth);
  }

  const mover = [host, bob].find((member) => member.auth.id === store.read(tableId)!.hand!.players[store.read(tableId)!.hand!.toAct!]!.playerId)!;
  const played = viewOf(act(tableId, mover.auth, { type: 'fold' }));
  assert.deepEqual(played.seats.slice(0, 2).map((seat) => seat!.name), ['Host', 'Bob']);
  assert.deepEqual(played.members.map((member) => member.name), ['Host', 'Bob', 'Cy']);
  assert.deepEqual(viewOf(poll(tableId, bob.auth)).you, { id: bob.auth.id, name: 'Bob', role: 'member', seat: 1, identity: bobWas });

  // The renamed player is the list's name at the next table they come to, and the same player
  const next = joined(create('Host', known(host.view.you.identity!)));
  assert.deepEqual([next.view.you.name, next.view.you.identity], ['Hostess', host.view.you.identity]);

  // Saying it again finds nobody, and saying who they are now works as for anyone
  assert.deepEqual(identify(tableId, bob.auth, known(bobWas)), { ok: false, code: 'invalid', error: 'That player is no longer on the list. Pick again' });
  const now = viewOf(identify(tableId, bob.auth, NEW));
  assert.notEqual(now.you.identity, bobWas);
  assert.deepEqual(listed().map((player) => player.name).sort(), ['Bob', 'Cy', 'Hostess']);
});

test('a member can say who they are after joining, as someone on the list or someone new, and keeps their name, seat and token', () => {
  const { store, create, join, poll, act, identify, listed } = setup();
  const host = joined(create('Host', NEW, { minBuyIn: 100 }));
  const tableId = host.view.id;
  const bob = joined(create('Bob', NEW)).view.you.identity!;
  const guest = joined(join(tableId, 'Bobby'));
  viewOf(act(tableId, guest.auth, { type: 'requestSeat', seat: 3, buyIn: 500 }));
  viewOf(act(tableId, host.auth, { type: 'approve', playerId: guest.auth.id }));

  const said = viewOf(identify(tableId, guest.auth, known(bob)));
  assert.deepEqual(said.you, { id: guest.auth.id, name: 'Bobby', role: 'member', seat: 3, identity: bob });
  assert.equal(said.feed.at(-1)!.text, 'Bobby is Bob on the list of players');
  assert.equal(viewOf(poll(tableId, guest.auth)).you.identity, bob, 'the same token still opens the same seat');
  assert.equal(store.read(tableId)!.members[1]!.token, guest.auth.token);

  // As someone new: under the name they go by here unless they give another
  const ann = joined(join(tableId, 'Ann'));
  const cy = joined(join(tableId, 'Cy'));
  const annNow = viewOf(identify(tableId, ann.auth, NEW));
  const cyNow = viewOf(identify(tableId, cy.auth, NEW, 'Cyrus'));

  assert.deepEqual(listed().filter((player) => [annNow.you.identity, cyNow.you.identity].includes(player.id)).map((player) => player.name).sort(), ['Ann', 'Cyrus']);
  assert.equal(cyNow.you.name, 'Cy');
  assert.equal(cyNow.feed.at(-1)!.text, 'Cy is Cyrus on the list of players');

  // It can be said again, and otherwise
  assert.equal(viewOf(identify(tableId, cy.auth, known(annNow.you.identity!))).you.identity, annNow.you.identity);
});

test('saying who you are is refused when it cannot be done, and never without the member\'s own token', () => {
  const busy: PlayerStore = {
    list: () => [],
    seen: () => { throw new StoreBusyError('The list of players is busy, try again'); },
    add: () => { throw new StoreBusyError('The list of players is busy, try again'); },
  };

  for (const players of [undefined, busy]) {
    const { service, store, create, join, identify, listed } = setup(players);
    const host = joined(create('Host'));
    const ann = joined(join(host.view.id, 'Ann'));
    const before = JSON.stringify(store.read(host.view.id));

    assert.equal(failure(identify(host.view.id, { id: ann.auth.id, token: host.auth.token }, NEW)).code, 'unauthorized');
    assert.equal(failure(identify(host.view.id, { id: 'NOBODY23', token: ann.auth.token }, NEW)).code, 'unauthorized');
    assert.equal(failure(identify('NOSUCH', ann.auth, NEW)).code, 'not_found');
    assert.deepEqual(listed(), [], 'a request without the token put someone on the list');

    if (players === busy) {
      assert.deepEqual(identify(host.view.id, ann.auth, NEW), { ok: false, code: 'busy', error: 'The list of players is busy, try again' });
      assert.deepEqual(identify(host.view.id, ann.auth, known('ABCDEFG')), { ok: false, code: 'busy', error: 'The list of players is busy, try again' });
    } else {
      assert.equal(failure(identify(host.view.id, ann.auth, known('ABCDEFG'))).error, 'That player is no longer on the list. Pick again');
      assert.match(failure(identify(host.view.id, ann.auth, NEW, '=1')).error, /Names start with/);
      assert.deepEqual(service.handle({ op: 'identify', tableId: host.view.id, auth: ann.auth }), { ok: false, code: 'invalid', error: 'The request does not say who you are' });
    }

    assert.equal(JSON.stringify(store.read(host.view.id)), before);
  }
});

test('the list of players is handed to a page of another build, and saying who you are is not', () => {
  const { service, create, join, listed } = setup();
  const host = joined(create('Host', NEW));
  const ann = joined(join(host.view.id, 'Ann'));
  const gate = new BuildGate(service, 'this-build');

  assert.deepEqual(gate.handle({ op: 'players', build: 'an-older-build' }), { ok: true, kind: 'players', players: listed(), build: 'this-build' });
  assert.equal(failure(gate.handle({ op: 'identify', build: 'an-older-build', tableId: host.view.id, auth: ann.auth, who: NEW })).code, 'stale');
  assert.equal(listed().length, 1);
});
