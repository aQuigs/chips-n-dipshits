/*
 * What a table comes to for the players the game knows: a line each, made from the Tonight page's own
 * numbers and the ledger's, whoever of them sat down as whom.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, evaluateHand, ledgerOf, nightIsOver, resultsOf, SEAT_COUNT, tonightView } from '../src/engine/index.ts';
import type { PlayerResult, TableResults, TableState } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { ACES, BOARD, cards, checkAround, KINGS, QUEENS, seededRng, TestTable } from './helpers.ts';
import { fixedSettings, randomConfig } from './randomConfig.ts';
import { chance, randomStep } from './randomPlay.ts';
import { ANN, BOB, CY, DEE, known } from './resultHelpers.ts';

const playersOf = (results: TableResults): Record<string, PlayerResult> => Object.fromEntries(results.players.map((player) => [player.playerId, player]));

const NOTHING = { hands: 0, won: 0, biggest: 0, best: null, badges: {}, highHand: false };

function finish(t: TestTable): void {
  t.runToResult();
  t.finishHand();
}

/** A hand with the button on seat 0 that seat 0 wins at a showdown with aces, seat 2 turning up kings and everyone else folding before the flop. */
function acesBeatKings(t: TestTable): void {
  t.deal({ button: 0, holes: { 0: ACES, 1: QUEENS, 2: KINGS }, board: BOARD });

  for (const player of t.state.hand!.players.filter((p) => p.seat > 2)) {
    t.fold(player.seat);
  }

  t.call(0);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);
  finish(t);
}

test('a known player who has had chips gets a line with the night as Tonight has it: the ledger’s money, hands, pots, the best hand shown and whose the high hand is', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Ann', 'Bob', 'Cy'], config: { name: 'Friday' } });
  known(t, [ANN, BOB, CY]);

  assert.deepEqual(resultsOf(t.state), { tableId: 'TEST01', tableName: 'Friday', unit: 'chips', createdAt: t.state.createdAt, version: t.state.version, players: [
    { ...NOTHING, playerId: ANN, name: 'Ann', net: 0 },
    { ...NOTHING, playerId: BOB, name: 'Bob', net: 0 },
    { ...NOTHING, playerId: CY, name: 'Cy', net: 0 },
  ] }, 'chips bought and not yet played are a night of nothing');

  acesBeatKings(t);

  assert.deepEqual(resultsOf(t.state).players, [
    { playerId: ANN, name: 'Ann', net: 30, hands: 1, won: 1, biggest: 50, best: cards('As Ah Jc 9h 7d'), badges: {}, highHand: true },
    { playerId: BOB, name: 'Bob', net: -10, hands: 1, won: 0, biggest: 0, best: null, badges: {}, highHand: false },
    { playerId: CY, name: 'Cy', net: -20, hands: 1, won: 0, biggest: 0, best: cards('Ks Kh Jc 9h 7d'), badges: {}, highHand: false },
  ]);
});

test('a member nobody knows gets no line and is in nobody’s; once they say who they are, the whole of their night is theirs', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Ann', 'Bob', 'Cy'] });
  known(t, [ANN, null, CY]);
  acesBeatKings(t);

  assert.deepEqual(resultsOf(t.state).players.map((player) => [player.playerId, player.net]), [[ANN, 30], [CY, -20]]);

  known(t, [ANN, BOB, CY]);
  assert.deepEqual(resultsOf(t.state).players.map((player) => [player.playerId, player.net, player.hands]), [[ANN, 30, 1], [BOB, -10, 1], [CY, -20, 1]]);

  // Someone who only watched has no night, known or not
  const watching = new TestTable({ stacks: [1000, 1000], names: ['Ann', 'Bob'] });
  watching.sitDown('Cy', 5, 500);
  watching.cmd(2, { type: 'standUp' });
  watching.ids.push(addMember(watching.state, 'Dee', watching.ctx()).id);
  known(watching, [ANN, BOB, CY, DEE]);

  assert.deepEqual(resultsOf(watching.state).players.map((player) => player.playerId), [ANN, BOB, CY]);
});

