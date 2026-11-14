/* What a page reports of its own failures: which, how many, and never a request that went unanswered or was refused. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ServerClock, ServerLine, TableConnection } from '../src/client/connection.ts';
import type { TableListener } from '../src/client/connection.ts';
import { browserOf, PageErrors, REPORTS_PER_LOAD, watchForErrors } from '../src/client/pageErrors.ts';
import type { FailureSource, PageFailure } from '../src/client/pageErrors.ts';
import type { Transport } from '../src/client/transport.ts';
import type { ApiRequest, ApiResponse, Built } from '../src/server/api.ts';

function thrown(message: string, frame = 'at draw (page.js:10:5)'): Error {
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n    ${frame}`;

  return error;
}

test('a failure is reported with its kind, message and trace, once however often it happens', () => {
  const errors = new PageErrors();

  assert.deepEqual(errors.take(thrown('x is undefined')), { message: 'TypeError: x is undefined', trace: 'TypeError: x is undefined\n    at draw (page.js:10:5)' });
  assert.equal(errors.take(thrown('x is undefined')), null);
  assert.ok(errors.take(thrown('x is undefined', 'at other (page.js:99:1)')), 'the same words from another place are another failure');
  assert.deepEqual(errors.take('a string thrown'), { message: 'a string thrown', trace: '' });
});

test('a page load sends three reports at most', () => {
  const errors = new PageErrors();
  const taken = ['a', 'b', 'c', 'd', 'e'].map((word) => errors.take(new Error(word)));

  assert.equal(taken.filter((failure) => failure !== null).length, REPORTS_PER_LOAD);
  assert.deepEqual(taken.slice(REPORTS_PER_LOAD), [null, null]);
});

test("nothing is reported that says only that a request got no answer, or that hides another site's failure", () => {
  const errors = new PageErrors();

  for (const message of ['NetworkError: Connection failure due to HTTP 0', 'TypeError: Failed to fetch', 'TypeError: Load failed', 'ScriptError: We are sorry, a server error occurred', 'Script error.', '', '   ']) {
    assert.equal(errors.take(new Error(message)), null, message);
  }

});

test('a browser is told by its name, major version and kind of device, and nothing else of it', () => {
  const agents: [string, ReturnType<typeof browserOf>][] = [
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.39 Mobile Safari/537.36', { name: 'Chrome', major: 131, device: 'phone' }],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', { name: 'Safari', major: 18, device: 'phone' }],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1', { name: 'Chrome', major: 131, device: 'phone' }],
    ['Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', { name: 'Safari', major: 17, device: 'tablet' }],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0', { name: 'Firefox', major: 132, device: 'desktop' }],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', { name: 'Edge', major: 131, device: 'desktop' }],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', { name: 'Samsung', major: 26, device: 'phone' }],
    ['something else entirely', { name: 'Other', major: 0, device: 'desktop' }],
  ];

  for (const [agent, browser] of agents) {
    assert.deepEqual(browserOf(agent), browser, agent);
  }
});

/** A stand-in for the window: something that throws and something left to reject. */
class Page extends EventTarget {
  fail(error: unknown): void {
    this.dispatchEvent(Object.assign(new Event('error'), { error, message: error instanceof Error ? error.message : String(error) }));
  }

  reject(reason: unknown): void {
    this.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }));
  }
}

test('what the page throws and what it leaves to reject are both reported, through the one sender', () => {
  const page = new Page();
  const sent: PageFailure[] = [];
  watchForErrors(page as unknown as FailureSource, { ready: () => true, send: (failure) => sent.push(failure) });

  const again = new Error('thrown');
  page.fail(again);
  page.reject(new Error('rejected'));
  page.fail(again);

  assert.deepEqual(
    sent.map((failure) => failure.message),
    ['thrown', 'rejected'],
  );
});

test('a failure while the page is at no table is let go without counting, so it neither uses up the reports nor stops the same failure being reported later', () => {
  const page = new Page();
  const sent: PageFailure[] = [];
  let atTable = false;
  watchForErrors(page as unknown as FailureSource, { ready: () => atTable, send: (failure) => sent.push(failure) });

  const again = new Error('in the lobby and at the table');
  for (const word of ['a', 'b', 'c', 'd']) {
    page.fail(new Error(word));
  }
  page.fail(again);
  assert.equal(sent.length, 0);

  atTable = true;
  page.fail(again);
  assert.deepEqual(
    sent.map((failure) => failure.message),
    ['in the lobby and at the table'],
  );
});

test('a report that fails, or that makes the page throw again, is never reported and stops nothing', () => {
  const page = new Page();
  let calls = 0;

  watchForErrors(page as unknown as FailureSource, {
    ready: () => true,
    send: () => {
      calls += 1;

      // As though sending it threw, which the browser would tell as one more failure
      page.fail(new Error('the report itself broke'));
      throw new Error('the report itself broke');
    },
  });

  assert.doesNotThrow(() => page.fail(new Error('first')));
  assert.equal(calls, 1, 'the report reported its own failure');

  assert.doesNotThrow(() => page.fail(new Error('second')));
  assert.equal(calls, 2);
});

/** A connection whose every request is lost, or refused, with a page watching for failures around it. */
async function connectionThat(answer: (request: ApiRequest) => Promise<ApiResponse & Built>): Promise<PageFailure[]> {
  const page = new Page();
  const sent: PageFailure[] = [];
  watchForErrors(page as unknown as FailureSource, { ready: () => true, send: (failure) => sent.push(failure) });

  const unhandled = (reason: unknown) => page.reject(reason);
  process.on('unhandledRejection', unhandled);

  try {
    const transport: Transport = { send: answer };
    const line = new ServerLine(transport, '__BUILD__', () => undefined);
    const listener: TableListener = { view: () => undefined, move: () => undefined, status: () => undefined, refused: () => undefined, notice: () => undefined };
    const table = new TableConnection(line, { tableId: 'ABC234', auth: { id: 'A', token: 'T' } }, new ServerClock(), listener);

    await table.send({ type: 'fold' });
    await table.send({ type: 'chat', text: 'hi' });
    await table.send({ type: 'react', kind: 'laugh' });
    table.close();

    // Lets anything left to reject be told
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', unhandled);
  }

  return sent;
}

test('a request that gets no answer, or is refused, is no failure of the page: nothing is reported', async () => {
  assert.deepEqual(await connectionThat(() => Promise.reject(new Error('NetworkError: Connection failure due to HTTP 0'))), []);
  assert.deepEqual(await connectionThat(() => Promise.reject(new TypeError('Failed to fetch'))), []);
  assert.deepEqual(await connectionThat(async () => ({ ok: false, code: 'unauthorized', error: 'Who are you', build: '__BUILD__' })), []);
  assert.deepEqual(await connectionThat(async () => ({ ok: false, code: 'busy', error: 'The table is busy, try again', build: '__BUILD__' })), []);
});
