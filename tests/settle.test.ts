import assert from 'node:assert/strict';
import test from 'node:test';

import { enoughSeated } from '../src/client/render/night.ts';
import { ownPayments, paymentText, settlement, settleUpText } from '../src/client/settle.ts';
import { addMember, formatAmount } from '../src/engine/index.ts';
import type { TableView } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';

const HOST = 0;

/** Three players and one hand: Quigs takes 100 from Danny and the big blind from Marge. */
function afterAHand(config: Record<string, unknown> = {}): TestTable {
  const table = new TestTable({ stacks: [1000, 1000, 1000], names: ['Quigs', 'Danny', 'Marge'], config: { smallBlind: 10, bigBlind: 20, ...config } });

  table.deal({ button: 0 });
  table.raise(0, 100);
  table.call(1);
  table.fold(2);
  table.check(1);
  table.raise(0, 200);
  table.fold(1);
  table.finishHand();

  return table;
}

/** What every player is up or down once the payments of `view` are made: nobody anything, if the list is right. */
function leftOwing(view: TableView): number[] {
  const nets = new Map(view.ledger.map((row) => [row.name, row.net]));

  for (const payment of settlement(view)) {
    nets.set(payment.from, nets.get(payment.from)! + payment.amount);
    nets.set(payment.to, nets.get(payment.to)! - payment.amount);
  }

  return [...nets.values()];
}

test('the text to copy is the Ledger’s own list, payment for payment, and paying it leaves nobody up or down', () => {
  const view = afterAHand().view(1);

  assert.deepEqual(
    view.ledger.map((row) => [row.name, row.net]),
    [
      ['Quigs', 120],
      ['Danny', -100],
      ['Marge', -20],
    ],
  );
  assert.deepEqual(settlement(view), [
    { from: 'Danny', to: 'Quigs', amount: 100 },
    { from: 'Marge', to: 'Quigs', amount: 20 },
  ]);
  assert.deepEqual(settleUpText(view).split('\n'), [`${view.config.name}: to settle up`, 'Danny pays Quigs 100', 'Marge pays Quigs 20']);
  assert.deepEqual(leftOwing(view), [0, 0, 0]);
});

test('the list is the same whoever looks, and each is told their own part of it', () => {
  const table = afterAHand();
  const zed = table.ids.push(addMember(table.state, 'Zed', table.ctx()).id) - 1;

  for (const player of [0, 1, 2, zed]) {
    assert.equal(settleUpText(table.view(player)), settleUpText(table.view(HOST)));
  }

  assert.deepEqual(ownPayments(table.view(0)), ['Danny pays you 100', 'Marge pays you 20']);
  assert.deepEqual(ownPayments(table.view(1)), ['You pay Quigs 100']);
  assert.deepEqual(ownPayments(table.view(2)), ['You pay Quigs 20']);
  assert.deepEqual(ownPayments(table.view(zed)), [], 'someone who never bought in');
});

test('at a table of dollars and cents the sums are written as the table writes them, to the cent', () => {
  const view = afterAHand({ unit: 'cents' }).view(HOST);
  const [first] = settlement(view);

  assert.equal(paymentText(first!, view.config), `Danny pays Quigs ${formatAmount(100, view.config)}`);
  assert.equal(formatAmount(100, view.config), '1.00');
  assert.deepEqual(settleUpText(view).split('\n').slice(1), ['Danny pays Quigs 1.00', 'Marge pays Quigs 0.20']);
  assert.deepEqual(leftOwing(view), [0, 0, 0]);
});

test('a rebuy and chips still on the table are in the sums: the list squares the ledger in the middle of a night too', () => {
  const table = afterAHand();

  table.cmd(1, { type: 'requestRebuy', amount: 500 });
  table.cmd(HOST, { type: 'approve', playerId: table.ids[1]! });
  table.deal();

  const view = table.view(HOST);

  assert.equal(view.ledger.find((row) => row.name === 'Danny')!.buyIn, 1500);
  assert.equal(
    view.ledger.reduce((sum, row) => sum + row.net, 0),
    0,
    'the ledger itself does not add up',
  );
  assert.deepEqual(
    leftOwing(view).filter((net) => net !== 0),
    [],
  );
});

test('with nobody up or down there is nothing to pay', () => {
  const view = new TestTable({ stacks: [1000, 1000] }).view(HOST);

  assert.deepEqual(settlement(view), []);
  assert.deepEqual(ownPayments(view), []);
});

test('the game has the players it takes to start once two are seated, and not after one of two has left', () => {
  const alone = new TestTable({ stacks: [1000] });

  assert.equal(enoughSeated(alone.view(HOST)), false);

  alone.sitDown('Danny', 1);
  assert.equal(enoughSeated(alone.view(HOST)), true);

  const two = new TestTable({ stacks: [1000, 1000] });

  two.cmd(1, { type: 'standUp' });
  assert.equal(enoughSeated(two.view(HOST)), false);
});
