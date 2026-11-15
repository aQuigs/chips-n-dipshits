import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMember, REACTION_GAP_MS, REACTION_LIFE_MS, reactionText, REACTIONS, REACTIONS_LIVE } from '../src/engine/index.ts';
import type { Command, TableState } from '../src/engine/index.ts';
import { seededRng, TestTable } from './helpers.ts';
import { assertInvariants } from './invariants.ts';
import { randomStep } from './randomPlay.ts';

const react = (t: TestTable, player: number, kind: string, to?: number): void => t.cmd(player, { type: 'react', kind, to: to === undefined ? undefined : t.ids[to] });

const POP = REACTIONS.find((kind) => !kind.thrown)!.id;
const THROW = REACTIONS.find((kind) => kind.thrown)!.id;

/** Six seated, hands not yet started. */
const sixSeated = () => new TestTable({ stacks: [1000, 1000, 1000, 1000, 1000, 1000], names: ['Dana', 'Lee', 'Sam', 'Kit', 'Max', 'Ola'] });

test('each reaction pops over its sender and each throw is aimed at another seated player, kept with the time it was made', () => {
  for (const kind of REACTIONS) {
    const t = sixSeated();

    react(t, 1, kind.id, kind.thrown ? 2 : undefined);

    assert.deepEqual(t.state.reactions, [kind.thrown ? { from: t.ids[1], kind: kind.id, at: t.now, to: t.ids[2] } : { from: t.ids[1], kind: kind.id, at: t.now }], kind.id);
  }
});

test('the words for a reaction name who made it, and who a throw was aimed at', () => {
  const t = sixSeated();

  react(t, 0, 'laugh');
  t.wait(REACTION_GAP_MS);
  react(t, 0, 'tomato', 3);

  assert.deepEqual(
    t.state.reactions.map((reaction) => reactionText(reaction, t.state.members)),
    ['Dana is laughing', 'Dana threw a tomato at Kit'],
  );
  assert.equal(reactionText({ from: 'GONE1234', kind: 'beer', at: 0, to: t.ids[1] }, t.state.members), 'Someone threw a beer at Lee');
});

test('a throw needs someone else seated to land on: not an empty seat, not the thrower, not someone only watching', () => {
  const t = sixSeated();
  const watcher = t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id) - 1;
  const refused = (to: unknown, message: string) => assert.throws(() => t.cmd(0, { type: 'react', kind: THROW, to } as Command), { name: 'GameError', message });

  refused(undefined, 'That player is not at the table');
  refused('NOBODY12', 'That player is not at the table');
  refused(t.ids[watcher], 'That player is not at the table');
  refused(7, 'That player is not at the table');
  refused(t.ids[0], 'Throw it at someone else');

  // One who stood up has given their seat up, so there is nobody there to throw at
  t.cmd(4, { type: 'standUp' });
  refused(t.ids[4], 'That player is not at the table');

  assert.throws(() => react(t, 0, POP, 1), { message: 'That is not something to throw' });
  assert.deepEqual(t.state.reactions, []);
});

test('a throw at a player who leaves after it was made stays its few seconds, and the next one at them is refused', () => {
  const t = sixSeated();

  react(t, 0, THROW, 4);
  t.cmd(4, { type: 'standUp' });

  assert.equal(t.view(1).reactions.length, 1, 'what was thrown is the page’s to land or not');
  assert.throws(() => react(t, 1, THROW, 4), { message: 'That player is not at the table' });
});

test('only a seated player reacts: a watcher, someone waiting for a seat and someone who is not a member are refused', () => {
  const t = sixSeated();
  const watcher = t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id) - 1;
  const asker = t.ids.push(addMember(t.state, 'Asker', t.ctx()).id) - 1;
  t.cmd(asker, { type: 'requestSeat', seat: 8, buyIn: 500 });

  assert.throws(() => react(t, watcher, POP), { message: 'You need a seat for that' });
  assert.throws(() => react(t, asker, POP), { message: 'You need a seat for that' });

  t.ids.push('NOBODY12');
  assert.throws(() => react(t, t.ids.length - 1, POP), { message: 'You are not part of this table' });
  assert.deepEqual(t.state.reactions, []);
});

test('a seated player reacts whatever the game is doing: sitting out, during a hand, between hands and after the night is over', () => {
  const t = sixSeated();
  const reacts = (kind: string, to?: number) => {
    t.wait(REACTION_GAP_MS);
    react(t, 5, kind, to);
    assert.deepEqual(t.state.reactions.at(-1), { from: t.ids[5], kind, at: t.now, ...(to === undefined ? {} : { to: t.ids[to] }) });
  };

  t.cmd(5, { type: 'sitOut' });
  reacts(POP);

  t.deal({ button: 0 });
  reacts(THROW, t.playerIn(t.toAct!));

  t.foldOut();
  reacts(POP);

  t.cmd(0, { type: 'endNight' });
  reacts(THROW, 0);
});

