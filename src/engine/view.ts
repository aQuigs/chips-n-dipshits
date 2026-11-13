import { bettingOptions } from './betting.ts';
import type { BettingOptions } from './betting.ts';
import type { Card } from './cards.ts';
import { buildPots } from './pots.ts';
import type { Pot } from './pots.ts';
import { memberOf, seatIndexOf } from './seats.ts';
import type { FeedEntry, HandResult, HandStage, PlayerAction, RequestKind, Street, TableConfig, TableState } from './types.ts';

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
  straddle: boolean;
  pendingAdd: number;
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

export interface HandView {
  number: number;
  stage: HandStage;
  street: Street;
  boards: Card[][];
  runs: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  straddleSeat: number | null;
  bigBlind: number;
  /** Every chip in the middle, bets in front of players included. */
  pot: number;
  pots: Pot[];
  currentBet: number;
  toAct: number | null;
  deadline: number | null;
  /** What the viewer may do, when the action is on them. */
  options: BettingOptions | null;
  /** The viewer still owes a run-it-twice vote. */
  canVote: boolean;
  /** The viewer may turn their cards face up. */
  canShow: boolean;
  result: HandResult | null;
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
  running: boolean;
  nextHandAt: number | null;
  /** Hands dealt at this table so far. */
  handCount: number;
  you: { id: string; name: string; isHost: boolean; seat: number | null };
  seats: (SeatView | null)[];
  hand: HandView | null;
  feed: FeedEntry[];
  /** Requests waiting on the host: all of them for the host, only their own for everyone else. */
  requests: RequestView[];
  ledger: LedgerRow[];
  members: { id: string; name: string }[];
}

/** The table as one member is allowed to see it. Never includes the deck, tokens, or face-down cards. */
export function viewFor(state: TableState, playerId: string, now: number): TableView {
  const me = memberOf(state, playerId);
  const mySeat = seatIndexOf(state, playerId);
  const isHost = state.hostId === playerId;
  const hand = state.hand;

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
      straddle: seat.straddle,
      pendingAdd: seat.pendingAdd,
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
      straddleSeat: hand.straddleSeat,
      bigBlind: hand.bigBlind,
      pot: hand.players.reduce((sum, p) => sum + p.committed, 0),
      pots: buildPots(hand.players),
      currentBet: hand.currentBet,
      toAct: hand.toAct,
      deadline: hand.deadline,
      options: myTurn ? bettingOptions(state, hand, mine) : null,
      canVote: hand.stage === 'ritVote' && mine !== undefined && !mine.folded && mine.ritVote === null,
      canShow: hand.stage === 'done' && mine !== undefined && !mine.shown,
      result: hand.result,
    };
  }

  const visibleRequests = state.requests.filter((request) => isHost || request.playerId === playerId);

  return {
    id: state.id,
    version: state.version,
    now,
    config: state.config,
    hostId: state.hostId,
    running: state.running,
    nextHandAt: state.nextHandAt,
    handCount: state.handCount,
    you: { id: me.id, name: me.name, isHost, seat: mySeat >= 0 ? mySeat : null },
    seats,
    hand: handView,
    feed: state.feed,
    requests: visibleRequests.map((request) => ({ ...request, name: memberOf(state, request.playerId).name })),
    ledger: ledgerOf(state),
    members: state.members.map((m) => ({ id: m.id, name: m.name })),
  };
}

/** Where everyone stands: what they bought, what they took off the table, and what is still in front of them. */
export function ledgerOf(state: TableState): LedgerRow[] {
  const rows: LedgerRow[] = [];

  // Chips in a pot that is still being played for count as their owner's until the hand pays out
  const unsettled = state.hand && state.hand.stage !== 'done' ? state.hand.players : [];

  for (const member of state.members) {
    const seat = state.seats.find((s) => s?.playerId === member.id);
    const inPot = unsettled.find((p) => p.playerId === member.id)?.committed ?? 0;
    const stack = seat ? seat.stack + seat.pendingAdd + inPot : 0;

    if (member.buyIn === 0 && member.cashOut === 0 && stack === 0) {
      continue;
    }

    rows.push({
      playerId: member.id,
      name: member.name,
      buyIn: member.buyIn,
      cashOut: member.cashOut,
      stack,
      net: stack + member.cashOut - member.buyIn,
    });
  }

  return rows;
}
