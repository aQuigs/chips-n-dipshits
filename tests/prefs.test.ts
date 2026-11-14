import assert from 'node:assert/strict';
import test from 'node:test';

import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import type { Pref, PrefHost, PrefMemory } from '../src/client/prefs.ts';
import { mapMemory } from './helpers.ts';

const REFUSING: PrefMemory = {
  get: () => {
    throw new Error('storage is denied');
  },
  set: () => {
    throw new Error('storage is denied');
  },
};

const SAMPLES = {
  fourColor: { kind: 'onOff', label: 'Four-color deck', default: false, css: 'attribute' },
  cardBack: {
    kind: 'choice',
    label: 'Card backs',
    options: [
      { value: 'stripes', label: 'Stripes' },
      { value: 'plain', label: 'Plain' },
    ],
    default: 'stripes',
    css: 'attribute',
  },
  textSize: { kind: 'range', label: 'Text size', min: 1, max: 1.5, step: 0.1, default: 1, css: 'property' },
  volume: { kind: 'range', label: 'Volume', min: 0, max: 100, step: 5, default: 60 },
} satisfies Record<string, Pref>;

function fakeHost(): PrefHost & { properties: Record<string, string> } {
  const properties: Record<string, string> = {};

  return { dataset: {}, properties, style: { setProperty: (name, value) => void (properties[name] = value) } };
}

test('a choice is kept under the name and in the words the page used before there was a registry', () => {
  const memory = mapMemory();
  const prefs = new Preferences(PREFERENCES, memory);

  assert.equal(prefs.get('sound'), true);
  assert.equal(prefs.get('theme'), 'cardroom');

  prefs.set('sound', false);
  prefs.set('theme', 'divebar');
  assert.deepEqual(memory.kept, { 'cnd.sound': 'off', 'cnd.theme': 'divebar' });

  const later = new Preferences(PREFERENCES, mapMemory({ 'cnd.sound': 'off', 'cnd.theme': 'daylight' }));
  assert.equal(later.get('sound'), false);
  assert.equal(later.get('theme'), 'daylight');
});

test('a browser that throws when asked to remember costs only that: choices still hold for the visit', () => {
  const prefs = new Preferences(SAMPLES, REFUSING, fakeHost());
  const heard: number[] = [];

  prefs.watch('volume', (value) => heard.push(value));

  assert.equal(prefs.get('fourColor'), false);
  assert.equal(prefs.get('volume'), 60);

  prefs.set('fourColor', true);
  prefs.set('volume', 35);

  assert.equal(prefs.get('fourColor'), true);
  assert.equal(prefs.get('volume'), 35);
  assert.deepEqual(heard, [35]);
});

test('a browser that takes a choice and then has nothing does not undo it', () => {
  const forgetful: PrefMemory = { get: () => null, set: () => undefined };
  const prefs = new Preferences(SAMPLES, forgetful);

  prefs.set('cardBack', 'plain');
  assert.equal(prefs.get('cardBack'), 'plain');
});

test('a choice made in another tab of the same browser is the one that holds, as it was before there was a registry', () => {
  const browser = mapMemory();
  const here = new Preferences(PREFERENCES, browser);
  const otherTab = new Preferences(PREFERENCES, browser);

  here.set('sound', true);
  otherTab.set('sound', false);

  assert.equal(here.get('sound'), false);
});

test('what was kept but no longer makes sense reads as the default, and a number is held to its range', () => {
  const kept = { 'cnd.fourColor': 'yes', 'cnd.cardBack': 'a back that was taken out', 'cnd.textSize': 'big', 'cnd.volume': '250' };
  const prefs = new Preferences(SAMPLES, mapMemory(kept));

  assert.equal(prefs.get('fourColor'), false);
  assert.equal(prefs.get('cardBack'), 'stripes');
  assert.equal(prefs.get('textSize'), 1);
  assert.equal(prefs.get('volume'), 100);

  assert.equal(new Preferences(SAMPLES, mapMemory({ 'cnd.volume': '' })).get('volume'), 60);
  assert.equal(new Preferences(SAMPLES, mapMemory({ 'cnd.volume': '-5' })).get('volume'), 0);
});

test('a choice that asks for it is shown on the host from the start and on every change, for stylesheets to react to', () => {
  const host = fakeHost();
  const prefs = new Preferences(SAMPLES, mapMemory({ 'cnd.cardBack': 'plain' }), host);

  assert.deepEqual(host.dataset, { fourColor: 'off', cardBack: 'plain' });
  assert.deepEqual(host.properties, { '--text-size': '1' });

  prefs.set('fourColor', true);
  prefs.set('textSize', 1.3);
  prefs.set('volume', 10);

  assert.deepEqual(host.dataset, { fourColor: 'on', cardBack: 'plain' });
  assert.deepEqual(host.properties, { '--text-size': '1.3' }, 'a choice that did not ask to be shown is not');
});

test('a watcher hears each new choice of what it watches, until it is stopped', () => {
  const prefs = new Preferences(SAMPLES, mapMemory());
  const heard: unknown[] = [];
  const stop = prefs.watch('fourColor', (on) => heard.push(on));

  prefs.set('fourColor', true);
  prefs.set('cardBack', 'plain');
  prefs.set('fourColor', false);
  stop();
  prefs.set('fourColor', true);

  assert.deepEqual(heard, [true, false]);
});

test('every preference starts out at a value it can hold', () => {
  const prefs = new Preferences(PREFERENCES, mapMemory());

  for (const [key, pref] of Object.entries(PREFERENCES) as [keyof typeof PREFERENCES, Pref][]) {
    assert.equal(prefs.get(key), pref.default, `${key} cannot hold its own default`);
  }
});
