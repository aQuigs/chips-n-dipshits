import { bettingOptions } from './betting.ts';
import type { BettingOptions } from './betting.ts';
import { bombPotDue, bombPotHangsOnCall } from './bombPots.ts';
import { isSevenDeuce } from './cards.ts';
import type { Card } from './cards.ts';
import type { HandEvent } from './events.ts';
import { readHand } from './handNames.ts';
import type { HandRead } from './handNames.ts';
import { comingIn } from './handPlan.ts';
import type { ComesIn } from './handPlan.ts';
import { reaches, roleOf } from './hosts.ts';
import type { Role } from './hosts.ts';
import { handsLeft, nightIsOver, onLastHand } from './night.ts';
import { buildPots } from './pots.ts';
import type { Pot } from './pots.ts';
import { memberOf, seatIndexOf } from './seats.ts';
import type { BombPot, FeedEntry, Hand, HandPlayer, HandResult, HandStage, PassedOver, PlayerAction, RequestKind, Straddle, StraddlePost, Street, TableConfig, TableState } from './types.ts';

/** A hole card as one viewer sees it: the card, or null when it is face down for them. */
export type VisibleCard = Card | null;

export interface SeatView {
  seat: number;
  playerId: string;
  name: string;
  stack: number;
  sittingOut: boolean;
  away: boolean;
  leaving: boolean;
  /** The kinds of straddle they post whenever one is theirs to post. */
  straddles: Straddle[];
  pendingAdd: number;
  /** The seat the host is moving them to when the hand ends. */
  moveTo: number | null;
  /** The blinds they missed and have yet to settle. For the whole table to see, as a missed-blind button on the felt is. */
  owesBigBlind: boolean;
  owesSmallBlind: boolean;
  /** How a player who owes blinds and is there to play gets back in, as things stand, which says what they chose; null for anyone else. */
  comesIn: ComesIn | null;
  /** Dealt into the hand on the table. */
  inHand: boolean;
  bet: number;
  folded: boolean;
  allIn: boolean;
  lastAction: PlayerAction | null;
  /** Null when the seat has no cards. */
  cards: VisibleCard[] | null;
  /** The cards are face up for the whole table, not just for this viewer. */
  shown: boolean;
  ritVote: boolean | null;
}

/** What the viewer's own two cards make, for them alone. */
export interface Holding {
  /** One for each board dealt so far, which is two once a hand run twice deals its second. */
  reads: HandRead[];
  /** Seven-deuce in a hand that pays the bounty for it. */
  bounty: boolean;
}

export interface HandView {
  number: number;
  stage: HandStage;
  street: Street;
  boards: Card[][];
  runs: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  /** The hand's straddles, in the order they were posted. */
  straddles: StraddlePost[];
  /** Why the viewer posted no straddle in this hand, when they had asked for one their seat could have posted; null otherwise. */
  passedOver: PassedOver | null;
  bigBlind: number;
  bombPot: BombPot | null;
  /** Every chip in the middle, bets in front of players included. */
  pot: number;
  pots: Pot[];
  currentBet: number;
  toAct: number | null;
  /** Which decision of the hand this is; sent back with the player's action. */
  turn: number;
  deadline: number | null;
  /** What the viewer may do, when the action is on them. */
  options: BettingOptions | null;
  /** The viewer still owes a run-it-twice vote. */
  canVote: boolean;
  /** The viewer may turn their cards face up. */
  canShow: boolean;
  result: HandResult | null;
  /** Everything that has happened in the hand so far, in order. The same for every viewer: it holds no face-down card. */
  events: HandEvent[];
  /** Null for a viewer who has no cards in the hand or has folded them. */
  holding: Holding | null;
}

export interface RequestView {
  playerId: string;
  name: string;
  kind: RequestKind;
  seat: number;
  amount: number;
}

export interface LedgerRow {
  playerId: string;
  name: string;
  buyIn: number;
  cashOut: number;
  /** Chips the host moved to this player from others, less those moved away. Already counted in `stack` or `cashOut`, so shown here but never added to `net` again. */
  transferred: number;
  /** Chips on the table right now. */
  stack: number;
  net: number;
}

export interface TableView {
  id: string;
  version: number;
  /** The server's clock when this view was made, for lining up countdowns. */
  now: number;
  config: TableConfig;
  hostId: string;
  cohostIds: string[];
  running: boolean;
  nextHandAt: number | null;
  /** Hands dealt at this table so far. */
  handCount: number;
  /** `role` says which of the host's powers the viewer has: whether a command needs them is its handler's `by`. */
  you: { id: string; name: string; role: Role; seat: number | null };
  seats: (SeatView | null)[];
  hand: HandView | null;
  /** The seats are shuffled when the hand ends. */
  shuffleAfterHand: boolean;
  /** The bomb pot the next hand dealt will be as things stand, or null for an ordinary hand or when no next hand is coming. */
  nextBombPot: BombPot | null;
  /** That bomb pot is one only because it was called: called off, the next hand is an ordinary one. */
  bombPotCalled: boolean;
  /** Hands still to be dealt before the night ends, not counting the one on the table; null while no last hands are called. */
  handsLeft: number | null;
  /** When the night ended, or null while it goes on. */
  nightEndedAt: number | null;
  feed: FeedEntry[];
  /** Requests waiting on the host: all of them for the host and co-hosts, only their own for everyone else. */
  requests: RequestView[];
  ledger: LedgerRow[];
  members: { id: string; name: string }[];
}