test('two members who are one player share one line: money, hands, pots and badges add up, the biggest pot is the bigger, the best hand the better, and the name the first', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000], names: ['Ann', 'Bob', 'Cy', 'Bob 2'] });
  known(t, [ANN, BOB, CY, BOB]);

  // Bob's first seat wins a small pot with queens, his second a bigger one with kings
  t.deal({ button: 0, holes: { 1: QUEENS, 2: '8c 6d' }, board: BOARD });
  t.fold(3);
  t.fold(0);
  t.call(1);
  t.check(2);
  checkAround(t, [1, 2], 3);
  finish(t);

  t.deal({ button: 0, holes: { 3: KINGS, 2: '8c 6d' }, board: BOARD });
  t.raise(3, 100);
  t.fold(0);
  t.fold(1);
  t.call(2);
  checkAround(t, [2, 3], 3);
  finish(t);

  t.state.tonight.players[t.ids[1]!]!.badges = { heater: 1, quads: 2 };
  t.state.tonight.players[t.ids[3]!]!.badges = { quads: 1, felted: 1 };

  const tonight = Object.fromEntries(t.view(0).tonight.players.map((row) => [row.name, row]));
  const bob = playersOf(resultsOf(t.state))[BOB]!;

  assert.equal(resultsOf(t.state).players.length, 3);
  assert.equal(bob.name, 'Bob');
  assert.equal(bob.net, tonight['Bob']!.net + tonight['Bob 2']!.net);
  assert.equal(bob.net, 20 + 110 - 10);
  assert.deepEqual([bob.hands, bob.won], [4, 2]);
  assert.deepEqual([tonight['Bob']!.biggest, tonight['Bob 2']!.biggest, bob.biggest], [40, 210, 210]);
  assert.deepEqual(bob.best, cards('Ks Kh Jc 9h 7d'), 'the kings of the second seat beat the queens of the first');
  assert.deepEqual(bob.badges, { heater: 1, quads: 3, felted: 1 });
  assert.equal(bob.highHand, true, 'held by either of the two');

  // As good a hand at both seats is the first seat's
  t.state.tonight.players[t.ids[1]!]!.best = cards('Kd Kc Jc 9h 7d');
  assert.deepEqual(playersOf(resultsOf(t.state))[BOB]!.best, cards('Kd Kc Jc 9h 7d'));
});

test('it takes two: a table where one person alone ever had chips is nobody’s night, however many times they sat down', () => {
  const alone = new TestTable({ stacks: [1000], names: ['Ann'] });
  known(alone, [ANN]);
  assert.deepEqual(resultsOf(alone.state).players, []);

  // The same player in two browsers, as the check of the deployed game plays
  const twice = new TestTable({ stacks: [1000, 1000], names: ['Ann', 'Ann 2'] });
  known(twice, [ANN, ANN]);
  twice.deal({ button: 0 });
  twice.foldOut();
  assert.deepEqual(resultsOf(twice.state).players, []);

  // A second person makes it a night, even one nobody knows
  const withAGuest = new TestTable({ stacks: [1000, 1000], names: ['Ann', 'Guest'] });
  known(withAGuest, [ANN, null]);
  withAGuest.deal({ button: 0 });
  withAGuest.foldOut();
  assert.deepEqual(resultsOf(withAGuest.state).players.map((player) => player.playerId), [ANN]);

  const nobodyKnown = new TestTable({ stacks: [1000, 1000] });
  assert.deepEqual(resultsOf(nobodyKnown.state).players, []);
});

