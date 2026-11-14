import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eligibleSeats, isStraddle, nightIsOver, SEAT_COUNT } from '../src/engine/index.ts';
import type { Straddle } from '../src/engine/index.ts';
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
  const nights = { afterLastHand: 0, endedOutright: 0, startedAgain: 0, signals: 0 };
  const blinds = { missedBigBlinds: 0, deadSmallBlinds: 0, shortOfOwed: 0, noSmallBlind: 0, deadButtons: 0, keptWaiting: 0, forgivenTables: 0 };
  const chops = { offered: 0, agreed: 0, saidNo: 0, timedOut: 0, unasked: 0 };
  const straddles: Record<Straddle | 'passedOver' | 'overAnAnte' | 'shownDown', number> = { straddle: 0, 'double straddle': 0, 'button straddle': 0, 'Mississippi straddle': 0, passedOver: 0, overAnAnte: 0, shownDown: 0 };

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 7877);
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

      const before = { hands: t.state.handCount, called: t.state.bombPotCalled, inHand: t.state.hand !== null, over: nightIsOver(t.state) };
      randomStep(t, rng);

      if (before.over !== nightIsOver(t.state)) {
        nights[before.over ? 'startedAgain' : before.inHand ? 'afterLastHand' : 'endedOutright'] += 1;
      }

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

      // A hand with blinds that left someone out who was there to play: they owe, and are waiting
      if (t.state.handCount > before.hands && t.state.hand && !t.state.hand.bombPot) {
        straddles.passedOver += t.state.hand.passedOver.length > 0 ? 1 : 0;
        blinds.keptWaiting += eligibleSeats(t.state).some((seat) => !t.state.hand!.players.some((player) => player.seat === seat)) ? 1 : 0;
      }
    }

    blinds.forgivenTables += t.state.config.missedBlinds === 'forgiven' ? 1 : 0;

    assertChipsConserved(t.state);
    assertLedgerAgrees(t.state, t.effects);
    assert.deepEqual(fixedSettings(t.state.config), fixedSettings(config), 'a setting chosen for good was changed along the way');
    handsPlayed += assertHandRecordsHold(t.effects);
    nights.signals += t.effects.filter((effect) => effect.type === 'nightEnded').length;
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

      const answers = record.events.flatMap((event, nth) => (event[0] === 'chopAnswer' ? [{ agree: event[2], timedOut: record.events[nth - 1]?.[0] === 'timeout' }] : []));
      chops.offered += record.events.some((event) => event[0] === 'chopOffer') ? 1 : 0;
      chops.agreed += answers.some((answer) => answer.agree) ? 1 : 0;
      chops.saidNo += answers.some((answer) => !answer.agree && !answer.timedOut) ? 1 : 0;
      chops.timedOut += answers.some((answer) => answer.timedOut) ? 1 : 0;
      chops.unasked += record.result.chopped && answers.length === 0 ? 1 : 0;

      const posts = record.events.flatMap((event) => (event[0] === 'post' ? [event] : []));
      const owed = posts.filter((post) => post[2] === 'missed big blind' || post[2] === 'dead small blind');
      blinds.missedBigBlinds += posts.some((post) => post[2] === 'missed big blind') ? 1 : 0;
      blinds.deadSmallBlinds += posts.some((post) => post[2] === 'dead small blind') ? 1 : 0;
      blinds.shortOfOwed += owed.some((post) => post[4] === 0) ? 1 : 0;
      blinds.noSmallBlind += posts.length > 0 && !record.bombPot && !posts.some((post) => post[2] === 'small blind') ? 1 : 0;

      const straddled = posts.flatMap((post) => (isStraddle(post[2]) ? [post[2]] : []));
      for (const what of straddled) {
        straddles[what] += 1;
      }

      straddles.overAnAnte += straddled.length > 0 && posts.some((post) => post[2] === 'ante' || post[2] === 'big blind ante') ? 1 : 0;
      straddles.shownDown += straddled.length > 0 && !record.result.uncontested ? 1 : 0;

      // A hand's first event says where the button was, and what ante it was dealt under when there was one
      const [dealt] = record.events;
      blinds.deadButtons += dealt?.[0] === 'start' && !record.players.some((player) => player.seat === dealt[2]) ? 1 : 0;

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

  const ended = `nights: ${JSON.stringify(nights)}`;
  assert.ok(nights.afterLastHand >= TABLES / 2 && nights.endedOutright >= TABLES / 4 && nights.startedAgain >= TABLES, ended);
  assert.equal(nights.signals, nights.afterLastHand + nights.endedOutright, `every night that ended said so once: ${ended}`);

  const bombs = `bomb pots: ${JSON.stringify(bombPots)}`;
  assert.ok(bombPots.chips >= TABLES && bombPots.cents >= TABLES, bombs);
  assert.ok(bombPots.called >= TABLES / 2 && bombPots.byCount >= TABLES, bombs);
  assert.ok(bombPots.overAnAnte >= TABLES && bombPots.short >= TABLES / 2 && bombPots.allInWhenDealt >= TABLES / 4, bombs);

  const missed = `missed blinds: ${JSON.stringify(blinds)}`;
  assert.ok(blinds.missedBigBlinds >= TABLES / 6 && blinds.deadSmallBlinds >= TABLES / 6 && blinds.keptWaiting >= TABLES / 6, missed);
  assert.ok(blinds.noSmallBlind >= TABLES && blinds.deadButtons >= TABLES / 2 && blinds.forgivenTables >= TABLES / 4, missed);

  // Random play is two-handed most of the time, where nobody straddles, and a double needs four players and nobody with the
  // right before under the gun: tests/straddles.test.ts is where every kind is dealt by the hundred
  const straddling = `straddles: ${JSON.stringify(straddles)}`;
  assert.ok(straddles.straddle >= TABLES / 10 && straddles['button straddle'] >= TABLES / 10 && straddles['Mississippi straddle'] >= TABLES / 10, straddling);
  assert.ok(straddles.passedOver >= TABLES && straddles.overAnAnte >= TABLES / 6 && straddles.shownDown >= TABLES / 6, straddling);


  // Random play is mostly two-handed or has an ante or a straddle in the pot, where nobody chops: tests/chop.test.ts chops by the hundred
  const chopping = `chops: ${JSON.stringify(chops)}`;
  assert.ok(chops.offered >= TABLES / 20 && chops.agreed >= TABLES / 30 && chops.saidNo + chops.timedOut >= 1, chopping);

  const doubles = `double-board bomb pots: ${JSON.stringify(doubleBoards)}`;
  assert.ok(doubleBoards.chips >= TABLES / 2 && doubleBoards.cents >= TABLES / 2, doubles);
  assert.ok(doubleBoards.shownDown >= TABLES && doubleBoards.wonUncontested >= TABLES / 4, doubles);
  assert.ok(doubleBoards.ranOut >= TABLES / 4 && doubleBoards.withSidePots >= TABLES / 10, doubles);
});
