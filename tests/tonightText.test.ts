import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crownOf, leadersOf, missedOf, standingOf, tonightText } from '../src/client/tonightText.ts';
import type { TableConfig, TableView, TonightRow } from '../src/engine/index.ts';
import { ACES, BOARD, checkAround, KINGS, QUEENS, TestTable } from './helpers.ts';

/** Three players one hand into a night: P0 won 50 with aces, P2 showed kings and lost 20, P1 folded the small blind. */
function oneHandIn(config: Partial<TableConfig> = {}): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { smallBlind: 10, bigBlind: 20, ...config } });

  t.deal({ button: 0, holes: { 0: ACES, 1: QUEENS, 2: KINGS }, board: BOARD });
  t.call(0);
  t.fold(1);
  t.check(2);
  checkAround(t, [2, 0], 3);
  t.runToResult();
  t.finishHand();

  return t;
}

/** A night that is over, for players given by what they are up or down. Whoever is named in `crowned` wears the crown. */
function nightOf(nets: Record<string, number>, crowned: string[], crownedBy: TableView['tonight']['crownedBy'] = 'net'): TableView {
  const t = new TestTable({ stacks: Object.keys(nets).map(() => 1000), names: Object.keys(nets) });
  t.cmd(0, { type: 'endNight' });

  const view = t.view(0);
  const players = view.tonight.players.map((row): TonightRow => ({ ...row, net: nets[row.name]! }));

  return { ...view, tonight: { ...view.tonight, players, dipshits: players.filter((row) => crowned.includes(row.name)).map((row) => row.playerId), crownedBy } };
}

test('the night as text names the table, how far the night is, who leads in what, and every player with the ledger\'s money', () => {
  const t = oneHandIn();
  t.cmd(1, { type: 'requestRebuy', amount: 500 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  t.cmd(2, { type: 'standUp' });

  assert.equal(
    tonightText(t.view(0)),
    [
      "Chips n' Dipshits: the night so far, 1 hand",
      'Up the most: P0, +30',
      'Most pots won: P0, 1',
      'Biggest pot: P0, 50',
      'Best hand: P0, Pair of aces (A♠ A♥ J♣ 9♥ 7♦)',
      '',
      'P0 +30 · 1 hand · 1 pot won',
      'P1 -10 · 1 hand · 0 pots won · 1 rebuy',
      'P2 (left) -20 · 1 hand · 0 pots won',
    ].join('\n'),
  );
  assert.equal(standingOf(t.view(0)), 'So far tonight, after 1 hand. The dipshit of the night is crowned when the night ends.');
  assert.equal(crownOf(t.view(0)), null, 'nobody is crowned while the night goes on');

  t.cmd(0, { type: 'endNight' });

  const [top, crown] = tonightText(t.view(1)).split('\n');
  assert.deepEqual([top, crown], ["Chips n' Dipshits: the night is over, 1 hand", 'Dipshit of the night: P2. Down 20, more than anyone.']);
  assert.equal(standingOf(t.view(1)), 'The night is over, after 1 hand.');
});

test('at a table that plays dollars and cents every amount in the text is written to the cent', () => {
  const t = oneHandIn({ unit: 'cents' });
  t.cmd(0, { type: 'endNight' });

  assert.equal(
    tonightText(t.view(0)),
    [
      "Chips n' Dipshits: the night is over, 1 hand",
      'Dipshit of the night: P2. Down 0.20, more than anyone.',
      'Up the most: P0, +0.30',
      'Most pots won: P0, 1',
      'Biggest pot: P0, 0.50',
      'Best hand: P0, Pair of aces (A♠ A♥ J♣ 9♥ 7♦)',
      '',
      'P0 +0.30 · 1 hand · 1 pot won',
      'P1 -0.10 · 1 hand · 0 pots won',
      'P2 -0.20 · 1 hand · 0 pots won',
    ].join('\n'),
  );
});

test('the crown says what settled it: the money alone, a tie on it broken by rebuys or by pots won, or a crown shared, and a night nobody lost has none', () => {
  const nets = { Ann: 300, Bob: -150, Cat: -150 };

  assert.deepEqual(crownOf(nightOf({ Ann: 300, Bob: -100, Cat: -200 }, ['Cat'])), { title: 'Dipshit of the night', names: 'Cat', line: 'Down 200, more than anyone.' });
  assert.equal(crownOf(nightOf(nets, ['Bob'], 'rebuys'))!.line, 'Down 150, tied for the worst night, and bought back in the most.');
  assert.equal(crownOf(nightOf(nets, ['Cat'], 'pots'))!.line, 'Down 150, tied for the worst night and on rebuys, and won the fewest pots.');
  assert.deepEqual(crownOf(nightOf(nets, ['Bob', 'Cat'])), { title: 'Dipshits of the night', names: 'Bob and Cat', line: 'Each down 150, with the same rebuys and the same pots won.' });
  assert.deepEqual(crownOf(nightOf({ Ann: 0, Bob: 0 }, [])), { title: 'No dipshit tonight', names: '', line: 'Nobody finished down.' });

  assert.equal(tonightText(nightOf({ Ann: 0, Bob: 0 }, [])).split('\n')[1], 'No dipshit tonight. Nobody finished down.');
});

test('players level in something are named together while they are few, and counted when they are many', () => {
  const view = oneHandIn().view(0);
  const led = (ids: string[]) => leadersOf({ ...view, tonight: { ...view.tonight, upMost: [], biggestPot: [], bestHand: ids, mostPots: ids } });
  const everyone = view.tonight.players.map((row) => row.playerId);

  assert.deepEqual(led(everyone.slice(0, 2)), [
    { label: 'Most pots won', who: 'P0 and P1', what: '1 each', cards: null },
    { label: 'Best hand', who: 'P0 and P1', what: 'Pair of aces each', cards: null },
  ]);
  assert.equal(led(everyone)[0]!.who, 'P0, P1 and P2');

  const four = new TestTable({ stacks: [1000, 1000, 1000, 1000] }).view(0);
  assert.deepEqual(leadersOf({ ...four, tonight: { ...four.tonight, mostPots: four.tonight.players.map((row) => row.playerId) } }), [{ label: 'Most pots won', who: '4 players', what: '0 each', cards: null }]);
  assert.deepEqual(leadersOf(four), [], 'nothing is led before anything has happened');
});

test('a table that began counting late says how many hands its numbers leave out, in the dialog and in the text', () => {
  const view = oneHandIn().view(0);
  const late = (missed: number): TableView => ({ ...view, tonight: { ...view.tonight, missed } });

  assert.equal(missedOf(view), null);
  assert.equal(missedOf(late(1)), 'These numbers start partway through the night: 1 hand was played before the count began. The money is all there.');
  assert.equal(tonightText(late(12)).split('\n').at(-1), 'These numbers start partway through the night: 12 hands were played before the count began. The money is all there.');
});

test('the night as text gives each player\'s badges after what they did, in the order of the list, with how many times', () => {
  const t = oneHandIn();
  t.state.tonight.players[t.ids[0]!]!.badges = { felted: 2, quads: 1 };

  const lines = tonightText(t.view(1)).split('\n');

  assert.ok(lines.includes('P0 +30 · 1 hand · 1 pot won · 🍀 Quads · 💀 Felted ×2'), lines.join('\n'));
  assert.ok(lines.includes('P2 -20 · 1 hand · 0 pots won'), 'a player with no badges gets no more');
});
