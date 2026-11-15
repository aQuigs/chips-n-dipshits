/*
 * Rules of the screen checks that can be read off their source. Each was a check that failed once on a
 * slow machine and passed when run again; CLAUDE.md has the rules that cannot be checked this way.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHECKS = 'scripts/screenChecks.ts';
const PAGE = 'src/client';

/** The lines of a file that match, each with where it is, so a failure says what to change. */
function linesWith(path: string, pattern: RegExp): string[] {
  return readFileSync(`${ROOT}${path}`, 'utf8')
    .split('\n')
    .flatMap((line, index) => (pattern.test(line) ? [`${path}:${index + 1}: ${line.trim().slice(0, 100)}`] : []));
}

test('no screen check sets a page’s clock', () => {
  assert.deepEqual(linesWith(CHECKS, /\.clock\.(setFixedTime|setSystemTime)\(/), [], 'the rig holds every page’s clock to its own: move time with rig.advance');
});

test('no screen check asks the screen for a toast', () => {
  assert.deepEqual(linesWith(CHECKS, /\.toast\b/), [], 'a toast is gone from the screen in seconds: ask what the page told with toastTold or toasts (scripts/pageSpies.ts)');
});

test('no screen check gives a wait a timeout of its own', () => {
  assert.deepEqual(linesWith(CHECKS, /\btimeout:/), [], 'the rig’s timeout is the one with room for a slow runner');
});

test('the page tells the time by Date.now alone, which is what a rig holds', () => {
  const sources = readdirSync(`${ROOT}${PAGE}`, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts'));
  assert.ok(sources.length > 50, 'the page’s sources were not found');

  // With nothing in the brackets a Date is the time now, which is what the rig cannot hold; made from a time it is only that time written out
  assert.deepEqual(sources.flatMap((name) => linesWith(`${PAGE}/${name}`, /\bnew Date\(\s*\)|\bnew Date\b(?!\()|(?<!new )\bDate\(\s*\)|performance\.timeOrigin/)), [], 'a page that read the time another way would run ahead of a rig’s clock');
});
