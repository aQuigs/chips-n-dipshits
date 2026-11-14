/*
 * The hand about to be dealt, decided from the table as it stands before a card or a chip moves:
 * where the button is, who is dealt in, what each of them has to post, and what anyone left out owes
 * for it. Nothing else decides any of it; `startHand` carries the plan out.
 *
 * The button moves by the dead-button rule. The big blind goes to the next player every hand, the
 * small blind is on the seat the big blind had, and the button on the seat the small blind had, whether
 * or not anyone is playing from those two seats. So nobody is passed over for a blind or made to post
 * one twice because someone else came or went.
 *
 * A player the blinds pass while they are not dealt in owes them, and so is not simply dealt in again:
 * they post what they owe or wait for the big blind to reach them. What a seat owes, and where the
 * button and the blinds are, is written by this module alone.
 */
import type { Rng } from './cards.ts';
import { forcedBets, positionsOf } from './forcedBets.ts';
import type { ForcedBet, Positions } from './forcedBets.ts';
import { eligibleSeats, seatsClockwiseAfter, stepsClockwise } from './seats.ts';
import type { BlindSeats, BombPot, Seat, TableState } from './types.ts';

/** What keeps a player who owes blinds out of a hand: the big blind has not reached them, or the button has not passed them. */
export type HeldFor = 'big blind' | 'button';

/** A seat's missed blinds, and whether its player has said they will post them. */
export interface Owed {
  seat: number;
  bigBlind: boolean;
  smallBlind: boolean;
  posts: boolean;
}

export interface HandPlan extends Positions {
  /** The seat the button is on, which nobody need be playing from. */
  button: number;
  /** Every forced bet of the hand, in the order they are posted. */
  bets: ForcedBet[];
  /** Players there to play who are not dealt in, and what each is waiting for. */
  held: { seat: number; for: HeldFor }[];
  /** Where the blinds are once the hand is dealt, for the next hand to go on from. */
  blinds: BlindSeats | null;
  /** Every seat that owes a blind once the hand is dealt. */
  owing: Owed[];
}

/** When a player who owes blinds is next dealt a hand that has blinds, as things stand. */
export type ComesIn =
  /** In the next one, with nothing to post for it: the big blind reaches them, or a new game starts. */
  | 'next hand'
  /** In the next one, posting what they owe. */
  | 'posting'
  /** Not in the next one: when the big blind reaches them, or once the button has passed them, posting what they owe. */
  | HeldFor;

/** Asked of a seat at the table or of one in a player's view. */
export function owes(seat: Pick<Seat, 'owesBigBlind' | 'owesSmallBlind'>): boolean {
  return seat.owesBigBlind || seat.owesSmallBlind;
}

function setOwed(seat: Seat, owed: Omit<Owed, 'seat'> | undefined): void {
  seat.owesBigBlind = owed?.bigBlind ?? false;
  seat.owesSmallBlind = owed?.smallBlind ?? false;
  seat.postsOwed = owed?.posts ?? false;
}

/** Who a hand that carries the blinds on is dealt to. */
interface Seating {
  sbSeat: number;
  bbSeat: number;
  /** The seat the button is due on, which had the small blind; null once the big blind has come round to it or past it. */
  buttonSeat: number | null;
  dealtIn: number[];
  posting: number[];
  held: HandPlan['held'];
}

/** Who is dealt in when the blinds move on from where the last hand had them. `ready` is two players or more. */
function seatingFrom(state: TableState, ready: readonly number[], last: BlindSeats): Seating {
  const bbSeat = seatsClockwiseAfter(ready, last.big)[0]!;
  const sbSeat = last.big;

  // Counted round from the big blind, the small blind's seat comes last of all that anyone plays from
  const fromBigBlind = (seat: number) => stepsClockwise(bbSeat, seat);
  const buttonSeat = fromBigBlind(last.small) > 0 && fromBigBlind(last.small) < fromBigBlind(sbSeat) ? last.small : null;

  // Past the button's seat and not yet the big blind, where nobody comes in by posting: they wait for the button to go by
  const behindButton = (seat: number) => seat === sbSeat || (buttonSeat !== null && fromBigBlind(seat) > fromBigBlind(buttonSeat));

  const seating: Seating = { sbSeat, bbSeat, buttonSeat, dealtIn: [], posting: [], held: [] };

  for (const seat of ready) {
    const { postsOwed } = state.seats[seat]!;

    // The big blind settles whatever its player owed
    if (seat === bbSeat || !owes(state.seats[seat]!)) {
      seating.dealtIn.push(seat);
    } else if (!postsOwed) {
      seating.held.push({ seat, for: 'big blind' });
    } else if (behindButton(seat)) {
      seating.held.push({ seat, for: 'button' });
    } else {
      seating.dealtIn.push(seat);
      seating.posting.push(seat);
    }
  }

  // The big blind has nobody to play against: rather than no hand at all, everyone there is dealt in, and owes nothing for it
  return seating.dealtIn.length < 2 ? { ...seating, dealtIn: [...ready], posting: [], held: [] } : seating;
}

