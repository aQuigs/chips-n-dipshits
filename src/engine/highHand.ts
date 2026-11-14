/*
 * The high hand: the best five cards turned up at a showdown, and who showed them. It is taken from a
 * hand's facts when the hand ends, by the rule the night's numbers use for each player's best hand, so
 * the two never disagree. A table can set a bonus, which everyone else seated pays its holder when the
 * night ends, or earlier when the host pays it out. Once paid, the next high hand starts from nothing,
 * while the night's own best stays on show, and so does what each player has collected.
 */
import { formatAmount } from './amounts.ts';
import type { Card } from './cards.ts';
import type { HandFacts, HandShown } from './handFacts.ts';
import { listed, madeHandName, midSentence } from './handNames.ts';
import { evaluateHand } from './handRank.ts';
import { splitAmount } from './pots.ts';
import { addFeed, memberOf, recordMove, seatsClockwiseAfter } from './seats.ts';
import { GameError, SEAT_COUNT } from './types.ts';
import type { Ctx, HighHands, ShownDown, TableState, Tonight } from './types.ts';

/** Beside the name of whoever holds it. In Unicode 6.0, so every phone draws it. */
export const HIGH_HAND_MARK = '🏆';

export function newHighHands(): HighHands {
  return { best: null, sincePaid: {}, paid: {} };
}

const rankOf = (cards: readonly Card[]): number => evaluateHand(cards).score;

/** "Four of a kind, kings". */
const highHandName = (cards: readonly Card[]): string => madeHandName(evaluateHand(cards));

/** The best of the hands a player turned up in one hand, one per board: the first board's when they are as good. */
function bestOf(shown: readonly HandShown[]): HandShown | null {
  return shown.reduce<HandShown | null>((best, hand) => (best && best.rank >= hand.rank ? best : hand), null);
}

/** Of those who showed down, the best hand, and everyone who showed it in the same hand: the first shown stays against a later one as good. */
function topOf(shown: Readonly<Record<string, ShownDown>>, among: (playerId: string) => boolean = () => true): { playerIds: string[]; hand: ShownDown } | null {
  let top: { playerIds: string[]; hand: ShownDown; rank: number } | null = null;

  for (const [playerId, hand] of Object.entries(shown)) {
    if (!among(playerId)) {
      continue;
    }

    const rank = rankOf(hand.cards);

    if (!top || rank > top.rank || (rank === top.rank && hand.hand < top.hand.hand)) {
      top = { playerIds: [playerId], hand, rank };
    } else if (rank === top.rank && hand.hand === top.hand.hand) {
      top.playerIds.push(playerId);
    }
  }

  return top && { playerIds: top.playerIds, hand: top.hand };
}

/** The high hand the bonus is paid for next: the best shown down since it was last paid, and who showed it. Null when none has been since. */
export function nextHighHand(highHand: HighHands): { playerIds: string[]; hand: ShownDown } | null {
  return topOf(highHand.sincePaid);
}

/**
 * The high hand of a table saved before it was kept, from the best hand each player showed, which the
 * night's numbers had: when two of them are as good, which came first is not known, so they share it.
 * Nothing has been paid for it.
 */
export function highHandsFrom(tonight: Tonight): HighHands {
  const sincePaid: Record<string, ShownDown> = {};

  for (const [playerId, numbers] of Object.entries(tonight.players)) {
    if (numbers.best) {
      sincePaid[playerId] = { cards: numbers.best, hand: 0 };
    }
  }

  const top = topOf(sincePaid);

  return { best: top && { playerIds: top.playerIds, cards: top.hand.cards, hand: 0 }, sincePaid, paid: {} };
}

/**
 * Takes the high hand from a finished hand's showdown: a better hand than the night's takes it, one as
 * good leaves it where it is, and players who show as good a hand as each other in the same hand share
 * it. What counts as shown is what the night's numbers count as a player's best hand: turned up at a
 * showdown, on any board, won or lost; a hand nobody won, such as a chop, has no showdown. The table is
 * told when the high hand the bonus is paid for next changes hands.
 */
