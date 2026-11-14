import { addStreet, newBoards, runOut } from './boards.ts';
import { boardsDealt } from './bombPots.ts';
import { HOLE_CARDS } from './cards.ts';
import type { Card } from './cards.ts';
import type { AnteFrom, BombPot, HandStage, PlayerAction, Post, Street } from './types.ts';

/**
 * How the picking of how many times to run it ended, on a `runs` event; left out when nobody was asked.
 * `settled`: the picks made left nothing open. `time`: the clock ran out on whoever had not picked.
 * `left`: a player gave up their seat without picking, and the event names their seat.
 */
export type RunsPicked = 'settled' | 'time' | 'left';

/**
 * How an answer to a chop was given for the big blind. `unasked`: at the offer, by their standing
 * choice or because they were away, so they were never on the clock for it. `unanswered`: they were
 * asked, and the clock ran out or they left.
 */
export type ChopUngiven = 'unasked' | 'unanswered';

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
  /** `unasked` when it was made for a player the hand could not wait for, away or leaving, who was never on the clock for it. */
  | [kind: 'fold' | 'check', seat: number, unasked?: true]
  | [kind: 'call', seat: number, amount: number, stackLeft: number]
  /** `to` is the player's total bet on the street, as in "raises to". */
  | [kind: 'bet' | 'raise', seat: number, to: number, stackLeft: number]
  /** The clock ran out on the seat; the check or fold that follows was made for them. */
  | [kind: 'timeout', seat: number]
  /** The part of a bet nobody could call goes back, and with it any part of an ante nobody could match. */
  | [kind: 'return', seat: number, amount: number]
  /** The cards a street adds to a board: board 0 for the first, and on from there for a hand played on several. */
  | [kind: 'street', board: number, cards: Card[]]
  /** A player still in picks how many times to run the rest: see `runVote.ts`. */
  | [kind: 'vote', seat: number, runs: number]
  /** Betting is over with cards to come, and the rest is dealt out on this many boards: more than one when it is run more than once, or the hand was dealt on several. */
  | [kind: 'runs', count: number, picking?: RunsPicked, leaver?: number]
  /** A player's cards turned face up by this event, null for one left as it was: see `shown.ts`. */
  | [kind: 'show', seat: number, cards: (Card | null)[]]
  | [kind: 'muck', seat: number]
  /** One player's share of one pot; `pot` 0 is the main pot, and `board` is which board won it. */
  | [kind: 'win', seat: number, amount: number, pot: number, board: number]
  /** The hand's winner collects a bounty: what each other player paid, and the hand it was for, in kept form (`startingHands.ts`). */
  | [kind: 'bounty', seat: number, payments: [seat: number, amount: number][], hand: string]
  /** The small blind offers to chop the blinds. */
  | [kind: 'chopOffer', seat: number]
  /** The big blind's answer, and when it was not theirs to give, how it came to be given for them. A no follows a `timeout` when the clock ran out. */
  | [kind: 'chopAnswer', seat: number, agree: boolean, ungiven?: ChopUngiven]
  /** The blinds chop: each goes back from in front of the seat that posted it, and the hand is over with no winner. */
  | [kind: 'chop', returned: [seat: number, amount: number][]]
  /**
   * After a hand that ended before its boards were out, the cards each board would have been dealt
   * next, laid out at a player's asking (rabbit hunting). They are no part of any board and count for nothing.
   */
  | [kind: 'hunt', cards: Card[][]];

/**
 * Events are saved with the table on every action, and unlike the play-by-play they are no use with
 * a stretch missing. A hand that runs longer than any real one stops being recorded altogether.
 */
export const EVENT_LIMIT = 320;

/**
 * Whether a hand whose events are `events` takes one more, by the rule they are kept under: the whole
 * hand from its start, or nothing. A hand with none past its start can't be followed, because it was
 * under way before events were kept or it outgrew the limit; one at the limit is emptied for good.
 */
export function takesEvent(events: readonly HandEvent[], event: HandEvent): boolean {
  return (events.length > 0 || event[0] === 'start') && events.length < EVENT_LIMIT;
}

/** A hand's events with one more, or none at all when the hand does not take it. The list given is left as it is. */
export function eventsWith(events: readonly HandEvent[], event: HandEvent): HandEvent[] {
  return takesEvent(events, event) ? [...events, event] : [];
}

export interface ReplaySeat {
  seat: number;
  name: string;
  stack: number;
  /** Chips in front of the player on the current street. */
  bet: number;
  /** Every chip they have in the hand as their own stake, and what they put in as dead money: what `buildPots` splits into pots. */
  committed: number;
  dead: number;
  folded: boolean;
  /** Their last chip is in the hand. */
  allIn: boolean;
  /** What they last did on the street, a blind they posted included: what the table says beside the seat. */
  lastAction: PlayerAction | null;
  /** How many times they picked to run the rest; null until they pick. */
  ritVote: number | null;
  /** Hole cards as the table sees them, null in place of each one face down. */
  cards: (Card | null)[];
}

