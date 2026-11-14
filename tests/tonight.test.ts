import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, evaluateHand, handFacts, HIGH_CARD, isSevenDeuce, isStraddle, ledgerOf, newTonight, nightIsOver, SEAT_COUNT, STRADDLES, STRADDLES_IN_A_ROW, STRAIGHT_FLUSH, straddlesAllowed, tonightView } from '../src/engine/index.ts';
import type { Card, Effect, HandRecord, PlayerTonight, Straddle, TableState, Tonight, TonightView } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { ACES, BOARD, cards, checkAround, handRecords, KINGS, QUEENS, seededRng, TestTable } from './helpers.ts';
import { assertInvariants } from './invariants.ts';
import { fixedSettings, randomConfig } from './randomConfig.ts';
import { chance, randomStep } from './randomPlay.ts';

// On the first board aces beat kings beat queens; on the second a king makes the kings three of a kind
const SECOND = 'Kd 4c 5h 8s Td';

const NOTHING: PlayerTonight = { hands: 0, won: 0, biggest: 0, best: null, rebuys: 0, busts: 0, streak: 0, badges: {} };

/** A player's numbers as the table keeps them, by where they stand in the test table's list. */
const numbers = (t: TestTable, player: number): PlayerTonight => t.state.tonight.players[t.ids[player]!] ?? NOTHING;

const tonight = (t: TestTable, viewer = 0): TonightView => t.view(viewer).tonight;

const names = (t: TestTable, ids: string[]): string[] => ids.map((id) => t.state.members.find((member) => member.id === id)!.name);

function finish(t: TestTable): void {
  t.runToResult();
  t.finishHand();
}

function transfer(t: TestTable, from: number, to: number, amount: number): void {
  t.cmd(0, { type: 'transferChips', from: t.ids[from]!, to: t.ids[to]!, amount });
}

/** A hand with the button on seat 0 that seat 0 wins at a showdown with aces, seat 2 turning up kings and everyone else folding before the flop. */
function acesBeatKings(t: TestTable): void {
  t.deal({ button: 0, holes: { 0: ACES, 1: QUEENS, 2: KINGS }, board: BOARD });

  for (const player of t.state.hand!.players.filter((p) => p.seat > 2)) {
    t.fold(player.seat);
  }

  t.call(0);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);
  finish(t);
}

test('a hand played is one a player was dealt, folded at once or not; a pot won is one they took chips from; the best hand is the best they showed, won or lost', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  assert.deepEqual(t.state.tonight, { hands: 0, players: {} });

  acesBeatKings(t);

  assert.equal(t.state.tonight.hands, 1);
  assert.deepEqual(numbers(t, 0), { ...NOTHING, hands: 1, won: 1, biggest: 50, best: cards('As Ah Jc 9h 7d'), streak: 1 });
  assert.deepEqual(numbers(t, 1), { ...NOTHING, hands: 1 }, 'folded before the flop, and still a hand played');
  assert.deepEqual(numbers(t, 2), { ...NOTHING, hands: 1, best: cards('Ks Kh Jc 9h 7d') }, 'the kings lost, and are still the best hand this player has shown');

  // Sitting a hand out is not playing it, and a walk is a pot won
  t.cmd(2, { type: 'sitOut' });
  t.deal({ button: 1 });
  t.foldOut();

  assert.equal(t.state.tonight.hands, 2);
  assert.deepEqual([numbers(t, 0).hands, numbers(t, 1).hands, numbers(t, 2).hands], [2, 2, 1]);
  assert.deepEqual([numbers(t, 0).won, numbers(t, 1).won], [2, 0]);
  assert.equal(numbers(t, 0).biggest, 50, 'the walk was smaller than the pot before it');
});

