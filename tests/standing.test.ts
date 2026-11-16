import assert from 'node:assert/strict';
import { test } from 'node:test';

import { standingName, standingOf, standingSays } from '../src/client/standing.ts';
import type { Straddle, TableConfig } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';

const EVERY_STRADDLE: Partial<TableConfig> = { allowDoubleStraddle: true, allowButtonStraddle: true, allowMississippiStraddle: true };

/** What the first player's button under the table says, and the name of the dialog it opens, with `straddles` and Always chop as given. */
function button(config: Partial<TableConfig>, straddles: Straddle[] = [], alwaysChop = false) {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config });

  for (const kind of straddles) {
    t.cmd(0, { type: 'setStraddle', kind, on: true });
  }

  if (alwaysChop) {
    t.cmd(0, { type: 'setAlwaysChop', on: true });
  }

  const standing = standingOf(t.view(0));

  return standing && { says: standingSays(standing), opens: standingName(standing) };
}

const same = (words: string) => ({ full: words, brief: words });

test('with nothing on, the button says what is behind it, and that it is off', () => {
  assert.deepEqual(button({}), { says: same('Straddle: off'), opens: same('Straddle') });
  assert.deepEqual(button(EVERY_STRADDLE), { says: same('Straddles: off'), opens: same('Straddles') });
  assert.deepEqual(button({ allowStraddle: false, allowChop: true }), { says: same('Always chop: off'), opens: same('Always chop') });
  assert.deepEqual(button({ allowChop: true }), {
    says: { full: 'Straddle and chop: off', brief: 'Straddle, chop: off' },
    opens: { full: 'Straddle and chop', brief: 'Straddle, chop' },
  });
});

test('a table that allows no straddle and no chop has no button', () => {
  assert.equal(button({ allowStraddle: false }), null);
});

test('a straddle that is on is on the face of the button, whatever else is behind it', () => {
  assert.deepEqual(button({}, ['straddle'])!.says, same('Straddle: on'));
  assert.deepEqual(button({ allowChop: true }, ['straddle'])!.says, same('Straddle: on'));
  assert.deepEqual(button(EVERY_STRADDLE, ['straddle'])!.says, same('Straddle: on'));
  assert.deepEqual(button(EVERY_STRADDLE, ['straddle', 'button straddle', 'Mississippi straddle'])!.says, same('3 straddles: on'));
});

test('a kind other than the one every table starts with is named, and in brief is a straddle', () => {
  assert.deepEqual(button(EVERY_STRADDLE, ['button straddle'])!.says, { full: 'Button straddle: on', brief: 'Straddle: on' });
  assert.deepEqual(button({ allowStraddle: false, allowButtonStraddle: true }), {
    says: { full: 'Button straddle: off', brief: 'Straddle: off' },
    opens: { full: 'Button straddle', brief: 'Straddle' },
  });
});

test('Always chop is said with the straddles that are on, and alone when none is', () => {
  assert.deepEqual(button({ allowChop: true }, [], true)!.says, same('Always chop: on'));
  assert.deepEqual(button({ allowChop: true }, ['straddle'], true)!.says, { full: 'Straddle and chop: on', brief: 'Straddle, chop: on' });
  assert.deepEqual(button({ ...EVERY_STRADDLE, allowChop: true }, ['straddle', 'double straddle'], true)!.says, { full: '2 straddles and chop: on', brief: '2 straddles, chop: on' });
});
