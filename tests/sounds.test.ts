import assert from 'node:assert/strict';
import test from 'node:test';

import { soundsHeard } from '../src/client/handSounds.ts';
import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import type { AppPreferences } from '../src/client/prefs.ts';
import { MOST_WAIT_MS, SOUND_GAP_MS, Sounds } from '../src/client/sound.ts';
import { RECIPES } from '../src/client/soundRecipes.ts';
import type { SoundMaker, SoundName } from '../src/client/sound.ts';
import { tableChange } from '../src/client/tableChange.ts';
import type { TableChange } from '../src/client/tableChange.ts';
import type { HandEvent, TableView } from '../src/engine/index.ts';
import { mapMemory, TestTable } from './helpers.ts';

/** A viewer's sounds, made by a stand-in that writes down what it was asked to play, on a clock the test moves. */
class Ears {
  readonly played: { sound: SoundName; volume: number; delay: number }[] = [];
  readonly prefs: AppPreferences = new Preferences(PREFERENCES, mapMemory());
  now = 0;
  inView = true;
  readonly sounds: Sounds;

  constructor() {
    const maker: SoundMaker = { play: (sound, volume, delay) => void this.played.push({ sound, volume, delay }) };

    this.sounds = new Sounds(maker, this.prefs, { now: () => this.now, inView: () => this.inView });
  }

  /** What the hand-sounds effect does with a change. */
  hear(change: TableChange, seat: number | null): SoundName[] {
    const from = this.played.length;

    for (const sound of soundsHeard(change.events, seat)) {
      this.sounds.play(sound);
    }

    this.now += 10_000;

    return this.played.slice(from).map((played) => played.sound);
  }
}

/** One seat's page: each view as it arrives, turned into the change the effects are handed. */
class Page {
  private shown: TableView | null = null;
  readonly ears = new Ears();
  private readonly table: TestTable;
  private readonly seat: number;

  constructor(table: TestTable, seat: number) {
    this.table = table;
    this.seat = seat;
  }

  arrive(wentBack = false): SoundName[] {
    const change = tableChange(this.shown, structuredClone(this.table.view(this.seat)), this.table.now, wentBack);

    this.shown = change.view;

    return this.ears.hear(change, this.seat);
  }
}

// Seat 0 is listening; seat 1 is someone else
const BY_SOMEONE_ELSE: [HandEvent, SoundName | null][] = [
  [['start', 1, 0, 10, 20, [[0, 'P0', 1000], [1, 'P1', 1000]]], null],
  [['post', 1, 'big blind', 20, 980], null],
  [['deal'], 'deal'],
  [['fold', 1], 'fold'],
  [['check', 1], 'knock'],
  [['call', 1, 20, 960], 'chips'],
  [['bet', 1, 40, 940], 'chips'],
  [['raise', 1, 120, 860], 'chips'],
  [['raise', 1, 980, 0], 'allIn'],
  [['call', 1, 600, 0], 'allIn'],
  [['timeout', 1], null],
  [['return', 1, 200], null],
  [['street', 0, ['As', 'Kd', '2c']], 'street'],
  [['street', 1, ['9h']], 'street'],
  [['vote', 1, true], null],
  [['runs', 2], null],
  [['show', 1, ['7d', '2s']], null],
  [['muck', 1], null],
  [['win', 1, 400, 0, 0], 'win'],
  [['bounty', 1, [[0, 20]]], 'chips'],
];

test('each kind of hand event makes its sound, or none', () => {
  for (const [event, sound] of BY_SOMEONE_ELSE) {
    assert.deepEqual(soundsHeard([event], 0), sound ? [sound] : [], event[0]);
  }
});

test('a player does not hear their own moves, and someone only watching hears everyone', () => {
  const own: HandEvent[] = [['fold', 0], ['check', 0], ['call', 0, 20, 960], ['bet', 0, 40, 940], ['raise', 0, 980, 0]];

  for (const event of own) {
    assert.deepEqual(soundsHeard([event], 0), [], event[0]);
    assert.equal(soundsHeard([event], null).length, 1, `a watcher hears a ${event[0]}`);
  }
});

