import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoTable } from '../src/demo/demoTable.ts';
import type { Command, TableView } from '../src/engine/index.ts';
import type { DemoTable } from '../src/demo/demoTable.ts';
import { seededRng } from './helpers.ts';

async function viewOf(demo: DemoTable): Promise<TableView> {
  const response = await demo.send({ op: 'poll', tableId: demo.tableId, auth: demo.you, since: -1 });
  assert.ok(response.ok && response.kind === 'view');

  return response.view;
}

function chipsInPlay(view: TableView): number {
  const stacks = view.seats.reduce((sum, seat) => sum + (seat ? seat.stack : 0), 0);

  return stacks + (view.hand && view.hand.stage !== 'done' ? view.hand.pot : 0);
}

test('the demo table opens on your decision: top pair and a flush draw, facing a bet on the flop', async () => {
  const demo = createDemoTable();
  const view = await viewOf(demo);
  const hand = view.hand!;

  assert.equal(view.you.seat, 0);
  assert.equal(view.you.role, 'host');
  assert.equal(hand.street, 'flop');
  assert.equal(hand.button, 0);
  assert.equal(hand.toAct, 0);
  assert.deepEqual(hand.boards, [['Kh', '9s', '4s']]);
  assert.deepEqual(view.seats[0]!.cards, ['As', 'Ks']);
  assert.equal(hand.pot, 570);
  assert.equal(hand.options!.callCost, 160);
  assert.equal(view.seats.filter((seat) => seat?.inHand && !seat.folded).length, 4);
  assert.equal(demo.step(), false, 'the bots wait while it is your turn');
});

test('the bots keep the demo table going for hands on end, and no chip goes missing', async () => {
  let now = 5_000_000;
  const rng = seededRng(7);
  const demo = createDemoTable({ now: () => now, random: () => rng.int(1000) / 1000 });
  let hands = 0;

  for (let i = 0; i < 3000; i++) {
    const view = await viewOf(demo);
    hands = Math.max(hands, view.hand?.number ?? 0);

    const bought = view.ledger.reduce((sum, row) => sum + row.buyIn - row.cashOut, 0);
    assert.equal(chipsInPlay(view), bought, 'chips appeared or vanished');

    const mine = view.hand?.options;
    if (mine) {
      await demo.send({ op: 'act', tableId: demo.tableId, auth: demo.you, command: mine.canCheck ? { type: 'check' } : { type: 'call' } });
    } else if (view.hand?.canVote) {
      await demo.send({ op: 'act', tableId: demo.tableId, auth: demo.you, command: { type: 'ritVote', runs: 2 } });
    } else if (view.requests.length > 0) {
      await demo.send({ op: 'act', tableId: demo.tableId, auth: demo.you, command: { type: 'approve', playerId: view.requests[0]!.playerId } });
    } else if (view.seats[0]!.stack === 0 && !view.seats[0]!.inHand && view.seats[0]!.pendingAdd === 0) {
      await demo.send({ op: 'act', tableId: demo.tableId, auth: demo.you, command: { type: 'requestRebuy', amount: 1000 } });
    } else if (!demo.step()) {
      // Nothing to do until a pause on the table's clock runs out
      now += 1000;
    }
  }

  assert.ok(hands >= 20, `only ${hands} hands were played`);
  demo.stop();
});

test('a bot in the big blind answers when the person at the page offers to chop', async () => {
  let now = 5_000_000;
  // Bots that fold to any bet, so the action comes round to the blinds
  const demo = createDemoTable({ now: () => now, random: () => 0 });
  const act = (command: Command) => demo.send({ op: 'act', tableId: demo.tableId, auth: demo.you, command });
  let offered = 0;

  await act({ type: 'updateConfig', config: { allowChop: true } });

  for (let i = 0; i < 6000 && offered < 3; i++) {
    const view = await viewOf(demo);
    const hand = view.hand;

    if (hand?.canOfferChop) {
      await act({ type: 'offerChop', turn: hand.turn });
      offered += 1;
      assert.equal(demo.step(), true, 'the bot in the big blind leaves the chop unanswered');
      assert.notEqual((await viewOf(demo)).hand?.stage, 'chop');
    } else if (hand?.options) {
      // Folding whatever it can, so the action comes round to the blinds often
      await act(hand.options.canCheck ? { type: 'check' } : { type: 'fold' });
    } else if (hand?.canVote) {
      await act({ type: 'ritVote', runs: 2 });
    } else if (view.requests.length > 0) {
      await act({ type: 'approve', playerId: view.requests[0]!.playerId });
    } else if (view.seats[0]!.stack === 0 && !view.seats[0]!.inHand && view.seats[0]!.pendingAdd === 0) {
      await act({ type: 'requestRebuy', amount: 1000 });
    } else if (!demo.step()) {
      now += 1000;
    }
  }

  assert.equal(offered, 3, `offered ${offered}: the action never came to the person at the page as the small blind with only the blinds in`);
  demo.stop();
});
