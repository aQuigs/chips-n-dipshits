import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEAT_COUNT } from '../src/engine/index.ts';
import { handRecords, seededRng, TestTable } from './helpers.ts';
import { assertChipsConserved, assertHandRecordsHold, assertInvariants, assertLedgerAgrees } from './invariants.ts';
import { fixedSettings, randomConfig } from './randomConfig.ts';
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
  const tablesPlaying = { chips: 0, cents: 0 };
  const handsWithAnte = { everyone: 0, bigBlind: 0 };
  const handsWithAnteIn = { chips: 0, cents: 0 };
  let shortAntes = 0;
  const transfersIn = { chips: 0, cents: 0 };

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 7919);
    const players = 2 + rng.int(SEAT_COUNT - 1);
    const stacks = Array.from({ length: players }, () => (chance(rng, 15) ? 1 + rng.int(30) : 100 + rng.int(1900)));

    const config = randomConfig(rng);

    // Seated first and given its settings after, so the stacks are whatever they are, not what the buy-in limits allow.
    // Only what can't be changed after has to be there from the start
    const t = new TestTable({ stacks, seed, config: fixedSettings(config) });
    t.cmd(0, { type: 'updateConfig', config });
    t.cmd(0, { type: 'start' });
    tablesPlaying[config.unit] += 1;

    for (let step = 0; step < STEPS_PER_TABLE; step++) {
      assertChipsConserved(t.state);
      if (chance(rng, SLOW_CHECK_PERCENT)) {
        assertInvariants(t.state, t.now);
      }

      randomStep(t, rng);
    }

    assertChipsConserved(t.state);
    assertLedgerAgrees(t.state, t.effects);
    assert.deepEqual(fixedSettings(t.state.config), fixedSettings(config), 'a setting chosen for good was changed along the way');
    handsPlayed += assertHandRecordsHold(t.effects);
    transfersIn[config.unit] += t.effects.filter((effect) => effect.type === 'ledger' && effect.entry.kind === 'transfer' && effect.entry.amount > 0).length;

    for (const record of handRecords(t.effects)) {
      showdowns += record.result.uncontested ? 0 : 1;
      runTwice += record.boards.length > 1 ? 1 : 0;
      bounties += record.result.bounty ? 1 : 0;

      // A hand's first event says what ante it was dealt under, when there was one
      const [dealt] = record.events;
      if (dealt?.[0] === 'start' && dealt[6]) {
        handsWithAnte[dealt[7]!] += 1;
        handsWithAnteIn[config.unit] += 1;
        shortAntes += record.events.some((event) => event[0] === 'post' && event[5] !== undefined && event[3] < dealt[6]!) ? 1 : 0;
      }
    }
  }

  // The run only proves something if it actually reached the interesting parts of the game
  const reached = `${handsPlayed} hands, ${showdowns} showdowns, ${runTwice} run twice, ${bounties} bounties`;
  assert.ok(handsPlayed >= TABLES * 30, reached);
  assert.ok(showdowns >= TABLES * 10, reached);
  assert.ok(runTwice >= TABLES, reached);
  assert.ok(bounties >= 1, reached);
  assert.ok(tablesPlaying.chips >= TABLES / 4 && tablesPlaying.cents >= TABLES / 4, `${tablesPlaying.chips} tables played whole chips and ${tablesPlaying.cents} dollars and cents`);

  const antes = `${handsWithAnte.everyone} hands where everyone anted and ${handsWithAnte.bigBlind} with a big-blind ante, ${handsWithAnteIn.chips} of them in whole chips and ${handsWithAnteIn.cents} in dollars and cents, ${shortAntes} with a player short of the ante`;
  assert.ok(handsWithAnte.everyone >= TABLES * 5 && handsWithAnte.bigBlind >= TABLES * 5, antes);
  assert.ok(handsWithAnteIn.chips >= TABLES * 5 && handsWithAnteIn.cents >= TABLES * 5, antes);
  assert.ok(shortAntes >= TABLES / 4, antes);

  assert.ok(transfersIn.chips >= TABLES && transfersIn.cents >= TABLES, `${transfersIn.chips} chips moved between players in whole chips and ${transfersIn.cents} in dollars and cents`);
});
