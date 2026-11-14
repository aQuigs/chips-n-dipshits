import assert from 'node:assert/strict';

import type { PrefMemory } from '../src/client/prefs.ts';
import { applyCommand, createTable, addMember, freshDeck, startHand, startOver, tick, viewFor, SEAT_COUNT } from '../src/engine/index.ts';
import type { Card, Command, Ctx, Effect, Hand, HandRecord, LedgerEntry, Rng, TableConfig, TableState, TableView } from '../src/engine/index.ts';

/** A small repeatable generator (mulberry32); the same seed always deals the same cards. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;

  return {
    int(maxExclusive: number): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * maxExclusive);
    },
  };
}

export function cards(text: string): Card[] {
  return text.split(' ').filter((card) => card.length > 0);
}

export interface DealOptions {
  button?: number;
  /** Hole cards by seat, e.g. { 0: 'As Ah' }. Seats left out get cards that clash with nothing. */
  holes?: Record<number, string>;
  /** Community cards in the order they come out. */
  board?: string;
  /** The extra cards the second board gets when the hand is run twice, or all the cards of the second board of a hand dealt on two. */
  secondBoard?: string;
}

export interface TableOptions {
  stacks: number[];
  /** The seat each player takes; seats 0, 1, 2 and so on when left out. */
  seats?: number[];
  config?: Partial<TableConfig>;
  seed?: number;
  /** What the players are called, by seat; P0, P1 and so on when left out. */
  names?: string[];
}

export function handRecords(effects: Effect[]): HandRecord[] {
  return effects.flatMap((effect) => (effect.type === 'hand' ? [effect.record] : []));
}

export function ledgerEntries(effects: Effect[]): LedgerEntry[] {
  return effects.flatMap((effect) => (effect.type === 'ledger' ? [effect.entry] : []));
}

const STREET_ENDS = [0, 3, 4, 5];

/** The cards of boards that are dealt together, in the order they leave the deck: a street at a time, to each board in turn. */
function streetByStreet(boards: Card[][]): Card[] {
  assert.ok(boards.every((board) => board.length === boards[0]!.length), 'boards dealt together have to be given to the same street');

  return STREET_ENDS.slice(1).flatMap((end, street) => boards.flatMap((board) => board.slice(STREET_ENDS[street], end)));
}

/** Replaces the cards of a hand just dealt with the ones `options` names. */
export function fixCards(hand: Hand, options: DealOptions): void {
  const holes = options.holes ?? {};
  const boards = [cards(options.board ?? ''), cards(options.secondBoard ?? '')];
  // A hand dealt on two boards takes each street for both; a second board that comes with running it twice follows the whole first
  const upcoming = hand.runs > 1 ? streetByStreet(boards) : boards.flat();
  const given = [...Object.values(holes).flatMap(cards), ...upcoming];
  const fixed = new Set(given);
  assert.equal(fixed.size, given.length, 'the same card was dealt twice');
  const spare = freshDeck().filter((card) => !fixed.has(card));

  for (const player of hand.players) {
    const hole = holes[player.seat];
    player.cards = hole ? cards(hole) : [spare.pop()!, spare.pop()!];
  }

  // The next card is taken from the end of the deck
  hand.deck = [...spare, ...upcoming.reverse()];
}

const DECK_SIZE = freshDeck().length;

/**
 * The draws that make the engine's shuffle hand back `deck`. It asks once for each place from the last
 * down to the second, and the answer is where the card for that place lies among those not yet placed.
 */
function shuffleDraws(deck: readonly Card[]): number[] {
  const unplaced = freshDeck();
  const draws: number[] = [];

  for (let place = deck.length - 1; place > 0; place--) {
    const from = unplaced.indexOf(deck[place]!);

    draws.push(from);
    unplaced[from] = unplaced[place]!;
    unplaced.pop();
  }

  return draws;
}

/**
 * An rng that answers the draws of the engine's shuffle with `shuffle` and every other draw with `other`.
 * A shuffle is known by its first draw, the only one made among a whole deck.
 */