test('the viewer’s own pot sounds bigger than anyone else’s, and covers someone else’s won at the same time', () => {
  const table = new TestTable({ stacks: [1000, 1000] });
  const pages = [new Page(table, 0), new Page(table, 1)];

  table.deal({ button: 0 });
  pages.forEach((page) => page.arrive());

  table.raise(0, 100);
  assert.deepEqual(pages.map((page) => page.arrive()), [[], ['chips']]);

  table.fold(1);
  assert.deepEqual(pages.map((page) => page.arrive()), [['fold', 'myWin'], ['win']]);

  // A pot split down the middle on one board, or one of two boards won by each
  const split: HandEvent[] = [['win', 1, 200, 0, 0], ['win', 0, 200, 0, 1]];
  assert.deepEqual(soundsHeard(split, 0), ['myWin']);
  assert.deepEqual(soundsHeard(split, 2), ['win']);
});

test('a hand plays its deal, its moves, its streets and its result as they come', () => {
  const table = new TestTable({ stacks: [1000, 1000, 1000] });
  const page = new Page(table, 2);

  page.arrive();
  table.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kc', 2: '7h 2s' }, board: '3c 8d Jh Qs 4d' });
  assert.deepEqual(page.arrive(), ['deal']);

  table.call(0);
  assert.deepEqual(page.arrive(), ['chips']);
  table.call(1);
  page.arrive();
  table.check(2);
  assert.deepEqual(page.arrive(), ['street'], 'the closing check is the viewer’s own, and the flop it brings is heard');

  table.check(1);
  assert.deepEqual(page.arrive(), ['knock']);
  table.raise(2, 100);
  page.arrive();
  table.fold(0);
  assert.deepEqual(page.arrive(), ['fold']);
  table.fold(1);
  assert.deepEqual(page.arrive(), ['fold', 'myWin']);
});

test('a hand run twice deals every street of both boards with its own sound, and the pot after the last', () => {
  const table = new TestTable({ stacks: [1000, 1000], config: { allowRunItTwice: true } });
  const page = new Page(table, 1);

  table.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Kd Kc' }, board: '3c 8d Jh Qs 4d', secondBoard: '2c 5h 9s 6d 7c' });
  page.arrive();
  table.raise(0, 1000);
  assert.deepEqual(page.arrive(), ['allIn']);
  table.call(1);
  page.arrive();
  table.cmd(0, { type: 'ritVote', agree: true });
  table.cmd(1, { type: 'ritVote', agree: true });
  page.arrive();

  const heard: SoundName[][] = [];
  for (let step = 0; step < 10 && table.state.hand!.stage !== 'done'; step++) {
    table.wait(table.state.hand!.deadline! - table.now);
    heard.push(page.arrive());
  }

  assert.deepEqual(heard, [['street'], ['street'], ['street'], ['street'], ['street'], ['street', 'win']]);
});

test('a bomb pot, dealt straight to the flop, plays the deal and then the flop, one clear of the other', () => {
  const table = new TestTable({ stacks: [1000, 1000, 1000] });
  const page = new Page(table, 2);

  page.arrive();
  table.cmd(0, { type: 'setBombPot', on: true });
  table.deal({ button: 0 });

  assert.deepEqual(table.view(2).hand!.events.map((event) => event[0]), ['start', 'post', 'post', 'post', 'deal', 'street'], 'a bomb pot’s events');

  assert.deepEqual(page.arrive(), ['deal', 'street']);

  const [deal, flop] = page.ears.played;
  const dealEnds = Math.max(...RECIPES.deal.map((voice) => voice.at + voice.length));
  assert.ok(dealEnds < flop!.delay - deal!.delay, `the deal is still playing when the flop comes: ${dealEnds} s against ${flop!.delay - deal!.delay} s`);
});

test('a seven-deuce bounty rings up its chips after the pot', () => {
  const table = new TestTable({ stacks: [1000, 1000, 1000], config: { sevenDeuceBounty: 50 } });
  const page = new Page(table, 1);

  table.deal({ button: 0, holes: { 0: '7h 2s' } });
  page.arrive();
  table.raise(0, 100);
  page.arrive();
  table.fold(1);
  page.arrive();
  table.fold(2);

  assert.deepEqual(page.arrive(), ['fold', 'win', 'chips']);
});

