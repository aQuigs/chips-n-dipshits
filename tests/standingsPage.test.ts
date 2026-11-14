/* The standings page's own choices: the order of the players, what is said of a record and a night, and which money it opens on. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { firstUnit, handsWon, nightSummary, potsWonText, ranked, SORTS, summaryOf } from '../src/client/standings.ts';
import type { PlayerStanding } from '../src/server/api.ts';

const player = (name: string, more: Partial<PlayerStanding> = {}): PlayerStanding => ({ id: `${name.toUpperCase()}234567`.slice(0, 7), name, nights: 1, nightsUp: 0, net: 0, hands: 0, won: 0, biggest: 0, best: null, badges: {}, highHands: 0, ...more });

const ANN = player('Ann', { nights: 12, nightsUp: 7, net: 4200, hands: 1430, won: 332, biggest: 9000 });
const BOB = player('Bob', { nights: 20, nightsUp: 4, net: -900, hands: 2000, won: 700, biggest: 12_000 });
const CY = player('Cy', { nights: 3, nightsUp: 3, net: 4200, hands: 100, won: 10, biggest: 300 });
const DEE = player('Dee', { nights: 1, net: -3300 });

const names = (players: PlayerStanding[]) => players.map((each) => each.name);

test('the page opens with whoever is up the most first, and each other order puts the most of its own first', () => {
  const players = [DEE, BOB, CY, ANN];

  assert.deepEqual(SORTS.map((sort) => sort.id), ['net', 'nights', 'rate', 'biggest']);
  assert.deepEqual(names(ranked(players, 'net')), ['Ann', 'Cy', 'Bob', 'Dee'], 'level on the money, by name');
  assert.deepEqual(names(ranked(players, 'nights')), ['Bob', 'Ann', 'Cy', 'Dee']);
  assert.deepEqual(names(ranked(players, 'rate')), ['Bob', 'Ann', 'Cy', 'Dee'], 'someone never dealt a hand stands below whoever won none of theirs');
  assert.deepEqual(names(ranked(players, 'biggest')), ['Bob', 'Ann', 'Cy', 'Dee']);

  assert.deepEqual(players, [DEE, BOB, CY, ANN], 'the list it was given is left as it was');
  assert.deepEqual(names(ranked([player('bob', { id: 'B222222' }), player('Bob', { id: 'B111111' }), player('ann')], 'net')), ['ann', 'bob', 'Bob'], 'the same players always come in the same order');
});

test('a hand won is one the player took chips from a pot of, and the share is of the hands they were dealt', () => {
  assert.equal(handsWon({ won: 1, hands: 4 }), 0.25);
  assert.equal(handsWon({ won: 0, hands: 9 }), 0);
  assert.equal(handsWon({ won: 0, hands: 0 }), null);

  assert.equal(potsWonText(ANN), '332 of 1,430 hands (23%)');
  assert.equal(potsWonText({ won: 1, hands: 1 }), '1 of 1 hand (100%)');
  assert.equal(potsWonText(DEE), 'No hands yet');
});

test('the line under a name says how many nights, how many of them up, and the share of hands won once there is one', () => {
  assert.equal(summaryOf(ANN), '12 nights · up in 7 · won 23% of hands');
  assert.equal(summaryOf(DEE), '1 night · up in 0');
});

test('the line under a night counts its hands and pots, with the biggest pot in the table’s own money when one was won', () => {
  const night = { at: 0, table: 'Friday', net: 5, hands: 132, won: 31, biggest: 420_050, best: null, badges: {}, highHand: false };

  assert.equal(nightSummary(night, 'chips'), '132 hands · 31 pots · biggest 420,050');
  assert.equal(nightSummary(night, 'cents'), '132 hands · 31 pots · biggest 4,200.50');
  assert.equal(nightSummary({ ...night, hands: 1, won: 0, biggest: 0 }, 'chips'), '1 hand · 0 pots');
});

test('the page opens on the money the viewer has a record in, on the one more players have when that settles nothing, and on nothing when nobody has a night', () => {
  const chips = { unit: 'chips' as const, players: [ANN, BOB] };
  const cents = { unit: 'cents' as const, players: [ANN, CY, DEE] };

  assert.equal(firstUnit([], ANN.id), null);
  assert.equal(firstUnit([chips], null), 'chips');
  assert.equal(firstUnit([chips, cents], BOB.id), 'chips');
  assert.equal(firstUnit([chips, cents], CY.id), 'cents');
  assert.equal(firstUnit([chips, cents], ANN.id), 'cents', 'in both, so the one with more players');
  assert.equal(firstUnit([chips, cents], null), 'cents');
  assert.equal(firstUnit([chips, { unit: 'cents', players: [CY, DEE] }], 'NOBODY2'), 'chips', 'level, so the first, which is chips');
});