function steeredRng(shuffle: (maxExclusive: number) => number, other: (maxExclusive: number) => number): Rng {
  let left = 0;

  return {
    int(maxExclusive: number): number {
      if (left === 0 && maxExclusive === DECK_SIZE) {
        left = DECK_SIZE - 1;
      }

      if (left === 0) {
        return other(maxExclusive);
      }

      left -= 1;

      return shuffle(maxExclusive);
    },
  };
}

/** A table with a player in each of the first seats, driven directly through the engine. */
export class TestTable {
  state: TableState;
  now = 1_000_000;
  rng: Rng;
  effects: Effect[] = [];
  /** Player id in the order of `stacks`, which is by seat unless `seats` says otherwise; for a table taken over with `adopt`, in the order they joined. */
  ids: string[] = [];

  constructor(options: TableOptions) {
    this.rng = seededRng(options.seed ?? 1);

    const config = { minBuyIn: 1, maxBuyIn: 1_000_000, actionSeconds: 0, allowRunItTwice: false, ...options.config };
    const name = (seat: number) => options.names?.[seat] ?? `P${seat}`;
    const { state, host } = createTable('TEST01', name(0), config, this.ctx());
    this.state = state;
    this.ids.push(host.id);

    for (let seat = 1; seat < options.stacks.length; seat++) {
      this.ids.push(addMember(state, name(seat), this.ctx()).id);
    }

    options.stacks.forEach((stack, player) => {
      this.cmd(player, { type: 'requestSeat', seat: options.seats?.[player] ?? player, buyIn: stack });

      if (player > 0) {
        this.cmd(0, { type: 'approve', playerId: this.ids[player]! });
      }
    });
  }

  /** Takes over a table that already exists, such as one read back from a save. The host comes first among its players. */
  static adopt(state: TableState): TestTable {
    const t = new TestTable({ stacks: [] });

    t.state = state;
    t.ids = [state.hostId, ...state.members.map((member) => member.id).filter((id) => id !== state.hostId)];
    t.now = Math.max(state.createdAt, ...state.feed.map((entry) => entry.at));

    return t;
  }

  ctx(): Ctx {
    return { now: this.now, rng: this.rng, effects: this.effects };
  }

  cmd(seat: number, command: Command): void {
    applyCommand(this.state, this.ctx(), this.ids[seat]!, command);
  }

  /**
   * Starts a hand with the cards fixed. Given a button, the hand starts a new game with the button
   * there and the blinds on its left, whatever was played before; given none, it follows on from the
   * last hand as any hand does. The deck is stacked before the hand begins, so whatever a hand does with
   * its cards as it is dealt, such as turning them up when the blinds or the antes leave nobody to act,
   * it does with the cards asked for.
   */
  deal(options: DealOptions = {}): void {
    if (options.button !== undefined) {
      startOver(this.state);
      this.state.buttonSeat = (options.button - 1 + SEAT_COUNT) % SEAT_COUNT;
    }

    // Dealt first on a copy, from a deck left in order: where in the deck each player's cards come from is
    // the engine's to say. The real rng is drawn from all the same, so what follows the hand is as random as ever
    const copy: TableState = JSON.parse(JSON.stringify(this.state));
    const others: number[] = [];

    startHand(copy, {
      now: this.now,
      effects: [],
      rng: steeredRng(
        (maxExclusive) => {
          this.rng.int(maxExclusive);

          return maxExclusive - 1;
        },
        (maxExclusive) => {
          others.push(this.rng.int(maxExclusive));

          return others[others.length - 1]!;
        },
      ),
    });

    const inOrder = freshDeck();
    const places = copy.hand!.players.map((player) => player.cards.map((card) => inOrder.indexOf(card)));

    fixCards(copy.hand!, options);

    const wanted = copy.hand!.players.map((player) => player.cards);
    const deck = [...copy.hand!.deck];
    places.forEach((ofPlayer, index) => ofPlayer.forEach((place, nth) => (deck[place] = wanted[index]![nth]!)));
    assert.equal(new Set(deck).size, DECK_SIZE, 'the stacked deck is not a whole deck');

    // Then for real, with every card where the copy says it has to be and every other draw as it fell there
    const next = (answers: number[]) => () => answers.shift() ?? assert.fail('the hand drew differently when it was dealt again');
    startHand(this.state, { ...this.ctx(), rng: steeredRng(next(shuffleDraws(deck)), next(others)) });

    assert.deepEqual(this.state.hand!.players.map((player) => player.cards), wanted, 'the cards did not come out as stacked: has the shuffle or the deal changed?');
  }