test('no hand sounds play on the first view, on a table that went back, or for what happened while the viewer was away', () => {
  const table = new TestTable({ stacks: [1000, 1000] });
  const page = new Page(table, 1);
  const saved = structuredClone(table.state);

  table.deal({ button: 0 });
  table.raise(0, 60);
  assert.deepEqual(page.arrive(), [], 'the page opened mid-hand');

  table.state = saved;
  table.deal({ button: 0 });
  table.call(0);
  table.check(1);
  assert.deepEqual(page.arrive(true), [], 'the table went back');

  table.check(1);
  table.check(0);
  table.wait(60_000);
  assert.deepEqual(page.arrive(), [], 'the turn reached a page that had been asleep for a minute');

  assert.deepEqual(page.ears.played, []);
});

test('a burst of moves plays each sound once, where it last came, and only the last few', () => {
  const calls: HandEvent[] = [2, 3, 4, 5, 6].map((seat) => ['call', seat, 20, 980]);
  assert.deepEqual(soundsHeard(calls, 0), ['chips'], 'five calls are one sound');

  const street: HandEvent[] = [['fold', 2], ['call', 3, 20, 980], ['check', 4], ['street', 0, ['As', 'Kd', '2c']], ['bet', 4, 40, 940], ['fold', 5], ['win', 4, 200, 0, 0]];
  assert.deepEqual(soundsHeard(street, 0), ['chips', 'fold', 'win'], 'how the street ended');
});

test('sounds asked for together are spaced out, and one that would wait too long behind them is dropped', () => {
  const ears = new Ears();
  const kinds: SoundName[] = ['fold', 'chips', 'knock', 'street', 'deal', 'win'];

  for (const sound of kinds) {
    ears.sounds.play(sound);
  }

  const fit = Math.floor(MOST_WAIT_MS / SOUND_GAP_MS) + 1;
  assert.deepEqual(ears.played.map((played) => played.sound), kinds.slice(0, fit));
  assert.deepEqual(ears.played.map((played) => played.delay), kinds.slice(0, fit).map((_, index) => (index * SOUND_GAP_MS) / 1000));

  // Once they have played, the next starts at once
  ears.now += 1000;
  ears.sounds.play('turn');
  assert.equal(ears.played.at(-1)!.delay, 0);

  // Asked for just after another, it waits for the gap and no longer
  ears.now += SOUND_GAP_MS / 2;
  ears.sounds.play('chips');
  assert.equal(ears.played.at(-1)!.delay, SOUND_GAP_MS / 2 / 1000);
});

test('the chime for the viewer’s turn waits behind other sounds, however many, and is never dropped', () => {
  const ears = new Ears();

  // A street's sounds, and a moment later another view with a check and the action reaching the viewer
  for (const sound of ['chips', 'fold', 'street'] as const) {
    ears.sounds.play(sound);
  }

  ears.now += 50;
  ears.sounds.play('knock');
  ears.sounds.play('turn');

  assert.deepEqual(ears.played.map((played) => played.sound), ['chips', 'fold', 'street', 'knock', 'turn']);
  assert.ok(ears.played.at(-1)!.delay * 1000 > MOST_WAIT_MS, 'the chime had to wait longer than any other sound may');
});

test('an event this page does not know is silent, and does not stop the rest being heard', () => {
  const unknown = [['bombPot', 3, 40]] as unknown as HandEvent[];

  assert.deepEqual(soundsHeard(unknown, 0), []);
  assert.deepEqual(soundsHeard([...unknown, ['check', 1]], 0), ['knock']);
});

test('the sound switch silences everything, volume zero too, and the volume is what is played at', () => {
  const ears = new Ears();

  ears.sounds.play('chips');
  assert.equal(ears.played.at(-1)!.volume, PREFERENCES.volume.default / 100);

  ears.prefs.set('volume', 80);
  ears.now += 1000;
  ears.sounds.play('knock');
  assert.equal(ears.played.at(-1)!.volume, 0.8);

  const before = ears.played.length;

  ears.prefs.set('volume', 0);
  ears.now += 1000;
  ears.sounds.play('turn');

  ears.prefs.set('volume', 100);
  ears.prefs.set('sound', false);
  ears.now += 1000;
  ears.sounds.play('turn');
  ears.sounds.play('myWin');

  assert.equal(ears.played.length, before);
});

test('out of sight, only the chime that calls the player back plays', () => {
  const ears = new Ears();

  ears.inView = false;
  ears.sounds.play('chips');
  ears.sounds.play('street');
  ears.sounds.play('turn');

  assert.deepEqual(ears.played.map((played) => played.sound), ['turn']);
});
