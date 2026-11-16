/*
 * The lists git joins by itself when two branches add to them (`merge=union` in .gitattributes). When
 * one branch has moved an entry, the join keeps the line in both places and says nothing, and an
 * entry listed twice passes the type check: the menu would show its line twice.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const JOINED = readFileSync(`${ROOT}.gitattributes`, 'utf8')
  .split('\n')
  .flatMap((line) => (line.endsWith(' merge=union') ? [line.split(' ')[0]!] : []));

test('no list that git joins by itself has an entry twice', () => {
  assert.ok(JOINED.length > 0, 'no joined list was found in .gitattributes');

  for (const path of JOINED) {
    // An entry has a line to itself: a name, or a file's name in quotes, and a comma
    const entries = readFileSync(`${ROOT}${path}`, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^['\w.-]+,$/.test(line));

    assert.ok(entries.length > 0, `${path} has no entries to look at`);
    assert.deepEqual(
      entries.filter((entry, index) => entries.indexOf(entry) !== index),
      [],
      `${path} lists an entry twice, which is what a join leaves when one branch moved it: keep it where the list has it now`,
    );
  }
});
