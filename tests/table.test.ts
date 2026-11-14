import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, createTable, DEFAULT_CONFIG, ledgerOf, STATE_SCHEMA, viewFor } from '../src/engine/index.ts';
import type { Ctx, Effect } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { seededRng, TestTable } from './helpers.ts';
import { assertChipsConserved, assertViewsKeepSecrets } from './invariants.ts';

function freshCtx(): Ctx {
  return { now: 5000, rng: seededRng(7), effects: [] };
}

function ledgerEntries(effects: Effect[]) {
  return effects.flatMap((effect) => (effect.type === 'ledger' ? [effect.entry] : []));
}

test('a new table fills in default settings and makes its creator the host', () => {
  const { state, host } = createTable('ABC123', '  Quigs  ', { smallBlind: 1, bigBlind: 2 }, freshCtx());

  assert.equal(host.name, 'Quigs');
  assert.equal(state.hostId, host.id);
  assert.deepEqual(state.config, { ...DEFAULT_CONFIG, smallBlind: 1, bigBlind: 2 });
  assert.equal(state.seats.length, 10);
});

test('table settings that make no sense are rejected', () => {
  const create = (config: unknown) => () => createTable('ABC123', 'Quigs', config, freshCtx());

  assert.throws(create({ smallBlind: 0 }), /small blind/);
  assert.throws(create({ smallBlind: 20, bigBlind: 10 }), /big blind can't be smaller than the small blind/);
  assert.throws(create({ smallBlind: 1.5 }), /whole number/);
  assert.throws(create({ minBuyIn: 500, maxBuyIn: 100 }), /maximum buy-in can't be smaller than the minimum/);
  assert.throws(create({ actionSeconds: 2 }), /action clock/);
  assert.throws(create({ allowStraddle: 'yes' }), /Straddles/);
  assert.throws(create({ name: '' }), /table name/);
  assert.throws(create({ sevenDeuceBounty: -5 }), /bounty/);
});

test('names are unique at a table and cannot look like a spreadsheet formula', () => {
  const ctx = freshCtx();
  const { state } = createTable('ABC123', 'Quigs', {}, ctx);

  assert.throws(() => addMember(state, 'quigs', ctx), /already called/);
  assert.throws(() => addMember(state, '=SUM(A1)', ctx), /Names start with/);
  assert.throws(() => addMember(state, '+1', ctx), /Names start with/);
  assert.throws(() => addMember(state, '', ctx), /1 to 16 characters/);
  assert.throws(() => addMember(state, 'x'.repeat(17), ctx), /1 to 16 characters/);
  assert.throws(() => addMember(state, 42, ctx), /missing/);

  assert.equal(addMember(state, "Big Al's 2nd", ctx).name, "Big Al's 2nd");
});

test('a name that reads like one already at the table is refused', () => {
  const ctx = freshCtx();
  const { state } = createTable('ABC123', 'Quigs', {}, ctx);

  addMember(state, 'Alice', ctx);
  addMember(state, 'TOM', ctx);
  addMember(state, 'Big Al', ctx);
  addMember(state, 'Bob', ctx);

  assert.throws(() => addMember(state, 'alice', ctx), /already called alice/);
  assert.throws(() => addMember(state, '\u0410lice', ctx), /one alphabet/, 'a Cyrillic A in a Latin name');
  assert.throws(() => addMember(state, '\u13AAlice', ctx), /one alphabet/, 'a Cherokee letter in a Latin name');
  assert.throws(() => addMember(state, '\u0422\u041E\u041C', ctx), /reads too much like TOM/, 'TOM written all in Cyrillic');
  assert.throws(() => addMember(state, '\u03A4\u039F\u039C', ctx), /reads too much like TOM/, 'TOM written all in Greek');
  assert.throws(() => addMember(state, 'Big AI', ctx), /reads too much like Big Al/, 'a capital I for a small l');
  assert.throws(() => addMember(state, 'B0b', ctx), /reads too much like Bob/, 'a zero for an o');
  assert.throws(() => addMember(state, '\uFF22ob', ctx), /reads too much like Bob/, 'a full-width B');

  // Names that only share an alphabet with nobody are as welcome as any
  for (const name of ['\u0410\u043D\u043D\u0430', '\u039D\u03AF\u03BA\u03BF\u03C2', '\u4F60\u597D', 'Zo\u00EB', 'Tim', 'Al']) {
    assert.equal(addMember(state, name, ctx).name, name);
  }
});

test('a full table turns a newcomer away until the host takes someone who is only watching off it', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  const watchers: string[] = [];

  while (t.state.members.length < 60) {
    watchers.push(addMember(t.state, `Watcher ${watchers.length}`, t.ctx()).id);
  }

  // Nobody already here loses their place to whoever comes next, however often they try
  assert.throws(() => addMember(t.state, 'Late', t.ctx()), /full.*host can make room/);
  assert.equal(t.state.members.length, 60);

  t.cmd(0, { type: 'kick', playerId: watchers[0]! });
  assert.equal(addMember(t.state, 'Late', t.ctx()).name, 'Late');

  // Removed since the host's screen was drawn: the message is about them, not about the host
  assert.throws(() => t.cmd(0, { type: 'kick', playerId: watchers[0]! }), /no longer at the table/);
});

test('a seat request waits for the host, who is the only other person to see it', () => {
  const t = new TestTable({ stacks: [1000], config: { minBuyIn: 100, maxBuyIn: 2000 } });
  const ann = addMember(t.state, 'Ann', t.ctx());
  const bob = addMember(t.state, 'Bob', t.ctx());
  t.ids.push(ann.id, bob.id);

  t.cmd(1, { type: 'requestSeat', seat: 4, buyIn: 500 });

  assert.equal(t.state.seats[4], null);
  assert.deepEqual(t.view(0).requests, [{ playerId: ann.id, name: 'Ann', kind: 'seat', seat: 4, amount: 500 }]);
  assert.equal(t.view(1).requests.length, 1);
  assert.equal(t.view(2).requests.length, 0);

  t.cmd(0, { type: 'approve', playerId: ann.id });

  assert.equal(t.state.seats[4]!.stack, 500);
  assert.equal(t.state.requests.length, 0);
  assert.deepEqual(ledgerEntries(t.effects).at(-1), {
    at: t.now,
    tableId: 'TEST01',
    playerId: ann.id,
    name: 'Ann',
    kind: 'buy-in',
    amount: 500,
  });
  assertChipsConserved(t.state);
});

test('seat requests are checked against the seat and the buy-in limits', () => {
  const t = new TestTable({ stacks: [1000], config: { minBuyIn: 100, maxBuyIn: 2000 } });
  t.ids.push(addMember(t.state, 'Ann', t.ctx()).id, addMember(t.state, 'Bob', t.ctx()).id);

  assert.throws(() => t.cmd(1, { type: 'requestSeat', seat: 0, buyIn: 500 }), /taken/);
  assert.throws(() => t.cmd(1, { type: 'requestSeat', seat: 10, buyIn: 500 }), /seat/);
  assert.throws(() => t.cmd(1, { type: 'requestSeat', seat: 3, buyIn: 99 }), /buy-in/);
  assert.throws(() => t.cmd(1, { type: 'requestSeat', seat: 3, buyIn: 2001 }), /buy-in/);
  assert.throws(() => t.cmd(0, { type: 'requestSeat', seat: 3, buyIn: 500 }), /already have a seat/);
});

test('a seat given to one player turns away everyone else who had asked for it', () => {
  const t = new TestTable({ stacks: [1000], config: { minBuyIn: 100, maxBuyIn: 2000 } });
  t.ids.push(addMember(t.state, 'Ann', t.ctx()).id, addMember(t.state, 'Bob', t.ctx()).id, addMember(t.state, 'Cy', t.ctx()).id);

  t.cmd(1, { type: 'requestSeat', seat: 3, buyIn: 500 });
  t.cmd(2, { type: 'requestSeat', seat: 3, buyIn: 500 });
  t.cmd(3, { type: 'requestSeat', seat: 4, buyIn: 500 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });

  assert.deepEqual(
    t.state.requests.map((request) => request.playerId),
    [t.ids[3]],
    'only the request for another seat is left',
  );
  assert.ok(t.feedText().includes('Seat 4 is taken, so Bob needs to pick another'));
  assert.equal(t.view(2).requests.length, 0, 'Bob is free to ask for another seat');
  assert.throws(() => t.cmd(0, { type: 'approve', playerId: t.ids[2]! }), /gone/);
});

test('a player can withdraw their own request', () => {
  const t = new TestTable({ stacks: [1000] });
  t.ids.push(addMember(t.state, 'Ann', t.ctx()).id);

  t.cmd(1, { type: 'requestSeat', seat: 3, buyIn: 500 });
  t.cmd(1, { type: 'cancelRequest' });

  assert.equal(t.state.requests.length, 0);
  assert.throws(() => t.cmd(0, { type: 'approve', playerId: t.ids[1]! }), /gone/);
});

test('only the host can use the host controls', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  const other = t.ids[0]!;

  for (const command of [
    { type: 'start' },
    { type: 'pause' },
    { type: 'approve', playerId: other },
    { type: 'deny', playerId: other },
    { type: 'kick', playerId: other },
    { type: 'setStack', playerId: other, stack: 5 },
    { type: 'updateConfig', config: { bigBlind: 500 } },
    { type: 'transferHost', playerId: t.ids[1]! },
  ] as const) {
    assert.throws(() => t.cmd(1, command), /Only the host/, command.type);
  }
});

