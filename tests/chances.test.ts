import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BOARD_SIZE, chanceFigures, chanceSteps, chancesOf, evaluateHand, freshDeck, MOST_COUNTED, SAMPLED_BOARDS, shuffle } from '../src/engine/index.ts';
import type { Card, Chances, Spot } from '../src/engine/index.ts';
import { cards, seededRng } from './helpers.ts';

const spot = (hands: string[], board = '', dead = ''): Spot => ({ hands: hands.map(cards), board: cards(board), dead: cards(dead) });

function assertShares(found: Chances, wanted: number[], what: string): void {
  assert.equal(found.shares.length, wanted.length, what);
  found.shares.forEach((share, hand) => assert.ok(Math.abs(share - wanted[hand]!) < 1e-12, `${what}: hand ${hand} has ${share}, not ${wanted[hand]}`));
}

const texts = (chances: Chances) => chanceFigures(chances).map((figure) => figure.text);
const favorites = (chances: Chances) => chanceFigures(chances).flatMap((figure, hand) => (figure.favorite ? [hand] : []));

/** The cards a spot leaves in the deck. */
const unseenIn = ({ hands, board, dead }: Spot) => freshDeck().filter((card) => ![...hands.flat(), ...board, ...dead].includes(card));

/**
 * A spot's chances counted the plain way, with nothing of the engine's but how five cards are ranked:
 * every way to finish the board, the best hands of each, a tie shared out. Also says which hands some
 * finish has among the best.
 */
function countedByHand(counted: Spot): { shares: number[]; canWin: boolean[] } {
  const deck = unseenIn(counted);
  const won = counted.hands.map(() => 0);
  const canWin = counted.hands.map(() => false);
  let finishes = 0;

  const finish = (board: Card[], from: number): void => {
    if (board.length < BOARD_SIZE) {
      for (let next = from; next < deck.length; next++) {
        finish([...board, deck[next]!], next + 1);
      }
      return;
    }

    const scores = counted.hands.map((hand) => evaluateHand([...hand, ...board]).score);
    const best = Math.max(...scores);
    const winners = scores.filter((score) => score === best).length;

    finishes += 1;
    scores.forEach((score, hand) => {
      if (score === best) {
        won[hand]! += 1 / winners;
        canWin[hand] = true;
      }
    });
  };

  finish([...counted.board], 0);

  return { shares: won.map((share) => share / finishes), canWin };
}

/** The most a sampled share may be off one that was counted: three standard errors of a share that size. */
const threeErrors = (share: number) => 3 * Math.sqrt((share * (1 - share)) / SAMPLED_BOARDS);

test('on the turn a hand’s chance is its outs over the cards nobody has seen', () => {
  // Two hands and four board cards leave 44 cards, one of which comes
  const turns: [what: string, hands: string[], board: string, outs: number][] = [
    ['a flush draw: nine hearts', ['As Ad', '7h 6h'], 'Kh 2h 9c Js', 9],
    ['a gutshot: four tens', ['Ks Kd', '9c 8c'], 'Qd Jh 2s 5c', 4],
    ['a set against a made flush: the last nine and three each of the fours, the deuces and the jacks', ['Ah Kh', '9c 9d'], '9h 4h 2h Jc', 10],
    ['drawing dead against four of a kind', ['9c 9d', 'Ac Kc'], '9h 9s 2c 5d', 0],
  ];

  for (const [what, hands, board, outs] of turns) {
    const chances = chancesOf(spot(hands, board));

    assert.equal(chances.exact, true, what);
    assertShares(chances, [1 - outs / 44, outs / 44], what);
  }

  assert.deepEqual(texts(chancesOf(spot(['9c 9d', 'Ac Kc'], '9h 9s 2c 5d'))), ['100', '0'], 'a hand that cannot win reads 0, and one that cannot lose 100');
});

test('hands that cannot be told apart whatever comes share the board', () => {
  // A rainbow board, so neither ace-king can make a flush the other cannot
  const tie = chancesOf(spot(['As Kd', 'Ah Kc'], '2c 7d 9s Jh'));

  assertShares(tie, [0.5, 0.5], 'a certain tie');
  assert.deepEqual(texts(tie), ['50', '50']);
  assert.deepEqual(favorites(tie), [], 'neither is the favorite');
});

