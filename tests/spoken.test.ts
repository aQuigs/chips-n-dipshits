import assert from 'node:assert/strict';
import { test } from 'node:test';

import { amountSaid, boardSaid, cardSaid, dealtSaid, hasCards, inWords, lineSaid, menuLabel, offersSaid, openSeatSaid, potSaid, resultSaid, seatSaid, seatsLabel, sizedSaid, turnSaid, voteSaid, warnAt } from '../src/client/spoken.ts';
import type { SeatShown } from '../src/client/spoken.ts';
import { Motion } from '../src/client/motion.ts';
import type { MotionPlayer } from '../src/client/motion.ts';
import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import { Suspense } from '../src/client/suspense.ts';
import { TableNews } from '../src/client/tableChange.ts';
import type { TableChange } from '../src/client/tableChange.ts';
import { TimeWarning } from '../src/client/timeWarning.ts';
import { freshDeck, prettyCard } from '../src/engine/index.ts';
import type { FeedEntry, TableView } from '../src/engine/index.ts';
import { ACES, KINGS, mapMemory, TestTable } from './helpers.ts';

const NOTHING: SeatShown = { status: null, took: 0, chance: null, made: null, muted: false };

/** Three players at 5/10, the button on seat 0, who is first to act. */
function threeHanded(config: object = {}): TestTable {
  const t = new TestTable({ stacks: [1000, 1000, 1000], names: ['Quigs', 'Pam', 'Stu'], config: { smallBlind: 5, bigBlind: 10, ...config } });

  t.cmd(0, { type: 'start' });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS, 2: '7h 2c' }, board: 'Qs Jh 4d 9c 3s' });

  return t;
}

const line = (text: string, kind: FeedEntry['kind'] = 'dealer', from: string | null = null): FeedEntry => ({ seq: 1, at: 0, kind, from, text });

test('every card is said in words, and no word of them is a suit sign or a letter for a rank', () => {
  const said = freshDeck().map(cardSaid);

  assert.equal(new Set(said).size, 52);
  assert.equal(cardSaid('As'), 'ace of spades');
  assert.equal(cardSaid('Td'), 'ten of diamonds');
  assert.equal(cardSaid('2c'), 'deuce of clubs');

  for (const words of said) {
    assert.match(words, /^[a-z]+ of (clubs|diamonds|hearts|spades)$/);
  }
});

test('text with cards written in it is said with each card in words, cards in a row as a list, and nothing else changed', () => {
  assert.equal(inWords('Flop: Q♠ J♥ 4♦'), 'Flop: queen of spades, jack of hearts, four of diamonds');
  assert.equal(inWords('Pam shows K♦ K♣ (Pair of kings)'), 'Pam shows king of diamonds, king of clubs (Pair of kings)');
  assert.equal(inWords('P1 shows one card, A♠'), 'P1 shows one card, ace of spades');
  assert.equal(inWords('Quigs raises to 30'), 'Quigs raises to 30');
  assert.equal(hasCards('Quigs raises to 30'), false);
  assert.equal(hasCards('River: 10♠'), true);

  // Whatever the page writes a card as comes back as that card
  for (const card of freshDeck()) {
    assert.equal(inWords(prettyCard(card)), cardSaid(card));
  }
});

test('an amount is said with what the table plays in, chips or dollars', () => {
  assert.equal(amountSaid(1500, { unit: 'chips' }), '1,500 chips');
  assert.equal(amountSaid(1, { unit: 'chips' }), '1 chip');
  assert.equal(amountSaid(1250, { unit: 'cents' }), '$12.50');
  assert.equal(amountSaid(-1250, { unit: 'cents' }), '-$12.50');
  assert.equal(sizedSaid('Raise to', 12500, { unit: 'chips' }), 'Raise to 12,500');
});

test('a seat is one sentence: who, where in the hand, the stack, the bet, what they did, their cards, and the marks beside the name', () => {
  const t = threeHanded();
  const seat = (viewer: number, of: number, shown: Partial<SeatShown> = {}) => seatSaid(t.view(viewer), t.view(viewer).seats[of]!, { ...NOTHING, ...shown });

  assert.equal(seat(0, 0), 'Quigs, you, dealer, 1,000 chips, on the clock, your cards: ace of spades, ace of hearts, host.');
  assert.equal(seat(1, 0), 'Quigs, dealer, 1,000 chips, on the clock, cards face down, host.');
  assert.equal(seat(0, 1, { status: 'SB' }), 'Pam, small blind, 995 chips, bet 5, cards face down.');
  assert.equal(seat(0, 2, { status: 'BB', muted: true }), 'Stu, big blind, 990 chips, bet 10, cards face down, muted by you.');

  t.raise(0, 30);
  t.fold(1);
  assert.equal(seat(0, 0, { status: 'Raise' }), 'Quigs, you, dealer, 970 chips, bet 30, raised, your cards: ace of spades, ace of hearts, host.');
  assert.equal(seat(0, 1, { status: 'Fold' }), 'Pam, small blind, 995 chips, bet 5, folded.', 'a folded hand has no cards to speak of');
  assert.equal(seat(1, 1, { status: 'Fold' }), 'Pam, you, small blind, 995 chips, bet 5, folded, your cards: king of spades, king of hearts.', 'their own they still hold');
});