test('rebuys respect the maximum buy-in', () => {
  const t = new TestTable({ stacks: [1000, 1000], config: { minBuyIn: 100, maxBuyIn: 1500 } });

  assert.throws(() => t.cmd(1, { type: 'requestRebuy', amount: 501 }), /rebuy/);
  t.cmd(1, { type: 'requestRebuy', amount: 500 });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });

  assert.equal(t.state.seats[1]!.stack, 1500);
  assert.throws(() => t.cmd(1, { type: 'requestRebuy', amount: 1 }), /maximum buy-in/);
});

test('a request that stopped fitting is cut down or dropped, never left for the host to fail on', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { minBuyIn: 100, maxBuyIn: 2000 } });
  t.ids.push(addMember(t.state, 'Ann', t.ctx()).id, addMember(t.state, 'Bob', t.ctx()).id);

  // The maximum came down after these two asked
  t.cmd(1, { type: 'requestRebuy', amount: 1000 });
  t.cmd(2, { type: 'requestRebuy', amount: 1000 });
  t.cmd(0, { type: 'updateConfig', config: { maxBuyIn: 1500 } });
  t.cmd(0, { type: 'approve', playerId: t.ids[1]! });
  assert.equal(t.state.seats[1]!.stack, 1500, 'the rebuy is cut down to what still fits');

  t.cmd(0, { type: 'updateConfig', config: { maxBuyIn: 1000 } });
  t.cmd(0, { type: 'approve', playerId: t.ids[2]! });
  assert.equal(t.state.seats[2]!.stack, 1000);
  assert.equal(t.feedText().at(-1), 'P2 is at the table maximum, so no chips are added');
  assert.equal(t.state.requests.length, 0);

  // A seat request is the player's own money, so one outside the new limits is theirs to make again
  t.cmd(3, { type: 'requestSeat', seat: 5, buyIn: 600 });
  t.cmd(4, { type: 'requestSeat', seat: 6, buyIn: 900 });
  t.cmd(0, { type: 'updateConfig', config: { minBuyIn: 800 } });

  assert.deepEqual(
    t.state.requests.map((request) => request.playerId),
    [t.ids[4]],
  );
  assert.ok(t.feedText().includes("Ann asked to sit down with 600, which the new buy-in limits don't allow"));
  assertChipsConserved(t.state);
});

