import type { Card } from './cards.ts';

/**
 * What happened in a hand, one entry per thing the dealer would call out, as data: the same story as
 * the play-by-play, for whatever needs to follow a hand step by step (a replay, a sound, a statistic).
 *
 * Each is a short list that starts with what kind it is, because a hand's events are saved with the
 * table on every action, sent with every view and kept in the hand's record. Seats are seat numbers
 * and amounts count the table's smallest unit, as everywhere. Only cards that are face up for the whole
 * table ever appear in one.
 */
export type HandEvent =
  /** Always first, with everything needed to set the table up as it was before the blinds. */
  | [kind: 'start', hand: number, button: number, smallBlind: number, bigBlind: number, players: [seat: number, name: string, stack: number][]]
  | [kind: 'post', seat: number, blind: 'small blind' | 'big blind' | 'straddle', amount: number, stackLeft: number]
  /** Everyone in the hand gets their two cards, face down. */
  | [kind: 'deal']
  | [kind: 'fold' | 'check', seat: number]
  | [kind: 'call', seat: number, amount: number, stackLeft: number]
  /** `to` is the player's total bet on the street, as in "raises to". */
  | [kind: 'bet' | 'raise', seat: number, to: number, stackLeft: number]
  /** The clock ran out on the seat; the check or fold that follows was made for them. */
  | [kind: 'timeout', seat: number]
  /** The part of a bet nobody could call goes back. */
  | [kind: 'return', seat: number, amount: number]
  /** The cards a street adds to a board: board 0, or 1 for the second one when the hand is run twice. */
  | [kind: 'street', board: number, cards: Card[]]
  | [kind: 'vote', seat: number, agree: boolean]
  /** Betting is over with cards to come, and the rest of the board runs out this many times. */
  | [kind: 'runs', count: number]
  | [kind: 'show', seat: number, cards: Card[]]
  | [kind: 'muck', seat: number]
  /** One player's share of one pot; `pot` 0 is the main pot, and `board` is which board won it. */
  | [kind: 'win', seat: number, amount: number, pot: number, board: number]
  | [kind: 'bounty', seat: number, payments: [seat: number, amount: number][]];

export interface ReplaySeat {
  seat: number;
  name: string;
  stack: number;
  /** Chips in front of the player on the current street. */
  bet: number;
  folded: boolean;
  /** Hole cards, once they are face up. */
  cards: Card[] | null;
}

/** The table as a hand's events leave it. */
export interface ReplayPosition {
  number: number;
  button: number;
  smallBlind: number;
  bigBlind: number;
  seats: ReplaySeat[];
  /** Chips in the middle, bets in front of players not included. */
  pot: number;
  boards: Card[][];
  awards: { seat: number; amount: number; pot: number; board: number }[];
}

/**
 * Where the first `count` events of a hand leave the table, worked out from the events alone. Null when
 * there is nothing to replay: a hand keeps no events when it was already under way as events came in,
 * or ran longer than a hand is recorded for.
 */
export function replayHand(events: readonly HandEvent[], count = events.length): ReplayPosition | null {
  const [first, ...rest] = events.slice(0, count);
  if (!first || first[0] !== 'start') {
    return null;
  }

  const [, number, button, smallBlind, bigBlind, players] = first;
  const position: ReplayPosition = {
    number,
    button,
    smallBlind,
    bigBlind,
    seats: players.map(([seat, name, stack]) => ({ seat, name, stack, bet: 0, folded: false, cards: null })),
    pot: 0,
    boards: [[]],
    awards: [],
  };

  const at = (seat: number) => position.seats.find((s) => s.seat === seat)!;

  // Cards that were out before an all-in, which a second board starts from
  let shared = 0;

  const collectBets = () => {
    for (const seat of position.seats) {
      position.pot += seat.bet;
      seat.bet = 0;
    }
  };

  for (const event of rest) {
    switch (event[0]) {
      case 'post':
      case 'call': {
        const player = at(event[1]);
        const amount = event[0] === 'post' ? event[3] : event[2];

        player.bet += amount;
        player.stack -= amount;
        break;
      }

      case 'bet':
      case 'raise': {
        const player = at(event[1]);

        player.stack -= event[2] - player.bet;
        player.bet = event[2];
        break;
      }

      case 'fold':
        at(event[1]).folded = true;
        break;

      case 'return': {
        const player = at(event[1]);

        player.bet -= event[2];
        player.stack += event[2];
        break;
      }

      case 'street': {
        const [, board, cards] = event;

        collectBets();
        position.boards[board] ??= position.boards[0]!.slice(0, shared);
        position.boards[board].push(...cards);
        break;
      }

      case 'runs':
        collectBets();
        shared = position.boards[0]!.length;
        break;

      case 'show':
        at(event[1]).cards = event[2];
        break;

      case 'win': {
        const [, seat, amount, pot, board] = event;

        collectBets();
        position.pot -= amount;
        at(seat).stack += amount;
        position.awards.push({ seat, amount, pot, board });
        break;
      }

      case 'bounty': {
        const [, winner, payments] = event;

        for (const [seat, amount] of payments) {
          at(seat).stack -= amount;
          at(winner).stack += amount;
        }
        break;
      }

      case 'start':
      case 'deal':
      case 'check':
      case 'timeout':
      case 'vote':
      case 'muck':
        break;

      default:
        // A kind of event added later has to say here what it does to the table, even if that is nothing
        event satisfies never;
    }
  }

  return position;
}