/** Where the button is for a hand that carries the blinds on. */
function buttonOf({ dealtIn, sbSeat, bbSeat, buttonSeat }: Seating): number {
  const fromBigBlind = (seat: number) => stepsClockwise(bbSeat, seat);
  const others = dealtIn.filter((seat) => seat !== bbSeat && seat !== sbSeat);

  // Heads-up, the small blind has the button
  if (others.length === 0) {
    return sbSeat;
  }

  // The last seat before the small blind's that the button is due on or a hand is played from. So it is dead when nobody
  // plays from the seat it is due on or from past it, and nobody is ever dealt in behind the button
  return [...others, ...(buttonSeat === null ? [] : [buttonSeat])].reduce((last, seat) => (fromBigBlind(seat) > fromBigBlind(last) ? seat : last));
}

/** Where the button goes when no blinds say: on from where it was to the next player, or to one drawn at random when it was nowhere. */
function buttonMovedOn(state: TableState, ready: readonly number[], rng: Rng): number {
  return state.buttonSeat === null ? ready[rng.int(ready.length)]! : seatsClockwiseAfter(ready, state.buttonSeat)[0]!;
}

/** A hand that carries the game on from the last hand's blinds. */
function carriedOn(state: TableState, ready: readonly number[], last: BlindSeats): HandPlan {
  const seating = seatingFrom(state, ready, last);
  const { sbSeat, bbSeat, dealtIn, posting, held } = seating;
  const button = buttonOf(seating);
  const positions: Positions = { order: seatsClockwiseAfter(dealtIn, button), sbSeat, bbSeat, posting };

  const owed = state.config.missedBlinds === 'owed';
  const passedByBigBlind = (seat: number) => stepsClockwise(last.big, seat) > 0 && stepsClockwise(last.big, seat) < stepsClockwise(last.big, bbSeat);

  const owing = state.seats.flatMap((seat, index): Owed[] => {
    if (!seat || dealtIn.includes(index)) {
      return [];
    }

    // Only a player waiting for the button to pass keeps their choice to post: anyone else who is out of the hand chooses again
    const posts = held.some((entry) => entry.seat === index && entry.for === 'button');

    // The small blind would have followed the big blind to this seat, and they cannot be dealt in before it has
    if (owed && passedByBigBlind(index)) {
      return [{ seat: index, bigBlind: true, smallBlind: true, posts }];
    }

    // The small blind is theirs after the big blind they posted. Someone who took the seat since never had that big blind
    const smallBlind = seat.owesSmallBlind || (owed && index === sbSeat && !seat.owesBigBlind);

    return seat.owesBigBlind || smallBlind ? [{ seat: index, bigBlind: seat.owesBigBlind, smallBlind, posts }] : [];
  });

  return { button, ...positions, bets: forcedBets(state, positions), held, blinds: { small: sbSeat, big: bbSeat }, owing };
}

/**
 * Plans the next hand for a table with at least two players there to play. `bombPot` says the hand is
 * one, which the caller has settled by then. Reads the table and changes nothing; `rng` is drawn from
 * only when there is no button to move on from.
 */