test('the table is told when the host turns a request down', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.ids.push(addMember(t.state, 'Ann', t.ctx()).id);

  t.cmd(2, { type: 'requestSeat', seat: 5, buyIn: 600 });
  t.cmd(0, { type: 'deny', playerId: t.ids[2]! });
  assert.equal(t.feedText().at(-1), "The host turned down Ann's request for a seat");

  t.cmd(1, { type: 'requestRebuy', amount: 100 });
  t.cmd(0, { type: 'deny', playerId: t.ids[1]! });
  assert.equal(t.feedText().at(-1), "The host turned down P1's request for chips");

  const lines = t.feedText().length;
  t.cmd(0, { type: 'deny', playerId: t.ids[1]! });
  assert.equal(t.feedText().length, lines, 'there was nothing left to turn down');

  t.cmd(0, { type: 'requestRebuy', amount: 250 });
  assert.equal(t.state.seats[0]!.stack, 1250, "the host's own rebuy needs no approval");
  assertChipsConserved(t.state);
});

test('a player on their way out cannot ask for chips that would never be added', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });

  t.cmd(0, { type: 'standUp' });
  assert.throws(() => t.cmd(0, { type: 'requestRebuy', amount: 500 }), /giving up your seat/);
});

test('the host can correct a stack between hands, and the ledger records the difference', () => {
  const t = new TestTable({ stacks: [1000, 1000] });

  t.cmd(0, { type: 'setStack', playerId: t.ids[1]!, stack: 1300 });
  t.cmd(0, { type: 'setStack', playerId: t.ids[1]!, stack: 900 });

  assert.equal(t.state.seats[1]!.stack, 900);
  assert.deepEqual(ledgerEntries(t.effects).slice(-2).map((e) => [e.kind, e.amount]), [['adjustment', 300], ['adjustment', -400]]);
  assertChipsConserved(t.state);

  t.deal({ button: 0 });
  assert.throws(() => t.cmd(0, { type: 'setStack', playerId: t.ids[1]!, stack: 5000 }), /current hand/);
});