test('three hands: a split between two of them counts half a win each', () => {
  // The queens are ahead. An ace or a king, four of the 42 cards left, gives both ace-kings the same pair
  const drawing = chancesOf(spot(['As Kd', 'Ah Kc', 'Qs Qd'], '2c 7d 9s Jh'));

  assertShares(drawing, [2 / 42, 2 / 42, 38 / 42], 'two hands drawing to the same outs');
  assert.deepEqual(texts(drawing), ['5', '5', '90']);
  assert.deepEqual(favorites(drawing), [2]);

  // Both aces have aces full whatever comes, and king-queen cannot catch up
  const made = chancesOf(spot(['As 2d', 'Ah 3c', 'Kd Qc'], 'Ac Ad 7s 7h'));

  assertShares(made, [0.5, 0.5, 0], 'two hands that tie and a third drawing dead');
  assert.deepEqual(texts(made), ['50', '50', '0']);
});

test('a board with all its cards has one way to finish: the best hand has it whole', () => {
  assertShares(chancesOf(spot(['As Ad', 'Kh Qh'], '2h 7h 9c Jd 3s')), [1, 0], 'won');
  assertShares(chancesOf(spot(['As Kd', 'Ah Kc', '2s 2d'], '5c 6d 7s 8h 9h')), [1 / 3, 1 / 3, 1 / 3], 'the board plays for everyone');
});

test('on the flop, counting agrees with every pair of cards tried by hand', () => {
  const flops = [
    spot(['9c 9d', 'Ah Kh'], '9h 4h 2c'),
    spot(['As Ks', 'Qd Qc'], 'Qs Js 4d'),
    spot(['Ac Ad', '7h 8h', 'Kd Kh'], '6h 5c 2h'),
    spot(['Tc Td', 'Th Ts'], '2c 7d 9s'),
    // A second board's flop is face up beside this one: its cards cannot come here
    spot(['As Kd', 'Qh Qc', '7s 6s'], '5s 8d 2s', 'Ah 9s Qd'),
    spot(['2c 7d', '3h 8s', '4c 9d', '5h Ts', '6c Jd', 'Ah Ad', 'Kc Kd', 'Qs Qh', 'Jc Th'], '2s 3d 4h', '5c 6d 7h'),
  ];

  for (const flop of flops) {
    const chances = chancesOf(flop);

    assert.equal(chances.exact, true);
    assertShares(chances, countedByHand(flop).shares, JSON.stringify(flop));
  }
});

test('which way a spot is worked out goes by how many ways its board can finish, not by the street', () => {
  const deck = freshDeck();
  const nine = Array.from({ length: 9 }, (_, hand) => [deck[hand * 2]!, deck[hand * 2 + 1]!]);

  // Two cards to come with nine hands in: 465 ways, fewer than heads-up on the flop
  assert.equal(chancesOf({ hands: nine, board: deck.slice(18, 21), dead: [] }).exact, true);

  // Five cards to come heads-up: 1,712,304 ways
  assert.equal(chancesOf(spot(['As Ah', 'Kd Kc'])).exact, false);

  // A first board run out and face up takes five cards from the deck of the second, and that is still too many to count
  assert.equal(chancesOf(spot(['As Ah', 'Kd Kc'], '', '2c 7d 9s Jh 3s')).exact, false);

  assert.ok(MOST_COUNTED >= 990 && MOST_COUNTED < 80_730, 'every spot from the flop on is counted, and none before it');
});

test('a sample comes within three standard errors of the count, for several seeds', () => {
  const flops = [spot(['9c 9d', 'Ah Kh'], '9h 4h 2c'), spot(['Ac Ad', '7h 8h', 'Kd Kh'], '6h 5c 2h'), spot(['As Kd', 'Qh Qc', '7s 6s'], '5s 8d 2s', 'Ah 9s Qd')];

  for (const flop of flops) {
    const counted = chancesOf(flop);

    // The spot's own seed, which is the one a page uses, and others
    for (const seed of [undefined, 1, 2, 3, 4, 5]) {
      const sampled = chancesOf(flop, { mostCounted: 0, seed });

      assert.equal(sampled.exact, false);
      sampled.shares.forEach((share, hand) => {
        const off = Math.abs(share - counted.shares[hand]!);

        assert.ok(off <= threeErrors(counted.shares[hand]!), `seed ${seed}, hand ${hand} of ${JSON.stringify(flop.hands)}: ${share} is ${off} from ${counted.shares[hand]}`);
      });
    }
  }
});

