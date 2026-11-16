import assert from 'node:assert/strict';
import test from 'node:test';

import { betStops } from '../src/client/betStops.ts';

const STAKES = { smallBlind: 10, bigBlind: 20 };

const amounts = (least: number, most: number, stakes = STAKES): number[] => {
  const stops = betStops(least, most, stakes);

  return Array.from({ length: stops.last + 1 }, (_, stop) => stops.amountAt(stop));
};

test('the slider stops at the least raise, at all in and at every big blind between them', () => {
  const stops = amounts(380, 1840);

  assert.equal(stops[0], 380);
  assert.equal(stops.at(-1), 1840);
  assert.deepEqual(stops.slice(0, 4), [380, 400, 420, 440]);
  assert.deepEqual(stops.slice(-3), [1800, 1820, 1840]);
  assert.equal(stops.length, 74);
});

test('both ends are exact when neither is a whole number of blinds, and every stop between them is', () => {
  const stops = amounts(345, 1007);

  assert.equal(stops[0], 345);
  assert.equal(stops.at(-1), 1007);
  assert.deepEqual(stops.slice(1, 3), [360, 380]);
  assert.equal(stops.at(-2), 1000);
  assert.ok(stops.slice(1, -1).every((amount) => amount % 20 === 0));
  assert.deepEqual(
    stops,
    [...stops].sort((a, b) => a - b),
    'the stops do not go up',
  );
  assert.equal(new Set(stops).size, stops.length, 'a stop comes twice');
});

test('a short range is stepped by the small blind', () => {
  assert.deepEqual(amounts(40, 150), [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]);
  assert.deepEqual(amounts(40, 240).slice(0, 3), [40, 60, 80], 'ten big blinds between the ends is no short range');
  assert.deepEqual(amounts(40, 239).slice(0, 3), [40, 50, 60]);
});

test('a range with no whole step in it has its two ends, and a raise that can only be all in has one stop', () => {
  assert.deepEqual(amounts(41, 49), [41, 49]);
  assert.deepEqual(amounts(40, 50), [40, 50]);
  assert.deepEqual(amounts(500, 500), [500]);
});

test('an amount from the box stands at the stop nearest it, and each stop at itself', () => {
  const stops = betStops(345, 1007, STAKES);

  for (let stop = 0; stop <= stops.last; stop += 1) {
    assert.equal(stops.stopOf(stops.amountAt(stop)), stop);
  }

  assert.equal(stops.stopOf(371), 2, '371 is nearest 380');
  assert.equal(stops.stopOf(369), 1, '369 is nearest 360');
  assert.equal(stops.stopOf(100), 0, 'less than the least raise');
  assert.equal(stops.stopOf(5000), stops.last, 'more than all in');
});

test('blinds of a table of cents step the slider in whole blinds of cents', () => {
  assert.deepEqual(amounts(100, 5000, { smallBlind: 25, bigBlind: 50 }).slice(0, 4), [100, 150, 200, 250]);
  assert.deepEqual(amounts(100, 400, { smallBlind: 25, bigBlind: 50 }), [100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 350, 375, 400]);
});