test('money is the ledger’s: a player who left keeps what they cashed out, a rebuy after a bust counts, and chips on the table or in the pot are their owner’s', () => {
  const t = new TestTable({ stacks: [1000, 30, 1000], names: ['Ann', 'Bob', 'Cy'] });
  known(t, [ANN, BOB, CY]);

  // Bob's 30 go in with queens against aces, and he buys 500 more
  t.deal({ button: 0, holes: { 0: ACES, 1: QUEENS }, board: BOARD });
  t.call(0);
  t.raise(1, 30);
  t.fold(2);
  t.call(0);
  finish(t);
  t.cmd(1, { type: 'requestRebuy', amount: 500 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });

  assert.deepEqual(resultsOf(t.state).players.map((player) => [player.name, player.net]), [['Ann', 50], ['Bob', -30], ['Cy', -20]]);

  // Cy leaves with what is left
  t.cmd(2, { type: 'standUp' });
  assert.deepEqual(playersOf(resultsOf(t.state))[CY], { playerId: CY, name: 'Cy', net: -20, hands: 1, won: 0, biggest: 0, best: null, badges: {}, highHand: false });

  // Mid-hand, what is in the pot is still whoever put it there's
  t.deal({ button: 0 });
  const mid = resultsOf(t.state);
  assert.deepEqual(mid.players.map((player) => player.net), [50, -30, -20]);
  assert.equal(mid.players.reduce((sum, player) => sum + player.net, 0), 0);
  assert.deepEqual(mid.players, tonightRows(t.state, [ANN, BOB, CY]));
});

/** What Tonight has for each member, as the line of the player they are said to be: for a table where every member is somebody else. */
function tonightRows(state: TableState, identities: string[]): PlayerResult[] {
  const view = tonightView(state, ledgerOf(state), nightIsOver(state));
  const holders = view.highHand.best?.playerIds ?? [];

  return state.members.flatMap((member, index) => {
    const row = view.players.find((candidate) => candidate.playerId === member.id);

    return row
      ? [{ playerId: identities[index]!, name: row.name, net: row.net, hands: row.hands, won: row.won, biggest: row.biggest, best: row.best?.cards ?? null, badges: Object.fromEntries(row.badges.map((badge) => [badge.id, badge.times])), highHand: holders.includes(member.id) }]
      : [];
  });
}

test('a transfer moves the money and is no pot won; a high-hand bonus paid is money too', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Ann', 'Bob', 'Cy'], config: { highHandBonus: 5 } });
  known(t, [ANN, BOB, CY]);
  acesBeatKings(t);

  t.cmd(0, { type: 'transferChips', from: t.ids[0]!, to: t.ids[1]!, amount: 137 });
  assert.deepEqual(resultsOf(t.state).players.map((player) => [player.net, player.won, player.biggest]), [[30 - 137, 1, 50], [-10 + 137, 0, 0], [-20, 0, 0]]);

  t.cmd(0, { type: 'payHighHand', hand: 1, to: [t.ids[0]!] });
  assert.deepEqual(resultsOf(t.state).players.map((player) => [player.net, player.won, player.biggest, player.highHand]), [[30 - 137 + 10, 1, 50, true], [-10 + 137 - 5, 0, 0, false], [-20 - 5, 0, 0, false]]);
});

test('blinds chopped are a hand played and no pot won, and nobody’s money moves', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Ann', 'Bob', 'Cy'], config: { allowChop: true } });
  known(t, [ANN, BOB, CY]);

  t.deal({ button: 0 });
  t.fold(0);
  t.cmd(1, { type: 'offerChop' });
  t.cmd(2, { type: 'answerChop', agree: true });
  t.finishHand();

  assert.equal(t.state.tonight.hands, 1);
  assert.deepEqual(resultsOf(t.state).players, tonightRows(t.state, [ANN, BOB, CY]));
  assert.deepEqual(resultsOf(t.state).players.map((player) => [player.net, player.won]), [[0, 0], [0, 0], [0, 0]]);
});

test('a table that plays dollars and cents says so, and its amounts are in cents', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Ann', 'Bob', 'Cy'], config: { unit: 'cents', smallBlind: 5, bigBlind: 15 } });
  known(t, [ANN, BOB, CY]);
  acesBeatKings(t);

  const results = resultsOf(t.state);
  assert.equal(results.unit, 'cents');
  assert.deepEqual(results.players.map((player) => [player.net, player.biggest]), [[20, 35], [-5, 0], [-15, 0]]);
});

test('ending the night changes nothing a line holds, and the results say which save of the table they are of', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Ann', 'Bob', 'Cy'] });
  known(t, [ANN, BOB, CY]);
  acesBeatKings(t);

  const before = resultsOf(t.state);
  t.cmd(0, { type: 'endNight' });
  assert.deepEqual(resultsOf(t.state).players, before.players);

  t.state.version = 41;
  assert.equal(resultsOf(t.state).version, 41);
});

