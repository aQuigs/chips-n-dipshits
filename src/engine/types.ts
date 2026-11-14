import type { Card, Rng } from './cards.ts';
import type { HandEvent } from './events.ts';

export const SEAT_COUNT = 10;

/**
 * Bumped when the shape of a saved table changes (a field renamed, retyped or removed), together with a
 * step in `upgradeState`. A field that is only added gets a default in `SAVED_DEFAULTS` instead.
 */
export const STATE_SCHEMA = 5;

/** What a table's amounts count, since every one of them is kept as a whole number: chips, or the cents of an amount written in dollars. */
export type Unit = 'chips' | 'cents';

/** Who pays the ante: every player dealt in pays one each, or the big blind pays one for the whole table. */
export type AnteFrom = 'everyone' | 'bigBlind';

/** How many boards a table plays its bomb pots on. */
export type BombPotBoards = 'one' | 'two';

/** What becomes of a blind a player was not dealt in for: owed when they come back, or forgiven. */
export type MissedBlinds = 'owed' | 'forgiven';

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
  /** The straddle under the gun. This and the three after it each allow one kind of straddle: see `STRADDLES`. */
  allowStraddle: boolean;
  allowDoubleStraddle: boolean;
  allowButtonStraddle: boolean;
  allowMississippiStraddle: boolean;
  /** The most times the rest of a hand may be run when everyone is all in: 1 never offers more. See `runVote.ts`. */
  maxRuns: 1 | 2 | 3;
  /** Paid by every other player dealt in to whoever wins with seven-deuce; 0 turns it off. */
  sevenDeuceBounty: number;
  /** Paid by everyone else seated to whoever holds the high hand, when the night ends or the host pays it out; 0 for the honor alone. */
  highHandBonus: number;
  /** What everyone dealt into a bomb pot puts in. */
  bombPotAmount: number;
  /** One hand in this many is a bomb pot without being called; 0 for only when one is called. */
  bombPotEvery: number;
  /** How many boards a bomb pot is dealt on: on two, each board wins half of every pot. */
  bombPotBoards: BombPotBoards;
  missedBlinds: MissedBlinds;
  /** When everyone else folds before the flop, the small blind may offer the big blind to take the blinds back: see `chop.ts`. */
  allowChop: boolean;
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
   * on the table, so they show up in the stack and in what is cashed out, never as bought.
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
  /** The kinds of straddle this player posts whenever one is theirs to post. Only kinds the table allows. */
  straddles: Straddle[];
  /** Approved chips waiting for the current hand to end. */
  pendingAdd: number;
  /** The seat the host is moving this player to once the hand they are dealt into ends; null for none. */
  moveTo: number | null;
  /** The big blind passed this seat while its player was not dealt in, or they sat down at a game already going. Only `handPlan.ts` changes this and the two fields after it. */
  owesBigBlind: boolean;
  /** The small blind came to this seat, or would have, while its player was not dealt in. */
  owesSmallBlind: boolean;
  /** Chose to post what they owe on the first hand they can be dealt, rather than wait for the big blind. False whenever nothing is owed. */
  postsOwed: boolean;
  /** Chops the blinds whenever the other blind would too, without being asked: see `chop.ts`. Only at a table that allows chops. */
  alwaysChop: boolean;
}

/** Where a hand's blinds fall, as seats: one may have nobody posting from it. */
export interface BlindSeats {
  small: number;
  big: number;
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
 * ritVote: everyone is all in and picking how many times to run the rest of the board.
 * runout: everyone is all in and the remaining board is being dealt, one street per step.
 * chop: the small blind offered to chop the blinds, and the big blind is on the clock to answer.
 * done: chips are awarded and the result stays up until the deadline.
 */
export type HandStage = 'betting' | 'chop' | 'ritVote' | 'runout' | 'done';

/**
 * The kinds of straddle, each by what its post is called: `straddle` is the one from under the gun.
 * What each is, and who may post it, is its entry in `STRADDLES` (`straddles.ts`).
 */
export type Straddle = 'straddle' | 'double straddle' | 'button straddle' | 'Mississippi straddle';

/**
 * What a forced bet is called, in the play-by-play and in a hand's events. A missed big blind and a
 * dead small blind are what a player who owes blinds posts to come back in before the big blind
 * reaches them, on top of the hand's own blinds.
 */
export type Post = 'small blind' | 'big blind' | 'missed big blind' | 'dead small blind' | Straddle | 'ante' | 'big blind ante' | 'bomb pot';

/** A straddle of a hand: who posts it, which kind it is and how much. */
export interface StraddlePost {
  seat: number;
  what: Straddle;
  amount: number;
}

/**
 * A player dealt into a hand who posts no straddle in it, though they asked for one their seat could
 * have posted, and why:
 * - `two players`: nobody straddles a hand dealt to two.
 * - `blind`: they are posting a blind, which a straddle is never posted on top of.
 * - `right`: the player in seat `ahead` had the right before them, and straddles.
 * - `short`: they cannot cover the `amount` it costs.
 */
export type PassedOver = { seat: number } & ({ why: 'two players' | 'blind' } | { why: 'right'; ahead: number } | { why: 'short'; amount: number });

/** The terms of a bomb pot; a hand with none is an ordinary one. */
export interface BombPot {
  amount: number;
  /** How many boards it is dealt on, from the flop. Left out of one on a single board, as in every bomb pot saved before there were two. */
  boards?: number;
}

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
  /** How many times they picked to run the rest when everyone is all in; null until they pick. */
  ritVote: number | null;
  lastAction: PlayerAction | null;
}

