/*
 * The wait for one build to be the only one that answers at an address, on an address whose answers
 * the test lays out in time, and the asking itself on a stand-in for `fetch`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { answersOver, askRound, QUESTION, QUIET_ANSWERS, QUIET_MS, SETTLE_DEADLINE_MS, untilOnly } from '../scripts/answering.ts';
import type { Answer } from '../scripts/answering.ts';

const NEW = 'the build put there';
const OLD = 'the build it had';
const URL = 'https://script.example/macros/s/abc/exec';

/**
 * An address that answers as the new build, or as `otherwise`, but for what `strays` lays out: at each
 * of those times after the start, the next call is answered that way. `silentUntil` is how long no
 * call is answered at all.
 */
function address(strays: Record<number, Answer> = {}, { silentUntil = 0, otherwise = { build: NEW } as Answer, roundMs = 0 } = {}) {
  let ms = 0;
  const due = Object.entries(strays)
    .map(([at, answer]) => ({ at: Number(at), answer }))
    .sort((a, b) => a.at - b.at);
  const asked: number[] = [];

  return {
    asked,
    elapsed: () => ms,
    asking: {
      answers: {
        ask: async (): Promise<Answer> => {
          asked.push(ms);

          if (ms < silentUntil) {
            return { failed: 'ECONNRESET' };
          }

          return due.length > 0 && due[0]!.at <= ms ? due.shift()!.answer : otherwise;
        },
      },
      now: () => new Date(ms),
      // `roundMs` is how long a round's answers take to come, on top of the pause before it
      pause: async (length: number) => {
        ms += length + roundMs;
      },
    },
  };
}

test('an address where only the build answers is taken to serve it alone after a whole stretch of calls, and not before', async () => {
  const { asking, asked, elapsed } = address();

  assert.deepEqual(await untilOnly(NEW, URL, asking), { settled: true, heard: true, other: null });

  assert.ok(elapsed() >= QUIET_MS && elapsed() < QUIET_MS + 1000, `it waited ${elapsed()} ms`);
  assert.ok(asked.length >= 100, `and asked ${asked.length} times in that stretch, several at a time`);
  assert.equal(asked.filter((at) => at === 0).length, 4);
});

test('a slow address is not taken to serve the build alone on a few answers, however long they took to come', async () => {
  // A round of four answers every ten seconds: five of them fill the stretch, and tell too little
  const { asking, asked, elapsed } = address({}, { roundMs: 10_000 });

  assert.deepEqual(await untilOnly(NEW, URL, asking), { settled: true, heard: true, other: null });

  assert.equal(asked.length, QUIET_ANSWERS, `it settled on ${asked.length} answers`);
  assert.ok(elapsed() > 2 * QUIET_MS && elapsed() < SETTLE_DEADLINE_MS, `after ${elapsed()} ms`);

  // And an answer from the build it had starts the count over, like the stretch
  const strayed = address({ 100_000: { build: OLD } }, { roundMs: 10_000 });

  assert.equal((await untilOnly(NEW, URL, strayed.asking)).settled, true);
  assert.ok(strayed.asked.filter((at) => at > 100_000 + 10_250).length >= QUIET_ANSWERS, 'the answers before it count for nothing');
});

test('one answer from the build the address had starts the stretch over, however long the build was alone before it', async () => {
  // Thirty seconds of the new build alone, then the old one once more
  const { asking, elapsed } = address({ 0: { build: OLD }, 8_000: { build: OLD }, 38_000: { build: OLD } });

  assert.deepEqual(await untilOnly(NEW, URL, asking), { settled: true, heard: true, other: `build ${OLD} answered 45 s ago` });

  assert.ok(elapsed() >= 38_000 + QUIET_MS, `it settled ${elapsed()} ms in`);
});

test('a call that got no answer, or one from code that names no build, starts the stretch over like any other build', async () => {
  for (const [stray, said] of [
    [{ failed: 'ECONNRESET' }, 'a call got no answer (ECONNRESET) 45 s ago'],
    [{ build: null }, 'code from before builds had ids answered 45 s ago'],
  ] as const) {
    const { asking, elapsed } = address({ 30_000: stray });

    assert.deepEqual(await untilOnly(NEW, URL, asking), { settled: true, heard: true, other: said });
    assert.ok(elapsed() >= 30_000 + QUIET_MS, JSON.stringify(stray));
  }
});

