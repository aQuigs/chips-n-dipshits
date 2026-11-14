import type { Card, Rng } from './cards.ts';
import type { HandEvent } from './events.ts';

export const SEAT_COUNT = 10;

/**
 * Bumped when the shape of a saved table changes (a field renamed, retyped or removed), together with a
 * step in `upgradeState`. A field that is only added gets a default in `SAVED_DEFAULTS` instead.
 */
export const STATE_SCHEMA = 3;

/** What a table's amounts count, since every one of them is kept as a whole number: chips, or the cents of an amount written in dollars. */
export type Unit = 'chips' | 'cents';

/** Who pays the ante: every player dealt in pays one each, or the big blind pays one for the whole table. */
export type AnteFrom = 'everyone' | 'bigBlind';

export interface TableConfig {
  /** Chosen when the table is created and fixed from then on: the chips already on it would change their worth. */
  unit: Unit;
  name: string;
  /** The group's call, opened from a button on the table; '' for none. */
  voiceLink: string;
  smallBlind: number;
  bigBlind: number;
  /** Put in the pot before the cards are played, by whoever `anteFrom` says; 0 for none. */
  ante: number;
  anteFrom: AnteFrom;
  minBuyIn: number;
  maxBuyIn: number;
  /** Seconds a player has to act; 0 turns the clock off. */
  actionSeconds: number;
  allowStraddle: boolean;
  allowRunItTwice: boolean;
  /** Paid by every other player dealt in to whoever wins with seven-deuce; 0 turns it off. */
  sevenDeuceBounty: number;
}

export interface Member {
  id: string;
  name: string;
  /** Secret that proves a request comes from this member's browser. */
  token: string;
  /** Total chips bought, across every time they sat down. */
  buyIn: number;
  /** Total chips taken off the table. */
  cashOut: number;
  /**
   * Chips the host moved to this member from other players, less those moved away. They change hands
   * on the table, so they are already in the stack and are never counted as bought or cashed out.
   */
  transferred: number;
}

export interface Seat {
  playerId: string;
  stack: number;
  /** Not dealt in from the next hand on. */
  sittingOut: boolean;
  /** Ran out the clock; checked or folded automatically until they act again. */
  away: boolean;
  /** Gives up the seat as soon as the current hand is over. */
  leaving: boolean;
  /** Posts a straddle whenever under the gun. */
  straddle: boolean;
  /** Approved chips waiting for the current hand to end. */
  pendingAdd: number;
  /** The seat the host is moving this player to once the hand they are dealt into ends; null for none. */
  moveTo: number | null;
}

export type RequestKind = 'seat' | 'rebuy';