test('before the flop, an estimate is within three standard errors of the figures every board gives', () => {
  // Counted over all 1,712,304 boards, a tie as half: what the books give as 81 to 19, 43 to 57 and 46 to 54
  const matchups: [what: string, hands: string[], first: number][] = [
    ['a pair over a pair', ['As Ah', 'Kd Kc'], 0.812555],
    ['two overcards against a pair', ['As Kd', 'Qh Qc'], 0.428352],
    ['two overcards of one suit against a pair', ['As Ks', 'Qh Qc'], 0.462145],
  ];

  for (const [what, hands, first] of matchups) {
    // At most 2.4 points for the first matchup and 3 for the others
    const tolerance = threeErrors(first);

    // The spot's own seed, which is what a page shows, and others
    for (const seed of [undefined, 11, 12, 13]) {
      const estimate = chancesOf(spot(hands), { seed });

      assert.equal(estimate.exact, false);
      assert.ok(Math.abs(estimate.shares[0]! - first) <= tolerance, `${what}, seed ${seed}: ${estimate.shares[0]} is not within ${tolerance} of ${first}`);
      assert.ok(Math.abs(estimate.shares[0]! + estimate.shares[1]! - 1) < 1e-9);
    }
  }

  assert.deepEqual(texts(chancesOf(spot(['As Ah', 'Kd Kc']))), ['~81', '~19']);
});

test('the shares of a spot add up to one, and say 0 exactly for a hand no finish wins or ties for', () => {
  const rng = seededRng(20_261_114);

  for (let round = 0; round < 60; round++) {
    const deck = shuffle(freshDeck(), rng);
    const hands = Array.from({ length: 2 + rng.int(5) }, () => [deck.pop()!, deck.pop()!]);
    // From the flop on, where the plain count is quick enough to hold every spot against
    const board = deck.splice(0, 3 + rng.int(3));
    const random: Spot = { hands, board, dead: deck.splice(0, rng.int(6)) };

    const chances = chancesOf(random);
    const plain = countedByHand(random);
    const what = JSON.stringify(random);

    assert.ok(Math.abs(chances.shares.reduce((sum, share) => sum + share, 0) - 1) < 1e-9, what);
    assertShares(chances, plain.shares, what);
    chances.shares.forEach((share, hand) => assert.equal(share === 0, !plain.canWin[hand], `${what}: hand ${hand}`));

    // And the figures: 0 and 100 only where they are true, and whole numbers that add up to 100
    const figures = texts(chances);
    figures.forEach((figure, hand) => {
      assert.equal(figure === '0', chances.shares[hand] === 0, `${what}: hand ${hand} reads ${figure}`);
      assert.equal(figure === '100', chances.shares[hand] === 1, `${what}: hand ${hand} reads ${figure}`);
    });

    const whole = figures.map((figure) => (figure === '<1' ? 0 : figure === '>99' ? 100 : Number(figure)));
    assert.ok(whole.every(Number.isInteger), `${what}: ${figures}`);
    assert.equal(whole.reduce((sum, points) => sum + points, 0), 100, `${what}: ${figures}`);
  }
});

test('the hands in another order get the same chances in that order, and the same spot the same answer every time', () => {
  const rng = seededRng(7);

  // Before the flop too, where the answer is an estimate: it must not depend on who is listed first
  for (const boardCards of [0, 0, 3, 3, 4, 5]) {
    const deck = shuffle(freshDeck(), rng);
    const hands = Array.from({ length: 2 + rng.int(3) }, () => [deck.pop()!, deck.pop()!]);
    const board = deck.splice(0, boardCards);
    const dead = deck.splice(0, rng.int(4));
    const first = chancesOf({ hands, board, dead });

    assert.deepEqual(chancesOf({ hands, board, dead }), first);

    const order = shuffle(hands.map((_hand, nth) => nth), rng);
    const reordered = chancesOf({ hands: order.map((nth) => hands[nth]!), board: [...board].reverse(), dead: [...dead].reverse() });

    assert.deepEqual(reordered.shares, order.map((nth) => first.shares[nth]), `${JSON.stringify(hands)} in the order ${order}`);
    assert.equal(reordered.exact, first.exact);
  }
});

