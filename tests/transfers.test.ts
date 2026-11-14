import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, ledgerOf } from '../src/engine/index.ts';
import type { Command } from '../src/engine/index.ts';
import { settleUp } from '../src/client/settle.ts';
import { ledgerEntries, TestTable } from './helpers.ts';
import { assertChipsConserved, assertLedgerAgrees } from './invariants.ts';

const transfer = (t: TestTable, sender: number, from: number, to: number, amount: unknown) =>
  t.cmd(sender, { type: 'transferChips', from: t.ids[from]!, to: t.ids[to]!, amount } as Command);

/** Refused with the message given, and the table left exactly as it was. */
function assertRefused(t: TestTable, send: () => void, message: string | RegExp): void {
  const before = JSON.stringify(t.state);
  const effects = t.effects.length;

  assert.throws(send, { name: 'GameError', message });
  assert.equal(JSON.stringify(t.state), before);
  assert.equal(t.effects.length, effects);
}

const nets = (t: TestTable) => Object.fromEntries(ledgerOf(t.state).map((row) => [row.name, row.net]));

test('a transfer moves the chips and books both sides of it, each naming the other player', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Host', 'Dana', 'Sam'] });
  const booked = t.effects.length;

  transfer(t, 0, 1, 2, 500);

  assert.deepEqual(t.stacks(), [1000, 500, 1500]);
  assert.deepEqual(ledgerEntries(t.effects.slice(booked)), [
    { at: t.now, tableId: t.state.id, playerId: t.ids[1], name: 'Dana', kind: 'transfer', amount: -500, otherId: t.ids[2], otherName: 'Sam' },
    { at: t.now, tableId: t.state.id, playerId: t.ids[2], name: 'Sam', kind: 'transfer', amount: 500, otherId: t.ids[1], otherName: 'Dana' },
  ]);
  assert.equal(t.feedText().at(-1), 'The host moved 500 from Dana to Sam');

  // Nobody bought or cashed out: Dana is 500 down on the night and Sam 500 up
  assert.deepEqual(t.state.members.map((m) => [m.buyIn, m.cashOut, m.transferred]), [[1000, 0, 0], [1000, 0, -500], [1000, 0, 500]]);
  assert.deepEqual(nets(t), { Host: 0, Dana: -500, Sam: 500 });
  assert.deepEqual(ledgerOf(t.state).map((row) => row.transferred), [0, -500, 500]);

  assertChipsConserved(t.state);
  assertLedgerAgrees(t.state, t.effects);
});

test('the settle-up after a transfer comes out as if the receiver had bought the chips with the giver\'s money', () => {
  // The host goes all in for 300 and loses it to Dana; Sam sits the hand out
  const t = new TestTable({ stacks: [300, 1000, 1000], names: ['Host', 'Dana', 'Sam'] });
  t.cmd(2, { type: 'sitOut' });
  t.deal({ button: 0, holes: { 0: '7h 2c', 1: 'As Ad' }, board: 'Kc 9d 4s 3h Jc' });
  t.raise(0, 300);
  t.call(1);
  t.finishHand();

  assert.deepEqual(nets(t), { Host: -300, Dana: 300, Sam: 0 });
  assert.deepEqual(settleUp(ledgerOf(t.state)), [{ from: 'Host', to: 'Dana', amount: 300 }]);

  // Sam stakes the host, who has nothing left
  transfer(t, 0, 2, 0, 500);

  assert.deepEqual(nets(t), { Host: 200, Dana: 300, Sam: -500 });
  assert.deepEqual(settleUp(ledgerOf(t.state)), [
    { from: 'Sam', to: 'Dana', amount: 300 },
    { from: 'Sam', to: 'Host', amount: 200 },
  ]);
  assert.equal(ledgerOf(t.state).reduce((sum, row) => sum + row.net, 0), 0);

  // The host buys more, Dana cashes out, and the night still settles to nothing left over
  t.cmd(0, { type: 'requestRebuy', amount: 400 });
  t.cmd(1, { type: 'standUp' });

  const rows = ledgerOf(t.state);
  const payments = settleUp(rows);
  assert.deepEqual(nets(t), { Host: 200, Dana: 300, Sam: -500 });
  assert.equal(rows.reduce((sum, row) => sum + row.net, 0), 0);
  assert.equal(payments.reduce((sum, p) => sum + p.amount, 0), 500);
  assert.equal(ledgerEntries(t.effects).filter((entry) => entry.kind === 'buy-in').length, 4, 'a transfer is never counted as buying chips');

  assertChipsConserved(t.state);
  assertLedgerAgrees(t.state, t.effects);
});

test('a whole stack can be given away, which leaves the giver out of the next hand until they add chips', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });

  transfer(t, 0, 1, 2, 1000);
  assert.deepEqual(t.stacks(), [1000, 0, 2000]);

  t.deal({ button: 0 });
  assert.deepEqual(t.state.hand!.players.map((p) => p.seat), [0, 2]);
  t.fold(t.state.hand!.toAct === 0 ? 0 : 2);
  t.finishHand();

  t.cmd(1, { type: 'requestRebuy', amount: 300 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  assert.equal(t.stacks()[1], 300);
  assertLedgerAgrees(t.state, t.effects);
});