test('a pot won is counted once a hand, whatever paid: a share of a split pot, one board of two, or both; the biggest pot is what the player took', () => {
  const split = new TestTable({ stacks: [1000, 1000, 1000], config: { smallBlind: 5, bigBlind: 20 } });
  split.deal({ button: 0, holes: { 0: 'As Kd', 2: 'Ac Kh' }, board: BOARD });
  split.call(0);
  split.fold(1);
  split.check(2);
  checkAround(split, [2, 0], 3);
  finish(split);

  assert.deepEqual([numbers(split, 0).won, numbers(split, 0).biggest], [1, 22], 'a share of the 45, not the 45');
  assert.deepEqual([numbers(split, 2).won, numbers(split, 2).biggest], [1, 23]);

  const twice = new TestTable({ stacks: [500, 500, 500], config: { smallBlind: 5, bigBlind: 20, allowRunItTwice: true } });
  twice.deal({ button: 0, holes: { 0: ACES, 2: KINGS }, board: BOARD, secondBoard: SECOND });
  twice.raise(0, 500);
  twice.fold(1);
  twice.call(2);
  twice.cmd(0, { type: 'ritVote', agree: true });
  twice.cmd(2, { type: 'ritVote', agree: true });
  finish(twice);

  assert.deepEqual([numbers(twice, 0).won, numbers(twice, 0).biggest], [1, 503]);
  assert.deepEqual([numbers(twice, 2).won, numbers(twice, 2).biggest], [1, 502]);
  assert.deepEqual(numbers(twice, 2).best, cards('Kd Ks Kh Td 8s'), 'three kings on the second board beat the pair they made on the first');

  const scooped = new TestTable({ stacks: [1000, 1000, 1000], config: { bombPotBoards: 'two' } });
  scooped.cmd(0, { type: 'setBombPot', on: true });
  scooped.deal({ button: 0, board: BOARD, secondBoard: SECOND, holes: { 0: ACES, 1: QUEENS, 2: '8c 6d' } });
  scooped.check(1);
  scooped.fold(2);
  scooped.raise(0, 100);
  scooped.call(1);
  checkAround(scooped, [1, 0], 2);
  finish(scooped);

  assert.deepEqual([numbers(scooped, 0).won, numbers(scooped, 0).biggest], [1, 500], 'both boards are one pot won, and added up');
});

test('the best hand stays until a better one is shown, and a hand that was mucked or never called is none', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });

  // Seat 1 is beaten at the showdown and mucks queens that would have been their best hand
  t.deal({ button: 0, holes: { 0: ACES, 1: QUEENS, 2: KINGS }, board: BOARD });
  t.call(0);
  t.call(1);
  t.check(2);
  checkAround(t, [1, 2, 0], 2);
  t.check(1);
  t.raise(2, 40);
  t.call(0);
  t.call(1);
  finish(t);

  assert.equal(numbers(t, 1).best, null);
  assert.deepEqual(numbers(t, 0).best, cards('As Ah Jc 9h 7d'));

  // Aces that win without a call, turned up afterwards for show, are no showdown
  t.deal({ button: 0, holes: { 1: 'Ad Ac' } });
  t.fold(0);
  t.raise(1, 100);
  t.fold(2);
  t.cmd(1, { type: 'showCards' });
  finish(t);

  assert.equal(numbers(t, 1).best, null);

  // A worse hand shown later does not replace a better one, and an equal one does not either
  t.deal({ button: 0, holes: { 0: 'Qs Qh', 2: 'Qd Qc' }, board: BOARD });
  t.call(0);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);
  finish(t);

  assert.deepEqual(numbers(t, 0).best, cards('As Ah Jc 9h 7d'));
  assert.deepEqual(numbers(t, 2).best, cards('Ks Kh Jc 9h 7d'));
});

test('a rebuy is chips bought after the first time: a top-up, a reload or sitting down again, and never a transfer or a stack the host set', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  assert.deepEqual(t.state.tonight.players, {}, 'a first buy-in is no rebuy');

  t.cmd(1, { type: 'requestRebuy', amount: 500 });
  assert.equal(numbers(t, 1).rebuys, 0, 'not until the host approves it');
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  assert.equal(numbers(t, 1).rebuys, 1);

  transfer(t, 0, 2, 200);
  t.cmd(0, { type: 'setStack', playerId: t.ids[2]!, stack: 5000 });
  assert.deepEqual([numbers(t, 0).rebuys, numbers(t, 2).rebuys], [0, 0], 'chips moved or set are not bought');

  t.cmd(2, { type: 'standUp' });
  t.cmd(2, { type: 'requestSeat', seat: 5, buyIn: 300 });
  t.cmd(0, { type: 'approve', playerId: t.ids[2]! });
  assert.equal(numbers(t, 2).rebuys, 1, 'sitting down again is buying again');

  // Chips approved during a hand are bought when it ends, and counted then
  t.deal({ button: 0 });
  t.cmd(1, { type: 'requestRebuy', amount: 100 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  assert.equal(numbers(t, 1).rebuys, 1);
  t.foldOut();
  assert.equal(numbers(t, 1).rebuys, 2);

  const late = t.sitDown('Late', 7, 400);
  assert.equal(numbers(t, late).rebuys, 0);
  assert.deepEqual(tonight(t).players.map((row) => [row.name, row.rebuys]).sort(), [['Late', 0], ['P0', 0], ['P1', 2], ['P2', 1]]);
});

for (const unit of ['chips', 'cents'] as const) {
  test(`${unit}: everyone who has had chips is listed with the ledger's own net, those who left too, and nobody who only watched`, () => {
    const t = new TestTable({ stacks: [1000, 1000, 1000, 250], config: { unit, smallBlind: 10, bigBlind: 20 } });
    const watcher = t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id) - 1;

    acesBeatKings(t);
    transfer(t, 0, 1, 137);
    t.cmd(3, { type: 'standUp' });
    t.cmd(1, { type: 'requestRebuy', amount: 5 });
    t.cmd(0, { type: 'approve', playerId: t.ids[1]! });

    const view = t.view(2);
    const rows = view.tonight.players;

    assert.deepEqual(rows.map((row) => [row.name, row.net, row.seated]), [['P1', 127, true], ['P3', 0, false], ['P2', -20, true], ['P0', -107, true]], 'the best night first');
    assert.deepEqual(rows.map((row) => [row.playerId, row.net]).sort(), view.ledger.map((row) => [row.playerId, row.net]).sort(), 'the same players and the same money as the ledger');
    assert.equal(rows.reduce((sum, row) => sum + row.net, 0), 0);
    assert.deepEqual(rows.find((row) => row.name === 'P3'), { playerId: t.ids[3], name: 'P3', seated: false, net: 0, hands: 1, won: 0, biggest: 0, best: null, rebuys: 0, badges: [] });
    assert.deepEqual(rows.find((row) => row.name === 'P0')!.best, { name: 'Pair of aces', cards: cards('As Ah Jc 9h 7d') });

    assert.deepEqual(t.view(watcher).tonight, view.tonight, 'someone watching is shown the same night');
    assert.deepEqual([view.tonight.hands, view.tonight.missed], [1, 0]);

    // Chips in a pot still being played for are their owner's until it is paid, as in the ledger
    t.deal({ button: 0 });
    t.raise(0, 300);
    assert.deepEqual(tonight(t).players.map((row) => [row.name, row.net]), [['P1', 127], ['P3', 0], ['P2', -20], ['P0', -107]]);
    assertInvariants(t.state, t.now);
  });
}

