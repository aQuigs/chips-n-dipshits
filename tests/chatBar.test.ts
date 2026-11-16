import assert from 'node:assert/strict';
import test from 'node:test';

import { barLine, spokenToViewer } from '../src/client/chatBar.ts';
import type { FeedEntry } from '../src/engine/types.ts';

let seq = 0;

const dealer = (text: string): FeedEntry => ({ seq: (seq += 1), at: 0, kind: 'dealer', from: null, text });
const says = (by: string, text: string): FeedEntry => ({ seq: (seq += 1), at: 0, kind: 'chat', from: by, by, text });

test('the bar shows the newest line, whoever said it, while no line holds it', () => {
  const lines = [says('marge', 'pizza is here'), dealer('Flop: Ah 7c 2d')];

  assert.equal(barLine(lines, null), lines[1]);
  assert.equal(barLine([dealer('Quigs calls 20'), lines[0]!], null), lines[0]);
  assert.equal(barLine([], null), null);
  assert.equal(barLine([], 7), null);
});

test('a person’s line that holds the bar stays under the dealer’s lines that come after it', () => {
  const said = says('marge', 'pizza is here, who owes me 12?');
  const lines = [dealer('Quigs calls 20'), said, dealer('Flop: Ah 7c 2d'), dealer('Danny checks')];

  assert.equal(barLine(lines, said.seq), said);
  assert.equal(barLine(lines, null), lines[3], 'its time is up');
});

test('a line spoken after the one that holds takes the bar at once, with whatever came after it', () => {
  const first = says('marge', 'pizza is here');
  const own = says('danny', 'on my way');
  const lines = [first, dealer('Flop: Ah 7c 2d'), own];

  assert.equal(barLine(lines, first.seq), own);
  assert.equal(barLine([...lines, dealer('Danny checks')], first.seq)?.text, 'Danny checks');
});

test('a line that holds and is no longer shown, its speaker muted, holds nothing', () => {
  const said = says('marge', 'pizza is here');
  const shown = [dealer('Quigs calls 20'), dealer('Flop: Ah 7c 2d')];

  assert.equal(barLine(shown, said.seq), shown[1]);
});

test('what the bar counts and holds is chat from someone else: not the dealer’s lines, and not the viewer’s own', () => {
  assert.equal(spokenToViewer(says('marge', 'hi'), 'danny'), true);
  assert.equal(spokenToViewer(says('danny', 'hi'), 'danny'), false);
  assert.equal(spokenToViewer(dealer('Quigs calls 20'), 'danny'), false);
});