/** The table as a hand's events leave it. */
export interface ReplayPosition {
  number: number;
  button: number;
  smallBlind: number;
  bigBlind: number;
  bombPot: BombPot | null;
  /** The seats that posted the blinds, -1 for one nobody posted. */
  sbSeat: number;
  bbSeat: number;
  /**
   * How far the events say the hand has come. They say less than the table knew: that players are
   * picking how many times to run it only with the first pick, and that a hand with nothing to win is
   * over not at all. `replay.ts` settles both for a finished hand.
   */
  stage: HandStage;
  /** The street last dealt, on whichever board. */
  street: Street;
  seats: ReplaySeat[];
  /** Chips in the middle, bets in front of players not included. */
  pot: number;
  boards: Card[][];
  /** How many boards the hand is played on: more than are laid out while one run more than once is still being dealt. */
  runs: number;
  awards: { seat: number; amount: number; pot: number; board: number }[];
  /** The cards each board would have been dealt next, once a player hunted them after the hand; null until then. Never part of `boards`. */
  hunted: Card[][] | null;
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
  const table = newBoards(boardsDealt(bombPot));
  const position: ReplayPosition = {
    number,
    button,
    smallBlind,
    bigBlind,
    bombPot,
    sbSeat: -1,
    bbSeat: -1,
    stage: 'betting',
    street: 'preflop',
    seats: players.map(([seat, name, stack]) => ({
      seat,
      name,
      stack,
      bet: 0,
      committed: 0,
      dead: 0,
      folded: false,
      allIn: false,
      lastAction: null,
      ritVote: null,
      cards: Array<Card | null>(HOLE_CARDS).fill(null),
    })),
    pot: 0,
    boards: table.boards,
    runs: table.runs,
    awards: [],
    hunted: null,
  };

  const at = (seat: number) => position.seats.find((s) => s.seat === seat)!;

  /** Chips leave a stack for the hand, as the player's stake unless they are dead money. */
  const pay = (player: ReplaySeat, amount: number, dead = false) => {
    player.stack -= amount;
    player.allIn = player.stack === 0;

    if (dead) {
      player.dead += amount;
    } else {
      player.committed += amount;
    }
  };

  const collectBets = () => {
    for (const seat of position.seats) {
      position.pot += seat.bet;
      seat.bet = 0;
    }
  };

  for (const event of rest) {
    switch (event[0]) {
      case 'post': {
        const [, seat, what, amount, , as] = event;
        const player = at(seat);

        pay(player, amount, as === 'dead');

        if (as) {
          position.pot += amount;
        } else {
          player.bet += amount;
          player.lastAction = what;
        }

        if (what === 'small blind') {
          position.sbSeat = seat;
        } else if (what === 'big blind') {
          position.bbSeat = seat;
        }
        break;
      }

      case 'call': {
        const player = at(event[1]);

        player.bet += event[2];
        pay(player, event[2]);
        player.lastAction = 'call';
        break;
      }

      case 'bet':
      case 'raise': {
        const player = at(event[1]);

        pay(player, event[2] - player.bet);
        player.bet = event[2];
        player.lastAction = event[0];
        break;
      }

      case 'fold':
        at(event[1]).folded = true;
        at(event[1]).lastAction = 'fold';
        break;

      case 'check':
        at(event[1]).lastAction = 'check';
        break;

      case 'return': {
        const player = at(event[1]);
        // What is more than the bet is the part of an ante that nobody could match, which was already in the pot
        const fromBet = Math.min(event[2], player.bet);

        player.bet -= fromBet;
        position.pot -= event[2] - fromBet;
        player.stack += event[2];
        player.committed -= event[2];
        player.allIn = false;
        break;
      }

      case 'street':
        collectBets();
        position.street = addStreet(table, event[1], event[2]);

        // A street with betting to come starts with nothing said, for whoever is still in to say it
        if (position.stage === 'betting') {
          for (const seat of position.seats) {
            seat.lastAction = seat.folded ? seat.lastAction : null;
          }
        }
        break;

      case 'vote':
        at(event[1]).ritVote = event[2];
        position.stage = 'ritVote';
        break;

      case 'runs':
        collectBets();
        runOut(table, event[1]);
        position.runs = table.runs;
        position.stage = 'runout';
        break;

      case 'show': {
        const player = at(event[1]);

        player.cards = player.cards.map((card, nth) => event[2][nth] ?? card);
        break;
      }

      case 'win': {
        const [, seat, amount, pot, board] = event;

        collectBets();
        position.pot -= amount;
        at(seat).stack += amount;
        position.awards.push({ seat, amount, pot, board });
        position.stage = 'done';
        break;
      }

      case 'bounty': {
        const [, winner, payments] = event;

        for (const [seat, amount] of payments) {
          at(seat).stack -= amount;
          at(winner).stack += amount;
        }
        position.stage = 'done';
        break;
      }

      case 'chopOffer':
        position.stage = 'chop';
        break;

      case 'chopAnswer':
        position.stage = 'betting';
        break;

      case 'chop':
        for (const [seat, amount] of event[1]) {
          const player = at(seat);

          player.bet -= amount;
          player.committed -= amount;
          player.stack += amount;
          player.allIn = false;
        }
        position.stage = 'done';
        break;

      case 'hunt':
        position.hunted = event[1];
        position.stage = 'done';
        break;

      case 'start':
      case 'deal':
      case 'timeout':
      case 'muck':
        break;

      default:
        // A kind of event added later has to say here what it does to the table, even if that is nothing
        event satisfies never;
    }
  }

  return position;
}
