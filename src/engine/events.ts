import { addStreet, newBoards, runOut } from './boards.ts';
import type { Card } from './cards.ts';
import type { AnteFrom, BombPot, Post } from './types.ts';

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
  /**
   * Always first, with everything needed to set the table up as it was before the blinds. The ante and
   * who pays it are left out of a hand without one. `bombPot` is there only for a bomb pot, whose ante
   * is 0: the table's own is not posted in one.
   */
  | [kind: 'start', hand: number, button: number, smallBlind: number, bigBlind: number, players: [seat: number, name: string, stack: number][], ante?: number, anteFrom?: AnteFrom, bombPot?: BombPot]
  /**
   * A forced bet. Left out, `as` means a live one, in front of the player like any bet. With `as`, the
   * chips went straight into the pot, as the player's own stake or as dead money: see `ForcedBet`.
   */
  | [kind: 'post', seat: number, what: Post, amount: number, stackLeft: number, as?: 'contribution' | 'dead']
  /** Everyone in the hand gets their two cards, face down. */
  | [kind: 'deal']
  | [kind: 'fold' | 'check', seat: number]
  | [kind: 'call', seat: number, amount: number, stackLeft: number]
  /** `to` is the player's total bet on the street, as in "raises to". */
  | [kind: 'bet' | 'raise', seat: number, to: number, stackLeft: number]
  /** The clock ran out on the seat; the check or fold that follows was made for them. */
  | [kind: 'timeout', seat: number]
  /** The part of a bet nobody could call goes back, and with it any part of an ante nobody could match. */
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
  bombPot: BombPot | null;
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

  const [, number, button, smallBlind, bigBlind, players, , , bombPot = null] = first;
  const table = newBoards();
  const position: ReplayPosition = {
    number,
    button,
    smallBlind,
    bigBlind,
    bombPot,
    seats: players.map(([seat, name, stack]) => ({ seat, name, stack, bet: 0, folded: false, cards: null })),
    pot: 0,
    boards: table.boards,
    awards: [],
  };

  const at = (seat: number) => position.seats.find((s) => s.seat === seat)!;

  const collectBets = () => {
    for (const seat of position.seats) {
      position.pot += seat.bet;
      seat.bet = 0;
    }
  };

  for (const event of rest) {
    switch (event[0]) {
      case 'post': {
        const [, seat, , amount, , as] = event;
        const player = at(seat);

        player.stack -= amount;

        if (as) {
          position.pot += amount;
        } else {
          player.bet += amount;
        }
        break;
      }

      case 'call': {
        const player = at(event[1]);

        player.bet += event[2];
        player.stack -= event[2];
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
        // What is more than the bet is the part of an ante that nobody could match, which was already in the pot
        const fromBet = Math.min(event[2], player.bet);

        player.bet -= fromBet;
        position.pot -= event[2] - fromBet;
        player.stack += event[2];
        break;
      }

      case 'street':
        collectBets();
        addStreet(table, event[1], event[2]);
        break;

      case 'runs':
        collectBets();
        runOut(table, event[1]);
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