test('a seat never names a card its viewer cannot see', () => {
  const t = threeHanded();

  for (const viewer of [1, 2]) {
    const said = t.view(viewer).seats.flatMap((seat) => (seat ? [seatSaid(t.view(viewer), seat, NOTHING)] : [])).join(' ');

    assert.doesNotMatch(said, /\bace\b/, `seat ${viewer} hears of the aces`);
  }
});

test('a seat says what it won, the hand it showed, and its chance to win when the table shows one', () => {
  const t = threeHanded();
  const view = t.view(2);

  assert.equal(seatSaid(view, view.seats[0]!, { ...NOTHING, took: 170, made: 'Pair of aces' }), 'Quigs, dealer, 1,000 chips, on the clock, won 170, cards face down, pair of aces, host.');
  assert.equal(seatSaid(view, view.seats[1]!, { ...NOTHING, chance: 'chance to win: 82%' }), 'Pam, small blind, 995 chips, bet 5, chance to win: 82%, cards face down.');
});

test('an open seat says its number and what the viewer can do with it', () => {
  assert.equal(openSeatSaid(4, 'open', false), 'Seat 5, open.');
  assert.equal(openSeatSaid(4, 'asked', false), 'Seat 5, you asked the host for it.');
  assert.equal(openSeatSaid(0, 'open', true), 'Seat 1, open, the dealer button is here this hand.');
});

test('the list of seats says where it starts, seat 1 for everyone, and which seat is the reader’s', () => {
  const t = threeHanded();
  const watcher = { ...t.view(0), you: { ...t.view(0).you, seat: null } };

  assert.equal(seatsLabel(t.view(1)), 'Seats, clockwise from seat 1. Yours is seat 2');
  assert.equal(seatsLabel(watcher), 'Seats, clockwise from seat 1');
});

test('the board and the pot are said in words, street by street', () => {
  const t = threeHanded();
  const hand = () => t.view(0).hand!;

  assert.equal(boardSaid(hand()), 'Board: no cards yet.');
  assert.equal(potSaid(t.view(0), hand(), null), 'Pot: 15 chips.');

  t.raise(0, 30);
  t.call(1);
  t.fold(2);
  assert.equal(boardSaid(hand()), 'Board: queen of spades, jack of hearts, four of diamonds.');
  assert.equal(potSaid(t.view(0), hand(), 'Main 60 · Side 1 20'), 'Pot: 70 chips, Main 60, Side 1 20.');
});

test('the play-by-play is said with cards in words, and a turn or a river as its one new card', () => {
  assert.equal(lineSaid(line('Flop: Q♠ J♥ 4♦')), 'Flop: queen of spades, jack of hearts, four of diamonds');
  assert.equal(lineSaid(line('Turn: Q♠ J♥ 4♦ 9♣')), 'Turn: nine of clubs');
  assert.equal(lineSaid(line('River: Q♠ J♥ 4♦ 9♣ 3♠')), 'River: three of spades');
  assert.equal(lineSaid(line('Second board, River: Q♠ J♥ 4♦ 9♣ 10♠')), 'Second board, River: ten of spades');
  assert.equal(lineSaid(line('Quigs wins 170 with pair of aces')), 'Quigs wins 170 with pair of aces');
});

test('a chat line is said with who said it, and a line shown as a picture as a GIF', () => {
  const chat = line('nice hand', 'chat', 'Pam');

  assert.equal(lineSaid(chat), 'Pam: nice hand');
  assert.equal(lineSaid({ ...chat, text: 'https://media.tenor.com/abc/cat.gif' }, true), 'Pam sent a GIF');
});

test('a turn is said with what it faces and the pot, and the offer to chop when there is one', () => {
  const t = threeHanded();

  assert.equal(turnSaid(t.view(0)), 'Your turn. 10 to call. Pot 15 chips.');
  assert.equal(turnSaid(t.view(1)), null, 'nobody else is told');

  t.call(0);
  t.call(1);
  assert.equal(turnSaid(t.view(2)), 'Your turn. Check or bet. Pot 30 chips.');
  assert.equal(dealtSaid(t.view(0).seats[0]!.cards as string[]), 'Your cards: ace of spades, ace of hearts.');
});

