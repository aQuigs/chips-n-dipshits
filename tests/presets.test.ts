import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, fromPreset, matchingPreset, newConfig, PRESET_KEYS, presetSettings, startingConfig } from '../src/engine/index.ts';
import type { TableConfig } from '../src/engine/index.ts';
import type { ApiResponse, Auth } from '../src/server/api.ts';
import { BuildGate } from '../src/server/build.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import { seededRng } from './helpers.ts';
import { randomConfig } from './randomConfig.ts';

/** Settings as a preset kept them, which is what `presetSettings` makes of a whole set. */
const kept = (config: Partial<TableConfig>): Record<string, unknown> => presetSettings({ ...DEFAULT_CONFIG, ...config });

test('a preset keeps every setting but the voice chat link, checked as a new table\'s are', () => {
  const settings = kept({ smallBlind: 25, bigBlind: 50, voiceLink: 'https://meet.google.com/abc-defg-hij', allowStraddle: false });

  assert.equal('voiceLink' in settings, false, 'anyone with the address can read the presets, so the call stays with the table');
  assert.deepEqual(Object.keys(settings), PRESET_KEYS);
  assert.equal(settings.smallBlind, 25);
  assert.equal(settings.allowStraddle, false);

  assert.throws(() => presetSettings({ ...DEFAULT_CONFIG, smallBlind: 0 }), { name: 'GameError', message: /small blind/ });
  assert.deepEqual(presetSettings({ ...DEFAULT_CONFIG, voiceLink: 'meet.google.com/half-typed' }), kept({}), 'a setting the preset leaves out stopped the save');
  assert.throws(() => presetSettings({ ...DEFAULT_CONFIG, smallBlind: 50, bigBlind: 20 }), { message: "The big blind can't be smaller than the small blind" });
});

test('a preset saved with the settings there are now gives them back exactly, with nothing to say', () => {
  const rng = seededRng(5);

  for (let round = 0; round < 200; round++) {
    const config = randomConfig(rng);
    const used = fromPreset(kept(config), config);

    assert.deepEqual(used, { config, notes: [] });
  }
});

test('a preset saved before a setting existed gives it the value a new table starts with', () => {
  const { voiceLink: _link, ante: _ante, anteFrom: _from, maxBuyIn: _max, ...beforeAntes } = { ...DEFAULT_CONFIG, unit: 'cents' as const, smallBlind: 10, bigBlind: 25, minBuyIn: 1000 };

  const used = fromPreset(beforeAntes);

  assert.deepEqual(used.notes, []);
  assert.equal(used.config.ante, 0);
  assert.equal(used.config.anteFrom, 'everyone');
  assert.equal(used.config.maxBuyIn, startingConfig({ unit: 'cents' }).maxBuyIn, 'what dollars and cents suggests, not the whole-chip default');
  assert.equal(used.config.smallBlind, 10);
  assert.deepEqual(newConfig(used.config), used.config);
});

test('a preset saved when run it twice was a switch runs it as it did: on is up to twice and off is once only, and a value of the new setting saved beside it wins', () => {
  const { maxRuns: _runs, ...beforeThree } = kept({});

  for (const [on, runs] of [[true, 2], [false, 1]] as const) {
    const used = fromPreset({ ...beforeThree, allowRunItTwice: on });

    assert.deepEqual(used.notes, []);
    assert.equal(used.config.maxRuns, runs);
    assert.ok(!('allowRunItTwice' in used.config));
  }

  assert.equal(fromPreset(beforeThree).config.maxRuns, 3, 'a preset older than either starts where a new table does');
  assert.equal(fromPreset({ ...beforeThree, allowRunItTwice: true, maxRuns: 3 }).config.maxRuns, 3);
});

