/*
 * Runs the very script that is pushed to Apps Script, in a JavaScript context that has nothing in it
 * but stand-ins for Apps Script's own services. Anything the bundle wrongly expects from Node or a
 * browser fails here instead of on the first real deployment.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import type { Plugin } from 'esbuild';

import { buildFiles, buildOf } from '../scripts/bundle.ts';
import type { Build } from '../scripts/bundle.ts';
import type { ApiRequest, ApiResponse, Built } from '../src/server/api.ts';
import { UNSTAMPED_BUILD } from '../src/server/build.ts';
import { FakeCache, FakeLock, FakeSpreadsheet } from './fakes.ts';

const DEPLOYED_AT = 'https://script.example/macros/s/abc/exec';

/**
 * What Apps Script does to a script in a page it serves: it takes out comments, reading the code the
 * way a browser from before template literals and without a notion of regular expressions would.
 * Only quoted strings are safe from it.
 */
function withoutWhatReadsAsComments(js: string): string {
  let kept = '';
  let quote: string | null = null;

  for (let at = 0; at < js.length; at++) {
    const char = js[at]!;
    const pair = js.slice(at, at + 2);

    if (quote) {
      kept += char === '\\' ? pair : char;
      at += char === '\\' ? 1 : 0;
      quote = char === quote || char === '\n' ? null : quote;
    } else if (pair === '//') {
      const lineEnd = js.indexOf('\n', at);
      at = lineEnd === -1 ? js.length : lineEnd - 1;
    } else if (pair === '/*') {
      const end = js.indexOf('*/', at + 2);
      at = end === -1 ? js.length : end + 1;
    } else {
      quote = char === '"' || char === "'" ? char : null;
      kept += char;
    }
  }

  return kept;
}

const SCRIPT_ELEMENT = /(<script[^>]*>)([\s\S]*?)(<\/script>)/g;

class FakeHtmlOutput {
  title = '';
  meta: Record<string, string> = {};
  private readonly content: string;

  constructor(content: string) {
    this.content = content.replace(SCRIPT_ELEMENT, (_, open: string, js: string, close: string) => open + withoutWhatReadsAsComments(js) + close);
  }

  getContent(): string {
    return this.content;
  }

  setTitle(title: string): this {
    this.title = title;
    return this;
  }

  addMetaTag(name: string, content: string): this {
    this.meta[name] = content;
    return this;
  }
}

interface DeployedScript {
  api(body: string): string;
  doGet(event: unknown): FakeHtmlOutput;
  doPost(event: unknown): { content: string; mimeType: string };
  spreadsheet: FakeSpreadsheet;
  /** The id of the build that was deployed, which its page sends with every request. */
  build: string;
}

const appScript = (html: string) => [...html.matchAll(SCRIPT_ELEMENT)].map((found) => found[2]!).sort((a, b) => b.length - a.length)[0]!;

// Built once for every test here: each deploys it anew, with a Sheet of its own
const BUILT: Promise<Build> = buildFiles(DEPLOYED_AT);

async function deploy(): Promise<DeployedScript> {
  const { id, files } = await BUILT;
  const code = files['gas/Code.js']!;
  const page = files['gas/index.html']!;
  const spreadsheet = new FakeSpreadsheet();
  const cache = new FakeCache();
  const lock = new FakeLock();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));

  const context = vm.createContext({
    console: { error: () => undefined, log: () => undefined },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush: () => undefined },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => lock },
    Utilities: { getUuid: () => randomUUID(), sleep: (ms: number) => void Atomics.wait(sleeper, 0, 0, ms) },
    ScriptApp: { getService: () => ({ getUrl: () => DEPLOYED_AT }) },
    HtmlService: {
      createHtmlOutputFromFile: () => new FakeHtmlOutput(page),
      createHtmlOutput: (html: string) => new FakeHtmlOutput(html),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (content: string) => ({
        content,
        mimeType: '',
        setMimeType(mimeType: string) {
          this.mimeType = mimeType;
          return this;
        },
      }),
    },
  });

  vm.runInContext(code, context);

  return { api: context.api, doGet: context.doGet, doPost: context.doPost, spreadsheet, build: id };
}