test('a table that plays dollars says a turn in dollars', () => {
  const t = new TestTable({ stacks: [10000, 10000], config: { unit: 'cents', smallBlind: 50, bigBlind: 100 } });

  t.cmd(0, { type: 'start' });
  t.deal({ button: 0 });

  assert.equal(turnSaid(t.view(t.toAct!)), 'Your turn. $0.50 to call. Pot $1.50.');
});

test('the choice of how many times to run it is said once it is the viewer’s to make', () => {
  const t = new TestTable({ stacks: [1000, 1000], config: { smallBlind: 5, bigBlind: 10, maxRuns: 3 } });

  t.cmd(0, { type: 'start' });
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS } });
  assert.equal(voteSaid(t.view(0).hand!), null);

  t.raise(t.toAct!, 1000);
  t.call(t.toAct!);
  assert.equal(voteSaid(t.view(0).hand!), 'All in. Pick how many times to run it: once, twice or three times.');
});

test('what the viewer may do once a hand is over is said, and nothing to someone who can do neither', () => {
  const t = threeHanded();

  assert.equal(offersSaid(t.view(1).hand!), null);

  t.fold(0);
  t.fold(1);
  assert.equal(offersSaid(t.view(1).hand!), 'You may show your cards.');
});

/** A table that reports itself still only when told to, as a page does while cards are being turned over. */
class TurningCards implements MotionPlayer {
  private readonly waiting: (() => void)[] = [];

  play(): void {}

  cancel(): void {
    this.land();
  }

  idle(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  seen(): boolean {
    return true;
  }

  dispose(): void {}

  land(): void {
    this.waiting.splice(0).forEach((resolve) => resolve());
  }
}

test('while the last cards of an all-in are turned over nothing of the result is said: the stack and the offers come with the winner, after the river', async () => {
  const t = new TestTable({ stacks: [1000, 1000] });
  const news = new TableNews();
  let shown: TableView | null = null;
  const change = () => {
    const next = news.change(shown, structuredClone(t.view(1)), t.now);

    shown = next.view;

    return next;
  };

  change();
  t.deal({ button: 0, holes: { 0: ACES, 1: KINGS }, board: '2c 7d 9h Jc 3s' });
  change();
  t.raise(0, 1000);
  t.call(1);
  change();

  while (t.state.hand && t.state.hand.stage !== 'done') {
    t.wait(t.state.hand.deadline! - t.now);
  }

  const said: string[] = [];
  const moves = new TurningCards();
  // What the page says of a change, in the order it says it: the play-by-play, then the result
  const tell = (told: TableChange) => void said.push(...told.feed.map((entry) => lineSaid(entry)), ...resultSaid(told));
  const suspense = new Suspense(new Motion(moves, new Preferences(PREFERENCES, mapMemory({})), { reduced: () => false, inView: () => true }), tell);

  // The whole runout reaches this page in one view, as it does a page that was slow to ask
  tell(suspense.see(change()));
  suspense.played();
  assert.deepEqual(
    said.filter((line) => /You have|You may|wins/.test(line)),
    [],
    'the result was given away while the cards were still being turned',
  );

  moves.land();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(said.slice(-3), ['River: three of spades', 'P0 wins 2,000 with pair of aces', 'You have 0 chips.']);
});

test('the menu says how many requests wait, to whoever is shown the number', () => {
  assert.equal(menuLabel(0), 'Menu');
  assert.equal(menuLabel(1), 'Menu, 1 request waiting for you');
  assert.equal(menuLabel(3), 'Menu, 3 requests waiting for you');
});

test('the clock is called once a turn, at ten seconds on a long clock and five on a short one, and never on one too short to act on', () => {
  assert.deepEqual([60, 30, 20, 19, 10, 9, 5].map(warnAt), [10, 10, 10, 5, 5, null, null]);

  const t = threeHanded({ actionSeconds: 30 });
  const view = t.view(0);
  const deadline = view.hand!.deadline!;
  const warning = new TimeWarning();

  assert.equal(warning.due(view, deadline - 25_000), null);
  assert.equal(warning.due(view, deadline - 9_800), 10);
  assert.equal(warning.due(view, deadline - 9_500), null, 'said once');
  assert.equal(warning.due(view, deadline - 4_000), null);
  assert.equal(warning.due(t.view(1), deadline - 9_800), null, 'someone else’s clock is not the viewer’s');

  // A page that reaches the turn with three seconds left says nothing: the figure would be stale before it was heard
  assert.equal(new TimeWarning().due(view, deadline - 3_000), null);
});
