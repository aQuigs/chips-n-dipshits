import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONFIG_KEYS, CONFIG_SPECS, DEFAULT_CONFIG, newConfig, startingConfig, validatedConfig, validSetting } from '../src/engine/index.ts';
import type { ChoiceSpec, NumberSpec } from '../src/engine/index.ts';
import { seededRng, TestTable } from './helpers.ts';
import { randomConfig, randomSetting } from './randomConfig.ts';

test('the default settings are the registry\'s defaults, and the table accepts them', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    unit: 'chips',
    name: "Chips n' Dipshits",
    voiceLink: '',
    smallBlind: 10,
    bigBlind: 20,
    ante: 0,
    anteFrom: 'everyone',
    minBuyIn: 400,
    maxBuyIn: 2000,
    actionSeconds: 30,
    allowStraddle: true,
    allowDoubleStraddle: false,
    allowButtonStraddle: false,
    allowMississippiStraddle: false,
    maxRuns: 3,
    allowChop: false,
    sevenDeuceBounty: 0,
    highHandBonus: 0,
    bombPotAmount: 100,
    bombPotEvery: 0,
    bombPotBoards: 'one',
    missedBlinds: 'owed',
  });
  assert.deepEqual(validatedConfig({}, DEFAULT_CONFIG), DEFAULT_CONFIG);
  assert.deepEqual(newConfig({}), DEFAULT_CONFIG);
});

test('a refusal names the setting and says what it may be', () => {
  const settings = (config: object) => () => validatedConfig(config, DEFAULT_CONFIG);

  assert.throws(settings({ smallBlind: 0 }), { name: 'GameError', message: 'The small blind must be a whole number from 1 to 1,000,000,000' });
  assert.throws(settings({ actionSeconds: 301 }), { message: 'The action clock must be a whole number from 0 to 300' });
  assert.throws(settings({ actionSeconds: 4 }), { message: 'The action clock must be off or at least 5 seconds' });
  assert.throws(settings({ maxRuns: 4 }), { message: 'Running it more than once must be one of: Once only, Up to twice, Up to three times' });
  assert.throws(settings({ maxRuns: '2' }), { message: 'Running it more than once must be one of: Once only, Up to twice, Up to three times' }, 'a count chosen from a few is the number itself, not its text');
  assert.throws(settings({ name: 'x'.repeat(41) }), { message: 'The table name must be 1 to 40 characters' });
  assert.throws(settings({ name: 7 }), { message: 'The table name is missing' });
  assert.throws(settings({ bigBlind: 5 }), { message: "The big blind can't be smaller than the small blind" });
  assert.throws(settings({ minBuyIn: 3000 }), { message: "The maximum buy-in can't be smaller than the minimum" });
});

test('when several things are wrong, the complaint is about the one that was always checked first', () => {
  const complaint = (config: object) => {
    try {
      validatedConfig(config, DEFAULT_CONFIG);
    } catch (error) {
      return (error as Error).message;
    }

    return null;
  };

  // The stakes and the clock come before the name, and a rule between two settings right after the second of them
  assert.equal(complaint({ name: '   ', smallBlind: 50, bigBlind: 10 }), "The big blind can't be smaller than the small blind");
  assert.equal(complaint({ name: '   ', actionSeconds: 3 }), 'The action clock must be off or at least 5 seconds');
  assert.equal(complaint({ smallBlind: 50, bigBlind: 10, minBuyIn: 0 }), "The big blind can't be smaller than the small blind");
  assert.equal(complaint({ smallBlind: 0, bigBlind: 0 }), 'The small blind must be a whole number from 1 to 1,000,000,000');
  assert.equal(complaint({ minBuyIn: 500, maxBuyIn: 100, actionSeconds: 400 }), "The maximum buy-in can't be smaller than the minimum");
  assert.equal(complaint({ bigBlind: 5, maxRuns: 0 }), "The big blind can't be smaller than the small blind");
  assert.equal(complaint({ sevenDeuceBounty: -1, maxRuns: 'x', name: 7 }), 'The table name is missing');
  assert.equal(complaint({ sevenDeuceBounty: -1, maxRuns: 'x' }), 'Running it more than once must be one of: Once only, Up to twice, Up to three times');
});

test('settings the host leaves out keep their value, and anything that is no setting is dropped', () => {
  const current = { ...DEFAULT_CONFIG, sevenDeuceBounty: 40, allowStraddle: false };

  assert.deepEqual(validatedConfig({ bigBlind: 50, cheat: true }, current), { ...current, bigBlind: 50 });
  assert.deepEqual(validatedConfig(null, current), current);
  assert.deepEqual(validatedConfig('nonsense', current), current);
});

