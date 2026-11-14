/*
 * A table's bounties: starting hands, each with what every other player dealt in pays whoever wins
 * with it. When a hand pays is `payBounty` in `hand.ts`; this is which bounty a player's cards are.
 */
import { formatAmount, validAmount } from './amounts.ts';
import type { Denominated } from './amounts.ts';
import type { Card } from './cards.ts';
import { listed } from './handNames.ts';
import { parseStartingHand, startingHandOf } from './startingHands.ts';
import { GameError } from './types.ts';

/** A starting hand in kept form and what each player pays for it. A pair, not an object: a table keeps its list twice, in its settings and on the hand in play. */
export type Bounty = [hand: string, amount: number];

/** The hand a bounty was paid for wherever a table or a record from before bounties were a list names none. */
export const SEVEN_DEUCE = '72';

/** What a list of bounties may hold, beside the hand and amount of each. */
export interface BountyLimits {
  /** The fewest of the table's smallest unit a bounty can be. */
  min: number;
  max?: number;
  /** The most hands on the list. */
  most: number;
}

/**
 * The bounty a player's cards collect on, of a list: the one for the very hand when both the ranks
 * written bare and the same ranks suited or offsuit are on it, so a table can pay more for 72s than
 * for the rest of 72 and a hand is never paid twice. Two entries can only both match in that way, since
 * the same hand written twice is refused.
 */
export function bountyFor(cards: readonly Card[], bounties: readonly Bounty[]): Bounty | null {
  if (cards.length !== 2) {
    return null;
  }

  const exactly = startingHandOf(cards);

  return bounties.find(([hand]) => hand === exactly) ?? bounties.find(([hand]) => hand === exactly.slice(0, 2)) ?? null;
}

/** A list of bounties as sent, each hand in kept form and each amount one the table can pay, or a refusal that names the bounty. */
export function validBounties(value: unknown, table: Denominated, limits: BountyLimits): Bounty[] {
  if (!Array.isArray(value)) {
    throw new GameError('The bounties must be a list of hands and amounts');
  }

  if (value.length > limits.most) {
    throw new GameError(`A table can have at most ${limits.most} bounty hands`);
  }

  return value.map((entry: unknown): Bounty => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      throw new GameError('Each bounty must be a hand and an amount');
    }

    const hand = parseStartingHand(entry[0]);

    return [hand, validAmount(entry[1], `The ${hand} bounty`, table, limits.min, limits.max)];
  });
}

/** What is wrong with a list whose every bounty is fine by itself: a hand on it twice, which would leave which one pays to chance. */
export function handListedTwice(bounties: readonly Bounty[]): string | null {
  const twice = bounties.find(([hand], index) => bounties.findIndex(([other]) => other === hand) !== index);

  return twice ? listedTwice(twice[0]) : null;
}

/** The refusal of a hand put on the list a second time. */
export function listedTwice(hand: string): string {
  return `${hand} is on the list of bounties twice: give it one amount`;
}

/** A bounty collected, as the play-by-play and the table's result say it: "Ann collects 150 for the J4s bounty". */
export function bountyWords(winner: string, hand: string, total: string): string {
  return `${winner} collects ${total} for the ${hand} bounty`;
}

/** The list as a sentence reads it: "72 for 25 and J4s for 50", or "none". */
export function bountiesText(bounties: readonly Bounty[], table: Denominated): string {
  return bounties.length === 0 ? 'none' : listed(bounties.map(([hand, amount]) => `${hand} for ${formatAmount(amount, table)}`));
}
