/*
 * The page's half of a join or a new table that may have to be asked twice (`Arrivals`), played
 * against the game itself over a line that loses what it is told to.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { Arrivals } from '../src/client/arrivals.ts';
import type { Arrival } from '../src/client/arrivals.ts';
import type { ApiRequest, ApiResponse, Who } from '../src/server/api.ts';
import { askingOf, MemoryArrivalKeys } from '../src/server/arrivalKeys.ts';
import { MemoryPlayerStore } from '../src/server/memoryPlayerStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import { failure, joined, seededRng } from './helpers.ts';

const NOW = 1_700_000_000_000;
const NEW: Who = { as: 'new' };
const real = (bytes: number) => new Uint8Array(randomBytes(bytes));

/** What becomes of one request: it is answered, its answer is lost, it never arrives, or the server acts on it and then says to try again. */
type Fate = 'answered' | 'answer lost' | 'never arrives' | 'busy after';

/** The game with a table at it, and a page's arrivals over a line whose next requests meet the fates given, in order. */
function game(...fates: Fate[]) {
  const players = new MemoryPlayerStore(seededRng(2));
  const service = new PokerService({ store: new MemoryStore(), presets: new MemoryPresetStore(), players, clock: { now: () => NOW }, rng: seededRng(1) });
  const tableId = joined(service.handle({ op: 'create', name: 'Quigs', who: NEW })).view.id;

  const sent: (ApiRequest & { key?: string })[] = [];
  const answers: ApiResponse[] = [];

  const arrivals = new Arrivals(real, async (request) => {
    const fate = fates.shift() ?? 'answered';
    sent.push(request);

    if (fate === 'never arrives') {
      return null;
    }

    answers.push(service.handle(request));

    return fate === 'answered' ? answers.at(-1)! : fate === 'busy after' ? { ok: false, code: 'busy', error: 'The table is busy, try again' } : null;
  });

  const join = (name: string, who: Who = NEW): Arrival => ({ op: 'join', tableId, name, who });
  const members = () => service['store'].read(tableId)!.members.map((member) => member.name);

  return { arrivals, players, service, tableId, sent, answers, join, members, keys: () => sent.map((request) => request.key) };
}

test('a join whose answer is lost, tried again in the same words, is the member the first asking made', async () => {
  const { arrivals, join, members, answers, keys, players } = game('answer lost');

  assert.equal(await arrivals.ask(join('Bob')), null);
  const second = joined((await arrivals.ask(join('Bob')))!);

  assert.deepEqual(second.auth, joined(answers[0]!).auth);
  assert.deepEqual(members(), ['Quigs', 'Bob']);
  assert.deepEqual(players.list().map((player) => player.name).sort(), ['Bob', 'Quigs']);
  assert.equal(keys()[0], keys()[1]);
  assert.equal(keys().length, 2);
});

test('a new table whose answer is lost, tried again, is the table that was made', async () => {
  const { arrivals, answers, keys, players } = game('answer lost');
  const create: Arrival = { op: 'create', name: 'Zed', who: NEW, config: { smallBlind: 5, bigBlind: 10 } };

  assert.equal(await arrivals.ask(create), null);
  const second = joined((await arrivals.ask({ ...create, config: { ...create.config } }))!);

  assert.equal(second.view.id, joined(answers[0]!).view.id);
  assert.deepEqual(second.auth, joined(answers[0]!).auth);
  assert.deepEqual(players.list().map((player) => player.name).sort(), ['Quigs', 'Zed']);
  assert.equal(keys()[0], keys()[1]);
});

test('an arrival that never reached the server, or that it acted on before saying to try again, arrives once', async () => {
  const { arrivals, join, members, answers, keys } = game('never arrives', 'busy after');

  assert.equal(await arrivals.ask(join('Bob')), null);
  assert.equal(failure((await arrivals.ask(join('Bob')))!).code, 'busy');
  const third = joined((await arrivals.ask(join('Bob')))!);

  assert.deepEqual(third.auth, joined(answers[0]!).auth);
  assert.deepEqual(members(), ['Quigs', 'Bob']);
  assert.equal(new Set(keys()).size, 1, 'the three tries went under more than one key');
});

