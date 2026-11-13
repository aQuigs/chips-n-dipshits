import assert from 'node:assert/strict';

import { applyCommand, createTable, addMember, freshDeck, startHand, tick, viewFor, SEAT_COUNT } from '../src/engine/index.ts';
import type { Card, Command, Ctx, Effect, Hand, HandRecord, Rng, TableConfig, TableState, TableView } from '../src/engine/index.ts';

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
  /** The extra cards the second board gets when the hand is run twice. */
  secondBoard?: string;
}

export interface TableOptions {
  stacks: number[];
  config?: Partial<TableConfig>;
  seed?: number;
  /** What the players are called, by seat; P0, P1 and so on when left out. */
  names?: string[];
}

export function handRecords(effects: Effect[]): HandRecord[] {
  return effects.flatMap((effect) => (effect.type === 'hand' ? [effect.record] : []));
}

/** Replaces the cards of a hand just dealt with the ones `options` names. */
export function fixCards(hand: Hand, options: DealOptions): void {
  const holes = options.holes ?? {};
  const upcoming = [...cards(options.board ?? ''), ...cards(options.secondBoard ?? '')];
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

/** A table with a player in each of the first seats, driven directly through the engine. */
export class TestTable {
  state: TableState;
  now = 1_000_000;
  rng: Rng;
  effects: Effect[] = [];
  /** Player id by the seat they were first given; for a table taken over with `adopt`, in the order they joined. */
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

    options.stacks.forEach((stack, seat) => {
      this.cmd(seat, { type: 'requestSeat', seat, buyIn: stack });

      if (seat > 0) {
        this.cmd(0, { type: 'approve', playerId: this.ids[seat]! });
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

  /** Starts a hand with the button and the cards fixed. */
  deal(options: DealOptions = {}): void {
    if (options.button !== undefined) {
      this.state.buttonSeat = (options.button - 1 + SEAT_COUNT) % SEAT_COUNT;
    }

    startHand(this.state, this.ctx());
    fixCards(this.state.hand!, options);
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
