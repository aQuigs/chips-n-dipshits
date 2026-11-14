import { formatAmount, shortAmount } from '../../engine/amounts.ts';
import type { Denominated } from '../../engine/amounts.ts';
import { onTheClock } from '../../engine/betting.ts';
import { BOARD_SIZE } from '../../engine/boards.ts';
import type { ChanceFigure } from '../../engine/chances.ts';
import { midSentence } from '../../engine/handNames.ts';
import type { HandRead } from '../../engine/handNames.ts';
import type { PotAward } from '../../engine/types.ts';
import type { HandView, Holding, SeatView, TableView } from '../../engine/view.ts';
import type { BoardCard, Place } from '../motion.ts';
import type { ShownChances } from '../tableChances.ts';
import { cardEl, h } from '../ui.ts';
import { nightOver } from './night.ts';
import { hostOrCohost, roleMark } from './roles.ts';

/** Whether the table is drawn lying down (desktop, landscape) or standing up (a phone held upright). */
export type Shape = 'wide' | 'tall';

/** Which edge of a seat sits at its spot, so seats along the top and bottom grow inward instead of off the screen. */
type Anchor = 'top' | 'middle' | 'bottom';

type SeatSpot = [x: number, y: number, anchor: Anchor];
/** A bet's place. One above or below the middle says how many rows of bets lie between it and the middle. */
type Spot = [x: number, y: number, rowsOut?: number];

// Where each seat sits, in percent of the stage, going clockwise from the viewer at the bottom
const SEAT_SPOTS: Record<Shape, SeatSpot[]> = {
  wide: [
    [50, 99, 'bottom'],
    [27, 97, 'bottom'],
    [8, 65, 'middle'],
    [8, 34, 'middle'],
    [27, 2, 'top'],
    [50, 2, 'top'],
    [73, 2, 'top'],
    [92, 34, 'middle'],
    [92, 65, 'middle'],
    [73, 97, 'bottom'],
  ],
  tall: [
    [50, 99.5, 'bottom'],
    [15, 79, 'middle'],
    [14, 59, 'middle'],
    [14, 39, 'middle'],
    [15, 19, 'middle'],
    [50, 0.5, 'top'],
    [85, 19, 'middle'],
    [86, 39, 'middle'],
    [86, 59, 'middle'],
    [85, 79, 'middle'],
  ],
};

// Where each seat's bet sits: between the seat and the middle, clear of the boards. A standing table has no
// room for a bet between a side seat and the boards, so those bets go just above and below the middle, and
// the bets of the seats next to them a row further out.
const BET_SPOTS: Record<Shape, Spot[]> = {
  wide: [[50, 70], [33, 70], [22, 59], [22, 41], [33, 30], [50, 30], [67, 30], [78, 41], [78, 59], [67, 70]],
  tall: [[50, 73], [33, 71, 1], [33, 59, 0], [33, 41, 0], [33, 28, 1], [50, 24], [67, 28, 1], [67, 41, 0], [67, 59, 0], [67, 71, 1]],
};

const ACTION_LABELS: Record<string, string> = {
  'small blind': 'SB',
  'big blind': 'BB',
  'missed big blind': 'Missed BB',
  straddle: 'Straddle',
  'double straddle': 'Double straddle',
  'button straddle': 'Straddle',
  'Mississippi straddle': 'Straddle',
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
};

export interface TableHandlers {
  onSit(seat: number): void;
  onStart(): void;
  onPlayOn(): void;
  /** While the host picks a new seat for a player: who, and where a pick goes. */
  moving?: { playerId: string; to(seat: number): void };
}

function seatPlace(shape: Shape, slot: number): { class: string; style: Record<string, string> } {
  const [x, y, anchor] = SEAT_SPOTS[shape][slot]!;

  // As custom properties, so the stylesheet can keep a seat near an edge from hanging off it
  return { class: `seat at-${anchor}`, style: { '--x': `${x}%`, '--y': `${y}%` } };
}

function betPlace(shape: Shape, slot: number): Record<string, string> {
  const [x, y, rowsOut] = BET_SPOTS[shape][slot]!;

  if (rowsOut === undefined) {
    return { left: `${x}%`, top: `${y}%` };
  }

  // The boards and the pot keep their size on a short table, where a share of its height stops clearing them
  const fromTheMiddle = `max(${Math.abs(y - 50)}%, var(--center-reach) + ${rowsOut} * var(--bet-row))`;

  return { left: `${x}%`, top: `calc(50% ${y < 50 ? '-' : '+'} ${fromTheMiddle})` };
}

