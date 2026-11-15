import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateHand, freshDeck, madeHandName, midSentence, playerHand, PLAYING_THE_BOARD, readHand, startingHandName } from '../src/engine/index.ts';
import type { Card } from '../src/engine/index.ts';
import { cards, seededRng } from './helpers.ts';

const read = (hole: string, board: string) => readHand(cards(hole), cards(board));
const nameOf = (hole: string, board: string) => read(hole, board).name;
const sorted = (list: readonly Card[]) => [...list].sort();

test('names every made hand', () => {
  assert.equal(nameOf('As Ks', 'Qs Js Ts 2c 3d'), 'Royal flush');
  assert.equal(nameOf('9h 8h', '7h 6h 5h Kc 2d'), 'Straight flush, nine high');
  assert.equal(nameOf('Kc Kd', 'Kh Ks 2c 7d 9h'), 'Four kings');
  assert.equal(nameOf('Kc Kd', 'Kh Ts Tc 2d 4s'), 'Full house, kings over tens');
  assert.equal(nameOf('Ac Jc', '8c 4c 2c Kd 3h'), 'Flush, ace high');
  assert.equal(nameOf('Tc 9d', '8h 7s 6c Kd 2h'), 'Straight, ten high');
  assert.equal(nameOf('7c 7d', '7h Ks 2c 9d 4h'), 'Three sevens');
  assert.equal(nameOf('Kc 7d', 'Kh 7s 2c 9d 4h'), 'Two pair, kings and sevens');
  assert.equal(nameOf('6c 6d', 'Kh Qs 2c 9d 4h'), 'Pair of sixes');
  assert.equal(nameOf('Ac Jd', '8h 4s 2c 9d 6h'), 'Ace high');
  assert.equal(nameOf('2c 2d', 'Kh Qs 7c 9d 4h'), 'Pair of deuces');
});

test('the wheel is a five-high straight, and a five-high straight flush', () => {
  assert.equal(nameOf('Ac 2d', '3h 4s 5c Kd Kh'), 'Straight, five high');
  assert.equal(nameOf('Ad 2d', '3d 4d 5d Kc Kh'), 'Straight flush, five high');
});

test('a hand is named on the flop and the turn as well as the river', () => {
  assert.equal(nameOf('Kc 7d', 'Kh 2s 9c'), 'Pair of kings');
  assert.equal(nameOf('Kc 7d', 'Kh 7s 9c 2d'), 'Two pair, kings and sevens');
});

test('a kicker is never named, but the hint lifts it when it is one of the player\'s own', () => {
  assert.equal(nameOf('Ac 3d', '8h 8s Kc 5d 2h'), 'Pair of eights');
  assert.ok(read('Ac 3d', '8h 8s Kc 5d 2h').plays.includes('Ac'), 'the ace in hand plays as the kicker');
  assert.equal(nameOf('Ac 3d', 'Kh Ks Kc Kd 2h'), 'Four kings');
  assert.ok(read('Ac 3d', 'Kh Ks Kc Kd 2h').plays.includes('Ac'));
  assert.equal(nameOf('Ac Ad', 'Kh 7s 5c 3d 2h'), 'Pair of aces');
  assert.equal(nameOf('Ac 9d', 'Kh 7s 5c 3d 2h'), 'Ace high');
});

test('a hand the board makes alone is the board playing, and showdown still names it', () => {
  assert.equal(nameOf('2c 3d', 'As Ks Qs Js Ts'), PLAYING_THE_BOARD);
  assert.equal(nameOf('2c 3d', 'Ah Ks Qd 9c 8h'), PLAYING_THE_BOARD);
  assert.equal(nameOf('Qc 3d', 'Kh Ks Kc Kd Ah'), PLAYING_THE_BOARD, 'the board\'s ace outkicks the queen');
  assert.equal(nameOf('Tc 3d', 'Ah Kd Qs Jc Th'), PLAYING_THE_BOARD, 'a ten that only matches the board\'s ten adds nothing');

  assert.equal(madeHandName(playerHand(cards('2c 3d'), cards('As Ks Qs Js Ts'))), 'Royal flush');
  assert.equal(madeHandName(playerHand(cards('Qc 3d'), cards('Kh Ks Kc Kd Ah'))), 'Four kings');
});

