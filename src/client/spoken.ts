/*
 * What the page says to someone who hears it read instead of seeing it: how a card and an amount are
 * said, the sentence a seat, the board and the pot each read as, and every line that is announced as
 * the game goes on. All of the wording is here, so it can be read through in one sitting and kept
 * short: whoever plays by ear hears these hundreds of times a night.
 *
 * Nothing here may say more than the screen shows. Every sentence is made from the viewer's own view,
 * which holds no face-down card of anyone else's and nobody else's choices.
 */
import { formatAmount } from '../engine/amounts.ts';
import type { Denominated } from '../engine/amounts.ts';
import { onTheClock } from '../engine/betting.ts';
import { splitWrittenCards } from '../engine/cards.ts';
import type { Card } from '../engine/cards.ts';
import { cardWords, listed, midSentence } from '../engine/handNames.ts';
import { BOARD_NAMES, STREET_TITLES } from '../engine/handWords.ts';
import { roleOf } from '../engine/hosts.ts';
import { timesText } from '../engine/runVote.ts';
import type { FeedEntry } from '../engine/types.ts';
import type { HandView, Holding, RequestView, SeatView, TableView } from '../engine/view.ts';
import type { TableChange } from './tableChange.ts';

// ---- Cards and amounts ----

/** A card as it is said in a list: "ace of spades". */
export const cardSaid = (card: Card): string => cardWords(card).replace(/^the /, '');

export const cardsSaid = (cards: readonly Card[]): string => cards.map(cardSaid).join(', ');

/** A card written as the page writes it, "10♠" or "Q♥", as the card it is. */
function cardWritten(written: string, suit: string): Card {
  const rank = written.slice(0, -1);

  return `${rank === '10' ? 'T' : rank}${suit}`;
}

/**
 * Text with every card written in it said in words, and cards that follow one another set apart by
 * commas: "Flop: Q♠ J♥ 4♦" is "Flop: queen of spades, jack of hearts, four of diamonds".
 */
export function inWords(text: string): string {
  const parts = splitWrittenCards(text);

  return parts
    .map((part, index) => {
      if (part.suit !== null) {
        return cardSaid(cardWritten(part.text, part.suit));
      }

      // Only a space between two cards: they are a list
      return part.text === ' ' && parts[index - 1]?.suit && parts[index + 1]?.suit ? ', ' : part.text;
    })
    .join('');
}

/** Whether text has a card written in it, which is then said otherwise than it is shown. */
export const hasCards = (text: string): boolean => splitWrittenCards(text).some((part) => part.suit !== null);

/** An amount beside another whose unit was just said: money still as money, "$12.50", and chips as their number, "1,500". */
function figure(amount: number, table: Denominated): string {
  if (table.unit === 'cents') {
    return `${amount < 0 ? '-' : ''}$${formatAmount(Math.abs(amount), table)}`;
  }

  return formatAmount(amount, table);
}

/** An amount with what the table plays in, where a bare figure could be anything: "1,500 chips", "$12.50". */
export function amountSaid(amount: number, table: Denominated): string {
  return table.unit === 'cents' ? figure(amount, table) : `${figure(amount, table)} ${Math.abs(amount) === 1 ? 'chip' : 'chips'}`;
}

// ---- The table ----

/** What each line a seat's plate can show is called aloud; null for one the seat's position already says. */
const STATUS_SAID: Record<string, string | null> = {
  SB: null,
  BB: null,
  'Missed BB': 'posted a missed big blind',
  Straddle: 'straddled',
  'Double straddle': 'straddled double',
  Fold: 'folded',
  Check: 'checked',
  Call: 'called',
  Bet: 'bet',
  Raise: 'raised',
  'All in': 'all in',
  Away: 'away',
  Leaving: 'leaving after this hand',
  'Chop?': 'offers to chop',
  'Out of chips': 'out of chips',
  'Sitting out': 'sitting out',
  'Waiting for BB': 'waiting for the big blind',
  'Waiting to post': 'waiting to post',
};