/** The table as one member is allowed to see it. Never includes the deck, tokens, or face-down cards. */
export function viewFor(state: TableState, playerId: string, now: number): TableView {
  const me = memberOf(state, playerId);
  const mySeat = seatIndexOf(state, playerId);
  const role = roleOf(state, playerId);
  const hand = state.hand;

  const comesIn = comingIn(state);

  const seats = state.seats.map((seat, index): SeatView | null => {
    if (!seat) {
      return null;
    }

    const player = hand?.players.find((p) => p.seat === index);
    const visible = player ? player.shown || index === mySeat : false;

    return {
      seat: index,
      playerId: seat.playerId,
      name: memberOf(state, seat.playerId).name,
      stack: seat.stack,
      sittingOut: seat.sittingOut,
      away: seat.away,
      leaving: seat.leaving,
      straddles: seat.straddles,
      pendingAdd: seat.pendingAdd,
      moveTo: seat.moveTo,
      owesBigBlind: seat.owesBigBlind,
      owesSmallBlind: seat.owesSmallBlind,
      comesIn: comesIn.get(index) ?? null,
      inHand: player !== undefined,
      bet: player?.bet ?? 0,
      folded: player?.folded ?? false,
      allIn: player?.allIn ?? false,
      lastAction: player?.lastAction ?? null,
      cards: player ? player.cards.map((card) => (visible ? card : null)) : null,
      shown: player?.shown ?? false,
      ritVote: player?.ritVote ?? null,
    };
  });

  let handView: HandView | null = null;
  if (hand) {
    const mine = hand.players.find((p) => p.seat === mySeat);
    const myTurn = hand.stage === 'betting' && mine !== undefined && hand.toAct === mySeat;

    handView = {
      number: hand.number,
      stage: hand.stage,
      street: hand.street,
      boards: hand.boards,
      runs: hand.runs,
      button: hand.button,
      sbSeat: hand.sbSeat,
      bbSeat: hand.bbSeat,
      straddles: hand.straddles,
      passedOver: hand.passedOver.find((passed) => passed.seat === mySeat) ?? null,
      bigBlind: hand.bigBlind,
      bombPot: hand.bombPot,
      pot: hand.players.reduce((sum, p) => sum + p.committed + p.dead, 0),
      pots: buildPots(hand.players),
      currentBet: hand.currentBet,
      toAct: hand.toAct,
      turn: state.turn,
      deadline: hand.deadline,
      options: myTurn ? bettingOptions(state, hand, mine) : null,
      canVote: hand.stage === 'ritVote' && mine !== undefined && !mine.folded && mine.ritVote === null,
      canShow: hand.stage === 'done' && mine !== undefined && !mine.shown,
      result: hand.result,
      events: hand.events,
      holding: mine && !mine.folded ? holdingOf(hand, mine) : null,
    };
  }

  const approves = reaches(role, 'host or cohost');
  const visibleRequests = state.requests.filter((request) => approves || request.playerId === playerId);

  return {
    id: state.id,
    version: state.version,
    now,
    config: state.config,
    hostId: state.hostId,
    cohostIds: state.cohostIds,
    running: state.running,
    nextHandAt: state.nextHandAt,
    handCount: state.handCount,
    you: { id: me.id, name: me.name, role, seat: mySeat >= 0 ? mySeat : null },
    seats,
    hand: handView,
    shuffleAfterHand: state.shuffleAfterHand,
    nextBombPot: nightIsOver(state) || onLastHand(state) ? null : bombPotDue(state),
    bombPotCalled: bombPotHangsOnCall(state),
    handsLeft: handsLeft(state),
    nightEndedAt: state.nightEndedAt,
    feed: state.feed,
    requests: visibleRequests.map((request) => ({ ...request, name: memberOf(state, request.playerId).name })),
    ledger: ledgerOf(state),
    members: state.members.map((m) => ({ id: m.id, name: m.name })),
  };
}

function holdingOf(hand: Hand, player: HandPlayer): Holding {
  return {
    reads: hand.boards.map((board) => readHand(player.cards, board)),
    bounty: hand.bounty > 0 && isSevenDeuce(player.cards),
  };
}

/** Where everyone stands: what they bought, what they took off the table, and what is still in front of them. */
export function ledgerOf(state: TableState): LedgerRow[] {
  const rows: LedgerRow[] = [];

  // Chips in a pot that is still being played for count as their owner's until the hand pays out
  const unsettled = state.hand && state.hand.stage !== 'done' ? state.hand.players : [];

  for (const member of state.members) {
    const seat = state.seats.find((s) => s?.playerId === member.id);
    const mine = unsettled.find((p) => p.playerId === member.id);
    const inPot = mine ? mine.committed + mine.dead : 0;
    const stack = seat ? seat.stack + inPot : 0;

    if (member.buyIn === 0 && member.cashOut === 0 && stack === 0) {
      continue;
    }

    rows.push({
      playerId: member.id,
      name: member.name,
      buyIn: member.buyIn,
      cashOut: member.cashOut,
      transferred: member.transferred,
      stack,
      net: stack + member.cashOut - member.buyIn,
    });
  }

  return rows;
}
