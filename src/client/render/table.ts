import { evaluateHand } from '../../engine/handRank.ts';
import type { HandView, SeatView, TableView } from '../../engine/view.ts';
import { cardEl, chips, h, shortChips } from '../ui.ts';

/** Whether the table is drawn lying down (desktop, landscape) or standing up (a phone held upright). */
export type Shape = 'wide' | 'tall';

/** Which edge of a seat sits at its spot, so seats along the top and bottom grow inward instead of off the screen. */
type Anchor = 'top' | 'middle' | 'bottom';

type SeatSpot = [x: number, y: number, anchor: Anchor];
type Spot = [x: number, y: number];

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

// Where each seat's bet sits: between the seat and the middle, clear of the board
const BET_SPOTS: Record<Shape, Spot[]> = {
  wide: [[50, 70], [33, 70], [22, 59], [22, 41], [33, 30], [50, 30], [67, 30], [78, 41], [78, 59], [67, 70]],
  tall: [[50, 73], [33, 71], [33, 59], [33, 41], [33, 28], [50, 24], [67, 28], [67, 41], [67, 59], [67, 71]],
};

const BOARD_SIZE = 5;

const ACTION_LABELS: Record<string, string> = {
  'small blind': 'SB',
  'big blind': 'BB',
  straddle: 'Straddle',
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
};

export interface TableHandlers {
  onSit(seat: number): void;
  onStart(): void;
}

function seatPlace(shape: Shape, slot: number): { class: string; style: Record<string, string> } {
  const [x, y, anchor] = SEAT_SPOTS[shape][slot]!;

  // As custom properties, so the stylesheet can keep a seat near an edge from hanging off it
  return { class: `seat at-${anchor}`, style: { '--x': `${x}%`, '--y': `${y}%` } };
}

function betPlace(shape: Shape, slot: number): Record<string, string> {
  const [x, y] = BET_SPOTS[shape][slot]!;

  return { left: `${x}%`, top: `${y}%` };
}

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

  return null;
}

/** What the viewer currently holds, e.g. "Pair of Aces", once there is a flop to make a hand with. */
function holdingName(seat: SeatView, hand: HandView): string | null {
  const board = hand.boards[0] ?? [];
  const cards = seat.cards;

  if (hand.boards.length > 1 || seat.folded || !cards || cards.some((card) => card === null) || board.length < 3) {
    return null;
  }

  return evaluateHand([...(cards as string[]), ...board]).name;
}

/** The line under a seat: the hand it showed down, or for the viewer what they hold so far. */
function handLabel(seat: SeatView, hand: HandView | null, isMe: boolean): string | null {
  if (!hand) {
    return null;
  }

  if (hand.stage === 'done') {
    // Run twice, a seat makes a hand per board, which is too much for one label; the result in the middle names them
    return hand.boards.length === 1 ? (hand.result?.hands.find((entry) => entry.seat === seat.seat)?.name ?? null) : null;
  }

  return isMe ? holdingName(seat, hand) : null;
}