/** What a seat's plate and the things around it show that its sentence has to be told, since the view alone does not say them. */
export interface SeatShown {
  /** The line on the plate, as it is drawn: "Fold", "All in", "Waiting for BB". */
  status: string | null;
  /** What the seat took from the hand, a bounty included; 0 for nothing. */
  took: number;
  /** The seat's chance to win as its plate words it, or null while it shows none. */
  chance: string | null;
  /** The hand it showed down, as the line under the seat names it. */
  made: string | null;
  /** The viewer has muted this player. */
  muted: boolean;
}

function positionSaid(seat: number, hand: HandView | null): string | null {
  if (!hand) {
    return null;
  }

  const parts = [hand.button === seat ? 'dealer' : null, hand.sbSeat === seat ? 'small blind' : null, hand.bbSeat === seat ? 'big blind' : null];

  return parts.filter((part) => part !== null).join(' and ') || null;
}

/** A seat's cards, once for the seat: the viewer's own and any turned up by name, and the rest only as lying face down. */
function cardsOfSeat(seat: SeatView, mine: boolean): string | null {
  const cards = seat.cards;
  if (!cards || (seat.folded && !mine && !seat.shown.some(Boolean))) {
    return null;
  }

  const up = cards.filter((card): card is Card => card !== null);

  if (mine) {
    const seen = cards.filter((card, nth): card is Card => card !== null && Boolean(seat.shown[nth]));
    const told = seen.length === 0 ? '' : seen.length === cards.length ? ', shown to the table' : `, ${cardSaid(seen[0]!)} shown to the table`;

    return `your cards: ${cardsSaid(up)}${told}`;
  }

  if (up.length === 0) {
    return 'cards face down';
  }

  return up.length === cards.length ? `shows ${cardsSaid(up)}` : `shows ${cardsSaid(up)}, the other card face down`;
}

/**
 * A seat as one sentence, in the order it is worth hearing: who, where they sit in the hand, what they
 * have, what they have bet and done, their cards, and then the marks beside their name.
 */
export function seatSaid(view: TableView, seat: SeatView, shown: SeatShown): string {
  const hand = view.hand;
  const mine = view.you.seat === seat.seat;
  const role = roleOf(view, seat.playerId);
  const highHand = view.tonight.highHand.next;
  const status = shown.status === null ? null : shown.status in STATUS_SAID ? STATUS_SAID[shown.status]! : shown.status.toLowerCase();
  const picked = hand?.stage === 'ritVote' && seat.inHand && !seat.folded ? (seat.ritVote ? `picked ${timesText(seat.ritVote)}` : 'still picking') : null;

  const parts = [
    mine ? `${seat.name}, you` : seat.name,
    positionSaid(seat.seat, hand),
    amountSaid(seat.stack, view.config),
    seat.pendingAdd > 0 ? `adding ${figure(seat.pendingAdd, view.config)} after this hand` : null,
    seat.bet > 0 ? `bet ${figure(seat.bet, view.config)}` : null,
    hand !== null && onTheClock(hand) === seat.seat ? 'on the clock' : null,
    shown.took > 0 ? `won ${figure(shown.took, view.config)}` : (shown.chance ?? status),
    picked,
    cardsOfSeat(seat, mine),
    shown.made ? midSentence(shown.made) : null,
    seat.moveTo !== null ? `moves to seat ${seat.moveTo + 1} after this hand` : null,
    role === 'host' ? 'host' : role === 'cohost' ? 'co-host' : null,
    highHand?.playerIds.includes(seat.playerId) ? `holds the high hand, ${midSentence(highHand.name)}` : null,
    shown.muted ? 'muted by you' : null,
  ];

  return `${parts.filter((part) => part !== null).join(', ')}.`;
}

/** What the viewer's own cards make, as the hint under them says it: a hand for each board, and the bounty they would collect. */
export function hintSaid(holding: Holding, table: Denominated): string {
  const several = holding.reads.length > 1;
  const reads = holding.reads.map((read, run) => `${several ? `${BOARD_NAMES[run]!}: ` : ''}${read.name}.`);

  return [...reads, holding.bounty ? `A bounty hand: ${amountSaid(holding.bounty[1], table)} from each player if it wins.` : null].filter((part) => part !== null).join(' ');
}

