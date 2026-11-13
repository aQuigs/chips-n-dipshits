import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEAT_COUNT } from '../src/engine/index.ts';
import { handRecords, seededRng, TestTable } from './helpers.ts';
import { assertChipsConserved, assertHandRecordsHold, assertInvariants, assertLedgerAgrees } from './invariants.ts';
import { randomConfig } from './randomConfig.ts';
import { chance, randomStep } from './randomPlay.ts';

// SIM_TABLES=2000 npm test runs a much longer soak than the default
const TABLES = Number(process.env.SIM_TABLES ?? 60);
const STEPS_PER_TABLE = 600;

// Building every player's view and saving the table are the slow parts, so they are checked on a sample of steps
const SLOW_CHECK_PERCENT = 10;

test('random play never breaks the rules of chip accounting, secrecy or turn order', () => {
  let handsPlayed = 0;
  let showdowns = 0;
  let runTwice = 0;
  let bounties = 0;

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 7919);
    const players = 2 + rng.int(SEAT_COUNT - 1);
    const stacks = Array.from({ length: players }, () => (chance(rng, 15) ? 1 + rng.int(30) : 100 + rng.int(1900)));

    // Seated first and given its settings after, so the stacks are whatever they are, not what the buy-in limits allow
    const t = new TestTable({ stacks, seed });
    t.cmd(0, { type: 'updateConfig', config: randomConfig(rng) });
    t.cmd(0, { type: 'start' });

    for (let step = 0; step < STEPS_PER_TABLE; step++) {
      assertChipsConserved(t.state);
      if (chance(rng, SLOW_CHECK_PERCENT)) {
        assertInvariants(t.state, t.now);
      }

      randomStep(t, rng);
    }

    assertChipsConserved(t.state);
    assertLedgerAgrees(t.state, t.effects);
    handsPlayed += assertHandRecordsHold(t.effects);

    for (const record of handRecords(t.effects)) {
      showdowns += record.result.uncontested ? 0 : 1;
      runTwice += record.boards.length > 1 ? 1 : 0;
      bounties += record.result.bounty ? 1 : 0;
    }
  }

  // The run only proves something if it actually reached the interesting parts of the game
  const reached = `${handsPlayed} hands, ${showdowns} showdowns, ${runTwice} run twice, ${bounties} bounties`;
  assert.ok(handsPlayed >= TABLES * 30, reached);
  assert.ok(showdowns >= TABLES * 10, reached);
  assert.ok(runTwice >= TABLES, reached);
  assert.ok(bounties >= 1, reached);
});