test('a preset saved when there was one kind of straddle plays as it did: under the gun if it allowed that, and no other kind', () => {
  for (const allowStraddle of [true, false]) {
    const { allowDoubleStraddle: _double, allowButtonStraddle: _button, allowMississippiStraddle: _mississippi, ...beforeMoreStraddles } = kept({ allowStraddle });

    // Filled into a table that allows every kind, as a host might who then picks the old preset
    const used = fromPreset(beforeMoreStraddles, { ...DEFAULT_CONFIG, allowDoubleStraddle: true, allowButtonStraddle: true, allowMississippiStraddle: true });

    assert.deepEqual(used.notes, []);
    assert.deepEqual(
      [used.config.allowStraddle, used.config.allowDoubleStraddle, used.config.allowButtonStraddle, used.config.allowMississippiStraddle],
      [allowStraddle, false, false, false],
    );
    assert.deepEqual(newConfig(used.config), used.config);
  }

  // One saved since keeps each kind as it was set
  const since = fromPreset(kept({ allowStraddle: false, allowButtonStraddle: true, allowMississippiStraddle: true }));
  assert.deepEqual([since.config.allowStraddle, since.config.allowDoubleStraddle, since.config.allowButtonStraddle, since.config.allowMississippiStraddle], [false, false, true, true]);
});

test('a dollars-and-cents preset saved before bomb pots gets the bomb pot a new dollars table starts with', () => {
  const { bombPotAmount: _amount, bombPotEvery: _every, ...beforeBombPots } = kept({ unit: 'cents', smallBlind: 25, bigBlind: 50, minBuyIn: 2000, maxBuyIn: 10_000 });

  const used = fromPreset(beforeBombPots);

  assert.deepEqual(used.notes, []);
  assert.equal(used.config.bombPotAmount, 250, '2.50, not 100 cents');
  assert.equal(used.config.bombPotAmount, startingConfig({ unit: 'cents' }).bombPotAmount);
  assert.equal(used.config.bombPotEvery, 0);
  assert.equal(fromPreset({ ...beforeBombPots, unit: 'chips' }).config.bombPotAmount, 100);
});

test('a preset saved before a bomb pot could have two boards plays its bomb pots on one, and one saved with two keeps them', () => {
  const { bombPotBoards: _boards, ...beforeTwoBoards } = kept({ bombPotAmount: 300, bombPotEvery: 5 });

  const used = fromPreset(beforeTwoBoards);

  assert.deepEqual(used.notes, []);
  assert.equal(used.config.bombPotBoards, 'one');
  assert.deepEqual([used.config.bombPotAmount, used.config.bombPotEvery], [300, 5], 'the bomb pot it did keep');

  // Filled into a form that was set to two boards, it still says one: the preset is the settings of the table it was saved from
  assert.equal(fromPreset(beforeTwoBoards, { ...DEFAULT_CONFIG, bombPotBoards: 'two' }).config.bombPotBoards, 'one');

  assert.deepEqual(fromPreset(kept({ bombPotBoards: 'two' })), { config: { ...DEFAULT_CONFIG, bombPotBoards: 'two' }, notes: [] });
});

test('a setting since taken out of the game is dropped without a word', () => {
  const used = fromPreset({ ...kept({ bigBlind: 40 }), rabbitHunting: true, burnCardsShown: 'often' });

  assert.deepEqual(used.notes, []);
  assert.equal('rabbitHunting' in used.config, false);
  assert.equal(used.config.bigBlind, 40);
});

test('a value no longer allowed goes back to the usual one, and a note names the setting and what it is now', () => {
  const used = fromPreset({ ...kept({ smallBlind: 5 }), actionSeconds: 900, allowStraddle: 'yes', name: '' });

  assert.equal(used.config.actionSeconds, 30);
  assert.equal(used.config.allowStraddle, true);
  assert.equal(used.config.name, DEFAULT_CONFIG.name);
  assert.equal(used.config.smallBlind, 5, 'the rest of the preset still counts');
  assert.deepEqual(used.notes, [
    'Seconds to act is back to 30: the preset’s is no longer allowed.',
    'Table name is back to Chips n\' Dipshits: the preset’s is no longer allowed.',
    'Straddle under the gun is back to on: the preset’s is no longer allowed.',
  ]);

  const clock = fromPreset({ ...kept({}), actionSeconds: 3 });
  assert.equal(clock.config.actionSeconds, 30);
  assert.deepEqual(clock.notes, ['Seconds to act is back to 30: the preset’s is no longer allowed.']);
});

