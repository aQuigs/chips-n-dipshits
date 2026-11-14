/*
 * Builds the saved tables in tests/fixtures/tables/: tables stopped at the moments a new version of the
 * game is most likely to trip over, as the code saved them at schema 3, before anything was added to
 * what a table holds. tests/savedTables.test.ts reads each one back and plays it on, which is what
 * shows that a game in progress survives every change made since.
 *
 * The files are what the code just before this script's commit wrote when given this script, byte for
 * byte. The cards and ids are seeded, so at its own commit this script builds the same tables again
 * (in another order of the settings, which is all that commit changed in a saved table) and checks
 * them against the files. Run at any later commit it would build tables holding whatever has been
 * added since, which proves nothing about old ones, so it never changes a file that is already there.
 * To make them again, check out the commit before this script's and run this script there.
 *
 * A later change of shape adds its own table beside these, saved by the code just before the change.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { addMember, STATE_SCHEMA, TIMING } from '../src/engine/index.ts';
import type { Hand, TableConfig, TableState } from '../src/engine/index.ts';
import { TestTable } from '../tests/helpers.ts';

const OUT = fileURLToPath(new URL('../tests/fixtures/tables/', import.meta.url));
const SCHEMA = 3;

const CONFIG: Partial<TableConfig> = { minBuyIn: 400, maxBuyIn: 2000, actionSeconds: 30, allowRunItTwice: true, sevenDeuceBounty: 25 };

function table(stacks: number[], seed: number): TestTable {
  return new TestTable({ stacks, config: CONFIG, seed });
}

/** Someone who has joined the table and is watching, as the next player in its list. */
function watcher(t: TestTable): number {
  t.ids.push(addMember(t.state, `P${t.ids.length}`, t.ctx()).id);

  return t.ids.length - 1;
}

function waitingRequests(): TestTable {
  const t = table([1000, 800], 31);
  const newcomer = watcher(t);
  watcher(t);

  t.cmd(1, { type: 'requestRebuy', amount: 500 });
  t.cmd(newcomer, { type: 'requestSeat', seat: 4, buyIn: 600 });
  t.cmd(1, { type: 'sitOut' });

  return t;
}

/** Before the flop, the straddler to act, the big blind all in for less than the raise, and chips of theirs waiting for the hand to end. */
function bettingWithStraddleAndSidePot(): TestTable {
  const t = table([2000, 2000, 400, 2000, 2000], 32);
  watcher(t);

  t.cmd(3, { type: 'setStraddle', on: true });
  t.cmd(0, { type: 'start' });
  t.deal({ button: 0, holes: { 0: 'Ad Qd', 2: 'Jc Jh', 3: '9s 8s', 4: 'Ks Kc' }, board: 'Jd 7c 2s 5h Tc' });

  t.raise(4, 500);
  t.call(0);
  t.fold(1);
  t.call(2);
  t.cmd(2, { type: 'requestRebuy', amount: 300 });
  t.cmd(0, { type: 'approve', playerId: t.ids[2]! });

  return t;
}

/** Two players all in on the flop, their cards face up, one of them having agreed to run it twice. */
function runItTwiceVote(): TestTable {
  const t = table([1000, 1000, 1000], 33);

  t.cmd(0, { type: 'start' });
  t.deal({ button: 0, holes: { 0: 'As Ah', 1: '9c 8c', 2: 'Kd Kh' }, board: 'Ks 7s 2d 3c 4h', secondBoard: 'Ac Qd' });

  t.raise(0, 60);
  t.call(1);
  t.call(2);
  t.check(1);
  t.raise(2, 100);
  t.raise(0, 940);
  t.fold(1);
  t.call(2);
  t.cmd(0, { type: 'ritVote', agree: true });

  return t;
}

/** The same hand once both agreed: the first board is out and the second has its turn card. */
function runoutOnTwoBoards(): TestTable {
  const t = runItTwiceVote();

  t.cmd(2, { type: 'ritVote', agree: true });
  for (let step = 0; step < 3; step++) {
    t.wait(TIMING.runoutStepMs);
  }

  return t;
}

/** A hand just won with seven-deuce, the bounty paid, and one of the losers on their way out of their seat. */
function doneWithBountyPaid(): TestTable {
  const t = table([1000, 1000, 1000, 1000], 35);

  t.cmd(0, { type: 'start' });
  t.deal({ button: 0, holes: { 3: '7h 2c' } });

  t.raise(3, 60);
  t.fold(0);
  t.fold(1);
  t.cmd(1, { type: 'standUp' });
  t.fold(2);

  return t;
}

const TABLES: Record<string, () => TestTable> = {
  'waiting-requests': waitingRequests,
  'betting-straddle-side-pot': bettingWithStraddleAndSidePot,
  'run-it-twice-vote': runItTwiceVote,
  'runout-two-boards': runoutOnTwoBoards,
  'done-bounty-paid': doneWithBountyPaid,
};

/** The table as the service would have saved it at schema 3. */
function saved(t: TestTable, version: number): TableState {
  const state = JSON.parse(JSON.stringify(t.state)) as TableState;

  state.version = version;

  // The repository is scanned for secrets, and that scan should stay able to catch a real one in a saved table
  for (const member of state.members) {
    member.token = `not-a-real-token-${member.name}`;
  }

  // Hands began to keep their events in the commit that added these tables, and a table from before it has none
  if (state.hand) {
    delete (state.hand as Partial<Hand>).events;
  }

  return state;
}

function write(name: string, state: object): void {
  const path = `${OUT}${name}.json`;

  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(state)}\n`);
    console.log(`wrote ${name}.json`);
    return;
  }

  assert.deepEqual(state, JSON.parse(readFileSync(path, 'utf8')), `${name}.json is already there and this code would save the table differently. Saved tables are written once; see the top of this script.`);
}

assert.equal(STATE_SCHEMA, SCHEMA, `These are tables from schema ${SCHEMA}, and this code saves schema ${STATE_SCHEMA}. See the top of this script.`);
mkdirSync(OUT, { recursive: true });

Object.entries(TABLES).forEach(([name, build], index) => {
  const state = saved(build(), 20 + index);

  write(`schema${SCHEMA}-${name}`, state);

  // Schema 2 was the same table without the bounty a hand is dealt under
  if (name === 'betting-straddle-side-pot') {
    const { bounty: _added, ...hand } = state.hand!;

    write(`schema2-${name}`, { ...state, schema: 2, hand });
  }
});