test('a kind there is not, or no kind at all, is refused and keeps nothing', () => {
  const t = sixSeated();

  for (const kind of ['dance', '', 'constructor', 7, null, undefined, { id: 'laugh' }]) {
    assert.throws(() => t.cmd(0, { type: 'react', kind } as Command), { name: 'GameError', message: 'Unknown reaction' }, String(kind));
  }

  assert.deepEqual(t.state.reactions, []);
});

test('a player reacts again only once the gap since their last has passed, by the table’s clock', () => {
  const t = sixSeated();

  react(t, 0, POP);
  t.wait(REACTION_GAP_MS - 1);
  assert.throws(() => react(t, 0, THROW, 1), { message: 'One at a time: give it a few seconds' });

  // Someone else is not held up by it
  react(t, 1, POP);

  t.wait(1);
  react(t, 0, THROW, 1);
  assert.deepEqual(t.state.reactions.map((reaction) => reaction.from), [t.ids[0], t.ids[1], t.ids[0]]);
});

test('the table takes so many at once and no more, and takes the next as soon as the oldest has gone', () => {
  const t = sixSeated();

  for (let player = 0; player < REACTIONS_LIVE; player++) {
    react(t, player, POP);
  }

  assert.throws(() => react(t, REACTIONS_LIVE, POP), { message: 'Plenty flying already: try again in a moment' });
  assert.equal(t.state.reactions.length, REACTIONS_LIVE);

  t.wait(REACTION_LIFE_MS - 1);
  assert.throws(() => react(t, REACTIONS_LIVE, POP), { message: 'Plenty flying already: try again in a moment' });

  t.wait(1);
  react(t, REACTIONS_LIVE, POP);
  assert.deepEqual(t.state.reactions, [{ from: t.ids[REACTIONS_LIVE], kind: POP, at: t.now }], 'those gone by were dropped when this one was kept');
});

test('a refused reaction changes nothing at all', () => {
  const t = sixSeated();
  react(t, 0, POP);
  const before = JSON.stringify(t.state);

  assert.throws(() => react(t, 0, POP));
  assert.equal(JSON.stringify(t.state), before);
});

test('every viewer, a watcher too, gets the same live reactions, and one gone by is in nobody’s view', () => {
  const t = sixSeated();
  const watcher = t.ids.push(addMember(t.state, 'Watcher', t.ctx()).id) - 1;

  react(t, 0, POP);
  t.wait(REACTION_LIFE_MS / 2);
  react(t, 1, THROW, 0);

  const views = [0, 1, 2, watcher].map((player) => t.view(player).reactions);
  for (const reactions of views) {
    assert.deepEqual(reactions, t.state.reactions);
  }

  t.wait(REACTION_LIFE_MS / 2);
  assert.deepEqual(t.view(watcher).reactions, [t.state.reactions[1]], 'the first has gone from the view though the table still keeps it');

  t.wait(REACTION_LIFE_MS);
  assert.deepEqual([0, 1, watcher].map((player) => t.view(player).reactions), [[], [], []]);
});

/** Everything about a table but its reactions. */
const allBut = (state: TableState) => JSON.parse(JSON.stringify({ ...state, reactions: null })) as unknown;

test('a reaction touches nothing else, over random tables: no hand, turn, clock, stack, record, line of the chat or draw on the table’s generator', () => {
  let made = 0;

  for (let seed = 1; seed <= 20; seed++) {
    const rng = seededRng(seed * 131);
    const t = new TestTable({ stacks: [500, 800, 1200, 300, 1000].slice(0, 2 + rng.int(4)), seed, config: { actionSeconds: 30, ante: rng.int(2) * 5 } });
    t.cmd(0, { type: 'start' });

    for (let step = 0; step < 300; step++) {
      randomStep(t, rng);

      const seated = t.state.seats.flatMap((seat) => (seat ? [seat.playerId] : []));
      if (seated.length < 2 || rng.int(3) > 0) {
        continue;
      }

      const from = seated[rng.int(seated.length)]!;
      const kind = REACTIONS[rng.int(REACTIONS.length)]!;
      const to = seated.find((id) => id !== from);
      const before = allBut(t.state);
      const generator = t.rng;
      let draws = 0;
      t.rng = { int: (most) => ((draws += 1), generator.int(most)) };

      try {
        t.cmd(t.ids.indexOf(from), { type: 'react', kind: kind.id, to: kind.thrown ? to : undefined });
        made += 1;
      } catch (error) {
        assert.equal((error as Error).name, 'GameError');
      }

      t.rng = generator;
      assert.deepEqual(allBut(t.state), before, `seed ${seed}, step ${step}`);
      assert.equal(draws, 0, 'the reaction drew on the table’s generator');
      assertInvariants(t.state, t.now);
    }
  }

  assert.ok(made >= 200, `${made} reactions made`);
});