test('settings that no longer go together both go back to the usual', () => {
  const used = fromPreset({ ...kept({}), smallBlind: 50, bigBlind: 20 });

  assert.equal(used.config.smallBlind, 10);
  assert.equal(used.config.bigBlind, 20);
  assert.deepEqual(used.notes, ['Small blind and Big blind are back to the usual: the preset’s no longer go together.']);
  assert.deepEqual(newConfig(used.config), used.config);
});

test('a dollars-and-cents preset plays dollars and cents, and its notes write amounts in dollars', () => {
  const settings = kept({ unit: 'cents', smallBlind: 25, bigBlind: 50, ante: 10, minBuyIn: 2000, maxBuyIn: 10_000 });

  assert.deepEqual(fromPreset(settings).config, { ...DEFAULT_CONFIG, unit: 'cents', smallBlind: 25, bigBlind: 50, ante: 10, minBuyIn: 2000, maxBuyIn: 10_000 });

  // A blind someone typed in dollars into the Sheet: amounts are kept as whole cents
  const typed = fromPreset({ ...settings, smallBlind: 0.25 });
  assert.equal(typed.config.smallBlind, 25);
  assert.deepEqual(typed.notes, ['Small blind is back to 0.25: the preset’s is no longer allowed.']);

  // What a table plays with that the game no longer has falls back first, so the amounts are read as whole chips
  const unknownUnit = fromPreset({ ...kept({ smallBlind: 5, bigBlind: 10 }), unit: 'euros' });
  assert.equal(unknownUnit.config.unit, 'chips');
  assert.equal(unknownUnit.config.bigBlind, 10);
  assert.deepEqual(unknownUnit.notes, ['Play with is back to Whole chips: the preset’s is no longer allowed.']);
});

test('the settings a preset doesn\'t keep come from the table they are filled into', () => {
  const others = { ...DEFAULT_CONFIG, voiceLink: 'https://discord.gg/abc' };

  assert.equal(fromPreset(kept({ bigBlind: 40 }), others).config.voiceLink, 'https://discord.gg/abc');
  assert.equal(fromPreset(kept({ bigBlind: 40 })).config.voiceLink, '');
});

test('whatever is in a preset, what it gives is a set of settings a table takes', () => {
  const rng = seededRng(9);
  const junk = [null, 7, 'x', [], {}, -1, 1e20, 0.5, true, { nested: 1 }, '25', 'https://example.com'];

  for (let round = 0; round < 300; round++) {
    const settings = Object.fromEntries(Object.entries(kept(randomConfig(rng))).map(([key, value]) => [key, rng.int(3) === 0 ? junk[rng.int(junk.length)] : value]));
    const { config } = fromPreset(settings);

    assert.deepEqual(newConfig(config), config, JSON.stringify(settings));
  }
});

test('a table playing a preset\'s settings is known to, and one that differs in anything a preset keeps is not', () => {
  const friday = { name: 'Friday 25/50', settings: kept({ smallBlind: 25, bigBlind: 50 }) };
  const presets = [{ name: 'Usual', settings: kept({}) }, friday];

  assert.equal(matchingPreset(presets, { ...DEFAULT_CONFIG, smallBlind: 25, bigBlind: 50, voiceLink: 'https://discord.gg/abc' }), friday);
  assert.equal(matchingPreset(presets, { ...DEFAULT_CONFIG, smallBlind: 25, bigBlind: 50, actionSeconds: 20 }), null);
});