test('a name inside a sentence starts small', () => {
  assert.equal(midSentence('Two pair, kings and sevens'), 'two pair, kings and sevens');
});

test('two cards before the flop are named by their shape', () => {
  assert.equal(startingHandName(cards('As Ah')), 'Pocket aces');
  assert.equal(startingHandName(cards('2s 2h')), 'Pocket deuces');
  assert.equal(startingHandName(cards('Kd Ad')), 'Ace-king suited');
  assert.equal(startingHandName(cards('As Kd')), 'Ace-king offsuit');
  assert.equal(startingHandName(cards('2c 7d')), 'Seven-deuce offsuit');
  assert.equal(startingHandName(cards('7c 2c')), 'Seven-deuce suited');
  assert.equal(startingHandName(cards('Tc 9c')), 'Ten-nine suited');

  assert.deepEqual(read('As Ah', ''), { name: 'Pocket aces', plays: [] });
});

test('the five cards that play are the right five in awkward spots', () => {
  const plays = (hole: string, board: string) => sorted(read(hole, board).plays);
  const these = (text: string) => sorted(cards(text));

  // Two pair on a paired board: the board's pair, the player's pair, and the board's best kicker
  assert.deepEqual(plays('7c 3d', 'Kh Ks 7s 4d 2h'), these('Kh Ks 7c 7s 4d'));

  // Six cards of a suit: the low one in hand sits out
  assert.deepEqual(plays('Kh 3h', 'Ah 9h 6h 4h 2c'), these('Ah Kh 9h 6h 4h'));
  assert.equal(read('Kh 3h', 'Ah 9h 6h 4h 2c').name, 'Flush, ace high');

  // A straight that needs one card from hand: the board's nine plays, not the one in hand
  assert.deepEqual(plays('Tc 9d', '9h 8s 7c 6d 2h'), these('Tc 9h 8s 7c 6d'));

  // The board's trips with a pocket pair, and a pocket pair that makes a bigger set with the board
  assert.deepEqual(plays('Qc Qd', '7h 7s 7c Kd 2h'), these('7h 7s 7c Qc Qd'));
  assert.equal(read('Qc Qd', '7h 7s 7c Kd 2h').name, 'Full house, sevens over queens');
  assert.deepEqual(plays('Kc Ks', '7h 7s 7c Kd 2h'), these('Kc Ks Kd 7h 7s'));
  assert.equal(read('Kc Ks', '7h 7s 7c Kd 2h').name, 'Full house, kings over sevens');

  // The board playing: its own five, none from hand
  assert.deepEqual(plays('2c 3d', 'As Ks Qs Js Ts'), these('As Ks Qs Js Ts'));
});

test('over random deals the hint makes the hand showdown would, from five of the player\'s seven cards', () => {
  const rng = seededRng(1113);
  const deck = freshDeck();

  for (let i = 0; i < 5000; i++) {
    const pool = [...deck];
    const draw = (count: number) => Array.from({ length: count }, () => pool.splice(rng.int(pool.length), 1)[0]!);
    const hole = draw(2);
    const board = draw(3 + rng.int(3));
    const seven = new Set([...hole, ...board]);

    const hint = readHand(hole, board);
    const showdown = playerHand(hole, board);

    assert.equal(hint.plays.length, 5);
    assert.ok(hint.plays.every((card) => seven.has(card)), `${hint.plays.join(' ')} is not from ${[...seven].join(' ')}`);
    assert.equal(evaluateHand(hint.plays).score, evaluateHand([...hole, ...board]).score, `${hole.join(' ')} on ${board.join(' ')}`);
    assert.equal(hint.name === PLAYING_THE_BOARD ? hint.name : madeHandName(showdown), hint.name);
    assert.equal(hint.name === PLAYING_THE_BOARD, board.length === 5 && evaluateHand(board).score === showdown.score, 'the board plays exactly when it alone is as good');
  }
});
