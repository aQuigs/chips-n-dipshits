import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HANDLERS } from '../src/engine/commands/index.ts';
import type { CommandOf, CommandType } from '../src/engine/commands/handler.ts';
import { addMember, reaches, roleOf } from '../src/engine/index.ts';
import type { Command, HostLevel, Role } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';

/** A table with the host and one other player seated, and a third member who is only watching. */
function tableWithWatcher(): { t: TestTable; watcher: number } {
  const t = new TestTable({ stacks: [1000, 1000] });
  t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id);

  return { t, watcher: 2 };
}

const send = (t: TestTable, player: number, command: unknown) => () => t.cmd(player, command as Command);

test('what is not a command is refused as unknown, and changes nothing', () => {
  const { t } = tableWithWatcher();
  const before = JSON.stringify(t.state);

  const nonsense: unknown[] = [
    null,
    undefined,
    'fold',
    7,
    {},
    { type: 'dance' },
    { type: 7 },
    { type: null },
    { type: ['fold'] },
    { type: { toString: () => 'fold' } },
    { type: 'constructor' },
    { type: 'toString' },
    { type: '__proto__' },
    { type: 'hasOwnProperty' },
  ];

  for (const command of nonsense) {
    assert.throws(send(t, 0, command), { name: 'GameError', message: 'Unknown command' }, JSON.stringify(command));
  }

  assert.equal(JSON.stringify(t.state), before);
});

test('someone who is not at the table is told so before anything else about their command', () => {
  const { t } = tableWithWatcher();
  t.ids.push('NOBODY12');

  assert.throws(send(t, 3, { type: 'start' }), { name: 'GameError', message: 'You are not part of this table' });
  assert.throws(send(t, 3, { type: 'dance' }), { message: 'You are not part of this table' });
  assert.throws(send(t, 3, null), { message: 'Unknown command' });
});

/** Who sends each host command in the test below, by their place in the table's player list. */
const HOST = 0;
const TARGET = 1;
const COHOST = 2;
const MEMBER = 3;
const ASKER = 4;

/** The host and two other players seated, one of them a co-host; a member who only watches; and one who has asked for a seat. */
function tableWithCohost(): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000] });
  t.cmd(HOST, { type: 'setCohost', playerId: t.ids[COHOST]!, on: true });
  t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id);
  t.ids.push(addMember(t.state, 'Asker', t.ctx()).id);
  t.cmd(ASKER, { type: 'requestSeat', seat: 6, buyIn: 500 });

  return t;
}

/**
 * Who may send each command, stated again here on purpose: a command added to the table fails this
 * test until it is listed, so whoever adds one decides who may send it and shows that it holds. A
 * host command comes with a sample that the table carries out when someone allowed sends it.
 */
const DECLARED: { [T in CommandType]: { by: 'member' | 'seat' } | { by: HostLevel; sample: (ids: string[]) => CommandOf<T>; setup?: (t: TestTable) => void } } = {
  requestSeat: { by: 'member' },
  requestRebuy: { by: 'seat' },
  cancelRequest: { by: 'member' },
  standUp: { by: 'seat' },
  sitOut: { by: 'seat' },
  sitIn: { by: 'seat' },
  setStraddle: { by: 'seat' },
  fold: { by: 'member' },
  check: { by: 'member' },
  call: { by: 'member' },
  raise: { by: 'member' },
  ritVote: { by: 'member' },
  showCards: { by: 'member' },
  chat: { by: 'member' },

  start: { by: 'host or cohost', sample: () => ({ type: 'start' }) },
  pause: { by: 'host or cohost', sample: () => ({ type: 'pause' }), setup: (t) => t.cmd(HOST, { type: 'start' }) },
  approve: { by: 'host or cohost', sample: (ids) => ({ type: 'approve', playerId: ids[ASKER]! }) },
  deny: { by: 'host or cohost', sample: (ids) => ({ type: 'deny', playerId: ids[ASKER]! }) },
  kick: { by: 'host or cohost', sample: (ids) => ({ type: 'kick', playerId: ids[TARGET]! }) },
  setStack: { by: 'host or cohost', sample: (ids) => ({ type: 'setStack', playerId: ids[TARGET]!, stack: 5 }) },
  moveSeat: { by: 'host or cohost', sample: (ids) => ({ type: 'moveSeat', playerId: ids[TARGET]!, seat: 7 }) },
  shuffleSeats: { by: 'host or cohost', sample: () => ({ type: 'shuffleSeats' }) },
  transferChips: { by: 'host or cohost', sample: (ids) => ({ type: 'transferChips', from: ids[TARGET]!, to: ids[HOST]!, amount: 5 }) },
  setBombPot: { by: 'host or cohost', sample: () => ({ type: 'setBombPot', on: true }) },
  setLastHands: { by: 'host or cohost', sample: () => ({ type: 'setLastHands', hands: 3 }) },
  endNight: { by: 'host or cohost', sample: () => ({ type: 'endNight' }) },
  playOn: { by: 'host or cohost', sample: () => ({ type: 'playOn' }), setup: (t) => t.cmd(HOST, { type: 'endNight' }) },
  updateConfig: { by: 'host or cohost', sample: () => ({ type: 'updateConfig', config: { bigBlind: 40 } }) },
  transferHost: { by: 'host alone', sample: (ids) => ({ type: 'transferHost', playerId: ids[TARGET]! }) },
  setCohost: { by: 'host alone', sample: (ids) => ({ type: 'setCohost', playerId: ids[TARGET]!, on: true }) },
};

