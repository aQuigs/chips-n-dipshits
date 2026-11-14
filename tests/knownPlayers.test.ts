import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { KnownPlayer } from '../src/engine/index.ts';
import { answerOf, offerOf, playerFor, RememberedPlayer } from '../src/client/knownPlayers.ts';
import type { Asked, PlayerMemory } from '../src/client/knownPlayers.ts';
import { mapMemory } from './helpers.ts';

const ANN = { id: 'ANNANNANN2', name: 'Ann' };
const BOB = { id: 'BOBBOBBOB2', name: 'Bob' };
const BIG_AL = { id: 'BIGALBIGA2', name: 'Big Al' };

/** A browser's memory as the page is handed it, holding a seat and a typed name from before, as most browsers that come back do. */
function browser(kept: Record<string, string> = {}): PlayerMemory & { kept: Record<string, string> } {
  const memory = mapMemory({ 'cnd.seat.ABC234': 'MEMBER23.TOKENTOKENTOKENTOKEN2345', 'cnd.name': 'Annie', 'cnd.theme': 'felt', ...kept });

  return { ...memory, remove: (key) => void delete memory.kept[key] };
}

function asked(over: Partial<Asked> = {}): Asked {
  return { players: null, remembered: null, said: null, filter: '', typed: '', ...over };
}

function many(count: number): KnownPlayer[] {
  return Array.from({ length: count }, (_player, index) => ({ id: `PLAYER${1000 + index}`, name: `Player ${index}` }));
}

test('with nobody known the question is only what your name is, before the list is in, when it is empty, and if it never comes', () => {
  for (const players of [null, []]) {
    const offer = offerOf(asked({ players, typed: 'Quigs' }));

    assert.deepEqual(offer, { mode: 'name', as: null, shown: [], filtered: false, alike: null });
    assert.deepEqual(answerOf(asked({ players, typed: 'Quigs' })), { who: { as: 'new' }, name: 'Quigs' });
  }
});

test('with players known and nobody remembered, the list is offered with someone new picked, and a tap on a name picks that player', () => {
  const players = [BOB, ANN, BIG_AL];
  const first = asked({ players, typed: 'Cy' });

  assert.deepEqual(offerOf(first), { mode: 'pick', as: null, shown: players, filtered: false, alike: null });
  assert.deepEqual(answerOf(first), { who: { as: 'new' }, name: 'Cy' });

  const picked = { ...first, said: ANN.id };
  assert.deepEqual(offerOf(picked), { mode: 'pick', as: ANN, shown: players, filtered: false, alike: null });
  assert.deepEqual(answerOf(picked), { who: { as: 'known', id: ANN.id }, name: 'Ann' }, 'the name typed for someone new is not sent for a known player');

  assert.deepEqual(answerOf({ ...picked, said: 'new' }), { who: { as: 'new' }, name: 'Cy' });
});

test('a remembered player is who the page says you are, until you say "not me", and even while the list is not in', () => {
  for (const players of [null, [BOB, ANN]]) {
    const first = asked({ players, remembered: ANN, typed: 'Annie' });

    assert.deepEqual(offerOf(first).mode, 'remembered');
    assert.deepEqual(offerOf(first).as, ANN);
    assert.deepEqual(answerOf(first), { who: { as: 'known', id: ANN.id }, name: 'Ann' });

    // Not me: the list if there is one, with nobody picked and the remembered player still on it to go back to
    const notMe = { ...first, said: 'new' };
    assert.deepEqual(offerOf(notMe), { mode: players ? 'pick' : 'name', as: null, shown: players ?? [], filtered: false, alike: null });
    assert.deepEqual(answerOf(notMe), { who: { as: 'new' }, name: 'Annie' });
    assert.deepEqual(answerOf({ ...notMe, said: BOB.id }), players ? { who: { as: 'known', id: BOB.id }, name: 'Bob' } : { who: { as: 'new' }, name: 'Annie' });
  }
});

test('a remembered player the list no longer has is not offered, and neither is a pick that is not on it', () => {
  const gone = asked({ players: [BOB], remembered: ANN, typed: 'Ann' });

  assert.equal(offerOf(gone).mode, 'pick');
  assert.equal(offerOf(gone).as, null);
  assert.deepEqual(answerOf(gone), { who: { as: 'new' }, name: 'Ann' });
  assert.deepEqual(answerOf({ ...gone, said: ANN.id }), { who: { as: 'new' }, name: 'Ann' });
});

