/*
 * Builds the saved tables in tests/fixtures/tables/: tables stopped at the moments a new version of the
 * game is most likely to trip over, as older code saved them. tests/savedTables.test.ts reads each one
 * back and plays it on, which is what shows that a game in progress survives every change made since.
 *
 * A file is what the code of its time wrote when given this script, byte for byte, and is written once:
 * run at any later commit the script would build a table holding whatever has been added since, which
 * proves nothing about old ones, so it only writes a table whose file is not there yet and never
 * touches one that is. The cards and ids are seeded, so run with `--check` at the commit that wrote a
 * set, it builds those tables again and holds them to their files.
 *
 * The first set is schema 3 as it began, before anything was added to what a table holds. To make it
 * again, check out the commit before this script's and run this script there.
 *
 * A change of shape adds its own tables beside these, saved by the code just before the change: add the
 * set and run the script before changing the shape, and commit the files it writes. The commands in a
 * set are written as the code of today takes them, so that the script still reads as one.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { addMember, STATE_SCHEMA, TIMING } from '../src/engine/index.ts';
import type { Hand, TableConfig, TableState } from '../src/engine/index.ts';
import { TestTable } from '../tests/helpers.ts';

const OUT = fileURLToPath(new URL('../tests/fixtures/tables/', import.meta.url));

const CONFIG: Partial<TableConfig> = { minBuyIn: 400, maxBuyIn: 2000, actionSeconds: 30, allowRunItTwice: true, sevenDeuceBounty: 25 };

function table(stacks: number[], seed: number, config: Partial<TableConfig> = {}): TestTable {
  return new TestTable({ stacks, config: { ...CONFIG, ...config }, seed });
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

  t.cmd(3, { type: 'setStraddle', kind: 'straddle', on: true });
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

/**
 * Before the flop of a hand with an ante, a player back from missing both blinds who posted them, and a
 * straddle under the gun whose player has a raise to answer. Two more players have asked to straddle
 * when it is their turn to, one of them on the big blind.
 */
function bettingWithStraddleAndMissedBlinds(): TestTable {
  const t = table([2000, 2000, 2000, 2000, 2000, 2000], 36, { ante: 5 });
  watcher(t);

  // The hands before the one saved are dealt here, not by the table's clock, which is started once they are done
  t.deal({ button: 0 });
  t.foldOut();
  t.cmd(4, { type: 'sitOut' });

  // The big blind passes seat 4 in the second of these, and the button in the third
  for (let hand = 0; hand < 3; hand++) {
    t.deal();
    t.foldOut();
  }

  t.cmd(4, { type: 'comeIn', post: true });
  for (const seat of [1, 2, 5]) {
    t.cmd(seat, { type: 'setStraddle', kind: 'straddle', on: true });
  }

  // The button on seat 5, the blinds on seats 0 and 1, and seat 2 under the gun
  t.deal({ holes: { 2: '9s 8s', 3: 'Ad Qd', 4: 'Ks Kc' }, board: 'Jd 7c 2s 5h Tc' });
  t.cmd(0, { type: 'start' });
  t.call(3);
  t.raise(4, 160);
  t.fold(5);
  t.fold(0);

  return t;
}

/** Tables as the code of one time saved them. */
interface TableSet {
  /** The schema that code saved. */
  schema: number;
  tables: Record<string, () => TestTable>;
  /** Saved before hands kept their events. */
  beforeEvents?: boolean;
}

const SETS: TableSet[] = [
  // Schema 3 as it began
  {
    schema: 3,
    beforeEvents: true,
    tables: {
      'waiting-requests': waitingRequests,
      'betting-straddle-side-pot': bettingWithStraddleAndSidePot,
      'run-it-twice-vote': runItTwiceVote,
      'runout-two-boards': runoutOnTwoBoards,
      'done-bounty-paid': doneWithBountyPaid,
    },
  },
  // Schema 3 as it ended, with everything added to a table while it lasted: the last code for which a hand had one straddle, kept as its seat
  {
    schema: 3,
    tables: {
      'with-straddle-and-missed-blinds': bettingWithStraddleAndMissedBlinds,
    },
  },
];

/** The table as the service would have saved it. */
function saved(t: TestTable, version: number, beforeEvents: boolean): TableState {
  const state = JSON.parse(JSON.stringify(t.state)) as TableState;

  state.version = version;

  // The repository is scanned for secrets, and that scan should stay able to catch a real one in a saved table
  for (const member of state.members) {
    member.token = `not-a-real-token-${member.name}`;
  }

  if (beforeEvents && state.hand) {
    delete (state.hand as Partial<Hand>).events;
  }

  return state;
}

const check = process.argv.includes('--check');

/** Writes a table that has no file yet. One that has is left alone, or with `--check` held to what this code builds. */
function write(name: string, schema: number, build: () => object): void {
  const path = `${OUT}${name}.json`;

  if (existsSync(path)) {
    if (check) {
      assert.deepEqual(build(), JSON.parse(readFileSync(path, 'utf8')), `${name}.json is already there and this code would save the table differently. Saved tables are written once; see the top of this script.`);
    }

    return;
  }

  assert.equal(STATE_SCHEMA, schema, `${name}.json is a table from schema ${schema}, and this code saves schema ${STATE_SCHEMA}. See the top of this script.`);
  writeFileSync(path, `${JSON.stringify(build())}\n`);
  console.log(`wrote ${name}.json`);
}

mkdirSync(OUT, { recursive: true });

let nth = 0;

for (const { schema, tables, beforeEvents = false } of SETS) {
  for (const [name, build] of Object.entries(tables)) {
    const version = 20 + nth++;
    const state = () => saved(build(), version, beforeEvents);

    write(`schema${schema}-${name}`, schema, state);

    // Schema 2 was the same table without the bounty a hand is dealt under
    if (name === 'betting-straddle-side-pot') {
      write(`schema2-${name}`, schema, () => {
        const built = state();
        const { bounty: _added, ...hand } = built.hand!;

        return { ...built, schema: 2, hand };
      });
    }
  }
}
