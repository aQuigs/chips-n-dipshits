import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { addMember, FEED_LIMIT, MENTIONS_PER_LINE, mentionsIn, NUDGE_GAP_MS, nudges, viewFor } from '../src/engine/index.ts';
import type { FeedEntry, Mention } from '../src/engine/index.ts';
import { restoreState } from '../src/server/store.ts';
import { TestTable } from './helpers.ts';
import { assertInvariants } from './invariants.ts';

const MEMBERS = [
  { id: 'ann', name: 'Ann' },
  { id: 'al', name: 'Al' },
  { id: 'alsmith', name: 'Al Smith' },
  { id: 'sam', name: 'Sam' },
];

/** Who a line names, by id, as the table settles it for a line said by `from`. */
const named = (text: string, from = 'sam', members = MEMBERS) => mentionsIn(text, members, from).map(([id]) => id);

/** The words each mention covers, which is what a page marks. */
const marked = (text: string, mentions: readonly Mention[]) => mentions.map(([, at, length]) => text.slice(at, at + length));

test('an @ and a name names that member, in any case, wherever the word starts', () => {
  assert.deepEqual(named('@Ann nice hand'), ['ann']);
  assert.deepEqual(named('nice hand @ann'), ['ann']);
  assert.deepEqual(named('nice hand, @ANN!'), ['ann']);
  assert.deepEqual(named('(@Ann)'), ['ann']);
  assert.deepEqual(marked('gg @ann.', mentionsIn('gg @ann.', MEMBERS, 'sam')), ['@ann'], 'the line keeps where the words were, as typed');
});

test('a name with a space in it is named whole, and the longer of two names that fit is the one meant', () => {
  const text = '@Al Smith and @Al';

  assert.deepEqual(named(text), ['alsmith', 'al']);
  assert.deepEqual(marked(text, mentionsIn(text, MEMBERS, 'sam')), ['@Al Smith', '@Al']);
  assert.deepEqual(named('@Al Smithers'), ['al'], 'a name followed by more of a word is not that name');
  assert.deepEqual(named('@Alan'), [], 'nor is the start of a longer word');
});

test('an @ in the middle of a word, alone, or before nobody at the table is just text', () => {
  assert.deepEqual(named('mail ann@ann.com'), []);
  assert.deepEqual(named('@ alone'), []);
  assert.deepEqual(named('@Bob are you there'), []);
});

test('two members with one name are not told apart, so an @ before that name names nobody', () => {
  const twins = [...MEMBERS, { id: 'ann2', name: 'ann' }];

  assert.deepEqual(named('@Ann hi', 'sam', twins), []);
  assert.deepEqual(named('@Ann @Sam hi', 'al', twins), ['sam'], 'the other names in the line still count');
});

test('naming yourself is just text, and a line names three people at most', () => {
  assert.deepEqual(named('@Sam talking to myself'), []);
  assert.equal(MENTIONS_PER_LINE, 3);
  assert.deepEqual(named('@Ann @Al @Al Smith @Sam', 'nobody'), ['ann', 'al', 'alsmith']);
});

test('a chat line keeps who said it and whom it names, as member ids, and a line naming nobody keeps no list', () => {
  const t = new TestTable({ stacks: [1000, 1000], names: ['Dana', 'Lee'] });
  const watcher = addMember(t.state, 'Kim Lee', t.ctx()).id;
  t.ids.push(watcher);

  t.cmd(0, { type: 'chat', text: 'hello all' });
  t.cmd(0, { type: 'chat', text: '@lee and @Kim Lee, you in?' });

  const [plain, naming] = t.state.feed.slice(-2) as [FeedEntry, FeedEntry];
  assert.deepEqual(plain, { seq: plain.seq, at: t.now, kind: 'chat', from: 'Dana', text: 'hello all', by: t.ids[0] });
  assert.deepEqual(naming.mentions, [
    [t.ids[1], 0, 4],
    [watcher, 9, 8],
  ]);

  // Every viewer is sent the same line, a watcher too: who is named is no secret
  assert.deepEqual(viewFor(t.state, watcher, t.now).feed.at(-1), naming);
  assertInvariants(t.state, t.now);
});

test('someone who has left the table is not named, and a watcher who joins later can be', () => {
  const t = new TestTable({ stacks: [1000, 1000], names: ['Dana', 'Lee'] });
  const kim = addMember(t.state, 'Kim', t.ctx()).id;

  t.cmd(0, { type: 'kick', playerId: kim });
  t.cmd(1, { type: 'chat', text: '@Kim where did you go' });
  assert.equal(t.state.feed.at(-1)!.mentions, undefined);

  const pat = addMember(t.state, 'Pat', t.ctx()).id;
  t.cmd(1, { type: 'chat', text: 'welcome @Pat' });
  assert.deepEqual(t.state.feed.at(-1)!.mentions, [[pat, 8, 4]]);
});

test('one sender nudges one player once a minute: named again sooner, they are marked but quiet', () => {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Dana', 'Lee', 'Kim'] });
  const lastNamed = () => (t.state.feed.at(-1)!.mentions ?? []).map((mention) => `${mention[0] === t.ids[1] ? 'Lee' : 'Kim'}${nudges(mention) ? '' : ' quiet'}`);

  t.cmd(0, { type: 'chat', text: '@Lee your turn' });
  assert.deepEqual(lastNamed(), ['Lee']);

  t.wait(NUDGE_GAP_MS - 1);
  t.cmd(0, { type: 'chat', text: '@Lee @Lee hello?? @Kim' });
  assert.deepEqual(lastNamed(), ['Lee quiet', 'Lee quiet', 'Kim']);

  // Another sender has a minute of their own
  t.cmd(2, { type: 'chat', text: '@Lee wake up' });
  assert.deepEqual(lastNamed(), ['Lee']);

  // A quiet mention doesn't start the minute again: it runs from the last nudge
  t.wait(1);
  t.cmd(0, { type: 'chat', text: '@Lee now?' });
  assert.deepEqual(lastNamed(), ['Lee']);
});

test('the limit is read from the lines the table still keeps, so a flood of lines buys one nudge a screenful', () => {
  const t = new TestTable({ stacks: [1000, 1000], names: ['Dana', 'Lee'] });

  t.cmd(0, { type: 'chat', text: '@Lee' });
  t.cmd(0, { type: 'chat', text: '@Lee' });
  assert.equal(nudges(t.state.feed.at(-1)!.mentions![0]!), false);

  for (let line = 0; line < FEED_LIMIT - 1; line++) {
    t.cmd(0, { type: 'chat', text: 'spam' });
  }
  t.cmd(0, { type: 'chat', text: '@Lee' });
  assert.equal(nudges(t.state.feed.at(-1)!.mentions![0]!), true);
});

test('a table saved before chat lines kept their sender loads with its old lines as they were, and new lines name people', () => {
  const state = restoreState(readFileSync(new URL('./fixtures/tables/schema5-runout-three-boards.json', import.meta.url), 'utf8'));
  const old: FeedEntry = { seq: state.feedSeq + 1, at: state.createdAt, kind: 'chat', from: 'P1', text: '@P0 said before' };
  state.feed.push(old);
  state.feedSeq += 1;

  const t = TestTable.adopt(restoreState(JSON.stringify(state)));
  assert.deepEqual(t.state.feed.at(-1), old, 'an old line is not given a sender or a mention it never had');

  t.cmd(1, { type: 'chat', text: '@P0 said now' });
  assert.deepEqual(t.state.feed.at(-1)!.mentions, [[t.ids[0], 0, 3]]);
  assertInvariants(t.state, t.now);
});