  fold(seat: number): void {
    this.cmd(seat, { type: 'fold' });
  }

  check(seat: number): void {
    this.cmd(seat, { type: 'check' });
  }

  call(seat: number): void {
    this.cmd(seat, { type: 'call' });
  }

  raise(seat: number, to: number): void {
    this.cmd(seat, { type: 'raise', to });
  }

  /** Lets time pass and applies whatever came due. */
  wait(ms: number): void {
    this.now += ms;
    tick(this.state, this.ctx());
  }

  /** The player in a seat, as `cmd` and the moves of a hand name them. */
  playerIn(seat: number): number {
    return this.ids.indexOf(this.state.seats[seat]!.playerId);
  }

  /** A new member takes an open seat with the host's approval. Gives back what `cmd` names them by. */
  sitDown(name: string, seat: number, buyIn = 1000): number {
    const player = this.ids.push(addMember(this.state, name, this.ctx()).id) - 1;

    this.cmd(player, { type: 'requestSeat', seat, buyIn });
    this.cmd(0, { type: 'approve', playerId: this.ids[player]! });

    return player;
  }

  /** Plays the hand on the table to its end by folding round to the last player in it, and clears it away. */
  foldOut(): void {
    while (this.state.hand?.stage === 'betting') {
      this.fold(this.playerIn(this.toAct!));
    }

    this.finishHand();
  }

  /** Keeps stepping time until the hand on the table is over and cleared away. */
  finishHand(): void {
    for (let i = 0; i < 100 && this.state.hand; i++) {
      const deadline = this.state.hand.deadline;
      assert.notEqual(deadline, null, 'the hand is waiting on a player');
      this.now = deadline!;
      tick(this.state, this.ctx());
    }
  }

  /** Steps time until the hand reaches the stage where the result is on display. */
  runToResult(): void {
    for (let i = 0; i < 100 && this.state.hand!.stage !== 'done'; i++) {
      const deadline = this.state.hand!.deadline;
      assert.notEqual(deadline, null, 'the hand is waiting on a player');
      this.now = deadline!;
      tick(this.state, this.ctx());
    }
  }

  stacks(): number[] {
    return this.ids.map((id) => this.state.seats.find((seat) => seat?.playerId === id)?.stack ?? 0);
  }

  view(seat: number): TableView {
    return viewFor(this.state, this.ids[seat]!, this.now);
  }

  get toAct(): number | null {
    return this.state.hand?.toAct ?? null;
  }

  feedText(): string[] {
    return this.state.feed.map((entry) => entry.text);
  }
}

export const BOARD = '2c 7d 9h Jc 3s';
export const ACES = 'As Ah';
export const KINGS = 'Ks Kh';
export const QUEENS = 'Qs Qh';

/** What the player in a seat may do, who has to be the one on the clock. */
export function options(t: TestTable, seat: number) {
  const found = t.view(seat).hand?.options;
  assert.ok(found, `seat ${seat} should be on the clock`);

  return found;
}

export function checkAround(t: TestTable, seats: number[], streets: number): void {
  for (let street = 0; street < streets; street++) {
    for (const seat of seats) {
      t.check(seat);
    }
  }
}

/** What each player has in front of them, has staked in all, and has put in as dead money. */
export function chipsIn(t: TestTable): number[][] {
  return t.state.hand!.players.map((p) => [p.bet, p.committed, p.dead]);
}

/** A browser's storage for preferences, kept in `kept`. */
export function mapMemory(kept: Record<string, string> = {}): PrefMemory & { kept: Record<string, string> } {
  return {
    kept,
    get: (key) => kept[key] ?? null,
    set: (key, value) => void (kept[key] = value),
  };
}
