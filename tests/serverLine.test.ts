import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ServerClock, ServerLine, TableConnection } from '../src/client/connection.ts';
import type { Transport } from '../src/client/transport.ts';
import type { ApiRequest, ApiResponse, Auth, Built } from '../src/server/api.ts';
import { BuildGate } from '../src/server/build.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import { seededRng } from './helpers.ts';

const PAGE_BUILD = 'aaaaaaaaaaaa';
const NEWER_BUILD = 'cccccccccccc';

/** A server the test can update under the page, and everything the page sent it. */
function server() {
  const game = new PokerService({ store: new MemoryStore(), clock: { now: () => Date.now() }, rng: seededRng(3) });
  const sent: (ApiRequest & Built)[] = [];
  let gate = new BuildGate(game, PAGE_BUILD);

  const transport: Transport = {
    send: async (request) => {
      sent.push(request);

      return gate.handle(request);
    },
  };

  return {
    transport,
    sent,
    deploy: () => {
      gate = new BuildGate(game, NEWER_BUILD);
    },
  };
}

/** Whether a promise has come to anything a little later: an answer that is withheld never does. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  const later = new Promise<false>((resolve) => setTimeout(() => resolve(false), 30));

  return Promise.race([promise.then(() => true), later]);
}

async function tableOf(line: ServerLine): Promise<{ tableId: string; auth: Auth; view: Extract<ApiResponse, { kind: 'joined' }>['view'] }> {
  const created = await line.ask({ op: 'create', name: 'Host' });
  assert.ok(created?.ok && created.kind === 'joined', JSON.stringify(created));

  return { tableId: created.view.id, auth: created.auth, view: created.view };
}

test('every request carries the build of the page, and an answer from the same build is handed on', async () => {
  const { transport, sent } = server();
  let outdated = 0;
  const line = new ServerLine(transport, PAGE_BUILD, () => (outdated += 1));

  const { tableId, auth } = await tableOf(line);
  const poll = await line.ask({ op: 'poll', tableId, auth, since: -1 });
  assert.ok(poll?.ok && poll.kind === 'view');

  const refused = await line.ask({ op: 'info', tableId: 'NOPE99' });
  assert.ok(refused && !refused.ok && refused.code === 'not_found', 'a refusal from the same build is the page’s to act on');

  assert.deepEqual(sent.map((request) => request.build), [PAGE_BUILD, PAGE_BUILD, PAGE_BUILD]);
  assert.equal(outdated, 0);
});

test('a request that gets no answer says nothing about the build', async () => {
  let outdated = 0;
  const line = new ServerLine({ send: () => Promise.reject(new Error('offline')) }, PAGE_BUILD, () => (outdated += 1));

  assert.equal(await line.ask({ op: 'info', tableId: 'ABC123' }), null);
  assert.equal(outdated, 0);
});

test('an answer from another build is told once and handed to nobody, and nothing more is sent', async () => {
  const { transport, sent, deploy } = server();
  let outdated = 0;
  const line = new ServerLine(transport, PAGE_BUILD, () => (outdated += 1));
  const { tableId, auth } = await tableOf(line);

  deploy();
  sent.length = 0;

  // The newer build answers this one with the table, which this page may not understand
  assert.equal(await settles(line.ask({ op: 'poll', tableId, auth, since: -1 })), false);
  assert.equal(outdated, 1);

  assert.equal(await settles(line.ask({ op: 'act', tableId, auth, command: { type: 'chat', text: 'hi' } })), false);
  assert.equal(await settles(line.ask({ op: 'poll', tableId, auth, since: -1 })), false);
  assert.equal(sent.length, 1, 'only the request that found out was sent');
  assert.equal(outdated, 1);
});

test('what a newer build says about a seat or a table being gone never reaches the page', async () => {
  const { transport, deploy } = server();
  const line = new ServerLine(transport, PAGE_BUILD, () => undefined);
  const { tableId } = await tableOf(line);

  deploy();

  // "unauthorized" from the newer build: acted on, it would take the seat out of the address
  assert.equal(await settles(line.ask({ op: 'poll', tableId, auth: { id: 'NOBODY00', token: 'wrong' }, since: -1 })), false);
});

test('a request still on its way when the page finds out is not handed its answer either', async () => {
  const answers: ((response: ApiResponse & Built) => void)[] = [];
  const line = new ServerLine({ send: () => new Promise((resolve) => answers.push(resolve)) }, PAGE_BUILD, () => undefined);

  const held = line.ask({ op: 'poll', tableId: 'ABC123', auth: { id: 'a', token: 'b' }, since: 4, holdMs: 20_000 });
  const move = line.ask({ op: 'act', tableId: 'ABC123', auth: { id: 'a', token: 'b' }, command: { type: 'fold' } });

  answers[1]!({ ok: false, code: 'stale', error: 'The game was updated. Reload to keep playing.', build: NEWER_BUILD });
  assert.equal(await settles(move), false);

  // The poll that was waiting comes back from the old server, with "nothing new"
  answers[0]!({ ok: true, kind: 'unchanged', now: 5, build: PAGE_BUILD });
  assert.equal(await settles(held), false, 'the poll would otherwise go round again');
});

test('a table connection whose move the newer build refused tells nobody, sends it once and stops asking', async () => {
  const { transport, sent, deploy } = server();
  const line = new ServerLine(transport, PAGE_BUILD, () => undefined);
  const { tableId, auth, view } = await tableOf(line);
  const told: string[] = [];

  const connection = new TableConnection(line, { tableId, auth }, new ServerClock(), {
    view: () => told.push('view'),
    status: () => told.push('status'),
    refused: () => told.push('refused'),
    notice: (message) => told.push(message),
  });
  connection.take(view);

  deploy();
  sent.length = 0;
  told.length = 0;

  assert.equal(await settles(connection.send({ type: 'fold' })), false);
  assert.deepEqual(told, ['status'], 'the buttons were locked for the move, and nothing was said or drawn after');
  assert.equal(connection.turnLocked, true, 'the move is never free to be pressed again');

  // Coming back to the tab, or anything else that asks afresh, sends nothing
  connection.refresh(true);
  await settles(new Promise(() => undefined));
  assert.deepEqual(sent.map((request) => request.op), ['act']);
});
