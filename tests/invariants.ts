/*
 * What must be true of a table at every moment, whatever was done to it. The simulation checks these
 * after every random move, and any other test, or a browser check through the rig, can call them too.
 */
import assert from 'node:assert/strict';

import { BOARD_SIZE, boardsDealt, evaluateHand, FEED_LIMIT, FLOP_SIZE, LIMITS, PLAYING_THE_BOARD, reaches, replayHand, roleOf, viewFor } from '../src/engine/index.ts';
import type { Effect, FeedEntry, HandPlayer, HandRecord, TableState } from '../src/engine/index.ts';
import { CACHE_VALUE_BYTES, utf8Bytes } from '../src/gas/sheetStore.ts';
import { restoreState } from '../src/server/store.ts';
import { handRecords, ledgerEntries } from './helpers.ts';

/**
 * Everywhere a chip that has been bought can be. A feature that gives chips somewhere new to sit adds
 * it here, and from then on every random game holds it to the ledger. Chips waiting to be added to a
 * stack are not listed: they are bought only when they arrive.
 */
export const CHIP_PLACES: { where: string; count(state: TableState): number }[] = [
  { where: 'in stacks', count: (state) => state.seats.reduce((sum, seat) => sum + (seat ? seat.stack : 0), 0) },
  { where: 'bet in the hand', count: (state) => stillInThePot(state).reduce((sum, p) => sum + p.committed, 0) },
  { where: 'dead money in the hand', count: (state) => stillInThePot(state).reduce((sum, p) => sum + p.dead, 0) },
];

/** The players whose chips are still in the middle: once the hand is done, the pots have been paid out to the stacks. */
function stillInThePot(state: TableState): HandPlayer[] {
  return state.hand && state.hand.stage !== 'done' ? state.hand.players : [];
}

/** No chip is created or lost: the chips on the table are the chips the ledger says were bought, less those cashed out. */
export function assertChipsConserved(state: TableState): void {
  const places = CHIP_PLACES.map((place) => ({ where: place.where, chips: place.count(state) }));
  const onTable = places.reduce((sum, place) => sum + place.chips, 0);
  const bought = state.members.reduce((sum, m) => sum + m.buyIn - m.cashOut, 0);

  assert.equal(onTable, bought, `chips on the table (${places.map((place) => `${place.chips} ${place.where}`).join(', ')}) should equal chips bought minus chips cashed out`);
  assert.equal(state.members.reduce((sum, m) => sum + m.transferred, 0), 0, 'chips moved between players were given and taken in different amounts');

  for (const seat of state.seats) {
    if (seat) {
      assert.ok(Number.isInteger(seat.stack) && seat.stack >= 0, 'a stack went negative or stopped being a whole number');
      assert.ok(Number.isInteger(seat.pendingAdd) && seat.pendingAdd >= 0, 'chips waiting to be added are out of range');
    }
  }

  for (const player of state.hand?.players ?? []) {
    assert.ok(player.bet >= 0 && player.committed >= player.bet, 'a bet is out of range');
    assert.ok(Number.isInteger(player.dead) && player.dead >= 0, 'dead money is out of range');
  }
}

/** The host is a member and never a co-host, and every co-host is a member, listed once. */
export function assertRolesHold(state: TableState): void {
  const members = new Set(state.members.map((member) => member.id));

  assert.ok(members.has(state.hostId), 'the host is not at the table');
  assert.ok(!state.cohostIds.includes(state.hostId), 'the host is listed as a co-host');
  assert.equal(new Set(state.cohostIds).size, state.cohostIds.length, 'a co-host is listed twice');
  assert.ok(state.cohostIds.every((id) => members.has(id)), 'a co-host is no longer at the table');
}

/** Nobody sits in two seats, and a move or shuffle waits only while there is a hand for it to wait for. */
export function assertSeatingHolds(state: TableState): void {
  const seated = state.seats.flatMap((seat) => (seat ? [seat.playerId] : []));

  assert.equal(new Set(seated).size, seated.length, 'a player sits in two seats');
  assert.ok(seated.every((id) => state.members.some((member) => member.id === id)), 'a seat belongs to nobody at the table');

  state.seats.forEach((seat, index) => {
    if (seat?.moveTo === null || !seat) {
      return;
    }

    assert.ok(state.hand, 'a move is still waiting with no hand on the table');
    assert.ok(Number.isInteger(seat.moveTo) && seat.moveTo >= 0 && seat.moveTo < state.seats.length && seat.moveTo !== index, 'a move waits for a seat that makes no sense');
    assert.ok(!seat.leaving && !state.shuffleAfterHand, 'a move waits for a player who is leaving, or alongside a shuffle');
  });

  assert.ok(state.hand || !state.shuffleAfterHand, 'a shuffle is still waiting with no hand on the table');

  for (const player of state.hand?.players ?? []) {
    assert.equal(state.seats[player.seat]?.playerId, player.playerId, 'a player dealt into the hand is no longer in the seat the hand knows them by');
  }
}