function seatEl(view: TableView, seat: SeatView, slot: number, shape: Shape, clockOffset: number): HTMLElement[] {
  const hand = view.hand;
  const isMe = view.you.seat === seat.seat;
  const acting = hand?.stage === 'betting' && hand.toAct === seat.seat;
  const result = hand?.result;
  const won = sum(result?.winnings.filter((win) => win.seat === seat.seat).map((win) => win.amount) ?? []);
  const bounty = result?.bounty?.seat === seat.seat ? sum(result.bounty.payments.map((payment) => payment.amount)) : 0;
  const status = statusOf(seat, hand);
  const label = handLabel(seat, hand, isMe);
  const place = seatPlace(shape, slot);

  const classes = [
    place.class,
    isMe && 'me',
    acting && 'acting',
    seat.folded && 'folded',
    !seat.inHand && (seat.sittingOut || seat.stack === 0) && 'out',
    won > 0 && 'winner',
  ].filter(Boolean);

  // Folded hands leave the table, except the viewer's own, which stays to look at
  const showCards = seat.cards !== null && (!seat.folded || isMe || seat.shown);
  const hole = showCards ? h('div.hole', null, seat.cards!.map((card) => cardEl(card))) : h('div.hole.none');

  let timer: HTMLElement | null = null;
  if (acting && hand.deadline !== null && view.config.actionSeconds > 0) {
    const total = view.config.actionSeconds * 1000;
    const left = Math.max(0, hand.deadline - (Date.now() + clockOffset));
    const fraction = Math.min(1, left / total);

    timer = h('div.timer', null, h('i', { style: { '--from': String(fraction), 'animation-duration': `${left}ms` } }));
  }

  let vote: HTMLElement | null = null;
  if (hand?.stage === 'ritVote' && seat.inHand && !seat.folded) {
    vote = h('div.tag.vote', { class: seat.ritVote ? 'yes' : '' }, seat.ritVote ? 'Twice ✓' : 'Deciding…');
  }

  const plate = h(
    'div.plate',
    null,
    h('div.name', { title: seat.name }, seat.name, view.hostId === seat.playerId ? h('span.host', { title: 'Host' }, '★') : null),
    h('div.stack', { title: chips(seat.stack) }, shortChips(seat.stack), seat.pendingAdd > 0 ? h('span.pending', null, ` +${shortChips(seat.pendingAdd)}`) : null),
    won > 0 ? h('div.status.won', null, `+${shortChips(won + bounty)}`) : status ? h('div.status', { 'data-status': status }, status) : null,
    // The seconds left, for everyone: the bar under the name alone is easy to miss until the time is gone
    timer ? h('div.status.clock', { 'data-countdown': hand!.deadline }, '') : null,
    timer,
  );

  const seatNode = h(
    'div',
    { class: classes.join(' '), style: place.style, 'data-seat': seat.seat },
    hole,
    plate,
    hand?.button === seat.seat ? h('div.dealer-button', { title: 'Dealer button' }, 'D') : null,
    vote,
    label ? h('div.tag', null, label) : null,
  );

  const nodes = [seatNode];
  if (seat.bet > 0) {
    nodes.push(h('div.bet', { style: betPlace(shape, slot) }, h('i.chip'), shortChips(seat.bet)));
  }

  return nodes;
}

function openSeatEl(view: TableView, seat: number, slot: number, shape: Shape, handlers: TableHandlers): HTMLElement {
  const myRequest = view.requests.find((request) => request.playerId === view.you.id && request.kind === 'seat');
  const place = seatPlace(shape, slot);

  if (myRequest?.seat === seat) {
    return h('div', { class: `${place.class} open requested`, style: place.style }, h('div.plate', null, 'Waiting for the host…'));
  }

  if (view.you.seat !== null || myRequest) {
    return h('div', { class: `${place.class} open idle`, style: place.style }, h('div.plate', { 'aria-hidden': 'true' }, 'Open'));
  }

  return h(
    'div',
    { class: `${place.class} open`, style: place.style },
    h('button.plate', { type: 'button', 'data-sit': seat, onclick: () => handlers.onSit(seat) }, 'Sit here'),
  );
}

function boardEl(hand: HandView): HTMLElement {
  const boards = hand.boards.map((board, run) => {
    const slots = Array.from({ length: BOARD_SIZE }, (_slot, index) => (board[index] ? cardEl(board[index]) : h('div.card.slot')));

    return h('div.board', { 'data-run': run }, slots);
  });

  // Run twice, the second board only exists once the first is out. Its place is kept from the start, so the table doesn't shift when it comes
  if (hand.runs > boards.length) {
    boards.push(h('div.board.later', { 'data-run': boards.length }, Array.from({ length: BOARD_SIZE }, () => h('div.card.slot'))));
  }

  return h('div.boards', { class: boards.length > 1 ? 'twice' : '' }, boards);
}

// More lines than this in the middle of the table run into the seats on a phone
const RESULT_LINES = 3;