const moveNote = (seat: number) => `Moves to seat ${seat + 1} after this hand`;

function sum(amounts: number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}

function statusOf(seat: SeatView, hand: HandView | null): string | null {
  if (seat.leaving) {
    return 'Leaving';
  }

  if (seat.away) {
    return 'Away';
  }

  if (seat.inHand && !seat.folded && seat.allIn) {
    return 'All in';
  }

  // The small blind's offer stands until the big blind answers it
  if (hand?.stage === 'chop' && seat.seat === hand.sbSeat) {
    return 'Chop?';
  }

  // The player on the clock is making a new decision, so their earlier one this street is old news
  if (seat.inHand && seat.lastAction && hand?.stage === 'betting' && hand.toAct !== seat.seat) {
    return ACTION_LABELS[seat.lastAction] ?? null;
  }

  if (seat.folded) {
    return 'Fold';
  }

  if (!seat.inHand && seat.stack === 0) {
    return 'Out of chips';
  }

  if (seat.sittingOut) {
    return 'Sitting out';
  }

  // Back at the table with blinds to settle: why they have no cards, for everyone to see
  if (!seat.inHand && seat.comesIn === 'big blind') {
    return 'Waiting for BB';
  }

  if (!seat.inHand && (seat.comesIn === 'button' || seat.comesIn === 'posting')) {
    return 'Waiting to post';
  }

  return null;
}

const dealerButtonEl = (title: string) => h('div.dealer-button', { title }, 'D');

/** The line under a seat for the hand it showed down. */
function shownLabel(seat: SeatView, hand: HandView): string | null {
  return hand.result?.hands.find((entry) => entry.seat === seat.seat)?.name ?? null;
}

/** A hand's name with what follows its kind set apart, so that where a line has no room for it the kind can stand alone. */
function nameEl(name: string): HTMLElement {
  const [kind, ...ranks] = name.split(', ');

  return h('span.name', null, kind, ranks.length > 0 ? h('span.detail', null, `, ${ranks.join(', ')}`) : null);
}

/**
 * What the viewer's cards make, a line per board, with room in each line for one more short figure.
 * Drawn whether or not the player wants it, so the preference only has to hide it.
 */
function hintEl(holding: Holding): HTMLElement {
  const perBoard = holding.reads.length > 1;

  return h(
    'div.tag.hint',
    { class: perBoard ? 'per-board' : '' },
    holding.reads.map((read, run) =>
      h(
        'div.read',
        null,
        perBoard ? h('span.run', { 'aria-label': `Board ${run + 1}:` }, String(run + 1)) : null,
        nameEl(read.name),
        run === 0 && holding.bounty ? h('span.bounty', null, 'Bounty hand') : null,
      ),
    ),
  );
}

/**
 * Picks out, among cards that could make the viewer's hand, the ones that do and the ones that don't,
 * given the reads they belong to. A hole card under several boards is marked only when every board agrees on it.
 */
function markPlaying(cards: HTMLElement[], reads: readonly HandRead[]): HTMLElement[] {
  const made = reads.filter((read) => read.plays.length > 0);
  if (made.length === 0) {
    return cards;
  }

  for (const card of cards) {
    const playsIn = made.filter((read) => read.plays.includes(card.dataset.card ?? '')).length;

    if (playsIn === made.length) {
      card.classList.add('plays');
    } else if (playsIn === 0) {
      card.classList.add('idle');
    }
  }

  return cards;
}

/**
 * A hand's chance to win, a figure for each board in the order the boards lie, in the line of the plate
 * that otherwise says what its player did. One figure carries its sign; several stand bare, with no
 * room for more on a phone's seat, and the line's title says them in full.
 */
function chanceEl(figures: (ChanceFigure | null)[]): HTMLElement {
  const several = figures.length > 1;
  const inFull = figures.map((figure, board) => `${several ? `board ${board + 1} ` : ''}${figure ? `${figure.text}%` : 'still to come'}`).join(', ');

  return h(
    'div.status.chance',
    { title: `Chance to win: ${inFull}` },
    figures.map((figure) => h('span', { class: figure ? figure.favorite && 'favorite' : 'pending' }, figure ? `${figure.text}${several ? '' : '%'}` : '…')),
  );
}