test('every command says who may send it, as this test expects', () => {
  assert.deepEqual(Object.keys(DECLARED).sort(), Object.keys(HANDLERS).sort(), 'a command is missing from DECLARED, or DECLARED names one the table does not take');

  for (const [type, declared] of Object.entries(DECLARED)) {
    assert.equal(HANDLERS[type as CommandType].by, declared.by, `${type} is sent by a different level than this test was told`);
  }
});

const ROLES: { sender: number; role: Role }[] = [
  { sender: HOST, role: 'host' },
  { sender: COHOST, role: 'cohost' },
  { sender: MEMBER, role: 'member' },
];

const REFUSALS: Record<HostLevel, string> = {
  'host or cohost': 'Only the host or a co-host can do that',
  'host alone': 'Only the host can do that',
};

for (const [type, declared] of Object.entries(DECLARED)) {
  if (!('sample' in declared)) {
    continue;
  }

  test(`${type} is for ${declared.by === 'host alone' ? 'the host alone' : 'the host or a co-host'}, and anyone else is refused before it is looked at`, () => {
    for (const { sender, role } of ROLES) {
      const t = tableWithCohost();
      declared.setup?.(t);
      assert.equal(roleOf(t.state, t.ids[sender]!), role);

      const command = declared.sample(t.ids) as Command;

      if (reaches(role, declared.by)) {
        t.cmd(sender, command);
        continue;
      }

      const before = JSON.stringify(t.state);
      assert.throws(send(t, sender, command), { name: 'GameError', message: REFUSALS[declared.by] }, `${role} sending ${type}`);
      assert.equal(JSON.stringify(t.state), before);
    }
  });
}

test('being refused for who you are comes before anything about the command itself is looked at', () => {
  const t = tableWithCohost();

  assert.throws(send(t, MEMBER, { type: 'setStack', playerId: 'NOBODY12', stack: -1 }), { message: 'Only the host or a co-host can do that' });
  assert.throws(send(t, COHOST, { type: 'setCohost', playerId: 'NOBODY12', on: 'yes' }), { message: 'Only the host can do that' });
});

test('what a player does about their seat needs a seat', () => {
  const { t, watcher } = tableWithWatcher();

  // Standing up comes last, since it gives up the seat the others need
  const seatOnly: Command[] = [{ type: 'requestRebuy', amount: 100 }, { type: 'sitOut' }, { type: 'sitIn' }, { type: 'setStraddle', on: true }, { type: 'standUp' }];

  for (const command of seatOnly) {
    assert.throws(send(t, watcher, command), { name: 'GameError', message: 'You need a seat for that' }, command.type);
  }

  // The seat is asked about first, then what was sent
  assert.throws(send(t, watcher, { type: 'setStraddle', on: 'yes' }), { message: 'You need a seat for that' });
  assert.throws(send(t, 1, { type: 'setStraddle', on: 'yes' }), { message: 'Straddle must be on or off' });

  for (const command of seatOnly) {
    t.cmd(1, command);
  }

  assert.equal(t.state.seats[1], null);
});

test('anyone at the table may chat, ask for a seat or take a request back, and the hand answers those not in it in its own words', () => {
  const { t, watcher } = tableWithWatcher();

  t.cmd(watcher, { type: 'chat', text: 'hello' });
  t.cmd(watcher, { type: 'requestSeat', seat: 5, buyIn: 500 });
  t.cmd(watcher, { type: 'cancelRequest' });
  assert.deepEqual(t.state.requests, []);

  t.deal({ button: 0 });

  assert.throws(send(t, watcher, { type: 'fold' }), { name: 'GameError', message: "It's not your turn" });
  assert.throws(send(t, watcher, { type: 'check' }), { message: "It's not your turn" });
  assert.throws(send(t, watcher, { type: 'call' }), { message: "It's not your turn" });
  assert.throws(send(t, watcher, { type: 'raise', to: 100 }), { message: "It's not your turn" });
  assert.throws(send(t, watcher, { type: 'ritVote', agree: true }), { message: 'There is no run-it-twice vote for you right now' });
  assert.throws(send(t, watcher, { type: 'showCards' }), { message: 'You can show your cards once the hand is over' });

  // What was sent is read before the hand is asked, so a malformed move says what is wrong with it
  assert.throws(send(t, watcher, { type: 'fold', turn: 'now' }), { message: 'The turn must be a whole number' });
  assert.throws(send(t, watcher, { type: 'ritVote', agree: 'yes' }), { message: 'Your vote must be on or off' });
  assert.throws(send(t, t.toAct!, { type: 'raise', to: '100' }), { message: /A raise here must be between/ });
});