function resultLines(view: TableView, hand: HandView): string[] {
  const result = hand.result;
  if (!result) {
    return [];
  }

  const nameAt = (seat: number) => view.seats[seat]?.name ?? 'Someone';
  const runs = hand.boards.length;
  const lines: string[] = [];

  for (let run = 0; run < runs; run++) {
    const wonHere = new Map<number, number>();
    for (const award of result.pots.flatMap((pot) => pot.awards)) {
      if (award.run === run) {
        wonHere.set(award.seat, (wonHere.get(award.seat) ?? 0) + award.amount);
      }
    }

    for (const [seat, amount] of wonHere) {
      const made = result.hands.find((shown) => shown.seat === seat && shown.run === run)?.name;
      const board = runs > 1 ? `Board ${run + 1}: ` : '';

      lines.push(`${board}${nameAt(seat)} wins ${chips(amount)}${made ? ` with ${made}` : ''}`);
    }
  }

  const bountyLine = result.bounty ? [`Seven-deuce! ${nameAt(result.bounty.seat)} collects a ${chips(sum(result.bounty.payments.map((payment) => payment.amount)))} bounty`] : [];

  if (lines.length + bountyLine.length <= RESULT_LINES) {
    return [...lines, ...bountyLine];
  }

  // Several pots or two boards say more than fits here: each winner gets one line, and the play-by-play has every pot
  const winners = [...result.winnings].sort((a, b) => b.amount - a.amount).map((win) => `${nameAt(win.seat)} wins ${chips(win.amount)}`);
  const room = RESULT_LINES - bountyLine.length;
  const shown = winners.length > room ? [...winners.slice(0, room - 1), `and ${winners.length - room + 1} more win a share`] : winners;

  return [...shown, ...bountyLine];
}

function messageEl(view: TableView, handlers: TableHandlers): HTMLElement | null {
  const hand = view.hand;

  if (hand?.stage === 'ritVote') {
    return h('div.message', null, 'All in. Run it twice?');
  }

  if (hand?.stage === 'done') {
    return h('div.message.result', null, resultLines(view, hand).map((line) => h('div', null, line)));
  }

  if (hand) {
    return null;
  }

  const seated = view.seats.filter((seat) => seat !== null).length;

  if (view.nextHandAt !== null) {
    return h('div.message', null, h('div', null, 'Next hand in ', h('span', { 'data-countdown': view.nextHandAt }, '…')));
  }

  if (!view.running) {
    if (view.you.isHost) {
      return h(
        'div.message',
        null,
        h('div', null, seated < 2 ? 'Share the invite link, then start once two players are seated.' : 'Everyone ready?'),
        h('button.btn.primary', { type: 'button', 'data-action': 'start', onclick: handlers.onStart }, view.handCount === 0 ? 'Start the game' : 'Resume the game'),
      );
    }

    return h('div.message', null, view.handCount === 0 ? 'Waiting for the host to start the game' : 'The host paused the game');
  }

  return h('div.message', null, 'Waiting for at least two players with chips');
}

function potEl(hand: HandView): HTMLElement | null {
  // Once the hand is over the pot has gone to the winners, and the result says who got what
  if (hand.pot === 0 || hand.stage === 'done') {
    return null;
  }

  const sidePots = hand.pots.length > 1 && hand.stage !== 'betting';
  const breakdown = sidePots ? hand.pots.map((pot, index) => `${index === 0 ? 'Main' : `Side ${index}`} ${chips(pot.amount)}`).join(' · ') : null;

  return h('div.pot', null, h('span.label', null, 'Pot'), chips(hand.pot), breakdown ? h('div.sidepots', null, breakdown) : null);
}

/** The poker table as one viewer sees it, with their own seat at the bottom. */
export function tableEl(view: TableView, shape: Shape, clockOffset: number, handlers: TableHandlers): HTMLElement {
  const seatCount = view.seats.length;
  const hero = view.you.seat ?? 0;
  const nodes: HTMLElement[] = [];

  view.seats.forEach((seat, index) => {
    const slot = (index - hero + seatCount) % seatCount;

    if (seat) {
      nodes.push(...seatEl(view, seat, slot, shape, clockOffset));
    } else {
      nodes.push(openSeatEl(view, index, slot, shape, handlers));
    }
  });

  const hand = view.hand;

  return h(
    'div',
    { class: `table ${shape}` },
    h('div.felt'),
    h('div.center', null, hand ? boardEl(hand) : null, hand ? potEl(hand) : null, messageEl(view, handlers)),
    nodes,
  );
}
