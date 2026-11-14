/*
 * Badges: what a player earns in a hand for the things people brag and groan about, such as quads,
 * winning with seven-deuce or felting someone. Each is one entry in `BADGES`, earned by a rule over the
 * hand's facts and what the hand did to the player's numbers for the night, and nothing else: never the
 * table, never a card nobody was shown. Nothing outside this file knows one badge from another.
 */
import { isSevenDeuce, rankOf } from './cards.ts';
import { somebodyWon } from './handFacts.ts';
import type { HandFacts, HandShown, PlayerFacts } from './handFacts.ts';
import { listed, midSentence } from './handNames.ts';
import { ACE, FOUR_OF_A_KIND, HIGH_CARD, STRAIGHT_FLUSH } from './handRank.ts';
import { addFeed } from './seats.ts';
import { countBadge } from './tonight.ts';
import type { Counted } from './tonight.ts';
import type { Ctx, TableState } from './types.ts';

export interface Badge {
  /** Saved with the night's numbers, and with a player's results after it: never changed or reused. */
  id: string;
  name: string;
  /** One symbol that stands for it where the name has no room, such as beside a player's name. */
  mark: string;
  /** What earns it, in a line. */
  description: string;
  /** Whether `player` earned it in `hand`, which somebody won. `night` is what the hand did to their numbers. */
  earned(hand: HandFacts, player: PlayerFacts, night: Counted): boolean;
  /** What they did to earn it this time, for the play-by-play. The description says it when this is left out. */
  story?(hand: HandFacts, player: PlayerFacts): string;
}

/** A badge as a player holds it: earned once a night, and counted each time they earn it again. */
export interface EarnedBadge {
  id: string;
  times: number;
}

const POT_IN_BIG_BLINDS = 100;
const IN_A_ROW = 3;
const BROKE = 3;

/** How many of a hand's five cards make what it is called: all five of a straight flush, the four of four of a kind. */
const MAKING: Record<number, number> = { [STRAIGHT_FLUSH]: 5, [FOUR_OF_A_KIND]: 4 };

/**
 * The hands of a category the player turned up at a showdown with a card of their own in what makes it.
 * Four of a kind or a straight flush on the board is everyone's, and nobody's to brag about.
 */
function ownShown(player: PlayerFacts, category: number): HandShown[] {
  const own = new Set(player.cards ?? []);

  return player.shown.filter((hand) => hand.category === category && hand.cards.slice(0, MAKING[category]).some((card) => own.has(card)));
}

const isRoyal = (hand: HandShown): boolean => rankOf(hand.cards[0]!) === ACE;

/** Four of a kind, a straight flush or a royal flush of their own that they turned up. */
const monsters = (player: PlayerFacts): HandShown[] => [...ownShown(player, FOUR_OF_A_KIND), ...ownShown(player, STRAIGHT_FLUSH)];

/** Whether they won a pot on that board against somebody: a side pot nobody else was in for is no win at a showdown. */
const wonOn = (player: PlayerFacts, board: number): boolean => player.wins.some((win) => win.board === board && win.contested);

const named = (hands: HandShown[]): string => midSentence(hands[0]!.name);

/**
 * Whether the player won the hand outright, as the seven-deuce bounty counts it: everyone else folded,
 * or at a showdown their hand beat every other one turned up, on every board the main pot paid out on.
 */
function wonOutright(hand: HandFacts, player: PlayerFacts): boolean {
  if (hand.ended === 'folds') {
    return !player.folded;
  }

  // A main pot too small to split leaves a board with nothing of it, and the bounty does not ask who won there
  const played = Array.from({ length: hand.boards }, (_board, board) => board).filter((board) => hand.players.some((other) => other.wins.some((win) => win.pot === 0 && win.board === board)));

  return played.every((board) => {
    const mine = player.shown.find((shown) => shown.board === board);
    const others = hand.players.filter((other) => other !== player).flatMap((other) => other.shown.filter((shown) => shown.board === board));

    return mine !== undefined && others.every((other) => other.rank < mine.rank);
  });
}

/** Who the player took the last chip of, alone. A player broken by a split pot was felted by nobody. */
const felted = (hand: HandFacts, player: PlayerFacts): PlayerFacts[] => hand.players.filter((other) => other.bustedBy.length === 1 && other.bustedBy[0] === player.seat);

/** Every third time a count goes up, which is the first time it reaches a multiple of `every`. */
const reached = (before: number, after: number, every: number): boolean => after > before && after % every === 0;

