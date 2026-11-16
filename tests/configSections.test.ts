import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONFIG_KEYS, CONFIG_SECTION_KEYS, CONFIG_SECTIONS, CONFIG_SPECS, DEFAULT_CONFIG, sectionOf, settingName } from '../src/engine/index.ts';
import type { ConfigKey, ConfigSection, SettingValue, TableConfig } from '../src/engine/index.ts';

const lines = (config: TableConfig) => Object.fromEntries(CONFIG_SECTION_KEYS.map((section) => [section, CONFIG_SECTIONS[section].holds(config)])) as Record<ConfigSection, string>;

/** Another value the setting could have. */
function another(key: ConfigKey, config: TableConfig): SettingValue {
  const spec = CONFIG_SPECS[key];

  switch (spec.kind) {
    case 'toggle':
      return !config[key];
    case 'choice':
      return spec.options.find((option) => option.value !== config[key])!.value;
    case 'text':
      return `${config[key]} two`;
    case 'link':
      return 'https://meet.example/abc';
    case 'handAmounts':
      return [['J4s', 30]];
    default:
      return (config[key] as number) + 1;
  }
}

test('every setting stands in exactly one section of the form', () => {
  const placed = CONFIG_SECTION_KEYS.flatMap((section) => [...CONFIG_SECTIONS[section].settings]);

  assert.deepEqual([...placed].sort(), [...CONFIG_KEYS].sort(), 'a setting is in no section, or in two');

  for (const section of CONFIG_SECTION_KEYS) {
    for (const key of CONFIG_SECTIONS[section].settings) {
      assert.equal(sectionOf(key), section);
    }
  }
});

test('the sections come in the order a host reaches for them, and each folds under a line of what it holds', () => {
  assert.deepEqual(
    CONFIG_SECTION_KEYS.map((section) => CONFIG_SECTIONS[section].label),
    ['Stakes', 'Bomb pots', 'Bounties and high hand', 'House rules', 'Table'],
  );

  assert.deepEqual(lines({ ...DEFAULT_CONFIG, name: 'Friday Night' }), {
    stakes: '10/20 · buy-in 400 to 2,000',
    bombPots: '100 each · only when called · one board',
    sideMoney: 'None',
    house: 'Straddle under the gun · run it up to 3 times · missed blinds owed',
    table: 'Friday Night · 30 s clock · no voice link',
  });

  const full: TableConfig = {
    ...DEFAULT_CONFIG,
    unit: 'cents',
    name: 'Nickels',
    voiceLink: 'https://meet.example/abc',
    smallBlind: 25,
    bigBlind: 50,
    ante: 10,
    anteFrom: 'bigBlind',
    minBuyIn: 2000,
    maxBuyIn: 10_000,
    actionSeconds: 0,
    allowDoubleStraddle: true,
    allowButtonStraddle: true,
    allowMississippiStraddle: true,
    maxRuns: 2,
    allowChop: true,
    bounties: [['72', 250]],
    highHandBonus: 500,
    bombPotAmount: 250,
    bombPotEvery: 5,
    bombPotBoards: 'two',
    missedBlinds: 'forgiven',
    rabbitHunting: true,
  };

  assert.deepEqual(lines(full), {
    stakes: '0.25/0.50 · BB ante 0.10 · buy-in 20.00 to 100.00',
    bombPots: '2.50 each · every 5 hands · two boards',
    sideMoney: '72 pays 2.50 · high hand 5.00',
    house: 'Straddles: under the gun, double, button, Mississippi · run it up to twice · blinds can chop · missed blinds forgiven · rabbit hunting',
    table: 'Nickels · no clock · voice link set',
  });

  assert.equal(lines({ ...DEFAULT_CONFIG, allowStraddle: false }).house, 'No straddles · run it up to 3 times · missed blinds owed');
  assert.equal(lines({ ...DEFAULT_CONFIG, allowStraddle: false, allowButtonStraddle: true, maxRuns: 1 }).house, 'Button straddle · run it once · missed blinds owed');
  assert.equal(lines({ ...DEFAULT_CONFIG, bombPotEvery: 1 }).bombPots, '100 each · every hand · one board');
  assert.equal(lines({ ...DEFAULT_CONFIG, highHandBonus: 50 }).sideMoney, 'High hand 50');
  assert.equal(lines({ ...DEFAULT_CONFIG, bounties: [['72', 25], ['AA', 100]] }).sideMoney, '72 pays 25 · AA pays 100');
  assert.equal(lines({ ...DEFAULT_CONFIG, bounties: [['72', 25], ['AA', 100], ['J4s', 50]], highHandBonus: 50 }).sideMoney, '3 bounty hands · high hand 50', 'a long list is counted, so the line stays a line');
});

test('no setting is forgotten by folding: each has its say in the line of its section', () => {
  // With an ante, so that who pays it means something
  const table: TableConfig = { ...DEFAULT_CONFIG, ante: 5, bounties: [['72', 25]], highHandBonus: 50 };
  const before = lines(table);

  for (const key of CONFIG_KEYS) {
    const after = lines({ ...table, [key]: another(key, table) });

    assert.notEqual(after[sectionOf(key)], before[sectionOf(key)], `the line of its section has nothing to say of ${key}`);
  }
});

test('away from the form a setting goes by a name that needs no heading', () => {
  assert.equal(settingName('bombPotBoards'), 'the boards of a bomb pot');
  assert.equal(settingName('smallBlind'), 'the small blind');
  assert.equal(settingName('maxRuns'), 'running it more than once');

  // What the form calls them leans on the heading over them
  assert.deepEqual([CONFIG_SPECS.bombPotAmount.label, CONFIG_SPECS.bombPotBoards.label, CONFIG_SPECS.allowMississippiStraddle.label, CONFIG_SPECS.name.label], ['Each player puts in', 'Boards', 'Mississippi', 'Name']);

  for (const section of CONFIG_SECTION_KEYS) {
    for (const key of CONFIG_SECTIONS[section].settings) {
      assert.equal(CONFIG_SPECS[key].label.toLowerCase().includes(CONFIG_SECTIONS[section].label.toLowerCase()), false, `the label of ${key} says its section's heading again`);
    }
  }
});
