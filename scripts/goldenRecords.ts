/*
 * Builds the hand records in tests/fixtures/records/: finished hands as the code of each schema wrote
 * them to the Hands tab, which is where they stay for good. tests/goldenRecords.test.ts reads each one
 * the way the history does and plays it back, which is what shows that a hand recorded by any version
 * still replays to its recorded result, or is told as text.
 *
 * A file is what the code of its time recorded for one of the hands below, and is written once: this
 * script only writes a record whose file is not there yet, under the schema the code has, and never
 * touches one that is. The cards are fixed, so run again at the commit that wrote a set it records the
 * same hands.
 *
 * The files of schemas 2 to 5 were written by the last commit of each, playing these hands as far as
 * the game then had them: schema 2 recorded no events, picking how many times to run it was a yes or a
 * no until schema 5, and a card could not be shown alone before schema 6. Those of schema 6 are from
 * before an event said how a picking ended, how a chop was answered for a player or that a move was
 * made for one who was away, so they also show that a hand recorded without those is still told, and
 * from before a bounty named its hand, which was seven-deuce.
 *
 * A change to what a record or an event holds adds its own set: run the script before making the
 * change, and commit the files it writes.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { STATE_SCHEMA } from '../src/engine/index.ts';
import type { HandRecord, TableConfig } from '../src/engine/index.ts';
import { handRecords, TestTable } from '../tests/helpers.ts';

const OUT = fileURLToPath(new URL('../tests/fixtures/records/', import.meta.url));

const HOLES = { 0: 'As Ah', 1: 'Kd Kh', 2: 'Qc Qs' };
const BOARD = '9s 7s 2h 3c 4d';
const SECOND = 'Ac Qd 8h 5c 6s';
const THIRD = 'Kc Jd Th 6c 5s';

function table(stacks: number[], config: Partial<TableConfig> = {}): TestTable {
  return new TestTable({ stacks, config });
}

/** Lets the hand on the table run to the end of its pause, and gives back what was recorded of it. */
function recordOf(t: TestTable): HandRecord {
  while (t.state.hand) {
    t.wait(t.state.hand.deadline! - t.now);
  }

  return handRecords(t.effects).at(-1)!;
}

/** Bet on every street and shown down, with a fold on the flop and a muck at the end. */
function showdown(): TestTable {
  const t = table([1000, 1000, 1000]);

  t.deal({ button: 0, holes: HOLES, board: BOARD });
  t.call(0);
  t.call(1);
  t.check(2);
  t.check(1);
  t.raise(2, 40);
  t.call(0);
  t.fold(1);
  t.check(2);
  t.check(0);
  t.check(2);
  t.raise(0, 100);
  t.call(2);

  return t;
}

/** Everyone posts an ante, and the hand is won before the flop by a raise nobody calls. */
function anteFolded(): TestTable {
  const t = table([1000, 1000, 1000], { ante: 5 });

  t.deal({ button: 0 });
  t.raise(0, 60);
  t.fold(1);
  t.fold(2);

  return t;
}

/** All in before the flop three ways with a side pot, run as many times as the table allows. */
function allIn(runs: 2 | 3): TestTable {
  const t = table([300, 1000, 1000], { maxRuns: runs });

  t.deal({ button: 0, holes: HOLES, board: BOARD, secondBoard: SECOND, thirdBoard: runs > 2 ? THIRD : undefined });
  t.raise(0, 300);
  t.raise(1, 1000);
  t.call(2);

  for (const voter of [0, 1, 2]) {
    t.cmd(voter, { type: 'ritVote', runs });
  }

  return t;
}

/** A bomb pot on two boards, checked down. */
function bombPotOnTwoBoards(): TestTable {
  const t = table([1000, 1000, 1000], { bombPotBoards: 'two', bombPotAmount: 50 });

  t.cmd(0, { type: 'setBombPot', on: true });
  t.deal({ button: 0, holes: HOLES, board: BOARD, secondBoard: SECOND });

  for (let street = 0; street < 3; street++) {
    t.check(1);
    t.check(2);
    t.check(0);
  }

  return t;
}

/** Folded to the blinds, who chop. */
function chopped(): TestTable {
  const t = table([1000, 1000, 1000], { allowChop: true });

  t.deal({ button: 0 });
  t.fold(0);
  t.cmd(1, { type: 'offerChop' });
  t.cmd(2, { type: 'answerChop', agree: true });

  return t;
}

/** Won before the flop with seven-deuce for the bounty, then a hand shown a card at a time and the rabbit hunted. */
function shownAndHunted(): TestTable {
  const t = table([1000, 1000, 1000], { bounties: [['72', 50]], rabbitHunting: true });

  t.deal({ button: 0, holes: { 0: '7h 2c', 1: 'Kd Kh', 2: 'Qc Qs' }, board: BOARD });
  t.raise(0, 60);
  t.fold(1);
  t.fold(2);
  t.show(1, [1]);
  t.show(1, [0]);
  t.cmd(2, { type: 'huntRabbit', hand: t.state.hand!.number });

  return t;
}

const HANDS: Record<string, () => TestTable> = {
  showdown,
  'ante-folded': anteFolded,
  'all-in-run-twice': () => allIn(2),
  'all-in-run-three-times': () => allIn(3),
  'bomb-pot-two-boards': bombPotOnTwoBoards,
  chopped,
  'shown-and-hunted': shownAndHunted,
};

mkdirSync(OUT, { recursive: true });

for (const [name, play] of Object.entries(HANDS)) {
  const file = `${OUT}schema${STATE_SCHEMA}-${name}.json`;

  if (existsSync(file)) {
    console.log(`kept     ${file}`);
    continue;
  }

  writeFileSync(file, `${JSON.stringify(recordOf(play()))}\n`);
  console.log(`written  ${file}`);
}
