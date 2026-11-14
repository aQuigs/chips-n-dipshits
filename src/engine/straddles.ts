/*
 * Straddles: bets a player chooses to post before the cards, to act last before the flop. Each kind
 * is one entry in `STRADDLES`, and `straddleLine` says which of the players who want one get to post
 * in a hand. Nothing else knows one kind from another: a straddle is posted as a live forced bet under
 * its own name, and the betting starts left of the biggest of those, as it does from the big blind.
 */
import type { HandPosts, Positions } from './forcedBets.ts';
import { seatsClockwiseAfter } from './seats.ts';
import type { PassedOver, Seat, Straddle, StraddlePost, TableConfig, TableState } from './types.ts';

const STRADDLE_BIG_BLINDS = 2;

/** How many times the straddle before it a straddle posted on top of one is. */
const RESTRADDLE_TIMES = 2;

/** The most straddles a hand can have one after the other: the one under the gun and those that double it. */
export const STRADDLES_IN_A_ROW = 2;

/** The settings that are switches. */
type SwitchKey = { [K in keyof TableConfig]: TableConfig[K] extends boolean ? K : never }[keyof TableConfig];

export interface StraddleKind {
  /** What its post is called, in the play-by-play and in a hand's events. */
  what: Straddle;
  /** The table setting that allows it. */
  setting: SwitchKey;
  /** What the table settings and a player's own switch call it. */
  label: string;
  /** How a refusal names it: "The button straddle must be on or off". */
  subject: string;
  /** Allowed at a table whose host never said. */
  byDefault: boolean;
  /** What it costs and when it is a player's to post, told to the player choosing it. */
  says: string;
  /** The seats it may be posted from in a hand, given the straddles posted before it. A seat nobody plays from, or one with a blind in front of it, is never offered it whatever this says. */
  seats(at: Positions, line: readonly StraddlePost[]): readonly number[];
  amount(bigBlind: number, line: readonly StraddlePost[]): number;
}

/** The first player after the big blind, who three-handed is the button. */
function underTheGun({ order, bbSeat }: Positions): number {
  return seatsClockwiseAfter(order, bbSeat)[0]!;
}

const firstStraddle = (bigBlind: number) => STRADDLE_BIG_BLINDS * bigBlind;

/**
 * Every kind of straddle. Another kind is another entry, with its name added to `Straddle` and its
 * switch to `TableConfig` and `CONFIG_SPECS`; the table settings, a player's choice and who posts in a
 * hand all follow from the entry.
 *
 * The order is the order they are listed in for a host and a player, and where two kinds would let a
 * player straddle from the same seat, the earlier names the post.
 */
export const STRADDLES: readonly StraddleKind[] = [
  {
    what: 'straddle',
    setting: 'allowStraddle',
    label: 'Straddle under the gun',
    subject: 'The straddle under the gun',
    byDefault: true,
    says: 'Twice the big blind when you are first to act before the flop. You act last instead.',
    seats: (at, line) => (line.length === 0 ? [underTheGun(at)] : []),
    amount: firstStraddle,
  },
  {
    what: 'double straddle',
    setting: 'allowDoubleStraddle',
    label: 'Double straddle',
    subject: 'The double straddle',
    byDefault: false,
    says: 'Twice the straddle when the player on your right straddles under the gun. You act last instead.',
    // Only on top of a line that began under the gun, and only from the next player: it never passes on round the table
    seats: (at, line) => (line.length > 0 && line.length < STRADDLES_IN_A_ROW && line[0]!.seat === underTheGun(at) ? [seatsClockwiseAfter(at.order, line.at(-1)!.seat)[0]!] : []),
    amount: (_bigBlind, line) => RESTRADDLE_TIMES * line.at(-1)!.amount,
  },
  {
    what: 'button straddle',
    setting: 'allowButtonStraddle',
    label: 'Button straddle',
    subject: 'The button straddle',
    byDefault: false,
    says: 'Twice the big blind when you have the button. The small blind acts first.',
    seats: (at, line) => (line.length === 0 ? [at.button] : []),
    amount: firstStraddle,
  },
  {
    what: 'Mississippi straddle',
    setting: 'allowMississippiStraddle',
    label: 'Mississippi straddle',
    subject: 'The Mississippi straddle',
    byDefault: false,
    says: 'Twice the big blind from any seat without a blind. The button has the first right to it, then the player on its right, and so on.',
    seats: (at, line) => (line.length === 0 ? at.order : []),
    amount: firstStraddle,
  },
];