test('who leads in what: up the most, the most pots, the biggest pot and the best hand, shared when level and nobody when there is none', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });

  assert.deepEqual([tonight(t).upMost, tonight(t).mostPots, tonight(t).biggestPot, tonight(t).bestHand], [[], [], [], []]);

  acesBeatKings(t);

  const after = tonight(t);
  assert.deepEqual([after.upMost, after.mostPots, after.biggestPot, after.bestHand].map((ids) => names(t, ids)), [['P0'], ['P0'], ['P0'], ['P0']]);

  // Seat 2 wins the same pot back from seat 0, with the same aces
  t.deal({ button: 0, holes: { 0: KINGS, 1: QUEENS, 2: 'Ad Ac' }, board: BOARD });
  t.call(0);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);
  finish(t);

  const level = tonight(t);
  assert.deepEqual([level.upMost, level.mostPots, level.biggestPot, level.bestHand].map((ids) => names(t, ids).sort()), [['P0', 'P2'], ['P0', 'P2'], ['P0', 'P2'], ['P0', 'P2']]);
});

/** The night's standings for players given by what they are up or down, how often they rebought and how many pots they won. */
function standings(nights: Record<string, [net: number, rebuys: number, won: number]>, over = true): { view: TonightView; crowned: string[] } {
  const t = new TestTable({ stacks: Object.keys(nights).map(() => 1000), names: Object.keys(nights) });
  const ledger = ledgerOf(t.state).map((row) => ({ ...row, net: nights[row.name]![0] }));

  t.state.members.forEach((member) => {
    const [, rebuys, won] = nights[member.name]!;
    t.state.tonight.players[member.id] = { ...NOTHING, hands: 10, won, rebuys };
  });

  const view = tonightView(t.state, ledger, over);

  return { view, crowned: names(t, view.dipshits) };
}

test('the dipshit of the night is whoever is down the most, and is crowned only once the night is over', () => {
  const night = { Ann: [300, 0, 4], Bob: [-100, 2, 1], Cat: [-200, 0, 3] } satisfies Record<string, [number, number, number]>;

  assert.deepEqual(standings(night, false).crowned, []);

  const { view, crowned } = standings(night);
  assert.deepEqual(crowned, ['Cat']);
  assert.equal(view.crownedBy, 'net');
  assert.deepEqual(view.players.map((row) => row.name), ['Ann', 'Bob', 'Cat'], 'the dipshit is at the bottom');
});