function seatEl(view: TableView, seat: SeatView, slot: number, shape: Shape, clockOffset: number, moving: string | null, chances: ShownChances | null): HTMLElement[] {
  const hand = view.hand;
  const isMe = view.you.seat === seat.seat;
  const acting = hand !== null && onTheClock(hand) === seat.seat;
  const result = hand?.result;
  const won = sum(result?.winnings.filter((win) => win.seat === seat.seat).map((win) => win.amount) ?? []);
  const bounty = result?.bounty?.seat === seat.seat ? sum(result.bounty.payments.map((payment) => payment.amount)) : 0;
  // A bounty can be all a hand brought in: a big blind everyone folded to, with no small blind or ante, wins nothing else
  const took = won + bounty;
  const status = statusOf(seat, hand);
  // A seat makes a hand per board on more than one, and once they are shown down the result in the middle names them: on a phone it needs the room
  const middleNamesHands = hand?.stage === 'done' && boardsWonOn(hand) > 1;
  const label = hand?.stage === 'done' && !middleNamesHands ? shownLabel(seat, hand) : null;
  const holding = isMe ? (hand?.holding ?? null) : null;
  const hint = holding && !middleNamesHands ? hintEl(holding) : null;
  const place = seatPlace(shape, slot);
  const spot = chances?.seats.indexOf(seat.seat) ?? -1;
  const chance = spot >= 0 ? chanceEl(chances!.boards.map((figures) => figures?.[spot] ?? null)) : null;

  const classes = [
    place.class,
    isMe && 'me',
    acting && 'acting',
    seat.folded && 'folded',
    !seat.inHand && (seat.sittingOut || seat.stack === 0) && 'out',
    took > 0 && 'winner',
    moving === seat.playerId && 'moving',
  ].filter(Boolean);

  // Folded hands leave the table, except the viewer's own, which stays to look at
  const showCards = seat.cards !== null && (!seat.folded || isMe || seat.shown);
  const hole = showCards ? h('div.hole', null, markPlaying(seat.cards!.map((card) => cardEl(card)), holding?.reads ?? [])) : h('div.hole.none');

  let timer: HTMLElement | null = null;
  if (acting && hand.deadline !== null && view.config.actionSeconds > 0) {
    const total = view.config.actionSeconds * 1000;
    const left = Math.max(0, hand.deadline - (Date.now() + clockOffset));
    const fraction = Math.min(1, left / total);

    timer = h('div.timer', null, h('i', { style: { '--from': String(fraction), 'animation-duration': `${left}ms` } }));
  }

  // What each player picked shows as they pick it, as it would be heard at a real table
  let vote: HTMLElement | null = null;
  if (hand?.stage === 'ritVote' && seat.inHand && !seat.folded) {
    vote = h('div.tag.vote', { class: seat.ritVote ? 'picked' : '' }, seat.ritVote ? `${PICKED[seat.ritVote - 1] ?? seat.ritVote} ✓` : 'Deciding…');
  }

  const plate = h(
    'div.plate',
    null,
    h('div.name', { title: seat.name }, h('span', null, seat.name), roleMark(view, seat.playerId)),
    h('div.stack', { title: formatAmount(seat.stack, view.config) }, shortAmount(seat.stack, view.config), seat.pendingAdd > 0 ? h('span.pending', null, ` +${shortAmount(seat.pendingAdd, view.config)}`) : null),
    // The seat has one line. While hands are face up with cards to come it is the hand's chance, as at the result it is
    // what the hand won: that its player is all in, away or leaving is back on it once the hand is over
    took > 0 ? h('div.status.won', null, `+${shortAmount(took, view.config)}`) : (chance ?? (status ? h('div.status', { 'data-status': status }, status) : null)),
    // The seconds left, for everyone: the bar under the name alone is easy to miss until the time is gone
    timer ? h('div.status.clock', { 'data-countdown': hand!.deadline }, '') : null,
    // In the plate, in short: a line under the seat would run onto the next one down the side of a phone's table
    seat.moveTo !== null ? h('div.move-note', { title: moveNote(seat.moveTo), 'aria-label': moveNote(seat.moveTo) }, `→ Seat ${seat.moveTo + 1}`) : null,
    timer,
  );

  const seatNode = h(
    'div',
    { class: classes.join(' '), style: place.style, 'data-seat': seat.seat },
    hole,
    plate,
    hand?.button === seat.seat ? dealerButtonEl('Dealer button') : null,
    vote,
    hint,
    label ? h('div.tag', null, label) : null,
  );

  const nodes = [seatNode];
  if (seat.bet > 0) {
    const bet = chipsEl(seat.bet, view.config, betPlace(shape, slot));

    bet.dataset.bet = String(seat.seat);
    nodes.push(bet);
  }

  return nodes;
}

