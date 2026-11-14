import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HANDLERS } from '../src/engine/commands/index.ts';
import { SEAT_COUNT } from '../src/engine/index.ts';
import type { Command, Rng, TableState } from '../src/engine/index.ts';
import type { CommandType, Handler } from '../src/engine/commands/handler.ts';
import { SheetStore } from '../src/gas/sheetStore.ts';
import type { ApiResponse, Auth, PageBrowser } from '../src/server/api.ts';
import { BuildGate } from '../src/server/build.ts';
import { described, ERROR_LIMITS, scrub } from '../src/server/errorLog.ts';
import { MemoryErrorLog } from '../src/server/memoryErrorLog.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import type { TableStore } from '../src/server/store.ts';
import { FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';
import { seededRng, TestTable } from './helpers.ts';
import { fixedSettings, randomConfig } from './randomConfig.ts';
import { chance, randomStep } from './randomPlay.ts';

const TOKEN = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CHROME: PageBrowser = { name: 'Chrome', major: 131, device: 'phone' };

// ---- The scrub ----

test('an address keeps its host and path, never its query or fragment, which can carry a seat', () => {
  assert.equal(scrub('Failed to load https://example.com/macros/exec?table=ABC234&me=K7PQ2M3N.SECRET#top now', 200), 'Failed to load https://example.com/macros/exec now');
  assert.equal(scrub('went to /exec?table=ABC234&me=abc.def and back', 200), 'went to /exec?… and back');
  assert.equal(scrub('What? Nothing else', 200), 'What? Nothing else');
});

test('anything shaped like a token goes, a piece of one included, and nothing like an ordinary word', () => {
  assert.equal(scrub(`bad token ${TOKEN} for K7PQ2M3N`, 200), 'bad token … for K7PQ2M3N');
  assert.equal(scrub(`cut ${TOKEN.slice(0, 11)}`, 200), 'cut …');
  assert.equal(scrub('blob dGhpcyBpcyBhIHNlY3JldCB0b2tlbjEyMw== end', 200), 'blob … end');
  assert.equal(scrub('Cannot read properties of undefined (reading handleRequestFailure)', 200), 'Cannot read properties of undefined (reading handleRequestFailure)');
  assert.equal(scrub('table ABC234 is gone', 200), 'table ABC234 is gone', 'a table id is no secret');
});

test('cards go, alone or run together as a deck is, and words that start like one stay', () => {
  assert.equal(scrub('dealt As Kd to seat 3', 200), 'dealt ·· ·· to seat 3');
  assert.equal(scrub('deck AsKdTh2c9s left', 200), 'deck ·· left');
  assert.equal(scrub('cards: [Ah, 7c]', 200), 'cards: [··, ··]');
  assert.equal(scrub('The Thing Ash Ascending', 200), 'The Thing Ash Ascending');
});

test('a dump of JSON and a long quoted span go, short quotes stay', () => {
  assert.equal(scrub('Unexpected token \'x\', "{"id":"ABC234","members":[{"token":"S"}]" is not valid JSON', 200), "Unexpected token 'x', \"…");
  assert.equal(scrub('state [{"cards":["As"]}]', 200), 'state …');
  assert.equal(scrub("reading 'seats' of 'a name somebody typed at the table'", 200), "reading 'seats' of '…'");
});

test('a message is one line and capped, cut cleanly even where a token straddles the cap', () => {
  assert.equal(scrub('one\n  two\tthree', 200), 'one two three');
  assert.equal(scrub('x'.repeat(300), 50).length, 50);
  assert.ok(scrub('x'.repeat(300), 50).endsWith('…'));

  // A token cut in two where reading stops leaves nothing of itself, however short the piece
  const cut = scrub(`${'word '.repeat(3999)}${TOKEN}`, 1_000_000);
  assert.ok(cut.endsWith('word'), cut.slice(-20));
});

test('what was thrown is described by its kind, message and first frames, each frame by its file alone', () => {
  const error = new TypeError(`Cannot read properties of undefined (reading 'stack')`);
  error.stack = [
    `TypeError: Cannot read properties of undefined (reading 'stack')`,
    '    at Table.draw (https://n-abc123def456ghi789jkl012-0lu-script.googleusercontent.com/userCodeAppPanel?table=ABC234&me=X.Y:120:9)',
    '    at App.showView (https://host.example/page.js:44:2)',
  ].join('\n');

  assert.deepEqual(described(error), {
    message: "TypeError: Cannot read properties of undefined (reading 'stack')",
    trace: 'at Table.draw (userCodeAppPanel:120:9) | at App.showView (page.js:44:2)',
  });
  assert.deepEqual(described('plain words'), { message: 'plain words', trace: '' });
  assert.deepEqual(described({ message: 42 }), { message: '42', trace: '' });

  const hostile = {
    get message(): string {
      throw new Error('no');
    },
  };
  assert.deepEqual(described(hostile), { message: 'A failure that could not be read', trace: '' });
});

// ---- The limits, with the clock moved by the test ----

function log() {
  const clock = { time: 1_700_000_000_000, now: () => clock.time };

  return { clock, errors: new MemoryErrorLog(clock) };
}

const fromPage = (memberId: string, tableId = 'ABC234', message = 'Boom') => ({ where: 'page', error: message, tableId, page: { memberId, build: '__BUILD__', browser: CHROME } });

test('the first of a failure is a row, its repeats within ten minutes a count, written as one row by the next report once the window is over', () => {
  const { clock, errors } = log();

  errors.report({ where: 'server act', error: new Error('Sheet failed at row 12'), tableId: 'ABC234' });
  clock.time += 1000;
  errors.report({ where: 'server act', error: new Error('Sheet failed at row 13'), tableId: 'ABC234' });
  errors.report({ where: 'server act', error: new Error('Sheet failed at row 14'), tableId: 'DEF567' });
  assert.equal(errors.rows.length, 1, 'repeats, numbers aside, are counted, not written');
  assert.deepEqual([errors.rows[0]!.times, errors.rows[0]!.message, errors.rows[0]!.tableId], [1, 'Sheet failed at row 12', 'ABC234']);

  // Another failure while the window is open is a row of its own
  errors.report({ where: 'server poll', error: new Error('Other'), tableId: null });
  assert.equal(errors.rows.length, 2);

  clock.time += ERROR_LIMITS.repeatWindowMs;
  errors.report({ where: 'page', error: 'Unrelated', tableId: 'ABC234' });

  const [, , repeats, unrelated] = errors.rows;
  assert.deepEqual([repeats!.where, repeats!.times, repeats!.tableId, repeats!.at], ['server act', 2, '', clock.time - ERROR_LIMITS.repeatWindowMs], 'repeats at two tables name neither');
  assert.match(repeats!.trace, /^Repeats after a first row at /);
  assert.equal(unrelated!.message, 'Unrelated');
  assert.equal(errors.rows.length, 4, 'a window with no repeats closes without a row');
});

test('a failure that comes back after its window gets its count written, then a row of its own as a first again', () => {
  const { clock, errors } = log();

  errors.report({ where: 'server act', error: 'Busy', tableId: 'ABC234' });
  errors.report({ where: 'server act', error: 'Busy', tableId: 'ABC234' });
  clock.time += ERROR_LIMITS.repeatWindowMs + 1;
  errors.report({ where: 'server act', error: 'Busy', tableId: 'ABC234' });

  assert.deepEqual(
    errors.rows.map((row) => [row.times, row.trace.startsWith('Repeats')]),
    [
      [1, false],
      [1, true],
      [1, false],
    ],
  );
});

test('a page is held to three reports a minute from one member, ten from one table and thirty from all of them; the next minute starts afresh', () => {
  const { clock } = log();
  const distinct = new MemoryErrorLog(clock);
  for (const word of ['one', 'two', 'three', 'four']) {
    distinct.report(fromPage('AAAA2222', 'ABC234', word));
  }
  assert.deepEqual(distinct.rows.map((row) => row.message), ['one', 'two', 'three']);

  const tables = new MemoryErrorLog(clock);
  for (let member = 0; member < 12; member++) {
    tables.report(fromPage(`MEMBER${member}`, 'ABC234', `word ${'abcdefghijklmnop'[member]}`));
  }
  assert.equal(tables.rows.length, ERROR_LIMITS.fromTable);

  const overall = new MemoryErrorLog(clock);
  for (let table = 0; table < 40; table++) {
    overall.report({ ...fromPage('AAAA2222', `TBL${String(table).padStart(3, '0')}`, `failure ${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'[table]}`) });
  }
  assert.equal(overall.rows.length, ERROR_LIMITS.rowsPerMinute, 'past twenty rows a minute nothing more is written, from anywhere');

  clock.time += 60_000;
  distinct.report(fromPage('AAAA2222', 'ABC234', 'five'));
  assert.deepEqual(distinct.rows.at(-1)!.message, 'five');
});

test('reports from pages are cut at thirty a minute in all, even when the rows would have room', () => {
  const { clock, errors } = log();
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789ABCDEFGH';

  for (let n = 0; n < 40; n++) {
    // The same words each time, so only the first is a row and the rest are counts that cost no row
    errors.report(fromPage(`MEMBER${letters[n]}`, `TABLE${letters[n]}`, 'Same'));
  }

  assert.equal(errors.rows.length, 1);

  // Once the window is over, the count is of the thirty that were let in, less the first
  clock.time += ERROR_LIMITS.repeatWindowMs;
  errors.report({ where: 'server', error: 'Something else' });
  assert.deepEqual(
    errors.rows.map((row) => [row.message, row.times]),
    [
      ['Same', 1],
      ['Same', ERROR_LIMITS.fromPages - 1],
      ['Something else', 1],
    ],
  );
});

test('at most twenty failures are counted at once: the oldest is let go, with its count written', () => {
  const { clock, errors } = log();

  for (let n = 0; n < ERROR_LIMITS.kinds; n++) {
    errors.report({ where: 'server act', error: `kind ${'abcdefghijklmnopqrstuvwxyz'[n]}` });
    errors.report({ where: 'server act', error: `kind ${'abcdefghijklmnopqrstuvwxyz'[n]}` });
  }

  clock.time += 60_000;
  errors.report({ where: 'server act', error: 'one too many' });

  assert.deepEqual(
    errors.rows.slice(-2).map((row) => [row.message, row.times]),
    [
      ['one too many', 1],
      ['kind a', 1],
    ],
  );
});

// ---- The service ----

function service(store: TableStore = new MemoryStore()) {
  const clock = { time: 1_700_000_000_000, now: () => clock.time };
  const errors = new MemoryErrorLog(clock);
  const game = new PokerService({ store, presets: new MemoryPresetStore(), clock, rng: seededRng(3), errors });
  const host = game.handle({ op: 'create', name: 'Host', config: { minBuyIn: 100 } });
  assert.ok(host.ok && host.kind === 'joined');

  return { game, errors, clock, tableId: host.view.id, auth: host.auth };
}

test('a refusal is an answer and no failure: a bad request, an unknown table or member and an illegal move write nothing', () => {
  const { game, errors, tableId, auth } = service();
  const stranger: Auth = { id: 'NOBODY22', token: TOKEN };

  const answers: ApiResponse[] = [
    game.handle('nonsense'),
    game.handle({ op: 'nothing' }),
    game.handle({ op: 'poll', tableId: 'ZZZ999', auth, since: 0 }),
    game.handle({ op: 'poll', tableId, auth: stranger, since: 0 }),
    game.handle({ op: 'act', tableId, auth, command: { type: 'fold' } }),
    game.handle({ op: 'act', tableId, auth, command: { type: 'requestSeat', seat: 99, buyIn: 1 } }),
    game.handle({ op: 'report', tableId, auth: stranger, message: 'Boom', trace: '', browser: CHROME }),
  ];

  assert.deepEqual(
    answers.map((answer) => !answer.ok && answer.code),
    ['invalid', 'invalid', 'not_found', 'unauthorized', 'invalid', 'invalid', 'unauthorized'],
  );
  assert.deepEqual(errors.rows, []);
});

test('a failure in answering a request is a row naming the operation and the table, and the request still fails as before', () => {
  const { game, errors, tableId, auth } = service();
  const original = HANDLERS.chat;

  HANDLERS.chat = { ...original, run: () => {
    throw new RangeError('Invalid array length');
  } };

  try {
    assert.throws(() => game.handle({ op: 'act', tableId, auth, command: { type: 'chat', text: 'hello' } }), /Invalid array length/);
  } finally {
    HANDLERS.chat = original;
  }

  assert.deepEqual(
    errors.rows.map(({ where, tableId: table, message, times }) => ({ where, table, message, times })),
    [{ where: 'server act', table: tableId, message: 'RangeError: Invalid array length', times: 1 }],
  );
  assert.match(errors.rows[0]!.trace, /^at /);
  assert.equal(errors.rows[0]!.build, '__BUILD__');
});

test('the same error caught again further out, as the Apps Script host does, is written once', () => {
  const { game, errors, tableId } = service();
  const error = new Error('Once only');

  game.failed({ where: 'server act', error, tableId });
  game.failed({ where: 'server', error, tableId });

  assert.equal(errors.rows.length, 1);
});

test('a sweep of old tables that fails is a row, and the table that was being made is made', () => {
  const store = new MemoryStore();
  store.putAwayOld = () => {
    throw new Error('Sweep broke');
  };
  const { errors } = service(store);

  assert.deepEqual(
    errors.rows.map((row) => [row.where, row.message]),
    [['server put away', 'Sweep broke']],
  );
});

test('a lock that could not be had in time is a row, written without waiting for the lock again, and the answer is still busy', () => {
  const lock = new FakeLock();
  const spreadsheet = new FakeSpreadsheet(lock);
  const store = new SheetStore({ spreadsheet: () => spreadsheet, cache: new FakeCache(), lock, flush: () => undefined });
  const { game, errors, tableId, auth } = service(store);

  lock.busy = true;
  lock.waits = [];
  const answer = game.handle({ op: 'act', tableId, auth, command: { type: 'chat', text: 'hello' } });

  assert.deepEqual(answer, { ok: false, code: 'busy', error: 'The table is busy, try again' });
  assert.deepEqual(lock.waits, [20_000], 'the lock was asked for once');
  assert.deepEqual(
    errors.rows.map((row) => [row.where, row.tableId, row.message]),
    [['server act', tableId, 'The lock was not free in time: The table is busy, try again']],
  );
});

test("a member's page reports a failure: one row with the page's build and browser, and the answer says nothing more", () => {
  const { game, errors, tableId, auth } = service();
  const gate = new BuildGate(game, '__BUILD__');

  const answer = gate.handle({ op: 'report', tableId, auth, message: 'TypeError: x is undefined', trace: '    at draw (https://h/page.js?me=A.B:1:2)', browser: CHROME, build: 'olderbuild12' });

  assert.deepEqual(answer, { ok: true, kind: 'reported', build: '__BUILD__' }, 'a page of another build is heard too');
  assert.deepEqual(errors.rows.map(({ at: _at, ...row }) => row), [
    { where: 'page', times: 1, message: 'TypeError: x is undefined', tableId, build: 'olderbuild12 (server __BUILD__)', browser: 'Chrome 131 on a phone', trace: 'at draw (page.js:1:2)' },
  ]);
});

test("a page's report is cut to size and keeps only the browser details the log knows", () => {
  const { game, errors, tableId, auth } = service();

  game.handle({ op: 'report', tableId, auth, message: 'm'.repeat(10_000), trace: 'at x\n'.repeat(10_000), browser: { name: '<script>', major: 5, device: 'phone' }, build: 'b'.repeat(500) });
  game.handle({ op: 'report', tableId, auth, message: 'second', trace: 7, browser: 'Chrome' });

  const [first, second] = errors.rows;
  assert.equal(first!.message.length, 200);
  assert.ok(first!.trace.length <= 600);
  assert.equal(first!.browser, '');
  assert.equal(first!.build, '? (server __BUILD__)');
  assert.deepEqual([second!.message, second!.trace, second!.browser], ['second', '', '']);
});

// ---- Nothing private in a row ----

/** A random table, played on a random number of steps, with the service's store holding it. */
function randomGame(seed: number): { t: TestTable; rng: Rng } {
  const rng = seededRng(seed * 4241);
  const players = 2 + rng.int(SEAT_COUNT - 1);
  const config = randomConfig(rng);
  const t = new TestTable({ stacks: Array.from({ length: players }, () => 100 + rng.int(1900)), seed, config: fixedSettings(config) });
  t.cmd(0, { type: 'updateConfig', config });
  t.cmd(0, { type: 'start' });

  for (let step = rng.int(400); step > 0; step--) {
    randomStep(t, rng);
  }

  return { t, rng };
}

/** Everything a table holds that no row may: every token, and every card that is not face up for the table, hole cards and the deck. */
function secretsOf(state: TableState): { tokens: string[]; cards: string[] } {
  return {
    tokens: state.members.map((member) => member.token),
    cards: [...(state.hand?.players.flatMap((player) => player.cards) ?? []), ...(state.hand?.deck ?? [])],
  };
}

/** An error thrown from inside a handler that quotes the table in one of the ways a real one might. */
function leakingError(state: TableState, rng: Rng): Error {
  const json = JSON.stringify(state);
  const { tokens, cards } = secretsOf(state);
  const member = state.members[rng.int(state.members.length)]!;
  const someCards = cards.slice(0, 1 + rng.int(Math.max(1, cards.length)));

  switch (rng.int(7)) {
    case 0:
      return new Error(json);
    case 1:
      try {
        JSON.parse(json.slice(0, 1 + rng.int(json.length - 1)));
      } catch (error) {
        return error as Error;
      }
      return new Error(json.slice(0, 500));
    case 2:
      return new TypeError(`Cannot deal ${someCards.join(' ')} to ${member.name} with token ${member.token}`);
    case 3:
      return new Error(`Lost at https://script.example/macros/s/x/exec?table=${state.id}&me=${member.id}.${member.token}#${tokens.join(',')}`);
    case 4: {
      const error = new Error('Short and plain');
      error.stack = `Error: Short and plain\n    at run (https://h/x.js?me=${member.id}.${member.token}:1:2)\n    at deal (${someCards.join('')}:3:4)`;
      return error;
    }
    case 5:
      return new Error(`deck ${state.hand?.deck.join('') ?? ''} ${tokens.join('')}`);
    default:
      return new RangeError(`'${json.slice(0, 300)}' is too long`);
  }
}

test('over random games, whatever a handler throws at whatever point, no row holds a token, a hole card or an undealt card', () => {
  let thrown = 0;
  const types = Object.keys(HANDLERS) as CommandType[];

  for (let seed = 1; seed <= 60; seed++) {
    const { t, rng } = randomGame(seed);
    const store = new MemoryStore();
    store.transact(t.state.id, () => ({ save: t.state, at: t.now, effects: [], result: null }));

    const clock = { now: () => t.now };
    const errors = new MemoryErrorLog(clock);
    const game = new PokerService({ store, presets: new MemoryPresetStore(), clock, rng: seededRng(seed), errors });
    const type = types[rng.int(types.length)]!;
    const original = HANDLERS[type] as Handler<CommandType>;
    const member = t.state.members[rng.int(t.state.members.length)]!;
    let secrets = secretsOf(t.state);

    (HANDLERS as Record<CommandType, Handler<CommandType>>)[type] = {
      ...original,
      run: (call: Parameters<Handler<CommandType>['run']>[0]) => {
        // Partway through the command, or before it does anything
        if (chance(rng, 50)) {
          try {
            (original.run as (call: unknown) => void)(call);
          } catch {
            // Refused partway: what the table holds then is still what the error quotes
          }
        }

        secrets = secretsOf(call.state);
        throw leakingError(call.state, rng);
      },
    } as Handler<CommandType>;

    try {
      game.handle({ op: 'act', tableId: t.state.id, auth: { id: member.id, token: member.token }, command: { type } as Command });
    } catch {
      thrown += 1;
    } finally {
      (HANDLERS as Record<CommandType, Handler<CommandType>>)[type] = original;
    }

    const written = JSON.stringify(errors.rows);

    for (const token of secrets.tokens) {
      for (let at = 0; at + 10 <= token.length; at++) {
        assert.ok(!written.includes(token.slice(at, at + 10)), `seed ${seed}: a piece of a token was written: ${written}`);
      }
    }

    for (const card of secrets.cards) {
      assert.doesNotMatch(written, new RegExp(`(?<![A-Za-z0-9])${card}(?![a-z0-9])`), `seed ${seed}: the card ${card} was written: ${written}`);
    }
  }

  assert.ok(thrown >= 20, `only ${thrown} of the games reached the handler`);
});

test('a store given no log, as in most tests, still works and reports nowhere', () => {
  const store = new SheetStore({ spreadsheet: () => new FakeSpreadsheet(), cache: new FakeCache(), lock: new FakeLock(), flush: () => undefined });

  assert.equal(store.read('ABC234'), null);
});