test('a refusal is an answer: what is asked after it is another arrival, and so is the same arrival once it was let in', async () => {
  const { arrivals, join, keys } = game();

  // Quigs made the table as someone new, so the list has the name
  assert.match(failure((await arrivals.ask(join('Quigs')))!).error, /already on the list of players/);
  assert.match(failure((await arrivals.ask(join('Quigs')))!).error, /already on the list of players/);
  joined((await arrivals.ask(join('Bob')))!);
  assert.match(failure((await arrivals.ask(join('Bob')))!).error, /already on the list of players/);

  assert.equal(new Set(keys()).size, 4, 'a key was used for a second arrival');
});

test('an arrival in other words is another arrival, with a key of its own', async () => {
  const { arrivals, join, members, keys } = game('answer lost', 'answer lost');

  await arrivals.ask(join('Bob'));
  await arrivals.ask(join('Bobby'));
  joined((await arrivals.ask(join('Bobby')))!);

  // Asked for again in the first words, the first arrival does not get its key back
  await arrivals.ask(join('Bob'));

  assert.deepEqual(members(), ['Quigs', 'Bob', 'Bobby']);
  assert.deepEqual([keys()[1] === keys()[2], new Set(keys()).size], [true, 3]);
});

test('an answer does not give up the key of an arrival asked in other words since', async () => {
  const waiting: ((response: ApiResponse | null) => void)[] = [];
  const sent: (ApiRequest & { key?: string })[] = [];
  const arrivals = new Arrivals(real, (request) => {
    sent.push(request);

    return new Promise((resolve) => waiting.push(resolve));
  });

  const asBob: Arrival = { op: 'join', tableId: 'ABC234', name: 'Bob', who: NEW };
  const asBobby: Arrival = { ...asBob, name: 'Bobby' };

  const first = arrivals.ask(asBob);
  const second = arrivals.ask(asBobby);
  waiting[0]!({ ok: false, code: 'invalid', error: 'No' });
  waiting[1]!(null);
  await Promise.all([first, second]);

  void arrivals.ask(asBobby);
  assert.equal(sent[2]!.key, sent[1]!.key, 'the arrival without an answer lost its key to the answer of another');
});

test('a visitor whose join got no answer finds their name on the list, says that is them, and is the member the first asking made', async () => {
  const { arrivals, join, members, answers, sent, players } = game('answer lost');

  assert.equal(await arrivals.ask(join('Big Cy')), null);

  // The list has them now, which the first asking did, and its name for them is what the page sends for the pick
  const listed = players.list().find((player) => player.name === 'Big Cy')!;
  const second = joined((await arrivals.ask(join(listed.name, { as: 'known', id: listed.id })))!);

  assert.deepEqual(second.auth, joined(answers[0]!).auth);
  assert.equal(second.view.you.identity, listed.id);
  assert.deepEqual(members(), ['Quigs', 'Big Cy']);
  assert.deepEqual(sent[1], sent[0], 'something other than the first asking was sent');
  assert.equal(sent.length, 2);
});

test('the same for a new table: the host who says the name on the list is theirs gets the table their first asking made', async () => {
  const { arrivals, answers, sent, players } = game('answer lost');
  const create: Arrival = { op: 'create', name: 'Zed', who: NEW, config: { smallBlind: 5, bigBlind: 10 } };

  assert.equal(await arrivals.ask(create), null);

  const listed = players.list().find((player) => player.name === 'Zed')!;
  const second = joined((await arrivals.ask({ ...create, who: { as: 'known', id: listed.id } }))!);

  assert.equal(second.view.id, joined(answers[0]!).view.id);
  assert.equal(sent.length, 2);
});