/** A pile of chips as a bet is drawn: a chip and what it is worth, or the chip alone. `style` says where it lies. */
function chipsEl(amount: number | undefined, table: Denominated, style: Record<string, string>): HTMLDivElement {
  return h('div.bet', { class: amount === undefined ? 'bare' : '', style }, h('i.chip'), amount === undefined ? null : shortAmount(amount, table));
}

function openSeatEl(view: TableView, seat: number, slot: number, shape: Shape, handlers: TableHandlers): HTMLElement {
  const myRequest = view.requests.find((request) => request.playerId === view.you.id && request.kind === 'seat');
  const place = seatPlace(shape, slot);
  // The button takes its turn on a seat nobody is in
  const deadButton = view.hand?.button === seat ? dealerButtonEl('Dealer button, on an empty seat this hand') : null;
  const open = (kind: string, plate: HTMLElement) => h('div', { class: `${place.class} open ${kind}`, style: place.style, 'data-open-seat': seat }, plate, deadButton);
  const moving = handlers.moving;

  // A seat that a move waiting for the hand will fill is not offered to another
  if (moving && !view.seats.some((other) => other?.moveTo === seat)) {
    return open('target', h('button.plate', { type: 'button', 'data-move-to': seat, onclick: () => moving.to(seat) }, 'Move here'));
  }

  if (myRequest?.seat === seat) {
    return open('requested', h('div.plate', null, 'Waiting for the host…'));
  }

  if (view.you.seat !== null || myRequest || nightOver(view)) {
    return open('idle', h('div.plate', { 'aria-hidden': 'true' }, 'Open'));
  }

  return open('', h('button.plate', { type: 'button', 'data-sit': seat, onclick: () => handlers.onSit(seat) }, 'Sit here'));
}

function boardEl(hand: HandView, turning: readonly BoardCard[]): HTMLElement {
  const boards = hand.boards.map((board, run) => {
    const dealt = board.map((card) => cardEl(card));
    // A card being turned over has nothing to say yet about the viewer's hand
    markPlaying(dealt.filter((_card, index) => !turning.some((held) => held.board === run && held.card === index)), hand.holding?.reads.slice(run, run + 1) ?? []);
    const slots = Array.from({ length: BOARD_SIZE }, (_slot, index) => dealt[index] ?? h('div.card.slot'));

    return h('div.board', { 'data-run': run }, slots);
  });

  // Run more than once, each next board only exists once the one before is out. Its place is kept from the start, so the table doesn't shift when it comes
  for (let run = boards.length; run < hand.runs; run++) {
    boards.push(h('div.board.later', { 'data-run': run }, Array.from({ length: BOARD_SIZE }, () => h('div.card.slot'))));
  }

  return h('div.boards', null, boards);
}

/** How many boards a hand's result speaks of: one for a hand everyone else folded, which was won whole however many were out. */
function boardsWonOn(hand: HandView): number {
  return hand.result?.uncontested ? 1 : hand.boards.length;
}

// A pick as the line under a seat says it, short enough for one line on the narrowest seat
const PICKED = ['Once', 'Twice', 'Three'];

/** Boards that paid the same players, in the order of their first board, with what each player took on them all. */
function boardsByWinners(awards: readonly PotAward[], runs: number): { boards: number[]; won: Map<number, number> }[] {
  const ways = new Map<string, { boards: number[]; won: Map<number, number> }>();

  for (let run = 0; run < runs; run++) {
    const here = awards.filter((award) => award.run === run && award.amount > 0);
    const key = [...new Set(here.map((award) => award.seat))].sort((a, b) => a - b).join();
    const way = ways.get(key) ?? { boards: [], won: new Map<number, number>() };

    way.boards.push(run);
    for (const award of here) {
      way.won.set(award.seat, (way.won.get(award.seat) ?? 0) + award.amount);
    }
    ways.set(key, way);
  }

  return [...ways.values()];
}