test('the receiver may end above the table maximum: a transfer is not a buy-in', () => {
  const t = new TestTable({ stacks: [1000, 1000], config: { maxBuyIn: 1000 } });

  transfer(t, 0, 0, 1, 1000);

  assert.deepEqual(t.stacks(), [0, 2000]);
});

test('an amount that is not a whole number of chips from one to the giver\'s stack is refused', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  const range = 'The amount must be a whole number from 1 to 1,000';

  assertRefused(t, () => transfer(t, 0, 0, 1, 1001), range);
  assertRefused(t, () => transfer(t, 0, 0, 1, 0), range);
  assertRefused(t, () => transfer(t, 0, 0, 1, -5), range);
  assertRefused(t, () => transfer(t, 0, 0, 1, 2.5), range);
  assertRefused(t, () => transfer(t, 0, 0, 1, '500'), range);

  transfer(t, 0, 0, 1, 1000);
  assertRefused(t, () => transfer(t, 0, 0, 1, 1), 'P0 has no chips to give');
});

test('chips move between two different players, each with a seat at the table', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  const watcher = t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id) - 1;

  assertRefused(t, () => transfer(t, 0, 1, 1, 100), 'Chips move between two different players');
  assertRefused(t, () => transfer(t, 0, watcher, 1, 100), "Watcher doesn't have a seat");
  assertRefused(t, () => transfer(t, 0, 1, watcher, 100), "Watcher doesn't have a seat");
  assertRefused(t, () => t.cmd(0, { type: 'transferChips', from: 'NOBODY12', to: t.ids[1]!, amount: 100 }), 'That player is no longer at the table');
  assertRefused(t, () => t.cmd(0, { type: 'transferChips', from: t.ids[1]!, to: 'NOBODY12', amount: 100 }), 'That player is no longer at the table');

  // Cashed out
  t.cmd(2, { type: 'standUp' });
  assertRefused(t, () => transfer(t, 0, 2, 1, 100), "P2 doesn't have a seat");
  assertRefused(t, () => transfer(t, 0, 1, 2, 100), "P2 doesn't have a seat");
});

test('during a hand, only players not dealt into it can give or receive', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000, 1000] });
  t.cmd(2, { type: 'sitOut' });
  t.cmd(3, { type: 'sitOut' });
  t.deal({ button: 0 });

  assertRefused(t, () => transfer(t, 0, 0, 2, 100), 'P0 is in the current hand. Pause the game, and once this hand is over the chips can move');
  assertRefused(t, () => transfer(t, 0, 2, 1, 100), 'P1 is in the current hand. Pause the game, and once this hand is over the chips can move');

  transfer(t, 0, 2, 3, 100);
  assert.deepEqual(t.stacks(), [t.stacks()[0], t.stacks()[1], 900, 1100]);

  // One who stood up mid-hand is on their way out, and their chips with them
  t.cmd(1, { type: 'standUp' });
  assertRefused(t, () => transfer(t, 0, 1, 2, 100), 'P1 is leaving the table');

  t.fold(0);
  t.finishHand();
  transfer(t, 0, 0, 2, 100);
  assertLedgerAgrees(t.state, t.effects);
});

test('a co-host may move chips to or from the host and themselves, and the chat names them', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Host', 'Cohost', 'Member'] });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });

  transfer(t, 1, 0, 1, 250);
  assert.equal(t.feedText().at(-1), 'Co-host Cohost moved 250 from Host to Cohost');
  assert.deepEqual(t.stacks(), [750, 1250, 1000]);

  assertRefused(t, () => transfer(t, 2, 1, 2, 250), 'Only the host or a co-host can do that');
});

test('on a table that plays dollars and cents, the amount is in cents and a fraction of a cent is refused', () => {
  const t = new TestTable({ stacks: [10_000, 5000], names: ['Dana', 'Sam'], config: { unit: 'cents', minBuyIn: 2000, maxBuyIn: 10_000 } });

  assertRefused(t, () => transfer(t, 0, 0, 1, 1234.5), 'The amount must be an amount to the cent from 0.01 to 100.00');
  assertRefused(t, () => transfer(t, 0, 0, 1, 10_001), 'The amount must be an amount to the cent from 0.01 to 100.00');

  transfer(t, 0, 0, 1, 1234);

  assert.deepEqual(t.stacks(), [8766, 6234]);
  assert.equal(t.feedText().at(-1), 'The host moved 12.34 from Dana to Sam');
  assert.deepEqual(nets(t), { Dana: -1234, Sam: 1234 });
  assert.deepEqual(ledgerEntries(t.effects).slice(-2).map((entry) => entry.amount), [-1234, 1234]);
});