/** A seat nobody sits in. */
export function openSeatSaid(seat: number, state: 'open' | 'asked' | 'target', deadButton: boolean): string {
  const words = { open: 'open', asked: 'you asked the host for it', target: 'open, to move the player to' };

  return `Seat ${seat + 1}, ${words[state]}${deadButton ? ', the dealer button is here this hand' : ''}.`;
}

/** What the list of seats is called, which says the order they are read in: from seat 1 for everyone, as they are drawn, so it says which is the reader's. */
export const seatsLabel = (view: TableView): string => (view.you.seat === null ? 'Seats, clockwise from seat 1' : `Seats, clockwise from seat 1. Yours is seat ${view.you.seat + 1}`);

/** The cards on the table: each board by name when there are several, and the cards a rabbit hunt showed set apart from them. */
export function boardSaid(hand: HandView): string {
  const several = hand.runs > 1;

  const boards = hand.boards.map((board, run) => {
    const hunted = hand.hunted?.[run] ?? [];
    const name = several ? `${BOARD_NAMES[run]!}: ` : 'Board: ';
    const dealt = board.length > 0 ? cardsSaid(board) : 'no cards yet';

    return `${name}${dealt}${hunted.length > 0 ? `. Would have come, did not count: ${cardsSaid(hunted)}` : ''}.`;
  });

  return boards.join(' ');
}

/** The pot, with its side pots when the table shows them. */
export function potSaid(view: TableView, hand: HandView, breakdown: string | null): string | null {
  if (hand.pot === 0 || hand.stage === 'done') {
    return null;
  }

  return `${hand.bombPot ? 'Bomb pot' : 'Pot'}: ${amountSaid(hand.pot, view.config)}${breakdown ? `, ${breakdown.replaceAll(' · ', ', ')}` : ''}.`;
}

// ---- Names of things that show no words ----

/** The menu button, which shows three bars and, to whoever runs the table, how many requests wait. */
export const menuLabel = (waiting: number): string => (waiting === 0 ? 'Menu' : `Menu, ${waiting} ${waiting === 1 ? 'request' : 'requests'} waiting for you`);

/** A choice of a move ahead that is not on offer says why, since dimmed alone does not. */
export const NOT_ON_OFFER = 'not on offer now';

export const LABELS = {
  skip: 'Skip to your move',
  table: 'The table',
  center: 'Board and pot',
  seats: 'Seats',
  bar: 'Your move',
  notices: 'Notices',
  feed: 'Chat and play-by-play',
  lines: 'Chat and play-by-play, oldest first',
  spoken: 'What is happening at the table',
  sizes: 'Bet sizes',
} as const;

// ---- What is announced ----

const streets = [STREET_TITLES.turn, STREET_TITLES.river].join('|');
// A turn or a river is written with the whole board, of which only the last card is news
const ONE_MORE_CARD = new RegExp(`^((?:(?:${BOARD_NAMES.join('|')}), )?(?:${streets}): )`);

/**
 * A line of the play-by-play or the chat as it is announced: cards in words, a turn or a river as its
 * one new card, a chat line with who said it, and a GIF as that. `gif` says the viewer sees the line
 * as a picture.
 */
export function lineSaid(entry: FeedEntry, gif = false): string {
  if (entry.kind === 'chat') {
    return gif ? `${entry.from} sent a GIF` : `${entry.from}: ${entry.text}`;
  }

  const cards = splitWrittenCards(entry.text).filter((part) => part.suit !== null);
  const lead = ONE_MORE_CARD.exec(entry.text)?.[1];

  if (lead && cards.length > 1) {
    return `${lead}${inWords(cards.at(-1)!.text)}`;
  }

  return inWords(entry.text);
}

/** What a player asks of whoever runs the table, as the line over the table words it: "wants seat 4 with 1,000". */
export function requestText(request: RequestView, table: Denominated): string {
  return request.kind === 'seat' ? `wants seat ${request.seat + 1} with ${formatAmount(request.amount, table)}` : `wants to add ${formatAmount(request.amount, table)}`;
}