test('kicking a player cashes them out', () => {
  const t = new TestTable({ stacks: [1000, 1000] });

  t.cmd(0, { type: 'kick', playerId: t.ids[1]! });

  assert.equal(t.state.seats[1], null);
  assert.equal(t.state.members[1]!.cashOut, 1000);
  assert.ok(t.feedText().includes('The host removed P1 from their seat'));
  assertChipsConserved(t.state);

  t.cmd(0, { type: 'kick', playerId: t.ids[1]! });
  assert.equal(t.state.members.length, 2, 'someone with a line in the ledger stays a member');
});

test('removing someone who never played frees their name and their place at the table', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.ids.push(addMember(t.state, 'Ann', t.ctx()).id);
  t.cmd(2, { type: 'requestSeat', seat: 5, buyIn: 600 });

  t.cmd(0, { type: 'kick', playerId: t.ids[2]! });

  assert.deepEqual(
    t.state.members.map((member) => member.name),
    ['P0', 'P1'],
  );
  assert.equal(t.state.requests.length, 0);
  assert.throws(() => t.view(2), /not part of this table/);
  assert.equal(addMember(t.state, 'Ann', t.ctx()).name, 'Ann');

  t.cmd(0, { type: 'standUp' });
  t.cmd(0, { type: 'kick', playerId: t.ids[0]! });
  assert.equal(t.state.hostId, t.ids[0], 'the host is never removed from their own table');
  assert.equal(t.state.members.some((member) => member.id === t.ids[0]), true);
});

test('new blinds apply from the next hand', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.deal({ button: 0 });

  t.cmd(0, { type: 'updateConfig', config: { smallBlind: 25, bigBlind: 50 } });

  assert.equal(t.state.hand!.bigBlind, 20);
  assert.ok(t.feedText().includes('Blinds are 25/50 from the next hand'));

  t.fold(0);
  t.finishHand();
  t.deal();
  assert.equal(t.state.hand!.bigBlind, 50);
  assert.equal(t.state.hand!.currentBet, 50);
});

test('a settings change keeps everything it does not mention and is validated as a whole', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  const before = { ...t.state.config };

  t.cmd(0, { type: 'updateConfig', config: { sevenDeuceBounty: 40 } });
  assert.deepEqual(t.state.config, { ...before, sevenDeuceBounty: 40 });

  assert.throws(() => t.cmd(0, { type: 'updateConfig', config: { bigBlind: 5 } }), /big blind/);
  assert.deepEqual(t.state.config, { ...before, sevenDeuceBounty: 40 });
});

test('turning straddles off clears everyone who had asked to straddle', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.cmd(2, { type: 'setStraddle', on: true });

  t.cmd(0, { type: 'updateConfig', config: { allowStraddle: false } });

  assert.equal(t.state.seats[2]!.straddle, false);
});

