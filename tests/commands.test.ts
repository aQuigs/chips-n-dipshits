import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember } from '../src/engine/index.ts';
import type { Command } from '../src/engine/index.ts';
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

test('only the host may send what is the host\'s to decide', () => {
  const { t, watcher } = tableWithWatcher();
  const playerId = t.ids[1]!;

  const hostOnly: Command[] = [
    { type: 'start' },
    { type: 'pause' },
    { type: 'approve', playerId },
    { type: 'deny', playerId },
    { type: 'setStack', playerId, stack: 5 },
    { type: 'updateConfig', config: { bigBlind: 40 } },
    { type: 'kick', playerId },
    { type: 'transferHost', playerId },
  ];

  const before = JSON.stringify(t.state);

  for (const command of hostOnly) {
    for (const sender of [1, watcher]) {
      assert.throws(send(t, sender, command), { name: 'GameError', message: 'Only the host can do that' }, command.type);
    }
  }

  // Being refused comes before anything about the command itself is looked at
  assert.throws(send(t, 1, { type: 'setStack', playerId: 'NOBODY12', stack: -1 }), { message: 'Only the host can do that' });
  assert.equal(JSON.stringify(t.state), before);

  // From the host the same commands get as far as being carried out, or refused for what they ask
  assert.throws(send(t, 0, { type: 'approve', playerId }), { message: 'That request is gone' });
  for (const command of hostOnly.filter((c) => c.type !== 'approve')) {
    t.cmd(0, command);
  }

  assert.equal(t.state.hostId, playerId);
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