export interface PotAward {
  seat: number;
  amount: number;
  /** Which board won it: 0 for the first, and on from there for a hand on several. */
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
  /** There was no showdown: everyone else folded, or the blinds chopped. */
  uncontested: boolean;
  /** The blinds chopped, the small blind's seat and the big blind's: each took back what they posted, and nobody won anything. Left out of every other hand. */
  chopped?: [smallBlind: number, bigBlind: number];
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
  /** The seat the button is on. Nobody need be playing from it: a dead button. */
  button: number;
  /** The seat the small blind falls on. Nobody posts it when no player dealt in sits there. */
  sbSeat: number;
  bbSeat: number;
  /** The hand's straddles in the order they were posted, each bigger than the one before: none in most hands. */
  straddles: StraddlePost[];
  /** The players whose straddle the hand did not take, for each of them to be told why. */
  passedOver: PassedOver[];
  /** The seven-deuce bounty this hand was dealt under; like the blinds, a new setting waits for the next hand. */
  bounty: number;
  /** The most times the rest may be run when everyone is all in, as the table allowed when this hand was dealt. */
  maxRuns: number;
  /** What kind of hand this is: a bomb pot and its terms, or null for an ordinary hand. Settled when it is dealt. */
  bombPot: BombPot | null;
  /** The small blind has offered to chop the blinds, which they may do once a hand. */
  chopOffered: boolean;
  /** Undealt cards; the next card comes off the end. */
  deck: Card[];
  /** The boards on the table. They and the three fields after them are kept by `boards.ts`, and written nowhere else. */
  boards: Card[][];
  /** How many boards the hand is played on: more than one from the deal in a double-board bomb pot, or from an all-in on when the rest is run more than once. More than are on the table while a hand run several times has boards still to come. */
  runs: number;
  /** The first board still being dealt; any before it have all their cards. */
  runIndex: number;
  /** How many community cards the hand's boards have in common: none when it was dealt on several, and for a hand run out after an all-in, those that were out by then. */
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

/** One player's running numbers for the night. What each counts is said where it is counted, in `tonight.ts`. */
export interface PlayerTonight {
  /** Hands they were dealt into. */
  hands: number;
  /** Hands they took chips from the pots of. */
  won: number;
  /** The most chips they took from the pots of one hand. */
  biggest: number;
  /** The five cards of the best hand they turned up at a showdown, or null when they have shown none. */
  best: Card[] | null;
  /** Times they bought chips after the first. */
  rebuys: number;
  /** Hands that left them with no chips. */
  busts: number;
  /** Hands won in a row, up to the last hand that somebody won. */
  streak: number;
  /** The badges they have earned tonight (`badges.ts`), by id, and how many times each. */
  badges: Record<string, number>;
}

/** A hand turned up at a showdown, as the high hand keeps it: its five cards, and the number of the hand it was shown in (0 when shown before the high hand was kept). */
export interface ShownDown {
  cards: Card[];
  hand: number;
}

/** The best hand turned up at a showdown over some stretch of the night, and who showed it. */
export interface HighHand extends ShownDown {
  /** Who showed it, by member id: more than one when they showed as good in the same hand. `cards` are the first one's. */
  playerIds: string[];
}

/** The high hand of the night. Only `highHand.ts` changes it. */
export interface HighHands {
  /** The best hand shown down tonight: when a later one is as good, the first stays. Null until a hand has been. */
  best: HighHand | null;
  /** The best hand each player has shown down since the bonus was last paid, by member id. The best of them is what the bonus is paid for next. */
  sincePaid: Record<string, ShownDown>;
  /** What each player has collected of the bonus tonight, by member id: only those who have collected some. */
  paid: Record<string, number>;
}

/**
 * The night's running numbers. Finished hands leave the table for their own tab, so what the night
 * comes to is counted here as each hand ends. Only `tonight.ts` changes it, and `highHand.ts` its high hand.
 */
export interface Tonight {
  /** Finished hands counted. Fewer than the table has played when its first hands were dealt before the count was kept. */
  hands: number;
  /** By member id. A member is in it once they are dealt a hand or buy chips again. */
  players: Record<string, PlayerTonight>;
  highHand: HighHands;
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
  /** The seat the button was on in the last hand dealt; null before a first hand and after a shuffle. */
  buttonSeat: number | null;
  /**
   * The seats the blinds fell on in the last hand that had blinds, which is where the next one takes
   * them on from. Null when there is no such hand to go on from, so that the next starts a new game.
   */
  blinds: BlindSeats | null;
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
  /** The host has called a bomb pot, which the next hand dealt will be. */
  bombPotCalled: boolean;
  /** Hands dealt since the last bomb pot, counted only while one comes every so many hands. */
  handsSinceBombPot: number;
  /** The number of the hand the night ends after, once the host has called the last hands; null while none are called. */
  lastHand: number | null;
  /** When the night ended, or null while it goes on. Only `endNight` and `restartNight` (`night.ts`) change it. */
  nightEndedAt: number | null;
  tonight: Tonight;
  feed: FeedEntry[];
  feedSeq: number;
}

/** Chips bought or cashed out, which money is paid for: what the settle-up counts. */
export type MoneyKind = 'buy-in' | 'cash-out' | 'adjustment';

/**
 * Chips moved from one player's stack to another's outside a hand, with no money paid to or by the bank:
 * a transfer the host made, or the high-hand bonus paid to its holder.
 */
export type MovedKind = 'transfer' | 'high hand';

/**
 * What a ledger line records. `amount` is chips onto the player's stack, positive, or off it, negative.
 * Chips moved between players are booked as two lines made together, off the giver's stack and onto
 * the receiver's, each naming the other player.
 */
export type LedgerDetail = { kind: MoneyKind; amount: number } | { kind: MovedKind; amount: number; otherId: string; otherName: string };

export type LedgerEntry = { at: number; tableId: string; playerId: string; name: string } & LedgerDetail;

export interface HandRecordPlayer {
  seat: number;
  /** The member in the seat; '' in a record saved before records kept it. */
  playerId: string;
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
  /** The big blind the hand was dealt under; 0 in a record saved before records kept it. */
  bigBlind: number;
  bombPot: BombPot | null;
  players: HandRecordPlayer[];
  result: HandResult;
  /** Everything that happened, in order; empty when the hand can't be followed from its start. */
  events: HandEvent[];
}

/** A night at a table came to its end. A table can have more than one, since play can start again after a night ends. */
export interface NightEnd {
  at: number;
  tableId: string;
}

/** Things that happened which belong in the permanent record, outside the table state. */
export type Effect = { type: 'ledger'; entry: LedgerEntry } | { type: 'hand'; record: HandRecord } | { type: 'nightEnded'; night: NightEnd };

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
  /** Sits a player back in and says how they settle the blinds they owe: posted on the first hand they can be dealt (`post`), or by waiting for the big blind. */
  | { type: 'comeIn'; post: boolean }
  /** Says whether the player posts one kind of straddle whenever it is theirs to post. */
  | { type: 'setStraddle'; kind: Straddle; on: boolean }
  | { type: 'fold'; turn?: number }
  | { type: 'check'; turn?: number }
  | { type: 'call'; turn?: number }
  | { type: 'raise'; to: number; turn?: number }
  /** The small blind's offer to chop the blinds, made instead of a move on their turn. */
  | { type: 'offerChop'; turn?: number }
  /** The big blind's answer to an offer to chop. */
  | { type: 'answerChop'; agree: boolean; turn?: number }
  /** Says whether the player chops the blinds whenever the other blind would too. */
  | { type: 'setAlwaysChop'; on: boolean }
  /** How many times the player wants the rest of an all-in hand run: see `runVote.ts`. */
  | { type: 'ritVote'; runs: number }
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
  | { type: 'setBombPot'; on: boolean }
  /**
   * How many hands are still to be dealt after the `from`th, the hand on the table as the sender saw it
   * (or the last one dealt, between hands); null calls the last hands off.
   */
  | { type: 'setLastHands'; hands: number | null; from?: number }
  | { type: 'endNight' }
  /** Starts dealing again after the night ended. */
  | { type: 'playOn' }
  /** Pays the high-hand bonus now, for the high hand shown in hand number `hand`, as the sender saw it. */
  /** `hand` and `to` are the hand number and the collectors the host was shown, so a payment that has since changed is refused rather than made. */
  | { type: 'payHighHand'; hand: number; to: string[] }
  | { type: 'forgiveBlinds'; playerId: string }
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