// ---- The service ----

function setup(build?: string) {
  const presets = new MemoryPresetStore();
  const service = new PokerService({ store: new MemoryStore(), presets, clock: { now: () => 1_700_000_000_000 }, rng: seededRng(4) });
  const handle = build ? (request: object) => new BuildGate(service, build).handle(request) : (request: object) => service.handle(request);

  const joined = (response: ApiResponse) => {
    assert.ok(response.ok && response.kind === 'joined', JSON.stringify(response));

    return { tableId: response.view.id, auth: response.auth };
  };

  const host = joined(handle({ op: 'create', name: 'Quigs', config: { smallBlind: 25, bigBlind: 50 }, build }));
  const member = (name: string) => joined(handle({ op: 'join', tableId: host.tableId, name, build })).auth;

  return { presets, handle, host, member, joined };
}

const save = (tableId: string, auth: Auth, name: string, replace = false) => ({ op: 'savePreset', tableId, auth, name, settings: { ...DEFAULT_CONFIG, smallBlind: 25, bigBlind: 50 }, replace });

test('the host and a co-host may save and delete presets; a plain member, someone from another table and a stranger may not', () => {
  const { handle, host, member, joined } = setup();
  const ann = member('Ann');
  const bob = member('Bob');
  assert.ok(handle({ op: 'act', tableId: host.tableId, auth: host.auth, command: { type: 'setCohost', playerId: ann.id, on: true } }).ok);

  const saved = handle(save(host.tableId, host.auth, 'Friday 25/50'));
  assert.ok(saved.ok && saved.kind === 'presets', JSON.stringify(saved));
  assert.deepEqual(saved.presets.map((preset) => preset.name), ['Friday 25/50']);

  const byCohost = handle(save(host.tableId, ann, 'Tuesday'));
  assert.ok(byCohost.ok && byCohost.kind === 'presets');
  assert.equal(byCohost.presets.length, 2);

  assert.deepEqual(handle(save(host.tableId, bob, 'Mine')), { ok: false, code: 'invalid', error: 'Only the host or a co-host can do that' });
  assert.deepEqual(handle({ op: 'deletePreset', tableId: host.tableId, auth: bob, name: 'Tuesday' }), { ok: false, code: 'invalid', error: 'Only the host or a co-host can do that' });

  // The host of another table, sending from this one with their own credentials
  const other = joined(handle({ op: 'create', name: 'Elsewhere' }));
  assert.equal((handle(save(host.tableId, other.auth, 'Theirs')) as { code: string }).code, 'unauthorized');
  assert.equal((handle({ op: 'deletePreset', tableId: host.tableId, auth: { id: 'NOBODY00', token: 'x' }, name: 'Tuesday' }) as { code: string }).code, 'unauthorized');
  assert.deepEqual(handle({ op: 'savePreset', tableId: host.tableId, name: 'No one', settings: {} }), { ok: false, code: 'invalid', error: 'Malformed request' });
  assert.equal((handle(save('ZZZZZZ', host.auth, 'Nowhere')) as { code: string }).code, 'not_found');

  const deleted = handle({ op: 'deletePreset', tableId: host.tableId, auth: ann, name: 'friday 25/50' });
  assert.ok(deleted.ok && deleted.kind === 'presets');
  assert.deepEqual(deleted.presets.map((preset) => preset.name), ['Tuesday'], 'the name matched whatever its case');

  const again = handle({ op: 'deletePreset', tableId: host.tableId, auth: ann, name: 'Friday 25/50' });
  assert.ok(again.ok && again.kind === 'presets', 'deleting one already gone is no failure: a second host got there first');
});

test('anyone may list the presets, without being at any table', () => {
  const { handle, host } = setup();
  handle(save(host.tableId, host.auth, 'Friday 25/50'));

  const listed = handle({ op: 'presets' });
  assert.ok(listed.ok && listed.kind === 'presets');
  assert.deepEqual(listed.presets, [{ name: 'Friday 25/50', settings: kept({ smallBlind: 25, bigBlind: 50 }) }]);
});