const COUNT_WORDS = ['', 'one', 'two', 'three'];

/** "Board 2", "Boards 1 and 3", "Both boards", "All three boards". */
function boardsName(boards: number[], of: number): string {
  const numbers = boards.map((board) => String(board + 1));

  if (boards.length === 1) {
    return `Board ${numbers[0]!}`;
  }

  if (boards.length === of) {
    return of === 2 ? 'Both boards' : `All ${COUNT_WORDS[of] ?? of} boards`;
  }

  return `Boards ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)!}`;
}

// More lines than this in the middle of the table run into the seats on a phone
const RESULT_LINES = 3;

// A board's line has room for this many winners with what each took there
const WINNERS_ON_A_LINE = 2;

function resultLines(view: TableView, hand: HandView): string[] {
  const result = hand.result;
  if (!result) {
    return [];
  }

  const nameAt = (seat: number) => view.seats[seat]?.name ?? 'Someone';
  if (result.chopped) {
    return [`${nameAt(hand.sbSeat)} and ${nameAt(hand.bbSeat)} chop the blinds`];
  }

  const amountOf = (chips: number) => formatAmount(chips, view.config);
  const runs = boardsWonOn(hand);
  const lines: string[] = [];
  let fits = true;

  for (const { boards, won } of boardsByWinners(result.pots.flatMap((pot) => pot.awards), runs)) {
    const label = runs > 1 ? `${boardsName(boards, runs)}: ` : '';

    // Several boards keep to a line each way they went: winners who split one, of a tie or of a side pot, are named with what each took and not their hands
    if (runs > 1 && won.size > 1) {
      fits &&= won.size <= WINNERS_ON_A_LINE;
      lines.push(`${label}${[...won].map(([seat, amount]) => `${nameAt(seat)} +${amountOf(amount)}`).join(', ')}`);
      continue;
    }

    for (const [seat, amount] of won) {
      // A line for boards won alike names no hand, which is one per board
      const made = boards.length === 1 ? result.hands.find((shown) => shown.seat === seat && shown.run === boards[0])?.name : undefined;

      lines.push(`${label}${nameAt(seat)} wins ${amountOf(amount)}${made ? ` with ${midSentence(made)}` : ''}`);
    }
  }

  // Folded to a big blind that was the only chips in the hand, which went back to its player
  if (result.uncontested && lines.length === 0) {
    lines.push(`Everyone folded to ${nameAt(result.winnings[0]!.seat)}`);
  }

  const bountyLine = result.bounty ? [`Seven-deuce! ${nameAt(result.bounty.seat)} collects a ${amountOf(sum(result.bounty.payments.map((payment) => payment.amount)))} bounty`] : [];

  if (fits && lines.length + bountyLine.length <= RESULT_LINES) {
    return [...lines, ...bountyLine];
  }

  // More winners than there are lines for, or than a board's line holds: each gets one line, and the play-by-play has every pot
  const winners = [...result.winnings].sort((a, b) => b.amount - a.amount).map((win) => `${nameAt(win.seat)} wins ${amountOf(win.amount)}`);
  const room = RESULT_LINES - bountyLine.length;
  const shown = winners.length > room ? [...winners.slice(0, room - 1), `and ${winners.length - room + 1} more win a share`] : winners;

  return [...shown, ...bountyLine];
}