/** The badges, in the order they are shown. An id, once released, is kept forever. */
export const BADGES: readonly Badge[] = [
  {
    id: 'royal',
    name: 'Royal Flush',
    mark: '💎',
    description: 'Showed down a royal flush with a card of their own in it. Frame it.',
    earned: (_hand, player) => ownShown(player, STRAIGHT_FLUSH).some(isRoyal),
  },
  {
    id: 'straightFlush',
    name: 'Straight Flush',
    mark: '🚽',
    description: 'Showed down a straight flush short of royal, with a card of their own in it.',
    earned: (_hand, player) => ownShown(player, STRAIGHT_FLUSH).some((hand) => !isRoyal(hand)),
    story: (_hand, player) => named(ownShown(player, STRAIGHT_FLUSH).filter((hand) => !isRoyal(hand))),
  },
  {
    id: 'quads',
    name: 'Quads',
    mark: '🍀',
    description: 'Showed down four of a kind with a card of their own in the four, won or lost.',
    earned: (_hand, player) => ownShown(player, FOUR_OF_A_KIND).length > 0,
    story: (_hand, player) => named(ownShown(player, FOUR_OF_A_KIND)),
  },
  {
    id: 'bigPot',
    name: 'Retirement Fund',
    mark: '💰',
    description: `Took ${POT_IN_BIG_BLINDS} big blinds or more out of one hand.`,
    earned: (hand, player) => hand.bigBlind > 0 && player.tookOut >= POT_IN_BIG_BLINDS * hand.bigBlind,
  },
  {
    id: 'heater',
    name: 'Heater',
    mark: '🔥',
    description: `Won ${IN_A_ROW} hands in a row.`,
    earned: (_hand, _player, { before, after }) => reached(before.streak, after.streak, IN_A_ROW),
  },
  {
    id: 'felted',
    name: 'Felted',
    mark: '💀',
    description: 'Took the last chip off another player, with no help.',
    earned: (hand, player) => felted(hand, player).length > 0,
    story: (hand, player) => {
      const broke = felted(hand, player);

      return `took ${listed(broke.map((other) => `${other.name}'s`))} last ${broke.length > 1 ? 'chips' : 'chip'}`;
    },
  },
  {
    id: 'scoop',
    name: 'Double Scoop',
    mark: '🍦',
    description: 'Took every chip of a showdown on two boards.',
    earned: (hand, player) => hand.boards === 2 && hand.ended === 'showdown' && player.tookOut === hand.pot,
  },
  {
    id: 'sevenDeuce',
    name: 'Seven-Deuce',
    mark: '💩',
    description: 'Won a hand outright with seven-deuce, as the bounty counts it, with the table seeing the cards.',
    earned: (hand, player) => player.cards !== null && isSevenDeuce(player.cards) && wonOutright(hand, player),
  },
  {
    id: 'airBall',
    name: 'Nothing Burger',
    mark: '🍔',
    description: 'Won a showdown without so much as a pair.',
    earned: (_hand, player) => player.shown.some((shown) => shown.category === HIGH_CARD && wonOn(player, shown.board)),
  },
  {
    id: 'cooler',
    name: 'Cooler',
    mark: '❄️',
    description: 'Showed down four of a kind or better of their own, and won nothing on that board.',
    earned: (_hand, player) => monsters(player).some((shown) => !wonOn(player, shown.board)),
    story: (_hand, player) => `lost with ${named(monsters(player).filter((shown) => !wonOn(player, shown.board)))}`,
  },
  {
    id: 'atm',
    name: 'ATM',
    mark: '🏧',
    description: `Went broke ${BROKE} times in one night. Thanks for your business.`,
    earned: (_hand, _player, { before, after }) => reached(before.busts, after.busts, BROKE),
  },
];

const BY_ID = new Map(BADGES.map((badge) => [badge.id, badge]));

/** The badge with that id, or undefined for one this code does not know. */
export function badgeOf(id: string): Badge | undefined {
  return BY_ID.get(id);
}

/** A player's badges as saved, in the order they are shown, leaving out any this code does not know. */
export function badgesIn(saved: Readonly<Record<string, number>>): EarnedBadge[] {
  return BADGES.filter((badge) => saved[badge.id]).map((badge) => ({ id: badge.id, times: saved[badge.id]! }));
}

/** The line in the play-by-play that tells the table a badge was earned. */
function earnedLine(badge: Badge, hand: HandFacts, player: PlayerFacts, times: number): string {
  // The first sentence of the description says what earned it; lines of the play-by-play end without a stop, as the dealer's do
  const story = badge.story?.(hand, player) ?? badge.description.split('. ')[0]!.replace(/\.$/, '');

  return `${player.name} earned ${badge.mark} ${badge.name}${times > 1 ? ` ×${times}` : ''}: ${midSentence(story)}`;
}

/**
 * Gives everyone in a finished hand the badges it earned them, and tells the table. A hand that nobody
 * won, as one whose pot went back to its players, earns nothing. `counted` is what the hand did to each
 * player's numbers, by member id.
 */
export function earnBadges(state: TableState, ctx: Ctx, facts: HandFacts, counted: ReadonlyMap<string, Counted>): void {
  if (!somebodyWon(facts)) {
    return;
  }

  for (const player of facts.players) {
    const night = counted.get(player.playerId)!;

    for (const badge of BADGES) {
      if (badge.earned(facts, player, night)) {
        const times = countBadge(state.tonight, player.playerId, badge.id);

        addFeed(state, ctx.now, 'dealer', null, earnedLine(badge, facts, player, times));
      }
    }
  }
}