const BY_NAME = new Map<string, StraddleKind>(STRADDLES.map((kind) => [kind.what, kind]));

export function straddleKind(what: Straddle): StraddleKind {
  return BY_NAME.get(what)!;
}

export function isStraddle(what: unknown): what is Straddle {
  return typeof what === 'string' && BY_NAME.has(what);
}

/** The kinds a table allows, in the order they are listed. */
export function straddlesAllowed(config: TableConfig): StraddleKind[] {
  return STRADDLES.filter((kind) => config[kind.setting]);
}

/** A player says whether they post one kind of straddle whenever it is theirs to post. Kept in the order the kinds are listed. */
export function chooseStraddle(seat: Seat, what: Straddle, on: boolean): void {
  seat.straddles = STRADDLES.map((kind) => kind.what).filter((kind) => (kind === what ? on : seat.straddles.includes(kind)));
}

/** Takes back what players asked for of kinds the table no longer allows, so that allowing one again starts from nobody posting it. */
export function dropStraddlesNotAllowed(state: TableState): void {
  const allowed = straddlesAllowed(state.config).map((kind) => kind.what);

  for (const seat of state.seats) {
    if (seat) {
      seat.straddles = seat.straddles.filter((what) => allowed.includes(what));
    }
  }
}

/**
 * Who straddles in a hand, from what the table allows and what each player dealt in has asked for.
 * `spare` is what a seat has left once everything it posts before a straddle is paid.
 *
 * A hand has one line of straddles: one first straddle, and on top of it only what its own kind lets
 * follow, each bigger than the one before, so the last is the biggest live bet and its player acts
 * last. The right to the first goes round from the button to its right, which leaves under the gun
 * last: the first player in that order who asked for a kind that is posted from their seat, and can
 * cover it, straddles. Nobody straddles on top of a blind, the hand's own or one they missed, and
 * nobody in a hand dealt to two players. A straddle is posted whole or not at all, and a player who
 * cannot cover one is passed like one who did not ask.
 */
export function straddleLine(state: TableState, at: Positions, spare: (seat: number) => number): Pick<HandPosts, 'straddles' | 'passedOver'> {
  const { order, sbSeat, bbSeat, posting = [] } = at;
  const allowed = straddlesAllowed(state.config);
  const asked = (seat: number) => allowed.filter((kind) => state.seats[seat]!.straddles.includes(kind.what));
  const asking = order.filter((seat) => asked(seat).length > 0);
  const straddles: StraddlePost[] = [];
  const passedOver: PassedOver[] = [];

  if (order.length <= 2) {
    return { straddles, passedOver: asking.map((seat) => ({ seat, why: 'two players' })) };
  }

  const blinds = new Set([sbSeat, bbSeat, ...posting]);
  const byRight = [...order].reverse().filter((seat) => asking.includes(seat));
  // Only the first reason is kept, and never the same player twice in the line, so it ends whatever a kind lets follow it
  const settled = (seat: number) => straddles.some((post) => post.seat === seat) || passedOver.some((passed) => passed.seat === seat);

  for (;;) {
    const offers = byRight.flatMap((seat): StraddlePost[] => {
      const kind = settled(seat) ? undefined : asked(seat).find((offered) => offered.seats(at, straddles).includes(seat));

      return kind ? [{ seat, what: kind.what, amount: kind.amount(state.config.bigBlind, straddles) }] : [];
    });
    const open = offers.filter((offer) => !blinds.has(offer.seat));
    const taken = open.findIndex((offer) => spare(offer.seat) >= offer.amount);

    for (const { seat } of offers.filter((offer) => blinds.has(offer.seat))) {
      passedOver.push({ seat, why: 'blind' });
    }

    open.forEach(({ seat, amount }, nth) => {
      if (nth !== taken) {
        passedOver.push(taken >= 0 && taken < nth ? { seat, why: 'right', ahead: open[taken]!.seat } : { seat, why: 'short', amount });
      }
    });

    if (taken < 0) {
      return { straddles, passedOver };
    }

    straddles.push(open[taken]!);
  }
}