function messageEl(view: TableView, handlers: TableHandlers): HTMLElement | null {
  const hand = view.hand;

  if (hand?.stage === 'ritVote') {
    return h('div.message', null, 'All in. How many runs?');
  }

  if (hand?.stage === 'done') {
    return h('div.message.result', null, resultLines(view, hand).map((line) => h('div', null, line)));
  }

  if (hand) {
    return null;
  }

  if (nightOver(view)) {
    return h(
      'div.message.night-over',
      null,
      h('div', null, 'The night is over'),
      hostOrCohost(view) ? h('button.btn.primary', { type: 'button', 'data-action': 'play-on', onclick: handlers.onPlayOn }, 'Keep playing') : null,
    );
  }

  const seated = view.seats.filter((seat) => seat !== null).length;

  if (view.nextHandAt !== null) {
    return h('div.message', null, h('div', null, 'Next hand in ', h('span', { 'data-countdown': view.nextHandAt }, '…')));
  }

  if (!view.running) {
    if (hostOrCohost(view)) {
      return h(
        'div.message',
        null,
        h('div', null, seated < 2 ? 'Share the invite link, then start once two players are seated.' : 'Everyone ready?'),
        h('button.btn.primary', { type: 'button', 'data-action': 'start', onclick: handlers.onStart }, view.handCount === 0 ? 'Start the game' : 'Resume the game'),
      );
    }

    return h('div.message', null, view.handCount === 0 ? 'Waiting for the host to start the game' : 'The game is paused');
  }

  return h('div.message', null, 'Waiting for at least two players with chips');
}

/**
 * What of a hand the table draws, for telling whether the table has to be drawn again. The side pots
 * are left out while the betting is on: `potEl` shows them only once it is over, and every bet changes
 * them, so a view that only confirms a bet the table already shows would otherwise draw it all anew.
 */
export function handDrawn(hand: HandView | null): unknown {
  return hand?.stage === 'betting' ? { ...hand, pots: null } : hand;
}

function potEl(table: Denominated, hand: HandView): HTMLElement | null {
  // Once the hand is over the pot has gone to the winners, and the result says who got what
  if (hand.pot === 0 || hand.stage === 'done') {
    return null;
  }

  // While bets are still out, an uncalled one looks like a side pot of its own
  const betsOut = hand.stage === 'betting' || hand.stage === 'chop';
  const sidePots = hand.pots.length > 1 && !betsOut;
  const breakdown = sidePots ? hand.pots.map((pot, index) => `${index === 0 ? 'Main' : `Side ${index}`} ${formatAmount(pot.amount, table)}`).join(' · ') : null;

  return h('div.pot', null, h('span.label', null, hand.bombPot ? 'Bomb pot' : 'Pot'), formatAmount(hand.pot, table), breakdown ? h('div.sidepots', null, breakdown) : null);
}

/**
 * The poker table as one viewer sees it, with their own seat at the bottom. `turning` are the last cards
 * of a runout being turned over: they are drawn, for the turn to show, but say nothing yet of the
 * viewer's hand. `chances` is what to write beside the hands that are face up against each other.
 */
export function tableEl(view: TableView, shape: Shape, clockOffset: number, handlers: TableHandlers, turning: readonly BoardCard[], chances: ShownChances | null): HTMLElement {
  const seatCount = view.seats.length;
  const hero = view.you.seat ?? 0;
  const nodes: HTMLElement[] = [];

  view.seats.forEach((seat, index) => {
    const slot = (index - hero + seatCount) % seatCount;

    if (seat) {
      nodes.push(...seatEl(view, seat, slot, shape, clockOffset, handlers.moving?.playerId ?? null, chances));
    } else {
      nodes.push(openSeatEl(view, index, slot, shape, handlers));
    }
  });

  const hand = view.hand;

  // Those who may move players can drag a seat to an open one
  const movable = hostOrCohost(view) && view.seats.includes(null) && !view.shuffleAfterHand;

  const table = h(
    'div',
    // How many boards the hand is played on, from its first card: the size of their cards and how far the bets stand off follow it
    { class: `table ${shape}${movable ? ' movable' : ''}`, 'data-boards': hand?.runs ?? 1 },
    h('div.felt'),
    h('div.center', null, hand ? boardEl(hand, turning) : null, hand ? potEl(view.config, hand) : null, messageEl(view, handlers)),
    nodes,
  );

  DRAWINGS.set(table, { shape, hero, seats: seatCount, config: view.config });

  return table;
}

/** What a table was drawn from that says where things on it go. */
interface Drawing {
  shape: Shape;
  hero: number;
  seats: number;
  config: Denominated;
}

const DRAWINGS = new WeakMap<HTMLElement, Drawing>();

/** A point on a drawn table, in its own pixels from its top left corner. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A table as `tableEl` drew it, for whatever moves things across it. Every answer is measured on the
 * page or built the way the table builds its own, so another shape of table, or another board, is
 * followed without a word here.
 */