/**
 * A bomb pot has its flop out from the first moment anyone sees it, on each board it was dealt on,
 * which a finished hand's record cannot show. One dealt on several boards stays on those: only a hand
 * on one board is ever run twice.
 */
export function assertBombPotsHold(state: TableState): void {
  const hand = state.hand;
  if (!hand?.bombPot) {
    return;
  }

  const dealtOn = boardsDealt(hand.bombPot);

  assert.ok(hand.street !== 'preflop' && hand.boards.length >= dealtOn, 'a bomb pot is on the table without a board it was dealt on');
  assert.ok(hand.boards.slice(0, dealtOn).every((board) => board.length >= FLOP_SIZE), 'a bomb pot is on the table without its flop');
  assert.ok(dealtOn === 1 || hand.runs === dealtOn, 'a bomb pot dealt on several boards was put on more');
}

/**
 * The boards on the table are the ones the hand says it is played on: no more of them than that, alike
 * in the cards it says they have in common and in no other, and while there is betting, all out and
 * all at the same street.
 */
export function assertBoardsHold(state: TableState): void {
  const hand = state.hand;
  if (!hand) {
    return;
  }

  const { boards, runs, runIndex, sharedBoardLength: shared } = hand;
  const dealt = boards.flat();

  assert.ok(boards.length >= 1 && boards.length <= runs, `${boards.length} boards are out in a hand played on ${runs}`);
  assert.ok(boards.every((board) => board.length === 0 || (board.length >= FLOP_SIZE && board.length <= BOARD_SIZE)), 'a board stopped between streets');
  assert.ok(boards.slice(0, runIndex).every((board) => board.length === BOARD_SIZE), 'a board was left short when the dealing moved on');

  for (const board of boards.slice(1)) {
    assert.deepEqual(board.slice(0, shared), boards[0]!.slice(0, shared), 'two boards differ in the cards they are said to have in common');
  }
  assert.equal(new Set(dealt).size, dealt.length - (boards.length - 1) * (boards.length > 1 ? shared : 0), 'two boards hold the same card beyond those they have in common');

  if (hand.stage === 'betting') {
    assert.equal(boards.length, runs, 'a board is still to come while there is betting');
    assert.ok(boards.every((board) => board.length === boards[0]!.length), 'the boards are at different streets while there is betting');
  }
}

/** The table comes back from being saved exactly as it was. */
export function assertSurvivesSaving(state: TableState): void {
  const json = JSON.stringify(state);

  assert.deepEqual(JSON.parse(json), state, 'the table holds something JSON does not keep');
  assert.deepEqual(restoreState(json), state, 'reading the table back changed it');
}

