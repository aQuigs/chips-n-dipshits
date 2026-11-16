import assert from 'node:assert/strict';
import { test } from 'node:test';

import { askedSays, chipsAsked, offeredToAdd, outOfChips, roomToAdd, suggestedBuyIn } from '../src/client/buyIns.ts';
import { addMember } from '../src/engine/index.ts';
import type { TableConfig } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';

const STAKES: Partial<TableConfig> = { smallBlind: 10, bigBlind: 20, minBuyIn: 400, maxBuyIn: 4000 };
const [HOST, PLAYER, THIRD] = [0, 1, 2];

/** Three players who each bought 2,000 at a table of 400 to 4,000. */
const seated = (config: Partial<TableConfig> = {}) => new TestTable({ stacks: [2000, 2000, 2000], config: { ...STAKES, ...config } });

/** The player keeps `stack` of what they bought, and the host has the rest: no chip is made or lost. */
function leaves(t: TestTable, stack: number): TestTable {
  const [theirs, mine] = [t.state.seats[HOST]!, t.state.seats[PLAYER]!];

  theirs.stack += mine.stack - stack;
  mine.stack = stack;

  return t;
}

/** The player is all in with aces against the host's kings, who has a set coming: the cards are still to be turned. */
function allIn(): TestTable {
  const t = seated();

  t.deal({ button: THIRD, holes: { [HOST]: 'Kh Kd', [PLAYER]: 'As Ad' }, board: 'Kc 7c 2d 9s 3h' });
  t.fold(THIRD);
  t.raise(HOST, 2000);
  t.call(PLAYER);

  return t;
}

test('the dialog offers what the player last bought in for, never the most the table allows', () => {
  const broke = leaves(seated(), 0);

  assert.equal(roomToAdd(broke.view(PLAYER)), 4000);
  assert.equal(offeredToAdd(broke.view(PLAYER)), 2000);

  const short = leaves(seated(), 300);

  assert.equal(roomToAdd(short.view(PLAYER)), 3700);
  assert.equal(offeredToAdd(short.view(PLAYER)), 2000);
});

test('no more is offered than there is room for under the table maximum', () => {
  const near = leaves(seated(), 3700);

  assert.equal(offeredToAdd(near.view(PLAYER)), 300);

  const full = leaves(seated(), 4000);

  assert.equal(roomToAdd(full.view(PLAYER)), 0);
  assert.equal(offeredToAdd(full.view(PLAYER)), 0);

  const over = leaves(seated(), 4500);

  assert.equal(roomToAdd(over.view(PLAYER)), 0, 'a stack won past the maximum has no room, and never less than none');
});

test('chips on their way to the stack take up room', () => {
  const t = allIn();

  // The host adds chips mid-hand, which wait for its end
  t.cmd(HOST, { type: 'requestRebuy', amount: 1500 });

  assert.equal(t.state.seats[HOST]!.pendingAdd, 1500);
  assert.equal(roomToAdd(t.view(HOST)), 2500);
});

test('once a player has bought twice their last buy is not in the view, and the offer is the buy-in a seat is offered', () => {
  const t = leaves(seated(), 0);

  t.cmd(PLAYER, { type: 'requestRebuy', amount: 700 });
  t.cmd(HOST, { type: 'approve', playerId: t.ids[PLAYER]! });
  leaves(t, 0);

  assert.equal(offeredToAdd(t.view(PLAYER)), suggestedBuyIn(t.state.config));
  assert.equal(suggestedBuyIn(t.state.config), 2000);
  assert.equal(offeredToAdd(leaves(t, 2500).view(PLAYER)), 1500, 'and still no more than there is room for');
});

test('the suggested buy-in is a hundred big blinds, as near to that as the table allows', () => {
  const at = (config: Partial<TableConfig>) => suggestedBuyIn(seated(config).state.config);

  assert.equal(at({}), 2000);
  assert.equal(at({ smallBlind: 1, bigBlind: 2 }), 400);
  assert.equal(at({ smallBlind: 50, bigBlind: 100 }), 4000);
});

test('someone watching has no seat to add to', () => {
  const t = seated();
  const watcher = t.ids.push(addMember(t.state, 'Ann', t.ctx()).id) - 1;

  assert.equal(roomToAdd(t.view(watcher)), 0);
  assert.equal(outOfChips(t.view(watcher)), false);
});

test('a player is out of chips with no stack and nothing riding on a hand in play', () => {
  const t = allIn();

  assert.equal(t.state.seats[PLAYER]!.stack, 0);
  assert.equal(outOfChips(t.view(PLAYER)), false, 'all in, with the cards to come');
  assert.equal(outOfChips(t.view(THIRD)), false, 'folded, with chips');

  t.runToResult();
  assert.equal(t.state.hand!.stage, 'done');
  assert.equal(outOfChips(t.view(PLAYER)), true, 'the hand is lost, its result still on the table');
  assert.equal(outOfChips(t.view(HOST)), false);

  t.finishHand();
  assert.equal(outOfChips(t.view(PLAYER)), true);

  // The next hand is dealt without them, and is no hand of theirs
  t.deal();
  assert.equal(outOfChips(t.view(PLAYER)), true);
});

test('chips on their way are chips: a player who lost everything with more already bought is not asked to buy again', () => {
  const t = allIn();

  t.cmd(PLAYER, { type: 'requestRebuy', amount: 1500 });
  t.cmd(HOST, { type: 'approve', playerId: t.ids[PLAYER]! });
  t.runToResult();

  assert.deepEqual([t.state.seats[PLAYER]!.stack, t.state.seats[PLAYER]!.pendingAdd], [0, 1500]);
  assert.equal(outOfChips(t.view(PLAYER)), false);
});

test('a request for chips is said as a request for a seat is, with the amount as the table writes it', () => {
  const t = leaves(seated(), 0);

  assert.equal(chipsAsked(t.view(PLAYER)), null);

  t.cmd(PLAYER, { type: 'requestRebuy', amount: 1000 });

  const asked = chipsAsked(t.view(PLAYER))!;

  assert.deepEqual(askedSays(asked, t.state.config), { full: 'Asked the host for 1,000 more chips', brief: 'Asked for 1,000' });
  assert.deepEqual(askedSays(asked, { unit: 'cents' }), { full: 'Asked the host for 10.00 more', brief: 'Asked for 10.00' });
  assert.equal(chipsAsked(t.view(THIRD)), null, 'nobody else has asked');

  // A request for a seat is not one for chips
  const watcher = t.ids.push(addMember(t.state, 'Ann', t.ctx()).id) - 1;

  t.cmd(watcher, { type: 'requestSeat', seat: 5, buyIn: 400 });
  assert.equal(chipsAsked(t.view(watcher)), null);
});
