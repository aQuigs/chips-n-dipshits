/*
 * Rules of the screen checks that can be read off their source. Each was a check that failed once on a
 * slow machine and passed when run again; CLAUDE.md has the rules that cannot be checked this way.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHECKS = ['scripts/screenChecks.ts', 'scripts/accessibilityChecks.ts', 'scripts/menuChecks.ts'];
const CLIENT = 'src/client';

/** The lines of a file that match, each with where it is, so a failure says what to change. */
function linesWith(path: string, pattern: RegExp): string[] {
  return readFileSync(`${ROOT}${path}`, 'utf8')
    .split('\n')
    .flatMap((line, index) => (pattern.test(line) ? [`${path}:${index + 1}: ${line.trim().slice(0, 100)}`] : []));
}

/** The same over every file the screen checks are written in. */
const checkLinesWith = (pattern: RegExp): string[] => CHECKS.flatMap((path) => linesWith(path, pattern));

test('no screen check sets a page’s clock', () => {
  assert.deepEqual(checkLinesWith(/\.clock\.(setFixedTime|setSystemTime)\(/), [], 'the rig holds every page’s clock to its own: move time with rig.advance');
});

test('no screen check asks the screen for a toast', () => {
  assert.deepEqual(checkLinesWith(/\.toast\b/), [], 'a toast is gone from the screen in seconds: ask what the page told with toastTold or toasts (scripts/pageSpies.ts)');
});

test('no screen check empties what a page wrote down, or reads its moves but by the table’s version', () => {
  assert.deepEqual(checkLinesWith(/\b(flights|played|buzzes|notices|titles|toasts|spoken)\.(splice\(|shift\(|pop\(|length\s*=(?!=))/), [], 'a page that is behind brings the last step’s news after the emptying: ask for what one step brought');
  assert.deepEqual(checkLinesWith(/window\.flights\b/), [], 'ask with flightsSince(table.version from before the step), or flown(page, since) (scripts/pageSpies.ts)');
});

test('no screen check gives a wait a timeout of its own', () => {
  assert.deepEqual(checkLinesWith(/\btimeout:/), [], 'the rig’s timeout is the one with room for a slow runner');
});

test('the page tells the time by Date.now alone, which is what a rig holds', () => {
  const sources = readdirSync(`${ROOT}${CLIENT}`, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts'));
  assert.ok(sources.length > 50, 'the page’s sources were not found');

  // With nothing in the brackets a Date is the time now, which is what the rig cannot hold; made from a time it is only that time written out
  assert.deepEqual(sources.flatMap((name) => linesWith(`${CLIENT}/${name}`, /\bnew Date\(\s*\)|\bnew Date\b(?!\()|(?<!new )\bDate\(\s*\)|performance\.timeOrigin/)), [], 'a page that read the time another way would run ahead of a rig’s clock');
});
