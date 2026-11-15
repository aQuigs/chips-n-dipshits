import assert from 'node:assert/strict';
import { test } from 'node:test';

import { holds, TAPS_SETTLE_MS } from '../src/client/tapGuard.ts';
import type { Box, Drawing, Hold, Spot } from '../src/client/tapGuard.ts';

const box = (left: number, top: number, width = 100, height = 40): Box => ({ left, top, right: left + width, bottom: top + height });
const spot = (is: string, at: Box, forGood = false): Spot<string> => ({ control: `${is} drawn anew`, is, box: at, forGood });
const held = (found: Hold<string>[]) => found.map(({ spot: { control }, until }) => [control, until]);

// The bar of a phone lying down while its player waits: the switch lies where Raise will come up
const WAITING: Spot<string>[] = [{ control: 'sit-out', is: 'sit-out', box: box(0, 100), forGood: false }];
const waitingLeftAt = (left: number): Drawing<string>[] => [{ left, spots: WAITING }];

test('a control that comes up where a different one lay takes no tap for the settle time from when it came up', () => {
  const raise = spot('raise', box(10, 110));

  assert.deepEqual(held(holds(waitingLeftAt(1000), [raise], 1000)), [[raise.control, 1000 + TAPS_SETTLE_MS]]);
});

test('a control that comes up over words, or beside another, is live at once', () => {
  const overWords = spot('fold', box(0, 300));
  const beside = spot('call', box(100, 100));
  const touching = spot('raise', box(98, 100));

  assert.deepEqual(holds(waitingLeftAt(1000), [overWords, beside, touching], 1000), []);
});

test('a part drawn again with the same controls in the same places holds nothing back, whatever they now say', () => {
  assert.deepEqual(holds(waitingLeftAt(1000), [spot('sit-out', box(0, 100))], 1000), []);
});

test('a control that moved onto its own old place alone is live, and one that moved onto another’s is not', () => {
  const two: Drawing<string> = { left: 1000, spots: [spot('show the ace', box(0, 100)), spot('show the king', box(130, 100))] };
  const nudged = spot('show the ace', box(20, 110));
  const kingWhereTheAceWas = spot('show the king', box(0, 100));

  assert.deepEqual(holds([two], [nudged], 1000), []);
  assert.deepEqual(held(holds([two], [kingWhereTheAceWas], 1000)), [[kingWhereTheAceWas.control, 1000 + TAPS_SETTLE_MS]]);
});

test('the same button for another decision is a different control', () => {
  const callFive: Drawing<string> = { left: 1000, spots: [spot('call of turn 4', box(0, 100))] };
  const callThirty = spot('call of turn 6', box(0, 100));

  assert.deepEqual(held(holds([callFive], [callThirty], 1000)), [[callThirty.control, 1000 + TAPS_SETTLE_MS]]);
});

test('a control with nothing to tell it by is the same only while it is the same element', () => {
  const unmarked: Spot<string> = { control: 'a field', is: null, box: box(0, 100), forGood: false };
  const another: Spot<string> = { control: 'another field', is: null, box: box(0, 100), forGood: false };

  assert.deepEqual(
    holds([{ left: 1000, spots: [unmarked] }], [unmarked, another], 1000).map((hold) => hold.spot.control),
    [another.control],
  );
});

test('what lay there a moment ago still counts when the part has been drawn again since, and the time runs from when the new control came up', () => {
  // Fold is tapped: the bar says the move is on its way, and then, the answer in, the switch moves up to where Fold was
  const turn: Drawing<string> = { left: 1000, spots: [spot('fold', box(0, 100))] };
  const sent = (left: number): Drawing<string> => ({ left, spots: [] });
  const sitOut = spot('sit-out', box(0, 100));

  assert.deepEqual(held(holds([turn, sent(1200)], [sitOut], 1200)), [[sitOut.control, 1200 + TAPS_SETTLE_MS]]);
  assert.deepEqual(holds([turn, sent(1000 + TAPS_SETTLE_MS)], [sitOut], 1000 + TAPS_SETTLE_MS), []);
});

test('a control that commits for good takes no tap when it first comes up, even over words', () => {
  const vote = spot('run it twice', box(0, 100), true);

  assert.deepEqual(held(holds([{ left: 5000, spots: [] }], [vote], 5000)), [[vote.control, 5000 + TAPS_SETTLE_MS]]);
  assert.deepEqual(holds([{ left: 5000, spots: [] }], [spot('fold', box(0, 100))], 5000), []);
});

test('a held control drawn again where it lay keeps the rest of its time, no more and no less, and is live once that is over', () => {
  const vote = spot('run it twice', box(0, 100), true);
  const again = spot('run it twice', box(0, 100), true);
  const first: Hold<string>[] = [{ spot: vote, until: 5000 + TAPS_SETTLE_MS }];
  const drawnAgain = (left: number): Drawing<string>[] => [
    { left: 5000, spots: [spot('call', box(0, 100))] },
    { left, spots: [vote] },
  ];

  assert.deepEqual(held(holds(drawnAgain(5100), [again], 5100, first)), [[again.control, 5000 + TAPS_SETTLE_MS]]);
  assert.deepEqual(holds(drawnAgain(5000 + TAPS_SETTLE_MS), [again], 5000 + TAPS_SETTLE_MS, first), []);
});