test('an address that never comes to answer as the build alone is given up at the deadline, with the last thing heard there that was not the build', async () => {
  // The build it had answers once every twenty seconds, for as long as anyone asks
  const mixed = address(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [10_000 + index * 20_000, { build: OLD }])));

  assert.deepEqual(await untilOnly(NEW, URL, mixed.asking), { settled: false, heard: true, other: `build ${OLD} answered 10 s ago` });
  assert.ok(mixed.elapsed() >= SETTLE_DEADLINE_MS && mixed.elapsed() < SETTLE_DEADLINE_MS + 1000);

  const silent = address({}, { silentUntil: Infinity });

  assert.deepEqual(await untilOnly(NEW, URL, silent.asking), { settled: false, heard: false, other: 'a call got no answer (ECONNRESET) 0 s ago' });

  // The build it had is still alone there: the web app did not take the version
  const untaken = address({}, { otherwise: { build: OLD } });

  assert.deepEqual(await untilOnly(NEW, URL, untaken.asking), { settled: false, heard: false, other: `build ${OLD} answered 0 s ago` });
});

test('an address that answers nothing at first and then as the build alone settles a whole stretch after its first answers', async () => {
  const { asking, elapsed } = address({}, { silentUntil: 20_000 });

  const { settled, heard } = await untilOnly(NEW, URL, asking);

  assert.deepEqual({ settled, heard }, { settled: true, heard: true });
  assert.ok(elapsed() >= 20_000 + QUIET_MS - 1000, `it settled ${elapsed()} ms in`);
});

test('a round of calls tells each build that answered once, and what the calls that told nothing said', async () => {
  const answers = [{ build: NEW }, { build: OLD }, { failed: 'ECONNRESET' }, { build: NEW }];
  const round = await askRound({ ask: async () => answers.shift()! }, URL);

  assert.deepEqual(round, { builds: [NEW, OLD], failed: ['ECONNRESET'] });
  assert.equal(answers.length, 0, 'a round is four calls');
});

/** `fetch`, as far as asking uses it, answering with what the test gives it. */
function posting(respond: () => Promise<{ status: number; text: string }>) {
  const sent: { url: string; method: string; body: string; redirect: string; signal: AbortSignal }[] = [];
  const answers = answersOver(async (url, init) => {
    sent.push({ url, ...init });
    const { status, text } = await respond();

    return { status, text: async () => text };
  });

  return { answers, sent };
}

const answering = (text: string, status = 200) => posting(async () => ({ status, text }));

test('an address is asked by a POST of something that is no request of the game\'s, with a limit on how long the answer may take', async () => {
  const { answers, sent } = answering('{"ok":false,"code":"invalid","error":"Malformed request","build":"abc123def456"}');

  assert.deepEqual(await answers.ask(URL), { build: 'abc123def456' });

  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0]!, signal: null }, { url: URL, method: 'POST', body: QUESTION, redirect: 'follow', signal: null });
  assert.ok(sent[0]!.signal instanceof AbortSignal);
  assert.throws(() => JSON.parse(QUESTION), 'the script must not take it for a request');
});

test('an answer of the game\'s with no build on it is code from before builds had ids, and anything else tells nothing', async () => {
  assert.deepEqual(await answering('{"ok":false,"error":"Malformed request"}').answers.ask(URL), { build: null });
  assert.deepEqual(await answering('{"ok":true,"build":12}').answers.ask(URL), { build: null });

  for (const [text, status] of [
    ['<!DOCTYPE html><html><body>Sign in to continue</body></html>', 200],
    ['<html>Service unavailable</html>', 503],
    ['', 200],
    ['null', 200],
    ['["build"]', 200],
    ['"abc123def456"', 200],
  ] as const) {
    assert.deepEqual(await answering(text, status).answers.ask(URL), { failed: `HTTP ${status}, and nothing the game answers with` }, text);
  }
});

test('a call that fails, or takes too long, is a call that got no answer and never an error', async () => {
  const failing = (error: unknown) =>
    posting(async () => {
      throw error;
    }).answers.ask(URL);

  assert.deepEqual(await failing(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) })), { failed: 'ENOTFOUND' });
  assert.deepEqual(await failing(new TypeError('fetch failed')), { failed: 'fetch failed' });
  assert.deepEqual(await failing(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), { failed: 'none in 20 s' });
  assert.deepEqual(await failing('dropped'), { failed: 'dropped' });

  // The answer starts and its text never comes
  const cutOff = answersOver(async () => ({
    status: 200,
    text: async () => {
      throw new TypeError('terminated');
    },
  }));
  assert.deepEqual(await cutOff.ask(URL), { failed: 'terminated' });
});