/** Asks as the page of the same build does. */
function call(script: DeployedScript, request: ApiRequest): ApiResponse & Built {
  return JSON.parse(script.api(JSON.stringify({ ...request, build: script.build }))) as ApiResponse & Built;
}

test('the script pushed to Apps Script plays a hand using nothing but Apps Script services', async () => {
  const script = await deploy();

  const created = call(script, { op: 'create', name: 'Host' });
  assert.ok(created.ok && created.kind === 'joined');
  const tableId = created.view.id;

  const joined = call(script, { op: 'join', tableId, name: 'Guest' });
  assert.ok(joined.ok && joined.kind === 'joined');

  const act = (auth: typeof created.auth, command: Extract<ApiRequest, { op: 'act' }>['command']) => {
    const response = call(script, { op: 'act', tableId, auth, command });
    assert.ok(response.ok && response.kind === 'view', JSON.stringify(response));

    return response.view;
  };

  act(created.auth, { type: 'requestSeat', seat: 0, buyIn: 1000 });
  act(joined.auth, { type: 'requestSeat', seat: 4, buyIn: 1000 });
  act(created.auth, { type: 'approve', playerId: joined.auth.id });
  const started = act(created.auth, { type: 'start' });

  // A held poll waits out the pause before the first hand and comes back with the cards dealt
  const dealt = call(script, { op: 'poll', tableId, auth: created.auth, since: started.version, holdMs: 10_000 });
  assert.ok(dealt.ok && dealt.kind === 'view');
  assert.equal(dealt.view.hand?.number, 1);
  assert.equal(dealt.view.seats[0]!.cards?.length, 2);

  const firstToAct = dealt.view.hand!.toAct === 0 ? created.auth : joined.auth;
  const afterFold = act(firstToAct, { type: 'fold' });
  assert.equal(afterFold.hand?.stage, 'done');

  assert.ok(script.spreadsheet.getSheetByName('Tables'), 'the table was saved to the Sheet');
  assert.ok(script.spreadsheet.getSheetByName('Ledger'), 'the buy-ins were written to the ledger');
});

test('a held poll gives up after the time it was asked to wait', async () => {
  const script = await deploy();
  const created = call(script, { op: 'create', name: 'Host' });
  assert.ok(created.ok && created.kind === 'joined');

  const asked = Date.now();
  const response = call(script, { op: 'poll', tableId: created.view.id, auth: created.auth, since: created.view.version, holdMs: 600 });
  const waited = Date.now() - asked;

  assert.ok(response.ok && response.kind === 'unchanged');
  assert.ok(waited >= 600 && waited < 3000, `waited ${waited} ms`);
});

test("the page's script reaches the browser whole, although Apps Script takes out what it reads as comments", async () => {
  const built = await BUILT;
  const script = await deploy();
  const page = script.doGet({}).getContent();
  const served = appScript(page);

  assert.equal(served.length, appScript(built.files['gas/index.html']!).length, 'nothing was cut out of it');
  assert.doesNotThrow(() => new vm.Script(served));
  assert.equal(buildOf(page), built.id, 'nor out of the line that says which build the page is');
});

test('the page and the script of one build say they are the same build', async () => {
  const built = await BUILT;
  const script = await deploy();

  assert.match(built.id, /^[0-9a-f]{12}$/);
  assert.equal(buildOf(built.files['gas/index.html']!), built.id);
  assert.equal(buildOf(built.files['web/index.html']!), built.id, 'the page for another host is the same build');
  assert.equal(call(script, { op: 'info', tableId: 'NOPE99' }).build, built.id, 'the script answers as that build');
  assert.equal(JSON.parse(script.api('not json')).build, built.id, 'even when it fails');

  for (const [path, content] of Object.entries(built.files)) {
    assert.equal(content.includes(UNSTAMPED_BUILD), false, `${path} was left unstamped`);
  }

  // The page that is served is refused nothing, and one that says it is another build is
  const created = call(script, { op: 'create', name: 'Host' });
  assert.ok(created.ok && created.kind === 'joined');

  const fromAnother = JSON.parse(script.api(JSON.stringify({ op: 'create', name: 'Host', build: '000000000000' }))) as ApiResponse & Built;
  assert.ok(!fromAnother.ok && fromAnother.code === 'stale', JSON.stringify(fromAnother));
  assert.equal(fromAnother.build, built.id);
});