/** The requests that are new to whoever runs the table, each as a line; none for anyone else, who is shown none. */
export function requestsSaid(before: TableView, view: TableView): string[] {
  if (view.you.role === 'member') {
    return [];
  }

  const known = new Set(before.requests.map((request) => `${request.playerId} ${request.kind} ${request.seat} ${request.amount}`));

  return view.requests
    .filter((request) => !known.has(`${request.playerId} ${request.kind} ${request.seat} ${request.amount}`))
    .map((request) => `${request.name} ${requestText(request, view.config)}. Approve or deny under Notices.`);
}

/** The viewer's own cards as a hand is dealt to them. */
export const dealtSaid = (cards: readonly Card[]): string => `Your cards: ${cardsSaid(cards)}.`;

/** What the viewer has in front of them once a hand is over. */
export const stackSaid = (stack: number, table: Denominated): string => `You have ${amountSaid(stack, table)}.`;

/**
 * The action is on the viewer: what they face and what is in the pot, which is what a decision needs.
 * Null when the view does not put them on the clock.
 */
export function turnSaid(view: TableView): string | null {
  const hand = view.hand;
  if (!hand) {
    return null;
  }

  if (hand.canAnswerChop) {
    return `Your turn. ${view.seats[hand.sbSeat]?.name ?? 'The small blind'} offers to chop the blinds.`;
  }

  const options = hand.options;
  if (!options) {
    return null;
  }

  const facing = options.canCheck ? 'Check or bet' : `${figure(options.callCost, view.config)} to call`;

  return `Your turn. ${facing}. Pot ${amountSaid(hand.pot, view.config)}.${hand.canOfferChop ? ' You may offer to chop the blinds.' : ''}`;
}

/** Everyone left is all in and the viewer is asked how many times to run the rest: a choice on a clock, like a turn. */
export function voteSaid(hand: HandView): string | null {
  if (!hand.canVote) {
    return null;
  }

  const picks = Array.from({ length: hand.maxRuns }, (_pick, nth) => timesText(nth + 1));

  return `All in. Pick how many times to run it: ${listed(picks).replace(' and ', ' or ')}.`;
}

/** What the viewer may now do that they could not a moment ago and that nothing else tells them of: show their cards, see what would have come. */
export function offersSaid(hand: HandView): string | null {
  const offers = [hand.canShow ? 'You may show your cards.' : null, hand.canHunt ? 'You may see the cards that would have come.' : null];

  return offers.filter((offer) => offer !== null).join(' ') || null;
}

/**
 * What the viewer is told of a hand's end: their stack, if they were in the hand, and what they may now do. It is
 * told by the pot being paid, not by the view having the hand over: while the last cards of an all-in are turned over
 * the page holds the result back, and a stack said then would give away what the screen has yet to show.
 */
export function resultSaid({ before, view, events }: Pick<TableChange, 'before' | 'view' | 'events'>): string[] {
  const hand = view.hand;
  if (before === null || hand?.stage !== 'done' || !events.some(([kind]) => kind === 'win' || kind === 'chop')) {
    return [];
  }

  const seat = view.you.seat === null ? null : view.seats[view.you.seat];

  return [seat?.inHand ? stackSaid(seat.stack, view.config) : null, offersSaid(hand)].filter((line) => line !== null);
}

/** The viewer's clock is running down. */
export const timeSaid = (seconds: number): string => `${seconds} seconds left.`;

/**
 * The seconds left on the clock at which a player is warned, once: late enough to be worth hearing
 * and early enough to act on. None on a clock too short to have both.
 */
export function warnAt(actionSeconds: number): number | null {
  if (actionSeconds >= 20) {
    return 10;
  }

  return actionSeconds >= 10 ? 5 : null;
}

/**
 * A move with its amount, as the button for it is named: the amount in full where the button shortens
 * it to fit, and otherwise the very words on the button, which is what someone who speaks to their
 * device says to press it.
 */
export const sizedSaid = (move: string, amount: number, table: Denominated): string => `${move} ${formatAmount(amount, table)}`;