test('a setting that is a count or one of several choices is checked like the rest', () => {
  const count: NumberSpec = { kind: 'count', label: 'Seats', subject: 'The number of seats', default: 9, min: 2, max: 10, group: 'table' };
  const choice: ChoiceSpec<'one' | 'two'> = {
    kind: 'choice',
    label: 'Decks',
    subject: 'The number of decks',
    default: 'one',
    options: [
      { value: 'one', label: 'One' },
      { value: 'two', label: 'Two' },
    ],
    group: 'table',
  };

  assert.equal(validSetting(count, 6, DEFAULT_CONFIG), 6);
  assert.throws(() => validSetting(count, 11, DEFAULT_CONFIG), { message: 'The number of seats must be a whole number from 2 to 10' });
  assert.equal(validSetting(choice, 'two', DEFAULT_CONFIG), 'two');
  assert.throws(() => validSetting(choice, 'three', DEFAULT_CONFIG), { name: 'GameError', message: 'The number of decks must be one of: One, Two' });
  assert.throws(() => validSetting(choice, undefined, DEFAULT_CONFIG), /must be one of/);

  const rng = seededRng(5);
  for (let draw = 0; draw < 200; draw++) {
    const drawn = [randomSetting(count, rng), randomSetting(choice, rng)];

    assert.deepEqual([validSetting(count, drawn[0], DEFAULT_CONFIG), validSetting(choice, drawn[1], DEFAULT_CONFIG)], drawn, 'a random draw is one the setting takes');
  }
});

test('random settings are always ones the table accepts, and between them reach every setting\'s edges', () => {
  const rng = seededRng(11);
  const seen = new Map(CONFIG_KEYS.map((key) => [key, new Set<unknown>()]));

  for (let draw = 0; draw < 500; draw++) {
    const config = randomConfig(rng);

    assert.deepEqual(newConfig(config), config);
    for (const key of CONFIG_KEYS) {
      seen.get(key)!.add(config[key]);
    }
  }

  for (const key of CONFIG_KEYS) {
    const spec = CONFIG_SPECS[key];
    const values = seen.get(key)!;

    assert.ok(values.size > 1, `${key} was never changed`);
    if (spec.kind === 'chips' || spec.kind === 'count' || spec.kind === 'seconds') {
      assert.ok(values.has(spec.min) && values.has(spec.default), `${key} was never at its lowest or its default`);
    }
  }
});

test('changing a setting that waits for the next hand leaves the hand in play as it is', () => {
  const waiting = CONFIG_KEYS.filter((key) => CONFIG_SPECS[key].nextHand);
  assert.deepEqual(waiting, ['smallBlind', 'bigBlind', 'ante', 'anteFrom', 'allowStraddle', 'allowDoubleStraddle', 'allowButtonStraddle', 'allowMississippiStraddle', 'maxRuns', 'missedBlinds', 'sevenDeuceBounty', 'bombPotAmount', 'bombPotEvery', 'bombPotBoards']);

  const rng = seededRng(3);

  for (const key of waiting) {
    const t = new TestTable({ stacks: [1000, 1000, 1000], config: { bigBlind: 20, sevenDeuceBounty: 10 } });
    t.deal({ button: 0 });
    t.call(0);

    const hand = JSON.stringify(t.state.hand);
    let changed = 0;

    for (let draw = 0; draw < 50; draw++) {
      const value = randomSetting(CONFIG_SPECS[key], rng);

      try {
        t.cmd(0, { type: 'updateConfig', config: { [key]: value } });
        changed += value === t.state.config[key] ? 1 : 0;
      } catch (error) {
        assert.equal((error as Error).name, 'GameError');
      }

      assert.equal(JSON.stringify(t.state.hand), hand, `changing ${key} reached into the hand on the table`);
    }

    assert.ok(changed > 10, `${key} was hardly ever changed`);
  }
});

test('a new table starts from what its choices suggest, and anything sent with them wins', () => {
  const cents = startingConfig({ unit: 'cents' });

  assert.deepEqual(cents, { ...DEFAULT_CONFIG, unit: 'cents', smallBlind: 25, bigBlind: 50, minBuyIn: 2000, maxBuyIn: 10_000, bombPotAmount: 250 });
  assert.deepEqual(newConfig({ unit: 'cents', smallBlind: 5, name: 'Nickels' }), { ...cents, smallBlind: 5, name: 'Nickels' });
  assert.deepEqual(startingConfig({ unit: 'euros' }), DEFAULT_CONFIG, 'a choice that is not one of the options suggests nothing');
  assert.deepEqual(startingConfig(), DEFAULT_CONFIG);

  // Every choice has to suggest settings its own table would take
  for (const key of CONFIG_KEYS) {
    const spec = CONFIG_SPECS[key];

    for (const option of spec.kind === 'choice' ? spec.options : []) {
      assert.deepEqual(newConfig({ [key]: option.value }), startingConfig({ [key]: option.value }), `${key}: ${option.label}`);
    }
  }
});

test('a refusal writes amounts the way the table being created or changed does', () => {
  const cents = startingConfig({ unit: 'cents' });

  assert.throws(() => newConfig({ unit: 'cents', smallBlind: 0 }), { message: 'The small blind must be an amount to the cent from 0.01 to 10,000,000.00' });
  assert.throws(() => validatedConfig({ sevenDeuceBounty: -1 }, cents), { message: 'The seven-deuce bounty must be an amount to the cent from 0.00 to 10,000,000.00' });
  assert.throws(() => newConfig({ unit: 'euros', smallBlind: 0 }), { name: 'GameError', message: 'What the table plays with must be one of: Whole chips, Dollars and cents' });
});