/** The first text anywhere inside `value` that is one of `secrets`. */
function secretIn(value: unknown, secrets: Set<string>): string | undefined {
  if (typeof value === 'string') {
    return secrets.has(value) ? value : undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  for (const inner of Object.values(value)) {
    const found = secretIn(inner, secrets);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/**
 * What each member's view shows is exactly what that member may know: no deck, nobody's token, and no
 * card that is face down for them, wherever in the view it might turn up. Players must not be named
 * like a card ("As") for this to tell the two apart.
 */
export function assertViewsKeepSecrets(state: TableState, now: number): void {
  const hand = state.hand;

  // A token is looked for inside longer text too, such as a link
  const anyToken = new RegExp(state.members.map((member) => member.token.replace(/[^A-Za-z0-9]/g, '\\$&')).join('|'));

  for (const viewer of state.members) {
    const view = viewFor(state, viewer.id, now);
    const json = JSON.stringify(view);

    assert.ok(!json.includes('"deck"') && !json.includes('"token"'), 'a view leaked the deck or a token');
    assert.ok(!anyToken.test(json), 'a view carries a token');

    const faceDown = new Set([...(hand?.deck ?? []), ...(hand?.players ?? []).filter((p) => !p.shown && p.playerId !== viewer.id).flatMap((p) => p.cards)]);
    const leaked = secretIn(view, faceDown);
    assert.equal(leaked, undefined, `${viewer.name}'s view holds a card that is face down for them`);

    for (const player of hand?.players ?? []) {
      const seen = view.seats[player.seat]!.cards!;
      const allowed = player.shown || viewer.id === player.playerId;

      assert.deepEqual(seen, allowed ? player.cards : [null, null], 'a view shows the wrong cards');
    }

    // The hint reads the viewer's own cards and the board, and is there only while those cards are live
    const mine = hand?.players.find((p) => p.playerId === viewer.id);
    const holding = view.hand?.holding ?? null;
    assert.equal(holding !== null, mine !== undefined && !mine.folded, `${viewer.name} has a hint that is not theirs to have, or lacks their own`);
    holding?.reads.forEach((read, run) => {
      const own = new Set([...mine!.cards, ...hand!.boards[run]!]);
      assert.ok(read.plays.every((card) => own.has(card)), `${viewer.name}'s hint plays a card that is not theirs or the board's`);

      // The view reads the player's own seat and the right board: whether the hand is right is checked over random deals in handNames.test.ts
      const shown = hand!.result?.hands.find((entry) => entry.seat === mine!.seat && entry.run === run);
      if (shown && hand!.boards[run]!.length === 5) {
        assert.equal(evaluateHand(read.plays).score, evaluateHand(shown.cards).score, `${viewer.name}'s hint makes a different hand from the one shown`);
        assert.ok(read.name === shown.name || read.name === PLAYING_THE_BOARD, `${viewer.name}'s hint says ${read.name} and the showdown ${shown.name}`);
      }
    });

    // Requests waiting on the host are for the host and co-hosts to see; anyone else sees only their own
    assert.equal(view.you.role, roleOf(state, viewer.id));
    const approves = reaches(view.you.role, 'host or cohost');
    assert.deepEqual(
      view.requests.map((request) => request.playerId),
      state.requests.filter((request) => approves || request.playerId === viewer.id).map((request) => request.playerId),
      `${viewer.name} sees the wrong requests`,
    );

    const options = view.hand?.options;
    if (options) {
      assert.equal(hand!.toAct, view.you.seat);
      assert.ok(options.callAmount >= 0 && options.callCost <= options.callAmount);
      if (options.canRaise) {
        assert.ok(options.minRaiseTo > hand!.currentBet && options.minRaiseTo <= options.maxRaiseTo, 'raise bounds are inverted');
      }
    }
  }
}

/** The chat when every line is as long as it may be, in characters that take three bytes each. */
function fullestChat(): FeedEntry[] {
  const line = (length: number) => '好'.repeat(length);

  return Array.from({ length: FEED_LIMIT }, (_entry, index) => ({
    seq: 1_000_000 + index,
    at: 1_700_000_000_000,
    kind: 'chat',
    from: line(LIMITS.nameLength),
    text: line(LIMITS.chatLength),
  }));
}

const FULLEST_CHAT_BYTES = utf8Bytes(JSON.stringify(fullestChat()));

/**
 * The table stays small enough for the store's cache. Above that size the Sheet store still saves it,
 * but no longer caches it, and then every poll from every player reads the Sheet under the lock. Chat
 * is the one part of a table that players fill at will, so the table is measured with the chat at its
 * fullest: whatever else it holds has to fit beside that.
 */
export function assertFitsTheStore(state: TableState): void {
  const withoutChat = utf8Bytes(JSON.stringify({ ...state, feed: [] }));
  const bytes = withoutChat - utf8Bytes('[]') + FULLEST_CHAT_BYTES;

  assert.ok(bytes <= CACHE_VALUE_BYTES, `with a full chat the table comes to ${bytes} bytes, and the cache takes ${CACHE_VALUE_BYTES}`);
}

/** Everything above, for a table as it stands at `now`. */
export function assertInvariants(state: TableState, now: number): void {
  assertChipsConserved(state);
  assertRolesHold(state);
  assertSeatingHolds(state);
  assertBombPotsHold(state);
  assertBoardsHold(state);
  assertSurvivesSaving(state);
  assertViewsKeepSecrets(state, now);
  assertFitsTheStore(state);
}

/** A finished hand moved chips between its players only, and awarded every pot in full. */
export function assertRecordBalances(record: HandRecord): void {
  const moved = record.players.reduce((sum, p) => sum + p.endStack - p.startStack, 0);
  const pots = record.result.pots.reduce((sum, pot) => sum + pot.amount, 0);
  const awarded = record.result.pots.reduce((sum, pot) => sum + pot.awards.reduce((s, award) => s + award.amount, 0), 0);
  const won = record.result.winnings.reduce((sum, w) => sum + w.amount, 0);

  assert.equal(moved, 0, `hand ${record.number} created or destroyed chips`);
  assert.equal(awarded, pots, `hand ${record.number} did not award every pot in full`);
  assert.equal(won, pots);
  assert.ok(record.boards.every((board) => board.length === 0 || board.length >= 3));
  assert.equal(new Set([...record.boards.flat(), ...record.players.flatMap((p) => p.cards ?? [])]).size >= record.boards[0]!.length, true);
}

/**
 * Every board of a hand that was shown down played for an equal share of each pot, the chips that do
 * not divide going to the first boards, and a board's share went, in equal parts but for its odd chips,
 * to exactly the best hands shown there by players in for that pot. A hand won without a showdown went
 * whole to its winner.
 */
export function assertBoardsShareThePots(record: HandRecord): void {
  const { result, boards } = record;
  const where = `hand ${record.number}`;

  if (result.uncontested) {
    assert.ok(result.pots.every((pot) => pot.awards.length === 1 && pot.awards[0]!.amount === pot.amount && pot.awards[0]!.run === 0), `${where}: a pot nobody contested was not paid whole`);
    return;
  }

  assert.ok(boards.every((board) => board.length === BOARD_SIZE), `${where} was shown down on a board short of its cards`);

  for (const pot of result.pots) {
    assert.ok(pot.awards.every((award) => award.run < boards.length), `${where}: a pot was paid on a board that was never dealt`);

    boards.forEach((_board, run) => {
      const on = `${where}, board ${run + 1} of ${boards.length}, a pot of ${pot.amount}`;
      const share = Math.floor(pot.amount / boards.length) + (run < pot.amount % boards.length ? 1 : 0);
      const paid = pot.awards.filter((award) => award.run === run);
      const shown = result.hands.filter((hand) => hand.run === run && pot.eligible.includes(hand.seat)).map((hand) => ({ seat: hand.seat, score: evaluateHand(hand.cards).score }));
      const best = Math.max(...shown.map((hand) => hand.score));
      const winners = shown.filter((hand) => hand.score === best).map((hand) => hand.seat);

      assert.equal(paid.reduce((sum, award) => sum + award.amount, 0), share, `${on}: the board did not play for its share`);
      assert.ok(paid.every((award) => winners.includes(award.seat)), `${on}: paid to ${paid.map((award) => award.seat)}, with the best hands shown by ${winners}`);
      assert.ok(paid.every((award) => award.amount === Math.floor(share / winners.length) || award.amount === Math.ceil(share / winners.length)), `${on}: not split evenly`);

      // A winner goes unpaid only when the share has fewer chips than winners
      assert.ok(paid.length === winners.length || share < winners.length, `${on}: a best hand got nothing`);
    });
  }
}

/**
 * A finished hand's events tell the whole of it: played back from the first event alone they end on
 * the stacks, boards, awards and shown cards of the record, and after every bet they agree with what
 * the event says the player had left. They hold no card that stayed face down.
 */
export function assertEventsRetellTheHand(record: HandRecord): void {
  const { events } = record;
  const end = replayHand(events);

  // A hand that was already under way when events began, or outgrew what is kept, has none at all
  if (!end) {
    assert.deepEqual(events, [], `hand ${record.number} has events that do not start with the hand`);
    return;
  }

  assert.deepEqual(
    end.seats.map(({ seat, name, stack }) => ({ seat, name, stack })),
    record.players.map((p) => ({ seat: p.seat, name: p.name, stack: p.endStack })),
    `hand ${record.number}: the events end on different stacks`,
  );
  assert.deepEqual(end.seats.map((seat) => seat.cards), record.players.map((p) => p.cards), `hand ${record.number}: the events show different cards`);
  assert.deepEqual(end.boards, record.boards, `hand ${record.number}: the events deal different boards`);
  assert.deepEqual(
    end.awards,
    record.result.pots.flatMap((pot, index) => pot.awards.map((award) => ({ seat: award.seat, amount: award.amount, pot: index, board: award.run }))),
    `hand ${record.number}: the events award the pots differently`,
  );
  assert.equal(end.pot, 0, `hand ${record.number}: the events leave chips in the middle`);
  assert.ok(end.seats.every((seat) => seat.bet === 0), `hand ${record.number}: the events leave a bet out`);

  const faceUp = new Set([...record.boards.flat(), ...record.players.flatMap((p) => p.cards ?? [])]);

  events.forEach((event, index) => {
    if (event[0] === 'post' || event[0] === 'call' || event[0] === 'bet' || event[0] === 'raise') {
      const stackLeft = event[0] === 'post' ? event[4] : event[3];
      const stack = replayHand(events, index + 1)!.seats.find((seat) => seat.seat === event[1])!.stack;

      assert.equal(stack, stackLeft, `hand ${record.number}: event ${index} leaves the player with a different stack than it says`);
    }

    if (event[0] === 'street' || event[0] === 'show') {
      assert.ok(event[2].every((card) => faceUp.has(card)), `hand ${record.number}: event ${index} holds a card nobody was shown`);
    }
  });
}

/**
 * A hand recorded as a bomb pot was played as one: everyone dealt in posted the amount, or all they
 * had, as their stake; nobody posted anything else; and nothing was done before the flop. A hand that
 * is not one has no such post.
 */
export function assertBombPotIsPlayedAsOne(record: HandRecord): void {
  const { events, bombPot } = record;
  const posts = events.flatMap((event) => (event[0] === 'post' ? [{ seat: event[1], what: event[2], amount: event[3], as: event[5] }] : []));

  if (!bombPot) {
    assert.ok(posts.every((post) => post.what !== 'bomb pot'), `hand ${record.number} is no bomb pot, and someone posted one`);
    assert.ok(events[0]?.[8] === undefined, `hand ${record.number} is no bomb pot, and starts as one`);
    return;
  }

  // A hand that outgrew what is recorded has no events to go by
  if (events.length === 0) {
    return;
  }

  const [start] = events;
  assert.ok(start?.[0] === 'start' && start[6] === 0, `hand ${record.number}: a bomb pot starts with an ante`);
  assert.deepEqual(start[8], bombPot, `hand ${record.number}: the first event does not say what bomb pot it is`);
  assert.deepEqual(
    posts.sort((a, b) => a.seat - b.seat),
    record.players.map((p) => ({ seat: p.seat, what: 'bomb pot', amount: Math.min(bombPot.amount, p.startStack), as: 'contribution' })),
    `hand ${record.number}: not everyone posted the bomb pot, or someone posted something else`,
  );

  const flop = events.findIndex((event) => event[0] === 'street');
  const dealt = events[flop];
  assert.ok(dealt?.[0] === 'street' && dealt[2].length === 3, `hand ${record.number}: a bomb pot without a flop`);
  assert.ok(events.slice(1, flop).every((event) => event[0] === 'post' || event[0] === 'deal' || event[0] === 'return'), `hand ${record.number}: something was done before the flop of a bomb pot`);

  // Every board it is dealt on gets its flop before anything else happens, and no board comes later
  const boards = boardsDealt(bombPot);
  assert.deepEqual(
    events.slice(flop, flop + boards).map((event) => (event[0] === 'street' ? [event[1], event[2].length] : event[0])),
    Array.from({ length: boards }, (_board, index) => [index, FLOP_SIZE]),
    `hand ${record.number}: a bomb pot on ${boards} boards did not start with a flop on each`,
  );
  assert.ok(record.boards.length === boards || (boards === 1 && events.some((event) => event[0] === 'runs' && event[1] > 1)), `hand ${record.number}: a bomb pot dealt on ${boards} boards ended on ${record.boards.length}`);
}

/** Checks every finished hand among the effects, and says how many there were. */
export function assertHandRecordsHold(effects: Effect[]): number {
  const records = handRecords(effects);

  for (const record of records) {
    assertRecordBalances(record);
    assertEventsRetellTheHand(record);
    assertBombPotIsPlayedAsOne(record);
    assertBoardsShareThePots(record);
  }

  return records.length;
}

/**
 * The ledger's entries add up, member by member, to what the table says each bought and cashed out and
 * had moved to them, and a transfer's two lines always come as a pair that gives and takes the same chips.
 */
export function assertLedgerAgrees(state: TableState, effects: Effect[]): void {
  const entries = ledgerEntries(effects);

  for (const member of state.members) {
    const totals = { paid: 0, moved: 0 };
    for (const entry of entries.filter((e) => e.playerId === member.id)) {
      totals[entry.kind === 'transfer' ? 'moved' : 'paid'] += entry.amount;
    }

    assert.equal(totals.paid, member.buyIn - member.cashOut, `the ledger entries and ${member.name}'s chips bought and cashed out disagree`);
    assert.equal(totals.moved, member.transferred, `the ledger entries and the chips moved to ${member.name} disagree`);
  }

  entries.forEach((entry, index) => {
    if (entry.kind !== 'transfer') {
      return;
    }

    const pair = entry.amount < 0 ? entries[index + 1] : entries[index - 1];
    assert.ok(pair?.kind === 'transfer' && pair.amount === -entry.amount && pair.playerId === entry.otherId && pair.otherId === entry.playerId, 'a transfer is booked without its other half');
  });
}