test('a listed preset holds only settings presets keep, whatever was put in its row', () => {
  const { handle, presets } = setup();
  presets.save({ name: 'By hand', settings: { bigBlind: 40, voiceLink: 'https://meet.google.com/abc-defg-hij', rabbitHunting: true }, savedAt: 0, savedBy: 'Quigs' }, false);

  const listed = handle({ op: 'presets' });
  assert.ok(listed.ok && listed.kind === 'presets');
  assert.deepEqual(listed.presets, [{ name: 'By hand', settings: { bigBlind: 40 } }]);
});

test('a preset keeps who saved it and when, and its name is cleaned as a table\'s is', () => {
  const { handle, host, presets } = setup();
  const saveCalls: unknown[] = [];
  const keep = presets.save.bind(presets);
  presets.save = (preset, replace) => {
    saveCalls.push(preset);

    return keep(preset, replace);
  };

  const saved = handle(save(host.tableId, host.auth, '  Friday‮  25/50\u0007 '));
  assert.ok(saved.ok && saved.kind === 'presets', JSON.stringify(saved));
  assert.deepEqual(saveCalls, [{ name: 'Friday 25/50', settings: kept({ smallBlind: 25, bigBlind: 50 }), savedAt: 1_700_000_000_000, savedBy: 'Quigs' }]);

  assert.deepEqual(handle(save(host.tableId, host.auth, 'x'.repeat(31))), { ok: false, code: 'invalid', error: 'The preset name must be 1 to 30 characters' });
  assert.deepEqual(handle(save(host.tableId, host.auth, '‏ ')), { ok: false, code: 'invalid', error: 'The preset name must be 1 to 30 characters' });
  assert.deepEqual(handle({ ...save(host.tableId, host.auth, 'Bad'), settings: { ...DEFAULT_CONFIG, actionSeconds: 3 } }), { ok: false, code: 'invalid', error: 'The action clock must be off or at least 5 seconds' });
});

test('a name already taken, whatever its case, is replaced only when the request says to', () => {
  const { handle, host } = setup();
  handle(save(host.tableId, host.auth, 'Friday 25/50'));

  assert.deepEqual(handle(save(host.tableId, host.auth, 'FRIDAY 25/50')), { ok: false, code: 'invalid', error: 'There is already a preset called Friday 25/50' });

  const replaced = handle({ ...save(host.tableId, host.auth, 'FRIDAY 25/50', true), settings: { ...DEFAULT_CONFIG, smallBlind: 50, bigBlind: 100 } });
  assert.ok(replaced.ok && replaced.kind === 'presets');
  assert.deepEqual(replaced.presets, [{ name: 'FRIDAY 25/50', settings: kept({ smallBlind: 50, bigBlind: 100 }) }]);
});

test('a page of another build may list the presets but not save or delete one', () => {
  const { handle, host } = setup('thisbuild000');
  handle({ ...save(host.tableId, host.auth, 'Friday 25/50'), build: 'thisbuild000' });

  const listed = handle({ op: 'presets', build: 'olderbuild00' });
  assert.ok(listed.ok && listed.kind === 'presets' && listed.presets.length === 1);

  assert.equal((handle({ ...save(host.tableId, host.auth, 'Stale'), build: 'olderbuild00' }) as { code: string }).code, 'stale');
  assert.equal((handle({ op: 'deletePreset', tableId: host.tableId, auth: host.auth, name: 'Friday 25/50', build: 'olderbuild00' }) as { code: string }).code, 'stale');

  const after = handle({ op: 'presets', build: 'thisbuild000' });
  assert.ok(after.ok && after.kind === 'presets');
  assert.deepEqual(after.presets.map((preset) => preset.name), ['Friday 25/50']);
});
