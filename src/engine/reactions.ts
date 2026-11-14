/*
 * Reactions and throws: an emoji a seated player pops up over their own seat, or something they throw
 * at another player's. They are kept on the table for a few seconds and then are gone, and they touch
 * nothing else: no hand, no turn, no clock, no stack and no line of the chat or the play-by-play.
 *
 * Every one costs the server what a bet does, a write of the table's row under the lock the bets wait
 * on, so they are limited by the table's clock, for each player and for the table as a whole.
 */
import { GameError } from './types.ts';
import type { Reaction, TableState } from './types.ts';

export interface ReactionKind {
  /** Saved with the table while the reaction is live, and sent back by the page: never changed or reused. */
  id: string;
  /** One emoji every phone draws. */
  mark: string;
  /**
   * What it is called aloud, written to stand in a sentence: "Sam is laughing", "Sam threw a tomato at
   * Dana". What a screen reader says of the control and of the reaction shown comes from here.
   */
  name: string;
  /** Thrown at another player's seat, rather than shown over the sender's own. */
  thrown: boolean;
}

/** Every reaction there is: what pops up over a player's own seat, then what can be thrown at another's. */
export const REACTIONS: readonly ReactionKind[] = [
  { id: 'laugh', mark: '😂', name: 'laughing', thrown: false },
  { id: 'cry', mark: '😭', name: 'crying', thrown: false },
  { id: 'fume', mark: '😡', name: 'fuming', thrown: false },
  { id: 'shock', mark: '😱', name: 'shocked', thrown: false },
  { id: 'pray', mark: '🙏', name: 'praying', thrown: false },
  { id: 'clap', mark: '👏', name: 'clapping', thrown: false },

  { id: 'tomato', mark: '🍅', name: 'a tomato', thrown: true },
  { id: 'fish', mark: '🐟', name: 'a fish', thrown: true },
  { id: 'chicken', mark: '🐔', name: 'a chicken', thrown: true },
  { id: 'poop', mark: '💩', name: 'poop', thrown: true },
  { id: 'beer', mark: '🍺', name: 'a beer', thrown: true },
  { id: 'rose', mark: '🌹', name: 'a rose', thrown: true },
];

/**
 * How long a reaction stays on the table, and in every view of it, after it is made. Longer than the
 * page shows one for: a reaction reaches the other pages a few seconds late, at their next poll.
 */
export const REACTION_LIFE_MS = 8000;

/**
 * The most reactions live on a table at once, which is also the most that can be made in any
 * `REACTION_LIFE_MS`: about one write every two seconds, what one player betting makes, so a pile-on
 * never queues more than a few writes in front of a bet.
 */
export const REACTIONS_LIVE = 4;

/** How soon after their last a player may react again: two at most of the table's four at a time. */
export const REACTION_GAP_MS = 4000;

export function reactionKind(id: unknown): ReactionKind | null {
  return REACTIONS.find((kind) => kind.id === id) ?? null;
}

/** The reactions still on the table at `now`, oldest first. */
export const liveReactions = (reactions: readonly Reaction[], now: number): Reaction[] => reactions.filter((reaction) => now - reaction.at < REACTION_LIFE_MS);

/**
 * Why `from` may not react at `now`, given the reactions live on the table, or null when they may.
 * The page asks the same before it offers the picker, so a player is seldom refused at all.
 */
export function reactionRefusal(live: readonly Reaction[], from: string, now: number): string | null {
  if (live.some((reaction) => reaction.from === from && now - reaction.at < REACTION_GAP_MS)) {
    return 'One at a time: give it a few seconds';
  }

  if (live.length >= REACTIONS_LIVE) {
    return 'Plenty flying already: try again in a moment';
  }

  return null;
}

/** `from` pops a reaction over their own seat, or throws one at the seated player `to`. */
export function addReaction(state: TableState, now: number, from: string, kind: unknown, to: unknown): void {
  const what = reactionKind(kind);
  if (!what) {
    throw new GameError('Unknown reaction');
  }

  if (what.thrown) {
    if (to === from) {
      throw new GameError('Throw it at someone else');
    }

    if (typeof to !== 'string' || !state.seats.some((seat) => seat?.playerId === to)) {
      throw new GameError('That player is not at the table');
    }
  } else if (to !== undefined) {
    throw new GameError('That is not something to throw');
  }

  const live = liveReactions(state.reactions, now);
  const refusal = reactionRefusal(live, from, now);
  if (refusal) {
    throw new GameError(refusal);
  }

  // Only what is live is kept, so the table holds `REACTIONS_LIVE` at most whatever the night brings
  state.reactions = [...live, what.thrown ? { from, kind: what.id, at: now, to: to as string } : { from, kind: what.id, at: now }];
}

/**
 * A reaction in words, by the names of who made it and who it was thrown at: "Sam is laughing", "Sam
 * threw a tomato at Dana". `members` is the table's, or a view's: a name no longer there is "Someone".
 */
export function reactionText(reaction: Reaction, members: readonly { id: string; name: string }[]): string {
  const what = reactionKind(reaction.kind);
  const nameOf = (id: string | undefined) => members.find((member) => member.id === id)?.name ?? 'Someone';

  if (!what?.thrown) {
    return `${nameOf(reaction.from)} is ${what?.name ?? 'reacting'}`;
  }

  return `${nameOf(reaction.from)} threw ${what.name} at ${nameOf(reaction.to)}`;
}