/** Builds as if a line had been added to one source file, without touching the file. */
function withALineAddedTo(file: string): Plugin {
  return {
    name: 'edited',
    setup(build) {
      build.onLoad({ filter: new RegExp(`${file.replaceAll('.', '[.]')}$`) }, async ({ path }) => ({
        contents: `${await readFile(path, 'utf8')}\nglobalThis.edited = true;\n`,
        loader: 'ts',
      }));
    },
  };
}

test('the build id follows what was built: the same twice over, and another when the page or the rules change', async () => {
  const [first, second, otherPage, otherRules] = await Promise.all([
    BUILT,
    buildFiles(DEPLOYED_AT),
    buildFiles(DEPLOYED_AT, [withALineAddedTo('src/client/app.ts')]),
    buildFiles(DEPLOYED_AT, [withALineAddedTo('src/engine/hand.ts')]),
  ]);

  assert.equal(second.id, first.id);
  assert.deepEqual(second.files, first.files);

  assert.notEqual(otherPage.id, first.id, 'a change to the page');
  assert.notEqual(otherRules.id, first.id, 'a change to the rules');
  assert.notEqual(otherRules.id, otherPage.id);

  // The rules run on the server alone, and the page of that build still has to know it is not the page of this one
  assert.equal(appScript(otherRules.files['gas/index.html']!), appScript(first.files['gas/index.html']!));
  assert.equal(buildOf(otherRules.files['gas/index.html']!), otherRules.id);
});

test('the served page is told its address and the table in the link, and nothing else from the link', async () => {
  const script = await deploy();

  const page = script.doGet({ parameter: { table: 'K7QF2M', me: 'AB12CD34.token123' } });
  assert.match(page.getContent(), /window\.CND_BOOT = \{"baseUrl":"https:\/\/script\.example\/macros\/s\/abc\/exec","table":"K7QF2M","me":"AB12CD34\.token123"\};/);
  assert.equal(page.title, "Chips n' Dipshits");
  assert.match(page.meta.viewport ?? '', /width=device-width/);

  const hostile = script.doGet({ parameter: { table: '</script><script>alert(1)</script>', me: '"};alert(1);//' } });
  assert.match(hostile.getContent(), /"table":null,"me":null/);
  assert.doesNotMatch(hostile.getContent(), /alert\(1\)/);

  const bare = script.doGet({});
  assert.match(bare.getContent(), /"table":null,"me":null/);
});

test('the same API answers over HTTP for a page hosted elsewhere, and bad input is an error, not a crash', async () => {
  const script = await deploy();

  const posted = script.doPost({ postData: { contents: JSON.stringify({ op: 'info', tableId: 'NOPE99', build: script.build }) } });
  assert.equal(posted.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(posted.content), { ok: false, code: 'not_found', error: JSON.parse(posted.content).error, build: script.build });

  for (const body of ['not json', 'null', '[]', '{"op":"launch"}', '{"op":"poll","tableId":5,"since":"x","holdMs":{}}']) {
    const answer = JSON.parse(script.api(body)) as ApiResponse;
    assert.equal(answer.ok, false, body);
  }

  // Longer than a cache key may be: it has to be turned away before the cache is asked
  const endless = JSON.stringify({ op: 'poll', tableId: 'X'.repeat(300), auth: { id: 'a', token: 'b' }, since: 0, holdMs: 5000, build: script.build });
  const asked = Date.now();
  assert.deepEqual(JSON.parse(script.api(endless)).code, 'not_found');
  assert.ok(Date.now() - asked < 1000, 'and without being held open');
});