test('when the name was on the list before, the first asking never having arrived, saying that is them joins them as that player, and no refusal is shown for it', async () => {
  const { arrivals, join, members, sent, players, keys } = game('never arrives');
  const listed = players.add('Cy', NOW);

  // Sent before the page had the list; the list then shows the name
  assert.equal(await arrivals.ask(join('cy')), null);
  const second = joined((await arrivals.ask(join(listed.name, { as: 'known', id: listed.id })))!);

  assert.equal(second.view.you.identity, listed.id);
  assert.deepEqual(members(), ['Quigs', 'Cy']);
  assert.deepEqual(sent.map((request) => 'who' in request && request.who?.as), ['new', 'new', 'known']);
  assert.deepEqual([keys()[0] === keys()[1], keys()[1] === keys()[2]], [true, false]);
});

test('while the line is still down the pick is not sent: the first asking keeps its key until it is answered', async () => {
  const { arrivals, join, members, answers, sent, players, keys } = game('answer lost', 'answer lost');

  await arrivals.ask(join('Cy'));
  const listed = players.list().find((player) => player.name === 'Cy')!;
  const pick = join(listed.name, { as: 'known', id: listed.id });

  assert.equal(await arrivals.ask(pick), null);
  const third = joined((await arrivals.ask(pick))!);

  assert.deepEqual(third.auth, joined(answers[0]!).auth);
  assert.deepEqual(members(), ['Quigs', 'Cy']);
  assert.equal(new Set(keys()).size, 1);
  assert.equal(sent.length, 3);
});

test('a pick that is not the name the first asking gave, or is for another table, is another arrival and nothing is asked before it', async () => {
  const { arrivals, join, members, sent, players, service, keys } = game('answer lost', 'answer lost', 'answer lost');
  const ann = players.add('Ann', NOW);
  const elsewhere = joined(service.handle({ op: 'create', name: 'Dee', who: NEW })).view.id;

  await arrivals.ask(join('Bob'));
  await arrivals.ask(join(ann.name, { as: 'known', id: ann.id }));
  assert.equal(sent.length, 2, 'the asking as Bob was sent again for a visitor who says they are Ann');

  // Someone new at one table, and then the player of that name at another
  await arrivals.ask(join('Eve'));
  const eve = players.list().find((player) => player.name === 'Eve')!;
  joined((await arrivals.ask({ op: 'join', tableId: elsewhere, name: eve.name, who: { as: 'known', id: eve.id } }))!);

  assert.equal(sent.length, 4);
  assert.equal(new Set(keys()).size, 4);
  assert.deepEqual(members(), ['Quigs', 'Bob', 'Ann', 'Eve']);
});

test('a key is one the server takes, and as hard to guess as the bytes it was made from', async () => {
  const wanted: number[] = [];
  const keysOf = async (random: (bytes: number) => Uint8Array, count: number) => {
    const sent: string[] = [];
    const arrivals = new Arrivals(random, async (request) => {
      sent.push((request as { key: string }).key);

      return { ok: false, code: 'invalid', error: 'No' };
    });

    for (let asked = 0; asked < count; asked += 1) {
      await arrivals.ask({ op: 'join', tableId: 'ABC234', name: 'Bob', who: NEW });
    }

    return sent;
  };

  const made = await keysOf((bytes) => {
    wanted.push(bytes);

    return real(bytes);
  }, 200);

  assert.ok(made.every((key) => askingOf(new MemoryArrivalKeys({ now: () => NOW }), key, 'words')), 'the server would refuse it, or take it for no key');
  assert.equal(new Set(made).size, made.length);
  assert.ok(wanted.every((bytes) => bytes >= 16), 'made from fewer than 128 bits');

  // Every byte the browser gives decides one symbol, and no symbol is likelier than another
  assert.equal(new Set(made.join('')).size, 64);

  const [fromZeros] = await keysOf((bytes) => new Uint8Array(bytes), 1);
  const [fromOnes] = await keysOf((bytes) => new Uint8Array(bytes).fill(255), 1);
  assert.deepEqual([new Set(fromZeros).size, new Set(fromOnes).size, fromZeros === fromOnes, fromZeros!.length], [1, 1, false, wanted[0]]);
});