export function takeHighHand(state: TableState, ctx: Ctx, facts: HandFacts): void {
  const highHand = state.tonight.highHand;
  const shown = facts.players.flatMap((player) => {
    const best = bestOf(player.shown);

    return best ? [{ playerId: player.playerId, best }] : [];
  });

  if (shown.length === 0) {
    return;
  }

  for (const { playerId, best } of shown) {
    const had = highHand.sincePaid[playerId];

    if (!had || best.rank > rankOf(had.cards)) {
      highHand.sincePaid[playerId] = { cards: best.cards, hand: facts.number };
    }
  }

  const rank = Math.max(...shown.map(({ best }) => best.rank));
  const holders = shown.filter(({ best }) => best.rank === rank);

  if (!highHand.best || rank > rankOf(highHand.best.cards)) {
    highHand.best = { playerIds: holders.map(({ playerId }) => playerId), cards: holders[0]!.best.cards, hand: facts.number };
  }

  const next = nextHighHand(highHand)!;
  if (next.hand.hand === facts.number) {
    const names = listed(next.playerIds.map((id) => memberOf(state, id).name));
    const name = midSentence(highHandName(next.hand.cards));

    addFeed(state, ctx.now, 'dealer', null, next.playerIds.length > 1 ? `${names} share the high hand with ${name}` : `${names} takes the high hand with ${name}`);
  }
}

/** One player's part of the bonus to one collector, by seat. */
export interface BonusPayment {
  from: number;
  to: number;
  amount: number;
}

/** What paying the bonus now would come to. */
export interface HighHandPayout {
  /** The number of the hand the high hand being paid for was shown in. */
  hand: number;
  /** The seats that collect, in the order the odd chip goes round. */
  collectors: number[];
  payments: BonusPayment[];
}

/**
 * What paying the bonus now would come to, or why it can't be paid. Only someone seated can be handed
 * chips, so a holder who has left passes it to the best hand among those seated. The odd chips of a
 * shared one carry on round from one payer to the next, or every payer's would go to the same collector.
 */
export function highHandPayout(state: TableState): HighHandPayout | { refused: string } {
  if (state.hand) {
    return { refused: 'The high hand is paid between hands. Pause the game, and once this hand is over it can be paid' };
  }

  const bonus = state.config.highHandBonus;
  if (bonus <= 0) {
    return { refused: 'There is no high-hand bonus: it is set in the table settings' };
  }

  const { sincePaid } = state.tonight.highHand;
  if (Object.keys(sincePaid).length === 0) {
    return { refused: state.tonight.highHand.best ? 'No hand has been shown down since the high hand was paid' : 'No hand has been shown down yet' };
  }

  const seatOf = new Map(state.seats.flatMap((seat, index) => (seat ? [[seat.playerId, index] as const] : [])));
  const top = topOf(sincePaid, (playerId) => seatOf.has(playerId));
  if (!top) {
    return { refused: 'Nobody who has shown down since the high hand was last paid is still seated' };
  }

  const collectors = seatsClockwiseAfter(
    top.playerIds.map((id) => seatOf.get(id)!),
    state.buttonSeat ?? SEAT_COUNT - 1,
  );
  const payments: BonusPayment[] = [];
  let oddTo = 0;

  state.seats.forEach((seat, from) => {
    if (!seat || collectors.includes(from)) {
      return;
    }

    const paying = Math.min(bonus, seat.stack);

    for (const [to, amount] of splitAmount(paying, [...collectors.slice(oddTo), ...collectors.slice(0, oddTo)])) {
      if (amount > 0) {
        payments.push({ from, to, amount });
      }
    }

    oddTo = (oddTo + paying) % collectors.length;
  });

  if (payments.length === 0) {
    return { refused: 'Nobody else seated has chips to pay it' };
  }

  return { hand: top.hand.hand, collectors, payments };
}

