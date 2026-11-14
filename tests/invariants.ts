/*
 * What must be true of a table at every moment, whatever was done to it. The simulation checks these
 * after every random move, and any other test, or a browser check through the rig, can call them too.
 */
import assert from 'node:assert/strict';

import { FEED_LIMIT, LIMITS, reaches, replayHand, roleOf, viewFor } from '../src/engine/index.ts';
import type { Effect, FeedEntry, HandRecord, TableState } from '../src/engine/index.ts';
import { CACHE_VALUE_BYTES, utf8Bytes } from '../src/gas/sheetStore.ts';
import { restoreState } from '../src/server/store.ts';
import { handRecords } from './helpers.ts';

/**
 * Everywhere a chip that has been bought can be. A feature that gives chips somewhere new to sit adds
 * it here, and from then on every random game holds it to the ledger. Chips waiting to be added to a
 * stack are not listed: they are bought only when they arrive.
 */
export const CHIP_PLACES: { where: string; count(state: TableState): number }[] = [
  { where: 'in stacks', count: (state) => state.seats.reduce((sum, seat) => sum + (seat ? seat.stack : 0), 0) },
  {
    // Once the hand is done its bets have been paid out to the stacks
    where: 'bet in the hand',
    count: (state) => (state.hand && state.hand.stage !== 'done' ? state.hand.players.reduce((sum, p) => sum + p.committed, 0) : 0),
  },
];

/** No chip is created or lost: the chips on the table are the chips the ledger says were bought, less those cashed out. */
export function assertChipsConserved(state: TableState): void {
  const places = CHIP_PLACES.map((place) => ({ where: place.where, chips: place.count(state) }));
  const onTable = places.reduce((sum, place) => sum + place.chips, 0);
  const bought = state.members.reduce((sum, m) => sum + m.buyIn - m.cashOut, 0);

  assert.equal(onTable, bought, `chips on the table (${places.map((place) => `${place.chips} ${place.where}`).join(', ')}) should equal chips bought minus chips cashed out`);

  for (const seat of state.seats) {
    if (seat) {
      assert.ok(Number.isInteger(seat.stack) && seat.stack >= 0, 'a stack went negative or stopped being a whole number');
      assert.ok(Number.isInteger(seat.pendingAdd) && seat.pendingAdd >= 0, 'chips waiting to be added are out of range');
    }
  }

  for (const player of state.hand?.players ?? []) {
    assert.ok(player.bet >= 0 && player.committed >= player.bet, 'a bet is out of range');
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

/** Checks every finished hand among the effects, and says how many there were. */
export function assertHandRecordsHold(effects: Effect[]): number {
  const records = handRecords(effects);

  for (const record of records) {
    assertRecordBalances(record);
    assertEventsRetellTheHand(record);
  }

  return records.length;
}

/** The ledger's entries add up to what the table says its members bought and cashed out. */
export function assertLedgerAgrees(state: TableState, effects: Effect[]): void {
  const entered = effects.reduce((sum, effect) => sum + (effect.type === 'ledger' ? effect.entry.amount : 0), 0);
  const bought = state.members.reduce((sum, m) => sum + m.buyIn - m.cashOut, 0);

  assert.equal(entered, bought, 'the ledger entries and the members\' totals disagree');
}