test('a new name that reads like a known player\'s points at that player, and stops once they are picked', () => {
  const players = [BOB, ANN, BIG_AL];

  for (const typed of ['Big Al', 'big al', ' BIG  AL ', 'BigAl', 'Big AI']) {
    assert.deepEqual(offerOf(asked({ players, typed })).alike, BIG_AL, typed);
  }

  assert.equal(offerOf(asked({ players, typed: 'Big Alan' })).alike, null);
  assert.equal(offerOf(asked({ players, typed: '   ' })).alike, null);
  assert.equal(offerOf(asked({ players, typed: 'Big Al', said: BIG_AL.id })).alike, null);
  assert.equal(offerOf(asked({ players, typed: 'Bob', remembered: ANN })).alike, null, 'nobody is typing a name while the page takes them for a known player');
});

test('a long list gets a box to find a name in, which narrows it by any part of the name and leaves the pick alone', () => {
  assert.equal(offerOf(asked({ players: many(8) })).filtered, false);
  assert.equal(offerOf(asked({ players: many(9) })).filtered, true);

  const forty = [...many(38), BOB, BIG_AL];
  const narrowed = asked({ players: forty, said: BOB.id, filter: ' b ' });

  assert.deepEqual(offerOf(narrowed).shown, [BOB, BIG_AL]);
  assert.deepEqual(offerOf({ ...narrowed, filter: 'PLAYER 3' }).shown.map((player) => player.name), ['Player 3', ...Array.from({ length: 8 }, (_name, index) => `Player 3${index}`)]);
  assert.deepEqual(offerOf({ ...narrowed, filter: 'zz' }).shown, []);
  assert.deepEqual(answerOf({ ...narrowed, filter: 'zz' }), { who: { as: 'known', id: BOB.id }, name: 'Bob' }, 'a player picked and then filtered out of sight is still the answer');
});

test('the browser remembers which known player it is beside its other memory, and reads nothing it cannot make sense of', () => {
  const memory = browser();
  const me = new RememberedPlayer(memory);
  const before = { ...memory.kept };

  assert.equal(me.get(), null);

  me.set(ANN);
  assert.deepEqual(me.get(), ANN);
  assert.deepEqual(memory.kept, { ...before, 'cnd.player': JSON.stringify(ANN) }, 'the seat, the typed name and the preferences are as they were');

  for (const kept of ['', 'Ann', '{', '[]', 'null', '{"id":"ANNANNANN2"}', '{"id":7,"name":"Ann"}', '{"id":"","name":""}']) {
    assert.equal(new RememberedPlayer(browser({ 'cnd.player': kept })).get(), null, kept);
  }
});

test('held to a list that was loaded, a remembered player who is gone is forgotten, one renamed is remembered by the new name, and a seat is never touched', () => {
  const memory = browser({ 'cnd.player': JSON.stringify(ANN) });
  const me = new RememberedPlayer(memory);
  const seat = memory.kept['cnd.seat.ABC234'];

  assert.deepEqual(me.heldTo([BOB, ANN]), ANN);
  assert.deepEqual(me.get(), ANN);

  const renamed = { id: ANN.id, name: 'Annabel' };
  assert.deepEqual(me.heldTo([renamed, BOB]), renamed);
  assert.deepEqual(me.get(), renamed);

  assert.equal(me.heldTo([BOB]), null);
  assert.equal(me.get(), null);
  assert.equal('cnd.player' in memory.kept, false);
  assert.deepEqual(memory.kept, { 'cnd.seat.ABC234': seat, 'cnd.name': 'Annie', 'cnd.theme': 'felt' });

  // With nobody remembered, an empty list and a full one are the same to it
  assert.equal(me.heldTo([]), null);
  assert.equal(me.heldTo([ANN]), null);
  assert.equal(me.get(), null);
});

test('a browser that refuses to remember anything asks who you are every time and breaks nothing', () => {
  const forgetful: PlayerMemory = { get: () => null, set: () => undefined, remove: () => undefined };
  const me = new RememberedPlayer(forgetful);

  me.set(ANN);
  assert.equal(me.get(), null);
  assert.equal(me.heldTo([ANN]), null);
});

test('what is remembered after joining is the player the table has you down as, under the name the list keeps', () => {
  assert.deepEqual(playerFor(ANN.id, { who: { as: 'known', id: ANN.id }, name: 'Ann' }), ANN);
  assert.deepEqual(playerFor('NEWNEWNEW2', { who: { as: 'new' }, name: '  Big   Bob ' }), { id: 'NEWNEWNEW2', name: 'Big Bob' });
});
