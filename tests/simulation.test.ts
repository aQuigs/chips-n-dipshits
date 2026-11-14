import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEAT_COUNT } from '../src/engine/index.ts';
import { handRecords, ledgerEntries, seededRng, TestTable } from './helpers.ts';
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
  const bombPots = { chips: 0, cents: 0, called: 0, byCount: 0, overAnAnte: 0, short: 0, allInWhenDealt: 0 };
  const doubleBoards = { chips: 0, cents: 0, shownDown: 0, ranOut: 0, withSidePots: 0, wonUncontested: 0 };

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

      const before = { hands: t.state.handCount, called: t.state.bombPotCalled };
      randomStep(t, rng);

      // A hand is dealt by time passing, never by the step that called a bomb pot or changed a setting
      const dealt = t.state.handCount > before.hands ? t.state.hand?.bombPot : null;
      if (dealt) {
        bombPots[t.state.config.unit] += 1;
        bombPots[before.called ? 'called' : 'byCount'] += 1;
        bombPots.overAnAnte += t.state.config.ante > 0 ? 1 : 0;
        bombPots.short += t.state.hand!.players.some((p) => p.committed < dealt.amount) ? 1 : 0;
        bombPots.allInWhenDealt += t.state.hand!.stage !== 'betting' ? 1 : 0;
        doubleBoards[t.state.config.unit] += dealt.boards === 2 ? 1 : 0;
      }
    }

    assertChipsConserved(t.state);
    assertLedgerAgrees(t.state, t.effects);
    assert.deepEqual(fixedSettings(t.state.config), fixedSettings(config), 'a setting chosen for good was changed along the way');
    handsPlayed += assertHandRecordsHold(t.effects);
    transfersIn[config.unit] += ledgerEntries(t.effects).filter((entry) => entry.kind === 'transfer' && entry.amount > 0).length;

    for (const record of handRecords(t.effects)) {
      showdowns += record.result.uncontested ? 0 : 1;
      runTwice += record.boards.length > 1 ? 1 : 0;
      bounties += record.result.bounty ? 1 : 0;

      if (record.bombPot?.boards === 2) {
        doubleBoards.shownDown += record.result.uncontested ? 0 : 1;
        doubleBoards.wonUncontested += record.result.uncontested ? 1 : 0;
        doubleBoards.ranOut += record.events.some((event) => event[0] === 'runs') ? 1 : 0;
        doubleBoards.withSidePots += record.result.pots.length > 1 ? 1 : 0;
      }

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

  assert.ok(transfersIn.chips >= TABLES && transfersIn.cents >= TABLES, `${transfersIn.chips} transfers at whole-chip tables and ${transfersIn.cents} at tables of dollars and cents`);

  const bombs = `bomb pots: ${JSON.stringify(bombPots)}`;
  assert.ok(bombPots.chips >= TABLES && bombPots.cents >= TABLES, bombs);
  assert.ok(bombPots.called >= TABLES / 2 && bombPots.byCount >= TABLES, bombs);
  assert.ok(bombPots.overAnAnte >= TABLES && bombPots.short >= TABLES / 2 && bombPots.allInWhenDealt >= TABLES / 4, bombs);

  const doubles = `double-board bomb pots: ${JSON.stringify(doubleBoards)}`;
  assert.ok(doubleBoards.chips >= TABLES / 2 && doubleBoards.cents >= TABLES / 2, doubles);
  assert.ok(doubleBoards.shownDown >= TABLES && doubleBoards.wonUncontested >= TABLES / 4, doubles);
  assert.ok(doubleBoards.ranOut >= TABLES / 4 && doubleBoards.withSidePots >= TABLES / 10, doubles);
});