/** Something a player asked for that the host or a co-host has to approve. */
export interface SeatRequest {
  playerId: string;
  kind: RequestKind;
  seat: number;
  amount: number;
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/**
 * betting: someone is on the clock.
 * ritVote: everyone is all in and deciding whether to run the board twice.
 * runout: everyone is all in and the remaining board is being dealt, one street per step.
 * done: chips are awarded and the result stays up until the deadline.
 */
export type HandStage = 'betting' | 'ritVote' | 'runout' | 'done';

/** What a forced bet is called, in the play-by-play and in a hand's events. */
export type Post = 'small blind' | 'big blind' | 'straddle' | 'ante' | 'big blind ante';

export type PlayerAction = Post | 'fold' | 'check' | 'call' | 'bet' | 'raise';

export interface HandPlayer {
  seat: number;
  playerId: string;
  name: string;
  cards: Card[];
  startStack: number;
  /** Chips put in on the current street. */
  bet: number;
  /** Chips put in over the whole hand as this player's own stake, the current street included. It caps what they can win from each opponent. */
  committed: number;
  /** Chips put in as dead money: in the main pot for whoever wins it, and no part of this player's stake. */
  dead: number;
  folded: boolean;
  allIn: boolean;
  /** Has acted on the current street; blinds don't count. */
  hasActed: boolean;
  /** Hole cards are face up for everyone. */
  shown: boolean;
  ritVote: boolean | null;
  lastAction: PlayerAction | null;
}

export interface PotAward {
  seat: number;
  amount: number;
  /** Which board won it: 0, or 1 for the second board when run twice. */
  run: number;
}

export interface PotResult {
  amount: number;
  eligible: number[];
  awards: PotAward[];
}

export interface ShownHand {
  seat: number;
  run: number;
  name: string;
  /** The five cards that make the hand. */
  cards: Card[];
}

export interface BountyResult {
  seat: number;
  payments: { seat: number; amount: number }[];
}

export interface HandResult {
  /** Everyone else folded, so there was no showdown. */
  uncontested: boolean;
  pots: PotResult[];
  /** Chips each seat won from the pots, bounty excluded. */
  winnings: { seat: number; amount: number }[];
  hands: ShownHand[];
  bounty: BountyResult | null;
}

export interface Hand {
  number: number;
  startedAt: number;
  smallBlind: number;
  bigBlind: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  straddleSeat: number | null;
  /** The seven-deuce bounty this hand was dealt under; like the blinds, a new setting waits for the next hand. */
  bounty: number;
  /** Undealt cards; the next card comes off the end. */
  deck: Card[];
  /** One board, or two when the hand is run twice. */
  boards: Card[][];
  runs: number;
  /** Board being dealt during a runout. */
  runIndex: number;
  /** Community cards already out when everyone got all in; both boards share them. */
  sharedBoardLength: number;
  street: Street;
  stage: HandStage;
  /** Everyone dealt in, in seat order. */
  players: HandPlayer[];
  /** Highest total bet on the current street. */
  currentBet: number;
  /** Smallest amount a raise must add: the size of the last full bet or raise. */
  minRaise: number;
  toAct: number | null;
  /** Last seat to bet or raise on the current street. */
  lastAggressor: number | null;
  /** When the current stage moves on by itself; null when it waits for a player indefinitely. */
  deadline: number | null;
  result: HandResult | null;
  log: string[];
  /** The same story as the log, as data. Empty for a hand that can't be followed from its start. */
  events: HandEvent[];
}

export type FeedKind = 'chat' | 'dealer' | 'system';

export interface FeedEntry {
  seq: number;
  at: number;
  kind: FeedKind;
  /** Who said it, for chat. */
  from: string | null;
  text: string;
}

export interface TableState {
  schema: number;
  id: string;
  /** Goes up by one every time the table is saved. */
  version: number;
  createdAt: number;
  config: TableConfig;
  hostId: string;
  /** Members the host has given the host's powers, apart from naming co-hosts and handing over the table. Never the host. */
  cohostIds: string[];
  members: Member[];
  seats: (Seat | null)[];
  requests: SeatRequest[];
  buttonSeat: number | null;
  /** The host has started the game, so hands are dealt whenever two players can play. */
  running: boolean;
  /** When the next hand is dealt while no hand is on the table. */
  nextHandAt: number | null;
  handCount: number;
  /**
   * Counts the decisions this table has asked of its players, so that an answer can say which one it
   * is an answer to. It runs on from hand to hand: a late answer must not fit a decision in the next one.
   */
  turn: number;
  hand: Hand | null;
  /** The host has shuffled the seats, which happens once the hand on the table ends. */
  shuffleAfterHand: boolean;
  feed: FeedEntry[];
  feedSeq: number;
}

/** Chips bought or cashed out, which money is paid for: what the settle-up counts. */
export type MoneyKind = 'buy-in' | 'cash-out' | 'adjustment';

/** Chips the host moved from one player's stack to another's. No money changes hands with the bank. */
export type TransferKind = 'transfer';

export type LedgerKind = MoneyKind | TransferKind;

interface LedgerLine {
  at: number;
  tableId: string;
  playerId: string;
  name: string;
  /** Chips onto the player's stack are positive, chips off it negative. */
  amount: number;
}

/**
 * One line of the ledger. A transfer is booked as two lines made together, chips off the giver's stack
 * and onto the receiver's, each naming the other player.
 */
export type LedgerEntry = LedgerLine & ({ kind: MoneyKind } | { kind: TransferKind; otherId: string; otherName: string });

export interface HandRecordPlayer {
  seat: number;
  name: string;
  startStack: number;
  endStack: number;
  /** Hole cards, only if they were shown. */
  cards: Card[] | null;
}

export interface HandRecord {
  at: number;
  tableId: string;
  number: number;
  /** The dealer's play-by-play, one line per event. */
  summary: string;
  boards: Card[][];
  players: HandRecordPlayer[];
  result: HandResult;
  /** Everything that happened, in order; empty when the hand can't be followed from its start. */
  events: HandEvent[];
}

/** Things that happened which belong in the permanent record, outside the table state. */
export type Effect = { type: 'ledger'; entry: LedgerEntry } | { type: 'hand'; record: HandRecord };

/** Everything the rules need from the outside world. */
export interface Ctx {
  now: number;
  rng: Rng;
  effects: Effect[];
}

export type Command =
  | { type: 'requestSeat'; seat: number; buyIn: number }
  | { type: 'requestRebuy'; amount: number }
  | { type: 'cancelRequest' }
  | { type: 'standUp' }
  | { type: 'sitOut' }
  | { type: 'sitIn' }
  | { type: 'setStraddle'; on: boolean }
  | { type: 'fold'; turn?: number }
  | { type: 'check'; turn?: number }
  | { type: 'call'; turn?: number }
  | { type: 'raise'; to: number; turn?: number }
  | { type: 'ritVote'; agree: boolean }
  | { type: 'showCards' }
  | { type: 'chat'; text: string }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'approve'; playerId: string }
  | { type: 'deny'; playerId: string }
  | { type: 'kick'; playerId: string }
  | { type: 'setStack'; playerId: string; stack: number }
  | { type: 'moveSeat'; playerId: string; seat: number }
  | { type: 'shuffleSeats' }
  | { type: 'transferChips'; from: string; to: string; amount: number }
  | { type: 'updateConfig'; config: Partial<TableConfig> }
  | { type: 'transferHost'; playerId: string }
  | { type: 'setCohost'; playerId: string; on: boolean };

/** A rule was broken or a request made no sense; the message is shown to the player. */
export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameError';
  }
}