export interface DrawnTable {
  /** The table itself. A table drawn again is another element. */
  element: HTMLElement;
  /** What the table has standing at a place: a seat's cards, its bet, one card of a board. Nothing where it draws nothing. */
  standing(place: Place): HTMLElement[];
  /** The middle of a place. Null where nothing marks it: a seat nobody sits in, a bet's place with no bet on it. */
  middle(place: Place): Point | null;
  /** The middle of something on the table, wherever it is drawn at this moment. */
  middleOf(element: Element): Point;
  /**
   * Makes a stand-in for what the table no longer draws, to be put on `element`: a pile of chips, saying
   * `amount` or bare, a seat's two cards face down, or one card of a board face down, laid out at `place`
   * as the table would draw it there. It lies over everything and under no finger, and taking it off
   * again leaves the table as it was drawn. Null where there is no such place.
   */
  standIn(what: 'chips' | 'cards' | 'card', place: Place, amount?: number): HTMLElement | null;
}

/** The table drawn in `stage` right now, or null while there is none. */
export function drawnTable(stage: Element): DrawnTable | null {
  const element = stage.querySelector<HTMLElement>(':scope > .table');
  const drawing = element && DRAWINGS.get(element);
  if (!element || !drawing) {
    return null;
  }

  const seatEl = (seat: number) => element.querySelector<HTMLElement>(`.seat[data-seat="${seat}"]`);

  // What marks the middle of a place. A bet's place has nothing when no bet is drawn there
  const marker = (place: Place): Element | null => {
    switch (place.at) {
      case 'deck':
        return element.querySelector('.felt');
      case 'pot':
        // Once the hand is over the result stands where the pot stood
        return element.querySelector('.pot') ?? element.querySelector('.center > .message') ?? element.querySelector('.center');
      case 'seat':
        return seatEl(place.seat)?.querySelector('.plate') ?? null;
      case 'cards':
        return seatEl(place.seat)?.querySelector('.hole') ?? null;
      case 'bet':
        return element.querySelector(`.bet[data-bet="${place.seat}"]`);
      case 'board':
        return element.querySelector(`.board[data-run="${place.board}"]`)?.children[place.card] ?? null;
    }
  };

  const middleOf = (target: Element): Point => {
    const box = target.getBoundingClientRect();
    const frame = element.getBoundingClientRect();
    // The page may be drawn smaller than life, as the frames of the theme showcase are. The table's own
    // width is asked of its style, which unlike `offsetWidth` is not rounded to a whole pixel
    const zoom = frame.width / parseFloat(getComputedStyle(element).width) || 1;

    return { x: (box.left + box.width / 2 - frame.left) / zoom, y: (box.top + box.height / 2 - frame.top) / zoom };
  };

  const betSpot = (seat: number) => betPlace(drawing.shape, (seat - drawing.hero + drawing.seats) % drawing.seats);

  // Where a stand-in lies: a bet's own place for one, and for anything else the middle of what marks the place
  const lies = (at: Place): Record<string, string> | null => {
    if (at.at === 'bet') {
      return betSpot(at.seat);
    }

    const spot = marker(at);
    const middle = spot && middleOf(spot);

    return middle && { left: `${middle.x}px`, top: `${middle.y}px` };
  };

  const standIn = (what: 'chips' | 'cards' | 'card', at: Place, amount?: number): HTMLElement | null => {
    const style = lies(at);
    if (!style) {
      return null;
    }

    const made = what === 'chips' ? chipsEl(amount, drawing.config, style) : what === 'cards' ? h('div.hole', { style }, cardEl(null), cardEl(null)) : h('div.board-card', { style }, cardEl(null));

    made.classList.add('stand-in');
    made.setAttribute('aria-hidden', 'true');

    return made;
  };

  return {
    element,
    standing: (at) => {
      const spot = marker(at);

      if (at.at === 'cards') {
        return [...(spot?.querySelectorAll<HTMLElement>('.card') ?? [])];
      }

      const stands = at.at === 'bet' || (at.at === 'board' && spot?.matches('[data-card]'));

      return stands && spot instanceof HTMLElement ? [spot] : [];
    },
    middle: (at) => {
      const spot = marker(at);

      return spot && middleOf(spot);
    },
    middleOf,
    standIn,
  };
}