/** The chat's line for a bonus paid. `by` names whoever paid it out early; null when the night's end did. */
function paidLine(state: TableState, payout: HighHandPayout, by: string | null): string {
  const { config } = state;
  const next = nextHighHand(state.tonight.highHand)!;
  const nameAt = (seat: number) => memberOf(state, state.seats[seat]!.playerId).name;
  const collectors = listed(payout.collectors.map(nameAt));
  const total = formatAmount(
    payout.payments.reduce((sum, payment) => sum + payment.amount, 0),
    config,
  );
  const terms = `${formatAmount(config.highHandBonus, config)} from everyone else seated, ${total} in all`;

  const holderGone = !next.playerIds.some((id) => state.seats.some((seat) => seat?.playerId === id));
  const what =
    holderGone
      ? `${listed(next.playerIds.map((id) => memberOf(state, id).name))} ${next.playerIds.length > 1 ? 'have' : 'has'} left, so the high-hand bonus goes to ${collectors}, the best hand of anyone seated: ${terms}`
      : `${collectors} ${payout.collectors.length > 1 ? 'share' : 'collects'} the high-hand bonus: ${terms}`;

  return by ? `${by} paid out the high hand. ${what}` : what;
}

/**
 * Pays the bonus as `highHandPayout` works it out, counts what each collector took, and starts the
 * next high hand from nothing. Gives back whether anything was paid; `by` names whoever paid it out
 * early, or is null at the night's end.
 */
export function payHighHand(state: TableState, ctx: Ctx, by: string | null): boolean {
  const payout = highHandPayout(state);
  if ('refused' in payout) {
    return false;
  }

  const line = paidLine(state, payout, by);
  const highHand = state.tonight.highHand;

  for (const { from, to, amount } of payout.payments) {
    const payer = state.seats[from]!;
    const collector = state.seats[to]!;

    payer.stack -= amount;
    collector.stack += amount;
    highHand.paid[collector.playerId] = (highHand.paid[collector.playerId] ?? 0) + amount;
    recordMove(state, ctx, 'high hand', memberOf(state, payer.playerId), memberOf(state, collector.playerId), amount);
  }

  highHand.sincePaid = {};
  addFeed(state, ctx.now, 'system', null, line);

  return true;
}

/**
 * Pays the bonus early, at the host's word, for the high hand they were shown: shown in hand `hand`,
 * collected by `to`. Between hands only.
 */
export function payHighHandNow(state: TableState, ctx: Ctx, by: string, hand: number, to: readonly string[]): void {
  const payout = highHandPayout(state);
  if ('refused' in payout) {
    throw new GameError(payout.refused);
  }

  const collectorIds = payout.collectors.map((seat) => state.seats[seat]!.playerId);
  if (payout.hand !== hand || [...collectorIds].sort().join() !== [...to].sort().join()) {
    throw new GameError('The high hand has changed since you looked, so have another look before paying it');
  }

  payHighHand(state, ctx, by);
}

/** The high hand as everyone at the table sees it. */
export interface HighHandView {
  /** Who showed it, by member id. */
  playerIds: string[];
  /** "Four of a kind, kings". */
  name: string;
  cards: Card[];
  /** The number of the hand it was shown in: 0 when that was before the table kept its high hand. */
  hand: number;
}

export interface HighHandsView {
  /** The best hand shown down tonight. Null before any showdown. */
  best: HighHandView | null;
  /** The high hand the bonus is paid for next: the night's best until that is paid, and after it the best shown down since. Null when none has been since. */
  next: HighHandView | null;
  /** What paying the bonus now would come to, as `highHandPayout` works it out, or why it can't be paid. */
  due: { hand: number; playerIds: string[]; total: number } | { refused: string };
  /** What each player has collected of the bonus tonight, the most first. */
  paid: { playerId: string; amount: number }[];
}

function shownAs(playerIds: string[], hand: ShownDown): HighHandView {
  return { playerIds, name: highHandName(hand.cards), cards: hand.cards, hand: hand.hand };
}

export function highHandsView(state: TableState): HighHandsView {
  const { best, paid } = state.tonight.highHand;
  const next = nextHighHand(state.tonight.highHand);
  const payout = highHandPayout(state);
  const total = 'refused' in payout ? 0 : payout.payments.reduce((sum, payment) => sum + payment.amount, 0);

  return {
    best: best && shownAs(best.playerIds, best),
    next: next && shownAs(next.playerIds, next.hand),
    due: 'refused' in payout ? payout : { hand: payout.hand, playerIds: payout.collectors.map((seat) => state.seats[seat]!.playerId), total },
    paid: Object.entries(paid)
      .map(([playerId, amount]) => ({ playerId, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}