test('level on what they lost, the crown goes to whoever rebought the most, and level on that too, to whoever won the fewest pots', () => {
  const onRebuys = standings({ Ann: [400, 0, 4], Bob: [-200, 3, 1], Cat: [-200, 1, 0] });
  assert.deepEqual([onRebuys.crowned, onRebuys.view.crownedBy], [['Bob'], 'rebuys']);
  assert.deepEqual(onRebuys.view.players.map((row) => row.name), ['Ann', 'Cat', 'Bob']);

  const onPots = standings({ Ann: [400, 0, 4], Bob: [-200, 3, 2], Cat: [-200, 3, 1] });
  assert.deepEqual([onPots.crowned, onPots.view.crownedBy], [['Cat'], 'pots']);
  assert.deepEqual(onPots.view.players.map((row) => row.name), ['Ann', 'Bob', 'Cat']);

  // Rebuys narrow three down to two, whom the pots cannot part
  const narrowed = standings({ Ann: [-200, 1, 0], Bob: [-200, 3, 2], Cat: [-200, 3, 2], Dan: [600, 0, 9] });
  assert.deepEqual([narrowed.crowned, narrowed.view.crownedBy], [['Bob', 'Cat'], 'rebuys']);
});

test('players level on all three share the crown, and nobody wears it when nobody is down', () => {
  const shared = standings({ Ann: [400, 0, 4], Bob: [-200, 1, 1], Cat: [-200, 1, 1] });
  assert.deepEqual([shared.crowned, shared.view.crownedBy], [['Bob', 'Cat'], 'net']);

  assert.deepEqual(standings({ Ann: [0, 2, 0], Bob: [0, 0, 5] }).crowned, [], 'a night nobody lost has no dipshit, whoever rebought');
});

test('ending the night crowns from the numbers as they stand, playing on takes the crown off and keeps the count, and a second ending crowns again', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });

  // The small blind folds to the big blind, and is the only one down
  t.deal({ button: 0 });
  t.foldOut();
  assert.deepEqual(tonight(t).dipshits, [], 'so far, nobody is crowned');

  t.cmd(0, { type: 'endNight' });
  assert.ok(nightIsOver(t.state));
  assert.deepEqual(names(t, tonight(t).dipshits), ['P1']);
  assert.deepEqual(tonight(t, 2), tonight(t), 'for everyone alike');

  t.cmd(0, { type: 'playOn' });
  t.cmd(0, { type: 'pause' });
  assert.deepEqual(tonight(t).dipshits, []);
  assert.equal(t.state.tonight.hands, 1, 'the same night goes on');

  // The same again, and then the big blind who won both gives it all away and more
  t.deal({ button: 0 });
  t.foldOut();
  transfer(t, 2, 0, 500);

  t.cmd(0, { type: 'endNight' });
  assert.deepEqual(names(t, tonight(t).dipshits), ['P2']);
  assert.deepEqual([t.state.tonight.hands, numbers(t, 1).hands, numbers(t, 2).won], [2, 2, 2], 'every hand of both stretches is counted once');
});

/** A table as the code before the night's numbers saved it: without them. */
function savedBefore(t: TestTable): TableState {
  const saved = JSON.parse(JSON.stringify(t.state)) as Partial<TableState>;
  delete saved.tonight;

  return restoreState(JSON.stringify(saved));
}

