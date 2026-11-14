/*
 * What a finished hand comes to, as facts: who put in and took out what, who won which pot, who showed
 * what, who went broke and to whom. Whatever counts, rewards or remembers something about a hand (the
 * night's numbers, a badge, the high hand) reads these, so each question about a hand is answered once
 * and the same way for all of them.
 *
 * They are read from the hand's record and nothing else. A record holds only what the whole table saw,
 * so no fact can hold a card that stayed face down, and the facts of any hand ever recorded can be made again.
 */
import { boardsDealt } from './bombPots.ts';
import type { Card } from './cards.ts';
import { evaluateHand } from './handRank.ts';
import type { BombPot, HandRecord, HandResult } from './types.ts';

/** Chips a player was paid from one pot on one board, as the hand was settled. */
export interface PotWon {
  /** 0 for the main pot, then the side pots in order. */
  pot: number;
  /** 0, or 1 for the second board of a hand played on two. */
  board: number;
  amount: number;
  /** How many players were paid from that pot on that board, this one among them: more than 1 is a split. A tie over a single chip pays one of them, and is 1. */
  between: number;
}

/** A hand a player turned up at a showdown, on one board. */
export interface HandShown {
  board: number;
  /** Higher beats lower and equal ties, across boards and across hands: `HandValue.score`. */
  rank: number;
  /** `HIGH_CARD` to `STRAIGHT_FLUSH` (`handRank.ts`). */
  category: number;
  /** As `handNames.ts` names it, such as "Full house, aces over kings". A royal flush is named as one. */
  name: string;
  /** The five cards that make it, most significant first. */
  cards: Card[];
}

export interface PlayerFacts {
  seat: number;
  playerId: string;
  name: string;
  /** Chips they put into the pots: blinds, antes and bets, less any part of a bet that came back uncalled. */
  putIn: number;
  /** Chips they took out of the pots. An uncalled bet coming back is not among them, and neither is a bounty. */
  tookOut: number;
  /** The seven-deuce bounty: what they collected, or below zero what they paid. */
  bounty: number;
  /** What the hand did to their stack: `tookOut - putIn + bounty`. */
  net: number;
  folded: boolean;
  /** Every share of a pot they were paid, by pot and by board. Empty when they won nothing. */
  wins: PotWon[];
  /**
   * Their two cards, when the table saw them: turned up at a showdown or an all-in, for a bounty, or by
   * choice once the hand was over. Null when they stayed face down, as a mucked or folded hand's do and
   * those of a winner nobody called.
   */
  cards: Card[] | null;
  /**
   * What they turned up at a showdown, a hand for each board. Empty when the hand ended without one, or
   * they had folded or mucked: cards shown by choice afterwards are in `cards` and make no hand here.
   */
  shown: HandShown[];
  /** The hand left them with no chips. */
  busted: boolean;
  /**
   * The seats that took a busted player's last chips: whoever collected the bounty that emptied
   * their stack, or with no such bounty everyone paid from a pot they were all in for. Never the
   * player themselves, and empty for a player who did not bust.
   */
  bustedBy: number[];
}

export interface HandFacts {
  number: number;
  /** When the hand was taken off the table. */
  at: number;
  /** A showdown, everyone folding to one player, or the two blinds chopping, which nobody won. */
  ended: 'showdown' | 'folds' | 'chop';
  /** The bomb pot it was, or null for a hand with blinds. */
  bombPot: BombPot | null;
  /** How many boards were on the table when it ended. */
  boards: number;
  /** It was on two boards because the players agreed to run it twice, not because it was dealt on two. */
  runTwice: boolean;
  /** 0 for a hand recorded before records said what the big blind was. */
  bigBlind: number;
  /** Every chip that was played for, all pots together. Uncalled chips that went back are not in it. */
  pot: number;
  /** Everyone dealt in, in seat order. */
  players: PlayerFacts[];
}

/** What counts as winning a pot: taking chips from the pots of the hand, be it the whole pot, a share of a split one, one board of two or a side pot. */
export function wonAPot(player: PlayerFacts): boolean {
  return player.tookOut > 0;
}

/** The seats still in the hand when it ended. A pot always holds a chip of every player who did not fold, so they are the ones in for the main pot. */
function seatsStillIn(result: HandResult): number[] {
  if (result.chopped) {
    return result.chopped;
  }

  return result.uncontested ? result.winnings.map((win) => win.seat) : (result.pots[0]?.eligible ?? []);
}

function endingOf(result: HandResult): HandFacts['ended'] {
  if (result.chopped) {
    return 'chop';
  }

  return result.uncontested ? 'folds' : 'showdown';
}

/** The facts of a finished hand, from its record. */
export function handFacts(record: HandRecord): HandFacts {
  const { result } = record;
  const stillIn = seatsStillIn(result);
  const collected = result.bounty ? result.bounty.payments.reduce((sum, payment) => sum + payment.amount, 0) : 0;
  const pot = result.pots.reduce((sum, each) => sum + each.amount, 0);

  const players = record.players.map((player): PlayerFacts => {
    const { seat } = player;
    const folded = !stillIn.includes(seat);

    const wins = result.pots.flatMap((each, index) =>
      each.awards
        .filter((award) => award.seat === seat && award.amount > 0)
        .map((award): PotWon => ({ pot: index, board: award.run, amount: award.amount, between: each.awards.filter((other) => other.run === award.run && other.amount > 0).length })),
    );
    const tookOut = wins.reduce((sum, win) => sum + win.amount, 0);

    const paid = result.bounty?.payments.find((payment) => payment.seat === seat)?.amount ?? 0;
    const bounty = (result.bounty?.seat === seat ? collected : 0) - paid;
    const net = player.endStack - player.startStack;

    const shown = result.hands
      .filter((hand) => hand.seat === seat)
      .map((hand): HandShown => {
        const value = evaluateHand(hand.cards);

        return { board: hand.run, rank: value.score, category: value.category, name: hand.name, cards: hand.cards };
      });

    const busted = player.endStack === 0;
    const takers = new Set<number>();

    if (busted && paid > 0) {
      // They had chips left when the pots were paid, some of them perhaps won there, and the bounty took the last
      takers.add(result.bounty!.seat);
    } else if (busted) {
      for (const each of result.pots) {
        if (each.eligible.includes(seat)) {
          each.awards.filter((award) => award.amount > 0).forEach((award) => takers.add(award.seat));
        }
      }
    }

    return {
      seat,
      playerId: player.playerId,
      name: player.name,
      putIn: tookOut + bounty - net,
      tookOut,
      bounty,
      net,
      folded,
      wins,
      cards: player.cards,
      shown,
      busted,
      bustedBy: [...takers].sort((a, b) => a - b),
    };
  });

  return {
    number: record.number,
    at: record.at,
    ended: endingOf(result),
    bombPot: record.bombPot,
    boards: record.boards.length,
    runTwice: record.boards.length > boardsDealt(record.bombPot),
    bigBlind: record.bigBlind,
    pot,
    players,
  };
}