test('the host can hand the table to someone else, and stays on as a co-host', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });

  t.cmd(0, { type: 'transferHost', playerId: t.ids[1]! });

  assert.equal(t.view(1).you.role, 'host');
  assert.equal(t.view(0).you.role, 'cohost');
  assert.deepEqual(t.state.cohostIds, [t.ids[0]], 'the new host is no longer listed as a co-host');
  assert.equal(t.feedText().at(-1), 'P1 is now the host, and P0 a co-host');

  assert.throws(() => t.cmd(0, { type: 'transferHost', playerId: t.ids[2]! }), { message: 'Only the host can do that' });
  t.cmd(0, { type: 'start' });

  t.cmd(1, { type: 'setCohost', playerId: t.ids[0]!, on: false });
  assert.equal(t.view(0).you.role, 'member');
  assert.equal(t.feedText().at(-1), 'P0 is no longer a co-host');

  const before = JSON.stringify(t.state);
  t.cmd(1, { type: 'transferHost', playerId: t.ids[1]! });
  assert.equal(JSON.stringify(t.state), before, 'handing the table to yourself changes nothing');
});

test('the host names co-hosts and takes it back, and the chat says so each time it changes', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id);

  t.cmd(0, { type: 'setCohost', playerId: t.ids[2]!, on: true });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[2]!, on: true });
  assert.deepEqual(t.state.cohostIds, [t.ids[2]], 'a co-host need not be seated, and is listed once');
  assert.equal(t.feedText().filter((line) => line === 'Watcher is now a co-host').length, 1);

  t.cmd(0, { type: 'setCohost', playerId: t.ids[2]!, on: false });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: false });
  assert.deepEqual(t.state.cohostIds, []);
  assert.equal(t.feedText().at(-1), 'Watcher is no longer a co-host');

  assert.throws(() => t.cmd(0, { type: 'setCohost', playerId: t.ids[0]!, on: true }), { message: 'The host has every power a co-host has' });
  assert.throws(() => t.cmd(0, { type: 'setCohost', playerId: 'NOBODY12', on: true }), { message: 'That player is no longer at the table' });
  assert.throws(() => t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: 'yes' as unknown as boolean }), { message: 'Co-host must be on or off' });
});

test('a co-host runs the game but cannot remove the host, from their seat or from the table', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[2]!, on: true });

  assert.throws(() => t.cmd(1, { type: 'kick', playerId: t.ids[0]! }), { message: 'Only the host can remove the host' });
  t.cmd(0, { type: 'standUp' });
  assert.throws(() => t.cmd(1, { type: 'kick', playerId: t.ids[0]! }), { message: 'Only the host can remove the host' });
  assert.throws(() => t.cmd(1, { type: 'setCohost', playerId: t.ids[2]!, on: false }), { message: 'Only the host can do that' });

  // A co-host is the host's equal in everything else, over other co-hosts too
  t.cmd(1, { type: 'setStack', playerId: t.ids[2]!, stack: 700 });
  t.cmd(1, { type: 'kick', playerId: t.ids[2]! });
  assert.equal(t.state.seats[2], null);
  assert.deepEqual(t.state.cohostIds, [t.ids[1], t.ids[2]], 'losing a seat does not end being a co-host');
  assert.deepEqual(t.feedText().slice(-3), ["Co-host P1 set P2's stack to 700", 'Co-host P1 removed P2 from their seat', 'P2 leaves the table with 700']);
});

test('only the host may take a co-host off the table altogether, which ends their role', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });
  t.ids.push(addMember(t.state, 'Ann', t.ctx()).id);
  t.cmd(0, { type: 'setCohost', playerId: t.ids[2]!, on: true });

  assert.throws(() => t.cmd(1, { type: 'kick', playerId: t.ids[2]! }), { message: 'Only the host can take a co-host off the table' });
  assert.throws(() => t.cmd(2, { type: 'kick', playerId: t.ids[2]! }), { message: 'Only the host can take a co-host off the table' });

  t.cmd(0, { type: 'kick', playerId: t.ids[2]! });
  assert.deepEqual(t.state.cohostIds, [t.ids[1]]);
  assert.equal(t.feedText().at(-1), 'The host removed Ann from the table');
});

test('the chat names a co-host as one, so no player\'s name can pass for the host', () => {
  const t = new TestTable({ stacks: [1000, 1000], names: ['Quigs', 'The host'] });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });

  t.cmd(1, { type: 'setStack', playerId: t.ids[0]!, stack: 900 });

  assert.equal(t.feedText().at(-1), "Co-host The host set Quigs's stack to 900");
});