test('a table saved before the numbers were kept starts counting from now, and says how many hands it missed', () => {
  const old = new TestTable({ stacks: [1000, 1000, 1000] });
  acesBeatKings(old);
  acesBeatKings(old);
  old.deal({ button: 0 });

  const t = TestTable.adopt(savedBefore(old));
  assert.deepEqual(t.state.tonight, { hands: 0, players: {} });
  assert.deepEqual([tonight(t).hands, tonight(t).missed], [0, 2], 'two finished hands were never counted; the one on the table still will be');
  assert.deepEqual(tonight(t).players.map((row) => [row.net, row.hands]), [[60, 0], [-20, 0], [-40, 0]], 'the money is the ledger\'s, and is all there');

  t.foldOut();
  assert.deepEqual([tonight(t).hands, tonight(t).missed], [1, 2]);
  assert.deepEqual(t.state.members.map((member) => t.state.tonight.players[member.id]!.hands), [1, 1, 1]);

  // Chips bought now by someone who bought before the count began are a rebuy all the same
  t.cmd(1, { type: 'requestRebuy', amount: 100 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  assert.equal(numbers(t, 1).rebuys, 1);
  assertInvariants(t.state, t.now);
});

/**
 * The night's numbers made again from nothing but what left the table for the record, its finished
 * hands and its ledger, one effect at a time. Counted here from the records as they are saved, by the
 * rules as the README gives them, and by none of the code that keeps the numbers.
 */
class Recount {
  readonly tonight: Tonight = newTonight();
  private readonly bought = new Set<string>();
  private read = 0;

  /** Takes in the effects that are new since the last call, and gives back the hands among them. */
  follow(effects: Effect[]): HandRecord[] {
    const fresh = effects.slice(this.read);
    this.read = effects.length;

    for (const effect of fresh) {
      if (effect.type === 'hand') {
        this.count(effect.record);
      } else if (effect.type === 'ledger' && effect.entry.kind === 'buy-in') {
        if (this.bought.has(effect.entry.playerId)) {
          this.of(effect.entry.playerId).rebuys += 1;
        }

        this.bought.add(effect.entry.playerId);
      }
    }

    return handRecords(fresh);
  }

  private of(playerId: string): PlayerTonight {
    return (this.tonight.players[playerId] ??= { ...NOTHING, badges: {} });
  }

  private count(record: HandRecord): void {
    const { result } = record;
    const took = (seat: number) => result.pots.flatMap((pot) => pot.awards).reduce((sum, award) => sum + (award.seat === seat ? award.amount : 0), 0);
    // Winning a hand is taking chips from its pots or collecting the bounty, which a big blind folded to can do from an empty pot
    const wonIt = (seat: number) => took(seat) > 0 || result.bounty?.seat === seat;
    const somebodyTook = record.players.some((player) => wonIt(player.seat));

    this.tonight.hands += 1;

    if (somebodyTook) {
      for (const [playerId, numbers] of Object.entries(this.tonight.players)) {
        if (!record.players.some((player) => player.playerId === playerId)) {
          numbers.streak = 0;
        }
      }
    }

    for (const player of record.players) {
      const numbers = this.of(player.playerId);
      const { busts, streak } = numbers;

      numbers.hands += 1;
      numbers.won += took(player.seat) > 0 ? 1 : 0;
      numbers.biggest = Math.max(numbers.biggest, took(player.seat));
      numbers.busts += player.endStack === 0 ? 1 : 0;
      numbers.streak = !somebodyTook ? streak : wonIt(player.seat) ? streak + 1 : 0;

      for (const shown of result.hands.filter((hand) => hand.seat === player.seat)) {
        if (numbers.best === null || evaluateHand(shown.cards).score > evaluateHand(numbers.best).score) {
          numbers.best = shown.cards;
        }
      }

      if (somebodyTook) {
        for (const id of badgesEarned(record, player, { busts, streak }, numbers)) {
          numbers.badges[id] = (numbers.badges[id] ?? 0) + 1;
          this.earned.push({ hand: record.number, seat: player.seat, id });
        }
      }
    }
  }

  /** Each badge earned, by the hand and the seat that earned it. */
  readonly earned: { hand: number; seat: number; id: string }[] = [];
}

/**
 * The badges a player earned in a hand somebody won, as the README says each is earned, read from the
 * record by none of the code that earns them. `before` is their busts and streak before the hand.
 */
function badgesEarned(record: HandRecord, player: HandRecord['players'][number], before: Pick<PlayerTonight, 'busts' | 'streak'>, after: PlayerTonight): string[] {
  const { result } = record;
  const { seat } = player;
  const hole = player.cards ?? [];
  const awards = result.pots.flatMap((pot) => pot.awards.filter((award) => award.amount > 0));
  const took = awards.filter((award) => award.seat === seat).reduce((sum, award) => sum + award.amount, 0);
  // Won at the showdown: paid from a pot on that run that somebody else was in for too
  const wonOn = (run: number) => result.pots.some((pot) => pot.eligible.length > 1 && pot.awards.some((award) => award.seat === seat && award.run === run && award.amount > 0));
  const ranks = (shown: Card[]) => shown.map((card) => card[0]);

  const shown = result.hands.filter((hand) => hand.seat === seat).map((hand) => ({ ...hand, value: evaluateHand(hand.cards) }));
  // A straight flush is the player's when any of its cards is; four of a kind when one of the four is
  const ownFlush = shown.filter((hand) => hand.value.category === STRAIGHT_FLUSH && hand.cards.some((card) => hole.includes(card)));
  const royal = (hand: { cards: Card[] }) => ranks(hand.cards).includes('A') && ranks(hand.cards).includes('K');
  const ownQuads = shown.filter((hand) => {
    const four = ranks(hand.cards).find((rank) => ranks(hand.cards).filter((other) => other === rank).length === 4);

    return four !== undefined && hole.some((card) => card[0] === four);
  });

  // Whose last chips the player took alone: the bounty's collector took them when the bounty emptied a stack, else everyone paid from a pot the broke player was in
  const feltedBy = (broke: HandRecord['players'][number]) => {
    const bounty = result.bounty?.payments.some((payment) => payment.seat === broke.seat) ? [result.bounty.seat] : [];
    const takers = bounty.length > 0 ? bounty : result.pots.filter((pot) => pot.eligible.includes(broke.seat)).flatMap((pot) => pot.awards.filter((award) => award.amount > 0).map((award) => award.seat));

    return new Set(takers.filter((taker) => taker !== broke.seat));
  };
  const felted = record.players.some((other) => other !== player && other.endStack === 0 && feltedBy(other).size === 1 && feltedBy(other).has(seat));

  // Runs the main pot paid nothing on, being too small to split, are not asked about
  const beatEveryone = record.boards.every((_board, run) => {
    if (!result.pots[0]?.awards.some((award) => award.run === run && award.amount > 0)) {
      return true;
    }

    const mine = shown.find((hand) => hand.run === run);
    const theirs = result.hands.filter((hand) => hand.seat !== seat && hand.run === run);

    return mine !== undefined && theirs.every((hand) => evaluateHand(hand.cards).score < mine.value.score);
  });
  const outright = result.uncontested ? result.winnings[0]?.seat === seat : beatEveryone;

  const every = (count: number, was: number, step: number) => count > was && count % step === 0;
  const pot = result.pots.reduce((sum, each) => sum + each.amount, 0);

  const earned: Record<string, boolean> = {
    royal: ownFlush.some(royal),
    straightFlush: ownFlush.some((hand) => !royal(hand)),
    quads: ownQuads.length > 0,
    bigPot: record.bigBlind > 0 && took >= 100 * record.bigBlind,
    heater: every(after.streak, before.streak, 3),
    felted,
    scoop: record.boards.length === 2 && !result.uncontested && took === pot,
    sevenDeuce: player.cards !== null && isSevenDeuce(player.cards) && outright,
    airBall: shown.some((hand) => hand.value.category === HIGH_CARD && wonOn(hand.run)),
    cooler: [...ownQuads, ...ownFlush].some((hand) => !wonOn(hand.run)),
    atm: every(after.busts, before.busts, 3),
  };

  return Object.keys(earned).filter((id) => earned[id]);
}

/**
 * The facts of a hand agree with its events, which tell the same hand another way: the facts are read
 * from the result and the stacks, the events are what was called out as it happened.
 */
function assertFactsAgreeWithEvents(record: HandRecord): void {
  const facts = handFacts(record);
  const where = `hand ${record.number}`;
  const total = (amounts: number[]) => amounts.reduce((sum, amount) => sum + amount, 0);

  assert.equal(total(facts.players.map((p) => p.putIn)), facts.pot, `${where}: what went in is not the pot`);
  assert.equal(total(facts.players.map((p) => p.tookOut)), facts.pot, `${where}: what came out is not the pot`);
  assert.equal(total(facts.players.map((p) => p.bounty)), 0, `${where}: a bounty was paid and collected in different amounts`);
  assert.ok(facts.players.every((p) => p.putIn >= 0 && p.net === p.tookOut - p.putIn + p.bounty), `${where}: a player's chips do not add up`);
  assert.ok(facts.players.every((p) => p.busted === p.bustedBy.length > 0 && !p.bustedBy.includes(p.seat)), `${where}: a bust with nobody to thank, or thanks with no bust`);
  assert.ok(facts.players.every((p) => p.shown.length === 0 || (!p.folded && p.cards !== null && facts.ended === 'showdown')), `${where}: a hand shown down by someone who was not there to show it`);

  for (const player of facts.players) {
    const gained = (seat: number) => facts.players.find((p) => p.seat === seat)!;

    assert.ok(player.bustedBy.every((seat) => gained(seat).tookOut > 0 || gained(seat).bounty > 0), `${where}: a bust credited to someone who took nothing`);
    assert.ok(player.shown.every((hand) => hand.cards.every((card) => player.cards!.includes(card) || record.boards[hand.board]!.includes(card))), `${where}: a hand shown that its cards and its board do not make`);
    assert.ok(player.wins.every((win) => win.between >= 1 && win.amount > 0) && player.wins.reduce((sum, win) => sum + win.amount, 0) === player.tookOut, `${where}: the pots a player was paid from do not come to what they took`);
  }

  if (record.events.length === 0) {
    return;
  }

  const told = new Map(record.players.map((p) => [p.seat, { putIn: 0, onStreet: 0, tookOut: 0, bounty: 0, folded: false, cards: null as string[] | null }]));
  const of = (seat: number) => told.get(seat)!;
  const newStreet = () => told.forEach((player) => (player.onStreet = 0));

  for (const event of record.events) {
    switch (event[0]) {
      case 'post':
        of(event[1]).putIn += event[3];
        of(event[1]).onStreet += event[5] ? 0 : event[3];
        break;
      case 'call':
        of(event[1]).putIn += event[2];
        of(event[1]).onStreet += event[2];
        break;
      case 'bet':
      case 'raise':
        of(event[1]).putIn += event[2] - of(event[1]).onStreet;
        of(event[1]).onStreet = event[2];
        break;
      case 'return':
        of(event[1]).putIn -= event[2];
        break;
      case 'chop':
        event[1].forEach(([seat, amount]) => (of(seat).putIn -= amount));
        break;
      case 'street':
      case 'runs':
        newStreet();
        break;
      case 'fold':
        of(event[1]).folded = true;
        break;
      case 'show':
        of(event[1]).cards = event[2];
        break;
      case 'win':
        of(event[1]).tookOut += event[2];
        break;
      case 'bounty':
        for (const [seat, amount] of event[2]) {
          of(seat).bounty -= amount;
          of(event[1]).bounty += amount;
        }
        break;
    }
  }

  assert.deepEqual(
    facts.players.map((p) => ({ putIn: p.putIn, tookOut: p.tookOut, bounty: p.bounty, folded: p.folded, cards: p.cards })),
    record.players.map((p) => {
      const { putIn, tookOut, bounty, folded, cards: shown } = of(p.seat);

      return { putIn, tookOut, bounty, folded, cards: shown };
    }),
    `${where}: the facts and the events tell different hands`,
  );
}

const TABLES = Number(process.env.SIM_TABLES ?? 40);
const STEPS_PER_TABLE = 600;

test('over random games the numbers are at every step exactly what the hand records and the ledger make them, and no fact holds a card nobody was shown', () => {
  const reached = { hands: 0, showdowns: 0, runTwice: 0, bombPots: 0, doubleBoards: 0, antes: 0, transfers: 0, rebuys: 0, left: 0, nightsEnded: 0, playedOn: 0, crowned: 0, busts: 0, splits: 0, bestHands: 0, chops: 0 };
  // Hands with each kind of straddle posted
  const straddled: Record<Straddle, number> = { straddle: 0, 'double straddle': 0, 'button straddle': 0, 'Mississippi straddle': 0 };
  const badges: Record<string, number> = {};

  for (let seed = 1; seed <= TABLES; seed++) {
    const rng = seededRng(seed * 104_729);
    const players = 2 + rng.int(SEAT_COUNT - 1);
    const stacks = Array.from({ length: players }, () => (chance(rng, 15) ? 1 + rng.int(30) : 100 + rng.int(1900)));
    // A chop needs three players or more and nothing but the blinds in, which random settings and play give
    // too seldom to count on: a quarter of the tables let the blinds chop, deal without an ante or a straddle,
    // and have players mostly fold before anyone has come in
    const chopping = seed % 4 === 0;
    const config = { ...randomConfig(rng), ...(chopping ? { allowChop: true, ante: 0 } : {}) };

    const t = new TestTable({ stacks, seed, config: fixedSettings(config) });
    t.cmd(0, { type: 'updateConfig', config });
    t.cmd(0, { type: 'start' });

    const recount = new Recount();

    for (let step = 0; step < STEPS_PER_TABLE; step++) {
      // What is face down on a hand that is over, which the step may take off the table
      const done = t.state.hand?.stage === 'done' ? t.state.hand : null;
      const faceDown = done ? [...done.deck, ...done.players.filter((p) => !p.shown).flatMap((p) => p.cards)] : [];
      const over = nightIsOver(t.state);

      const hand = t.state.hand;
      const nobodyIn = hand?.stage === 'betting' && hand.street === 'preflop' && hand.lastAggressor === null && hand.toAct !== hand.sbSeat && hand.toAct !== hand.bbSeat;

      if (chopping && nobodyIn && chance(rng, 75)) {
        t.cmd(t.ids.indexOf(t.state.seats[hand.toAct!]!.playerId), { type: 'fold' });
      } else {
        randomStep(t, rng);
      }

      // Random play hardly ever leaves a straddle on until it is its player's to post, so now and then everyone asks for
      // every kind the table allows, or only for those from under the gun: a straddle from elsewhere leaves no room for a double
      if (!chopping && chance(rng, 15)) {
        const wanted = chance(rng, 50) ? STRADDLES.slice(0, STRADDLES_IN_A_ROW) : STRADDLES;

        for (const kind of straddlesAllowed(t.state.config)) {
          t.state.seats.forEach((seat) => seat && t.cmd(t.ids.indexOf(seat.playerId), { type: 'setStraddle', kind: kind.what, on: wanted.includes(kind) }));
        }
      }

      // And now and then each player switches Always chop on or off, so that some hands chop with nobody asked
      if (t.state.config.allowChop && chance(rng, 10)) {
        t.state.seats.forEach((seat) => seat && t.cmd(t.ids.indexOf(seat.playerId), { type: 'setAlwaysChop', on: chance(rng, 50) }));
      }

      for (const record of recount.follow(t.effects)) {
        const facts = handFacts(record);
        const told = JSON.stringify(facts);

        assertFactsAgreeWithEvents(record);
        assert.equal(done?.number, record.number, 'a hand left the table that was not over');
        assert.ok(faceDown.every((card) => !told.includes(`"${card}"`)), `hand ${record.number}: the facts hold a card nobody was shown`);

        reached.hands += 1;
        reached.showdowns += facts.ended === 'showdown' ? 1 : 0;
        reached.chops += facts.ended === 'chop' ? 1 : 0;
        reached.runTwice += facts.runTwice ? 1 : 0;
        reached.bombPots += facts.bombPot ? 1 : 0;
        reached.doubleBoards += facts.bombPot?.boards === 2 ? 1 : 0;
        reached.antes += record.events[0]?.[0] === 'start' && record.events[0][6] ? 1 : 0;
        new Set(record.events.flatMap((event) => (event[0] === 'post' && isStraddle(event[2]) ? [event[2]] : []))).forEach((what) => (straddled[what] += 1));
        reached.busts += facts.players.some((p) => p.busted) ? 1 : 0;

        const bounty = record.result.bounty;
        assert.ok(!bounty || recount.earned.some((earned) => earned.hand === record.number && earned.seat === bounty.seat && earned.id === 'sevenDeuce'), `hand ${record.number}: a bounty was paid for seven-deuce and the badge was not earned`);
        reached.splits += facts.players.some((p) => p.wins.some((win) => win.between > 1)) ? 1 : 0;
      }

      assert.deepEqual(t.state.tonight, recount.tonight, `table ${seed}, step ${step}: the numbers saved with the table are not what its records come to`);

      if (over !== nightIsOver(t.state)) {
        reached[over ? 'playedOn' : 'nightsEnded'] += 1;
      }

      if (chance(rng, 10)) {
        const view = t.view(0);
        const { tonight: night } = view;
        const worst = Math.min(0, ...night.players.map((row) => row.net));

        assert.equal(night.missed, 0, 'a table that has counted from its first hand missed none');
        assert.deepEqual(night.players.map((row) => [row.playerId, row.net]).sort(), view.ledger.map((row) => [row.playerId, row.net]).sort(), 'the night and the ledger disagree about the money');
        assert.equal(night.players.reduce((sum, row) => sum + row.net, 0), 0, 'the night is not zero-sum');
        assert.equal(night.dipshits.length > 0, nightIsOver(t.state) && worst < 0, 'a crown before the night was over, or none after it with someone down');
        assert.ok(night.dipshits.every((id) => night.players.find((row) => row.playerId === id)!.net === worst), 'the crown is on someone who is not down the most');
        assert.deepEqual(JSON.parse(JSON.stringify(night)), night, 'the night holds something JSON does not keep');

        reached.crowned += night.dipshits.length > 0 ? 1 : 0;
      }
    }

    for (const { id } of recount.earned) {
      badges[id] = (badges[id] ?? 0) + 1;
    }

    const last = t.view(0).tonight;
    reached.transfers += t.state.members.some((member) => member.transferred !== 0) ? 1 : 0;
    reached.rebuys += last.players.reduce((sum, row) => sum + row.rebuys, 0);
    reached.left += last.players.filter((row) => !row.seated && row.hands > 0).length;
    reached.bestHands += last.players.filter((row) => row.best !== null).length;
  }

  // The run only proves something if it reached the parts of the game the numbers have to survive
  const said = JSON.stringify({ ...reached, straddled, badges });
  assert.ok(reached.hands >= TABLES * 30 && reached.showdowns >= TABLES * 10, said);
  assert.ok(reached.runTwice >= TABLES / 2 && reached.bombPots >= TABLES && reached.doubleBoards >= TABLES / 2, said);
  assert.ok(reached.antes >= TABLES * 5, said);
  assert.ok(reached.chops >= TABLES / 2, said);
  // A double needs four players, two of them wanting one in a row from under the gun, so it comes up least
  assert.ok(STRADDLES.every((kind) => straddled[kind.what] >= TABLES / 20), said);
  assert.ok(reached.transfers >= TABLES / 2 && reached.rebuys >= TABLES && reached.left >= TABLES, said);
  assert.ok(reached.nightsEnded >= TABLES / 2 && reached.playedOn >= TABLES / 2 && reached.crowned >= TABLES / 2, said);
  assert.ok(reached.busts >= TABLES && reached.splits >= TABLES / 4 && reached.bestHands >= TABLES * 2, said);
  // The rarest hands, a straight flush and better, are left to the tests of each badge
  assert.ok(['felted', 'heater', 'bigPot', 'scoop', 'airBall'].every((id) => badges[id]! >= TABLES), said);
  assert.ok(['sevenDeuce', 'atm'].every((id) => badges[id]! >= TABLES / 4), said);
});