test('a spot that names a card twice, or something that is no card face up, is refused', () => {
  const refused: [what: string, spot: Spot][] = [
    ['a card in a hand and on the board', spot(['As Ah', 'Kd Kc'], 'As 7d 2c')],
    ['a card in two hands', spot(['As Ah', 'As Kc'])],
    ['a card on the board and among the dead', spot(['As Ah', 'Kd Kc'], '9s 7d 2c', '9s')],
    ['a face-down card', { hands: [cards('As Ah'), [null as unknown as Card, 'Kc']], board: [], dead: [] }],
    ['a board with six cards', spot(['As Ah', 'Kd Kc'], '2c 3c 4c 5c 6c 7c')],
  ];

  for (const [what, bad] of refused) {
    assert.throws(() => chancesOf(bad), Error, what);
    assert.throws(() => chanceSteps(bad), Error, `${what}, before any of the work is done`);
  }
});

test('the work comes a board at a time, and done in pieces gives the answer done at once gives', () => {
  const turn = spot(['As Ad', '7h 6h'], 'Kh 2h 9c Js');
  const steps = chanceSteps(turn);
  let taken = 0;
  let step = steps.next();

  while (!step.done) {
    taken += 1;
    step = steps.next();
  }

  assert.equal(taken, 44, 'one step for each card that can come');
  assert.deepEqual(step.value, chancesOf(turn));

  const sampled = chanceSteps(spot(['As Ah', 'Kd Kc']));
  let boards = 0;
  while (!sampled.next().done) {
    boards += 1;
  }

  assert.equal(boards, SAMPLED_BOARDS);
});

test('an estimate never reads 0 or 100, and is marked as one', () => {
  assert.deepEqual(texts({ shares: [0, 1], exact: false }), ['<1', '>99']);
  assert.deepEqual(texts({ shares: [0.4688, 0.5312], exact: false }), ['~47', '~53']);
  assert.deepEqual(favorites({ shares: [0.4688, 0.5312], exact: false }), [1]);
});

test('a figure never lies at the ends: a hand that can still win does not read 0, nor one that can still lose 100', () => {
  assert.deepEqual(texts({ shares: [0.004, 0.996], exact: true }), ['<1', '>99']);
  assert.deepEqual(favorites({ shares: [0.004, 0.996], exact: true }), [1]);
  assert.deepEqual(texts({ shares: [0, 1], exact: true }), ['0', '100']);
  assert.deepEqual(texts({ shares: [0.003, 0.003, 0.994], exact: true }), ['<1', '<1', '>99']);
  assert.deepEqual(texts({ shares: [0.006, 0.497, 0.497], exact: true }), ['<1', '50', '50']);
});

test('whole figures add up to 100: each share is rounded down, and the points left go to the hands that lost most by it', () => {
  assert.deepEqual(texts({ shares: [1 / 3, 1 / 3, 1 / 3], exact: true }), ['34', '33', '33'], 'the earlier hand first where two lost the same');
  assert.deepEqual(favorites({ shares: [1 / 3, 1 / 3, 1 / 3], exact: true }), [], 'a point that only rounding gave makes no favorite');
  assert.deepEqual(texts({ shares: [0.125, 0.125, 0.75], exact: true }), ['13', '12', '75']);
  assert.deepEqual(texts({ shares: [0.502, 0.498], exact: true }), ['50', '50']);
  assert.deepEqual(favorites({ shares: [0.502, 0.498], exact: true }), [], 'ahead by less than the figures show is no favorite');
  assert.deepEqual(texts({ shares: [0.57, 0.43], exact: true }), ['57', '43'], 'a share that is a whole figure but for how it is stored');
  assert.deepEqual(chanceFigures({ shares: [], exact: true }), []);
});
