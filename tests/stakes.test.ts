import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, stakesText } from '../src/engine/index.ts';

test('the stakes are the blinds, with the ante and who pays it when there is one', () => {
  assert.equal(stakesText(DEFAULT_CONFIG), '10/20');
  assert.equal(stakesText({ ...DEFAULT_CONFIG, anteFrom: 'bigBlind' }), '10/20', 'who would pay an ante is not said while there is none');
  assert.equal(stakesText({ ...DEFAULT_CONFIG, ante: 5 }), '10/20 · ante 5');
  assert.equal(stakesText({ ...DEFAULT_CONFIG, ante: 20, anteFrom: 'bigBlind' }), '10/20 · BB ante 20');
  assert.equal(stakesText({ unit: 'cents', smallBlind: 25, bigBlind: 50, ante: 5, anteFrom: 'everyone' }), '0.25/0.50 · ante 0.05');
  assert.equal(stakesText({ unit: 'chips', smallBlind: 500, bigBlind: 1000, ante: 1000, anteFrom: 'bigBlind' }), '500/1,000 · BB ante 1,000');
});