export function planHand(state: TableState, bombPot: BombPot | null, rng: Rng): HandPlan {
  const ready = eligibleSeats(state);

  if (state.blinds && !bombPot) {
    return carriedOn(state, ready, state.blinds);
  }

  // No blinds to go on from, or none in this hand: everyone there to play is dealt in, and the button moves on a player
  const button = buttonMovedOn(state, ready, rng);
  const positions = positionsOf(ready, button);
  const bets = forcedBets(state, positions, bombPot);

  // A bomb pot has no blinds, so none move, none are missed and none are made up: the next hand finds them as they were
  if (bombPot) {
    const owing = state.seats.flatMap((seat, index): Owed[] => (seat && owes(seat) ? [{ seat: index, bigBlind: seat.owesBigBlind, smallBlind: seat.owesSmallBlind, posts: seat.postsOwed }] : []));

    return { button, ...positions, bets, held: [], blinds: state.blinds, owing };
  }

  // A new game: a table's first hand, or the one after a shuffle. Nobody owes anything, and the blinds start left of the button
  return { button, ...positions, bets, held: [], blinds: { small: positions.sbSeat, big: positions.bbSeat }, owing: [] };
}

/** Takes on what a plan decided about the table itself, as its hand is dealt: where the button and the blinds are, and who owes what from here. */
export function takeUp(state: TableState, plan: HandPlan): void {
  state.buttonSeat = plan.button;
  state.blinds = plan.blinds;

  state.seats.forEach((seat, index) => {
    if (seat) {
      setOwed(seat, plan.owing.find((entry) => entry.seat === index));
    }
  });
}

/**
 * When each player who owes blinds and is there to play is next dealt a hand with blinds, as the
 * table stands. A bomb pot in between is dealt to all of them and changes none of it.
 */
export function comingIn(state: TableState): Map<number, ComesIn> {
  // A player with everything in the hand on the table is still in the game until it says otherwise
  const inHand = new Set(state.hand?.players.map((player) => player.seat));
  const ready = state.seats.flatMap((seat, index) => (seat && !seat.sittingOut && !seat.leaving && (seat.stack > 0 || inHand.has(index)) ? [index] : []));

  const seating = state.blinds && ready.length > 1 ? seatingFrom(state, ready, state.blinds) : null;
  const held = new Map(seating?.held.map((entry): [number, ComesIn] => [entry.seat, entry.for]));

  return new Map(
    ready
      .filter((seat) => owes(state.seats[seat]!))
      .map((seat): [number, ComesIn] => [seat, held.get(seat) ?? (seating?.posting.includes(seat) ? 'posting' : 'next hand')]),
  );
}

/** What a player owes as they take a seat: a big blind at a table with a game going, since they come in ahead of their turn for it. */
export function owedOnSitting(state: TableState): Pick<Seat, 'owesBigBlind' | 'owesSmallBlind' | 'postsOwed'> {
  return { owesBigBlind: state.blinds !== null && state.config.missedBlinds === 'owed', owesSmallBlind: false, postsOwed: false };
}

/** A player says how they settle what they owe: by posting it on the first hand they can be dealt, or by waiting for the big blind. */
export function choosePosting(seat: Seat, post: boolean): void {
  seat.postsOwed = post && owes(seat);
}

export function forgive(seat: Seat): void {
  setOwed(seat, undefined);
}

export function forgiveEveryone(state: TableState): void {
  for (const seat of state.seats) {
    if (seat) {
      forgive(seat);
    }
  }
}

/** Ends the game the blinds were moving in, so the next hand starts a new one: the button drawn afresh and nothing owed. */
export function startOver(state: TableState): void {
  state.buttonSeat = null;
  state.blinds = null;
  forgiveEveryone(state);
}

/**
 * The host moved a player from one seat to another. The button and the blinds belong to the order
 * the players sit in: a move that passes nobody leaves that order as it was, so what was on the old
 * seat goes with the player. A move past someone changes the order, and what was on the old seat stays
 * there, as when a player leaves.
 *
 * A blind left on a seat nobody is in holds a place in that order as its player did. So a move past
 * such a seat, or onto it, leaves everything where it was too: the two blinds are never on one seat.
 */
export function followMove(state: TableState, from: number, to: number): void {
  const blindOn = (index: number) => index === state.blinds?.small || index === state.blinds?.big;
  const passes = (start: number, end: number) => state.seats.some((seat, index) => (seat !== null || blindOn(index)) && stepsClockwise(start, index) > 0 && stepsClockwise(start, index) < stepsClockwise(start, end));

  if (blindOn(to) || (passes(from, to) && passes(to, from))) {
    return;
  }

  const moved = (seat: number) => (seat === from ? to : seat);

  if (state.buttonSeat !== null) {
    state.buttonSeat = moved(state.buttonSeat);
  }

  if (state.blinds) {
    state.blinds = { small: moved(state.blinds.small), big: moved(state.blinds.big) };
  }
}