const TABLES = 40;
const STEPS_PER_TABLE = 250;

test('over random games, at every step: each line is its members’ Tonight rows added up, everyone’s money comes to nothing when everyone is known, and saving the table changes nothing', () => {
  const reached = { lines: 0, shared: 0, unknown: 0, nobody: 0, cents: 0, bestHands: 0, highHands: 0 };

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 7919);
    const players = 2 + rng.int(SEAT_COUNT - 1);
    const config = randomConfig(rng);
    const t = new TestTable({ stacks: Array.from({ length: players }, () => 100 + rng.int(1900)), seed, config: fixedSettings(config) });
    t.cmd(0, { type: 'updateConfig', config });
    t.cmd(0, { type: 'start' });

    // A third of the tables know everybody apart, a third have two members who are one player, a third someone unknown
    const kind = seed % 3;
    const identityOf = (index: number): string | null => (kind === 1 && index === 1 ? 'PLAYER0' : kind === 2 && index === 0 ? null : `PLAYER${index}`);

    for (let step = 0; step < STEPS_PER_TABLE; step++) {
      randomStep(t, rng);
      t.state.members.forEach((member, index) => {
        member.identity = identityOf(index);
      });

      if (step % 10 !== 0 && !chance(rng, 10)) {
        continue;
      }

      const results = resultsOf(t.state);
      const view = tonightView(t.state, ledgerOf(t.state), nightIsOver(t.state));
      const holders = view.highHand.best?.playerIds ?? [];
      const rowsOf = (playerId: string) => view.players.filter((row) => t.state.members.find((member) => member.id === row.playerId)!.identity === playerId);
      const people = new Set(view.players.map((row) => t.state.members.find((member) => member.id === row.playerId)!.identity ?? row.playerId));

      assert.deepEqual(resultsOf(restoreState(JSON.stringify(t.state))), results, `seed ${seed} step ${step}`);
      assert.equal(new Set(results.players.map((player) => player.playerId)).size, results.players.length);

      if (people.size < 2) {
        assert.deepEqual(results.players, []);
        reached.nobody += 1;
        continue;
      }

      assert.deepEqual(results.players.map((player) => player.playerId).sort(), [...new Set(view.players.flatMap((row) => t.state.members.find((member) => member.id === row.playerId)!.identity ?? []))].sort());

      for (const player of results.players) {
        const rows = rowsOf(player.playerId);
        const sum = (of: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + of(row), 0);
        const bestScore = Math.max(-1, ...rows.map((row) => (row.best ? evaluateHand(row.best.cards).score : -1)));
        const badges: Record<string, number> = {};
        rows.forEach((row) => row.badges.forEach((badge) => (badges[badge.id] = (badges[badge.id] ?? 0) + badge.times)));

        assert.equal(player.net, sum((row) => row.net));
        assert.equal(player.hands, sum((row) => row.hands));
        assert.equal(player.won, sum((row) => row.won));
        assert.equal(player.biggest, Math.max(...rows.map((row) => row.biggest)));
        assert.equal(player.best ? evaluateHand(player.best).score : -1, bestScore);
        assert.deepEqual(player.badges, badges);
        assert.equal(player.highHand, rows.some((row) => holders.includes(row.playerId)));

        reached.lines += 1;
        reached.shared += rows.length > 1 ? 1 : 0;
        reached.bestHands += player.best ? 1 : 0;
        reached.highHands += player.highHand ? 1 : 0;
      }

      if (kind === 2) {
        reached.unknown += 1;
      } else {
        assert.equal(results.players.reduce((total, player) => total + player.net, 0), 0, `seed ${seed} step ${step}: to the chip and the cent`);
      }

      reached.cents += results.unit === 'cents' ? 1 : 0;
    }
  }

  for (const [what, times] of Object.entries(reached)) {
    assert.ok(what === 'nobody' || times > 0, `the games never reached: ${what}`);
  }
});