test('a co-host removed from their seat mid-hand plays out as one who stood up, and keeps the role', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.cmd(0, { type: 'setCohost', playerId: t.ids[2]!, on: true });
  t.deal({ button: 0 });

  t.cmd(0, { type: 'kick', playerId: t.ids[2]! });
  assert.equal(t.state.seats[2]!.leaving, true);

  t.cmd(2, { type: 'pause' });
  while (t.toAct !== null) {
    t.fold(t.toAct);
  }
  t.finishHand();

  assert.equal(t.state.seats[2], null);
  assert.equal(t.state.running, false);
  assert.equal(t.view(2).you.role, 'cohost');
  assertChipsConserved(t.state);
});

test('a co-host\'s own seat and chips need nobody\'s approval, like the host\'s', () => {
  const t = new TestTable({ stacks: [1000, 300] });
  t.ids.push(addMember(t.state, 'Ann', t.ctx()).id);
  t.cmd(0, { type: 'setCohost', playerId: t.ids[2]!, on: true });

  t.cmd(2, { type: 'requestSeat', seat: 5, buyIn: 500 });
  assert.equal(t.state.seats[5]!.stack, 500);

  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });
  t.deal({ button: 0 });
  t.cmd(1, { type: 'requestRebuy', amount: 200 });
  assert.equal(t.state.seats[1]!.pendingAdd, 200, 'chips asked for mid-hand still wait for its end');
  assert.deepEqual(t.state.requests, []);
});

test('a co-host is told they have the host\'s powers and sees every request; a plain member sees their own, and everyone sees who the co-hosts are', () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.ids.push(addMember(t.state, 'Ann', t.ctx()).id);
  t.ids.push(addMember(t.state, 'Bob', t.ctx()).id);
  t.cmd(0, { type: 'setCohost', playerId: t.ids[1]!, on: true });
  t.cmd(2, { type: 'requestSeat', seat: 5, buyIn: 500 });
  t.cmd(3, { type: 'requestSeat', seat: 6, buyIn: 500 });

  const asked = [t.ids[2], t.ids[3]];
  assert.deepEqual(t.view(0).requests.map((r) => r.playerId), asked);
  assert.deepEqual(t.view(1).requests.map((r) => r.playerId), asked);
  assert.deepEqual(t.view(2).requests.map((r) => r.playerId), [t.ids[2]]);

  assert.deepEqual([0, 1, 2].map((player) => t.view(player).you.role), ['host', 'cohost', 'member']);
  for (const player of [0, 1, 2, 3]) {
    assert.deepEqual(t.view(player).cohostIds, [t.ids[1]]);
  }

  assertViewsKeepSecrets(t.state, t.now);
});

test('chat lands in the feed, which keeps only the latest entries', () => {
  const t = new TestTable({ stacks: [1000, 1000] });

  t.cmd(1, { type: 'chat', text: '  nice   hand  ' });
  assert.deepEqual(
    { kind: t.state.feed.at(-1)!.kind, from: t.state.feed.at(-1)!.from, text: t.state.feed.at(-1)!.text },
    { kind: 'chat', from: 'P1', text: 'nice hand' },
  );

  t.cmd(1, { type: 'chat', text: 'a\u0000b \u202Eevil\u2066 \u{1F468}\u200D\u{1F469}\u200D\u{1F467}' });
  assert.equal(t.state.feed.at(-1)!.text, 'ab evil \u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 'control and text-reversing characters are dropped, joined emoji are kept');
  assert.throws(() => t.cmd(1, { type: 'chat', text: '\u202E\u0007' }), /message/);

  t.cmd(1, { type: 'chat', text: `Z${'\u0301'.repeat(40)}algo and cafe\u0301` });
  assert.equal(t.state.feed.at(-1)!.text, 'Z\u0301\u0301\u0301algo and cafe\u0301', 'a tower of accents is cut down to what a language would write');

  // Invisible joiners between the accents would otherwise pass the same tower off as many short ones
  t.cmd(1, { type: 'chat', text: `a${'\u0301\u0301\u0301\u200D'.repeat(30)}h` });
  assert.equal(t.state.feed.at(-1)!.text, 'a\u0301\u0301\u0301h');

  // An emoji built from several keeps the joiner that holds it together
  t.cmd(1, { type: 'chat', text: 'gg \u{1F3F3}\uFE0F\u200D\u{1F308}' });
  assert.equal(t.state.feed.at(-1)!.text, 'gg \u{1F3F3}\uFE0F\u200D\u{1F308}');

  assert.throws(() => t.cmd(1, { type: 'chat', text: '   ' }), /message/);
  assert.throws(() => t.cmd(1, { type: 'chat', text: 'x'.repeat(201) }), /message/);

  for (let i = 0; i < 100; i++) {
    t.cmd(1, { type: 'chat', text: `message ${i}` });
  }
  assert.equal(t.state.feed.length, 60);
  assert.equal(t.state.feed.at(-1)!.text, 'message 99');
});

test('sitting out skips the next deal, and sitting back in rejoins', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });

  t.cmd(2, { type: 'sitOut' });
  t.deal({ button: 0 });
  assert.deepEqual(t.state.hand!.players.map((p) => p.seat), [0, 1]);

  t.fold(0);
  t.finishHand();
  t.cmd(2, { type: 'sitIn' });
  t.deal();
  assert.deepEqual(t.state.hand!.players.map((p) => p.seat), [0, 1, 2]);
});

test('the ledger always nets to zero, mid-hand included', () => {
  const t = new TestTable({ stacks: [1000, 700, 400] });
  const net = () => ledgerOf(t.state).reduce((sum, row) => sum + row.net, 0);

  assert.equal(net(), 0);

  t.deal({ button: 0 });
  t.raise(0, 100);
  t.call(1);
  assert.equal(net(), 0);
  assert.deepEqual(ledgerOf(t.state).map((row) => row.stack), [1000, 700, 400], 'chips in the pot still count as their owner\'s');

  t.fold(2);
  t.raise(1, 200);
  t.fold(0);
  assert.equal(net(), 0);
  assert.deepEqual(ledgerOf(t.state).map((row) => row.net), [-100, 120, -20]);

  t.finishHand();
  t.cmd(2, { type: 'standUp' });
  assert.equal(net(), 0);
  assert.deepEqual(ledgerOf(t.state).find((row) => row.name === 'P2'), {
    playerId: t.ids[2]!,
    name: 'P2',
    buyIn: 400,
    cashOut: 380,
    stack: 0,
    net: -20,
  });
});

test('a view never carries the deck, anyone\'s token, or cards that are face down for that viewer', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh' } });

  const view = t.view(1);
  const json = JSON.stringify(view);

  assert.deepEqual(view.seats[1]!.cards, ['Ks', 'Kh']);
  assert.deepEqual(view.seats[0]!.cards, [null, null]);
  for (const hidden of ['As', 'Ah', 'Qs', 'Qh', '"deck"', '"token"', ...t.state.members.map((m) => m.token)]) {
    assert.ok(!json.includes(hidden), `the view leaks ${hidden}`);
  }

  const spectator = addMember(t.state, 'Watcher', t.ctx());
  const watching = viewFor(t.state, spectator.id, t.now);
  assert.deepEqual(watching.seats.map((seat) => seat?.cards), [[null, null], [null, null], [null, null], ...Array(7).fill(undefined)]);
  assert.equal(watching.you.seat, null);
  assert.equal(watching.hand!.options, null);
});

test('only the player on the clock is told their options', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.deal({ button: 0 });

  assert.notEqual(t.view(0).hand!.options, null);
  assert.equal(t.view(1).hand!.options, null);
  assert.equal(t.view(2).hand!.options, null);
});

test('a table saved by the version before this one is brought up to date, and an unknown version is refused', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], config: { sevenDeuceBounty: 50 } });
  t.deal({ button: 0, holes: { 0: '7h 2c' } });

  const saved = JSON.parse(JSON.stringify(t.state)) as { schema: number; hand: { bounty?: number } };
  saved.schema = 2;
  delete saved.hand.bounty;

  assert.deepEqual(restoreState(JSON.stringify(saved)), t.state, 'the hand on the table keeps the bounty it would have paid');

  saved.schema = 1;
  assert.throws(() => restoreState(JSON.stringify(saved)), /schema 1/);

  saved.schema = STATE_SCHEMA + 1;
  assert.throws(() => restoreState(JSON.stringify(saved)), new RegExp(`schema ${STATE_SCHEMA + 1}`));
});
