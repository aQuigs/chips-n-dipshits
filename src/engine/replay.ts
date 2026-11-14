/*
 * A finished hand played back from its record. `replayHand` says where any number of a hand's events
 * leave the chips and the cards; this says the rest of what a table drawn from a record needs: which
 * events a player would count as one step, what the dealer called out at each, who was to act, how far
 * the hand had come, and the view the page's table is drawn from.
 *
 * A record holds a player's cards only as the table saw them, so nothing here can show a card that
 * stayed face down. The one thing added is the viewer's own two cards, where their browser kept them.
 */
import { formatAmount } from './amounts.ts';
import type { Denominated } from './amounts.ts';
import { BOARD_SIZE } from './boards.ts';
import { boardsDealt, bombPotName } from './bombPots.ts';
import { bountyWords } from './bounties.ts';
import { HOLE_CARDS, prettyCards } from './cards.ts';
import type { Card } from './cards.ts';
import { replayHand } from './events.ts';
import type { HandEvent, ReplayPosition } from './events.ts';
import { midSentence, readHand } from './handNames.ts';
import { BOARD_NAMES, huntedText, potLabel, STREET_TITLES } from './handWords.ts';
import { buildPots } from './pots.ts';
import { timesText, voteStory } from './runVote.ts';
import { fullyShown } from './shown.ts';
import { stakesText } from './stakes.ts';
import type { HandRecord, HandResult, HandStage, PotResult } from './types.ts';
import type { HandView, SeatView, TableView } from './view.ts';

/** One step of a hand played back: the events a player would count as one thing happening. */
export interface ReplayStep {
  /** How many of the hand's events have happened once the step is taken. */
  events: number;
  /** The part of the hand it belongs to, which a scrub bar marks where it starts: "Preflop", "Flop", "Second board", "Showdown", "End". */
  part: string;
  /** What the dealer called out at the step, in order. */
  lines: string[];
}

/** The part a hand ends in when hands were shown down, and when they were not: named so that no two parts of a hand start with the same letter, which is what marks them on a scrub bar. */
const SHOWDOWN = 'Showdown';
const UNSHOWN = 'End';

/** How the telling stands as it reaches an event. */
interface Telling {
  record: HandRecord;
  table: Denominated;
  /** The event's place among the hand's. */
  nth: number;
  /** The hand is over: whatever comes now is after it. */
  over: boolean;
}

/** What comes after the hand is won or lost: a card turned up by choice, the bounty, the rabbit. */
const AFTER_THE_HAND = new Set<HandEvent[0]>(['show', 'bounty', 'hunt']);

/**
 * How many of a hand's events it takes to be over, by what follows them. A hand folded to a blind that
 * was its only chips pays nobody, so no one kind of event says a hand has ended.
 */
function eventsToTheEnd(events: readonly HandEvent[]): number {
  let count = events.length;

  while (count > 0 && AFTER_THE_HAND.has(events[count - 1]![0])) {
    count -= 1;
  }

  return count;
}

const before = ({ record, nth }: Telling) => record.events[nth - 1];

type RunsEvent = Extract<HandEvent, [kind: 'runs', ...rest: unknown[]]>;

/**
 * Whether a hand's players were asked how many times to run it before this `runs`. The event says how
 * the picking ended; one recorded before it did tells only of a picking in which somebody picked.
 */
const pickingEnded = (runs: RunsEvent, last: HandEvent | undefined) => runs[2] !== undefined || last?.[0] === 'vote';
const positionAt = ({ record }: Telling, count: number) => replayHand(record.events, count)!;
const nameAt = (record: HandRecord, seat: number) => record.players.find((player) => player.seat === seat)?.name ?? 'Someone';

/** Whether every board the hand ended on was out with all its cards once `count` events had happened. */
function boardsOut(telling: Telling, count: number): boolean {
  const { boards, runs } = positionAt(telling, count);

  return boards.length === runs && boards.every((board) => board.length === BOARD_SIZE);
}

/**
 * How an event takes its place among the steps: whether it `opens` one of its own, and `by` whose
 * decision it was, which is the seat the table before it shows on the clock. A step may be less than
 * the live table showed at once, a call and then the card it brought, but never shows what was not
 * so: nobody is on the clock who was not, and no stage is shown that the hand skipped. A new kind of
 * event takes a case here, and the build fails until it has one.
 */
function placed(event: HandEvent, telling: Telling): { opens: boolean; by: number | null } {
  const last = before(telling);

  switch (event[0]) {
    case 'start':
      return { opens: true, by: null };

    // The blinds, the antes and the cards are how the hand starts, and chips that come back belong to whatever sent them
    case 'post':
    case 'deal':
    case 'return':
      return { opens: false, by: null };

    // A move the clock made for a player is told with the clock running out, and one made for a player the hand could not wait for was nobody's decision
    case 'fold':
    case 'check':
      return { opens: last?.[0] !== 'timeout', by: event[2] ? null : event[1] };

    case 'chopAnswer':
      return { opens: last?.[0] !== 'timeout', by: event[3] === 'unasked' ? null : event[1] };

    case 'call':
    case 'bet':
    case 'raise':
    case 'timeout':
    case 'chopOffer':
      return { opens: true, by: event[1] };

    // A street dealt to several boards at once is one street: only a hand dealt on several from the start has one
    case 'street':
      return { opens: !(last?.[0] === 'street' && event[1] > last[1] && boardsDealt(telling.record.bombPot) > 1), by: null };

    case 'vote':
    case 'bounty':
    case 'hunt':
      return { opens: true, by: null };

    // A yes is the chop: the blinds go back with the answer
    case 'chop':
      return { opens: last?.[0] !== 'chopAnswer', by: null };

    // With nobody asked, the hand is run out by the same move that ended the betting
    case 'runs':
      return { opens: pickingEnded(event, last), by: null };

    // Hands turn up together when the betting ends. After the hand a card is turned by choice, each one a thing of its own
    case 'show':
    case 'muck':
      return { opens: telling.over || !(last?.[0] === 'show' || last?.[0] === 'muck'), by: null };

    // A pot is paid in one go, however many share it and on however many boards
    case 'win':
      return { opens: !(last?.[0] === 'win' && last[3] === event[3]), by: null };

    // An event this code does not know, from a newer server, is passed over
    default:
      event satisfies never;

      return { opens: false, by: null };
  }
}

const allIn = (stackLeft: number) => (stackLeft === 0 ? ' and is all in' : '');

/**
 * What the dealer called out for an event, in the words of the play-by-play; null for one that is told
 * with others or not at all. A new kind of event takes a case here, and the build fails until it has one.
 */
function said(event: HandEvent, telling: Telling): string | null {
  const { record, table, nth } = telling;
  const name = (seat: number) => nameAt(record, seat);
  const amount = (chips: number) => formatAmount(chips, table);

  switch (event[0]) {
    case 'start': {
      const [, number, button, smallBlind, bigBlind, , ante = 0, anteFrom = 'everyone', bombPot] = event;
      const terms = bombPot ? `${bombPotName(bombPot)} ${amount(bombPot.amount)}` : `blinds ${stakesText({ unit: table.unit, smallBlind, bigBlind, ante, anteFrom })}`;
      const onTheButton = record.players.find((player) => player.seat === button);

      return `Hand #${number} · ${terms} · ${onTheButton ? `${onTheButton.name} has the button` : `dead button on seat ${button + 1}`}`;
    }

    // Told by `postLines`, which says a bet the whole table posts in one line
    case 'post':
    case 'deal':
      return null;

    case 'fold':
      return `${name(event[1])} folds`;

    case 'check':
      return `${name(event[1])} checks`;

    case 'call':
      return `${name(event[1])} calls ${amount(event[2])}${allIn(event[3])}`;

    case 'bet':
      return `${name(event[1])} bets ${amount(event[2])}${allIn(event[3])}`;

    case 'raise':
      return `${name(event[1])} raises to ${amount(event[2])}${allIn(event[3])}`;

    case 'timeout':
      return `${name(event[1])} ran out of time`;

    case 'return': {
      const bet = positionAt(telling, nth).seats.find((seat) => seat.seat === event[1])?.bet ?? 0;

      return event[2] > bet ? `${amount(event[2])} that nobody could match returned to ${name(event[1])}` : `Uncalled bet of ${amount(event[2])} returned to ${name(event[1])}`;
    }

    case 'street': {
      const after = positionAt(telling, nth + 1);
      const which = after.runs > 1 ? `${BOARD_NAMES[event[1]]}, ` : '';

      return `${which}${STREET_TITLES[after.street]}: ${prettyCards(after.boards[event[1]]!)}`;
    }

    case 'vote':
      return `${name(event[1])} picks ${timesText(event[2])}`;

    case 'runs': {
      const [, runs, picking, leaver] = event;
      const unpicked = picking === 'time' ? ({ why: 'time' } as const) : picking === 'left' ? ({ why: 'left', name: name(leaver!) } as const) : undefined;

      return pickingEnded(event, before(telling)) ? voteStory(positionAt(telling, nth).seats.filter((seat) => !seat.folded), runs, unpicked) : null;
    }

    case 'show': {
      const turned = event[2].filter((card) => card !== null);
      const all = turned.length === event[2].length;
      const whole = fullyShown(positionAt(telling, nth + 1).seats.find((seat) => seat.seat === event[1])?.cards ?? []);
      // At a showdown a hand is named as it is turned up, for each board it plays on
      const made = !telling.over && boardsOut(telling, nth) ? record.result.hands.filter((hand) => hand.seat === event[1]).map((hand) => hand.name) : [];

      return `${name(event[1])} ${all ? 'shows' : whole ? 'shows the other card,' : 'shows one card,'} ${prettyCards(turned)}${made.length > 0 ? ` (${made.join(' / ')})` : ''}`;
    }

    case 'muck':
      return `${name(event[1])} mucks`;

    case 'win': {
      const [, seat, share, pot, board] = event;
      const { result, boards } = record;
      const from = potLabel(pot, result.pots.length);

      if (result.uncontested) {
        return `${name(seat)} wins ${amount(share)}${from}`;
      }

      const on = boards.length > 1 ? ` on the ${midSentence(BOARD_NAMES[board]!)}` : '';
      const made = result.hands.find((hand) => hand.seat === seat && hand.run === board)?.name;

      return `${name(seat)} wins ${amount(share)}${from}${on}${made ? ` with ${midSentence(made)}` : ''}`;
    }

    case 'bounty':
      return bountyWords(name(event[1]), event[3], amount(event[2].reduce((sum, [, paid]) => sum + paid, 0)));

    case 'chopOffer':
      return `${name(event[1])} offers to chop the blinds`;

    case 'chopAnswer':
      if (event[2]) {
        return `${name(event[1])} agrees to chop`;
      }

      return event[3] || before(telling)?.[0] === 'timeout' ? `${name(event[1])} did not answer, so there is no chop` : `${name(event[1])} says no to the chop`;

    case 'chop':
      return `${event[1].map(([seat]) => name(seat)).join(' and ')} chop the blinds: each takes back their own`;

    case 'hunt':
      return `Rabbit hunt, cards that did not count: ${huntedText(event[1])}`;

    default:
      event satisfies never;

      return null;
  }
}

type PostEvent = Extract<HandEvent, [kind: 'post', ...rest: unknown[]]>;

/**
 * The forced bets of a hand as the play-by-play tells them: a bet the whole table posts in one line,
 * and only a player it leaves all in with a line of their own.
 */
function postLines({ record, table }: Telling): string[] {
  const posts = record.events.filter((event): event is PostEvent => event[0] === 'post');
  const line = (who: string, [, , what, posted, stackLeft]: PostEvent) => `${who} posts ${what} ${formatAmount(posted, table)}${allIn(stackLeft)}`;
  const lines: string[] = [];

  for (const what of new Set(posts.map((post) => post[2]))) {
    const kind = posts.filter((post) => post[2] === what);
    const fromEveryone = kind.length === record.players.length;
    const inFull = fromEveryone ? kind.filter((post) => post[4] > 0) : [];

    lines.push(...kind.filter((post) => !inFull.includes(post)).map((post) => line(nameAt(record, post[1]), post)));

    if (inFull.length === 1) {
      lines.push(line(nameAt(record, inFull[0]![1]), inFull[0]!));
    } else if (inFull.length > 1) {
      lines.push(line(inFull.length === kind.length ? 'Everyone' : 'Everyone else', inFull[0]!));
    }
  }

  return lines;
}

/** The part of the hand that `event` begins, or null when it goes on with the part before. */
function partBegun(event: HandEvent, telling: Telling): string | null {
  const { record, nth } = telling;
  const ending = record.result.uncontested ? UNSHOWN : SHOWDOWN;

  switch (event[0]) {
    // A board the rest is run on again is a part of its own, whichever street it starts from
    case 'street':
      return event[1] > 0 && boardsDealt(record.bombPot) === 1 ? BOARD_NAMES[event[1]]! : STREET_TITLES[positionAt(telling, nth + 1).street];

    // Hands that turn up with cards still to come are being run out, not shown down
    case 'show':
    case 'muck':
      return telling.over || boardsOut(telling, nth) ? ending : null;

    case 'win':
    case 'chop':
    case 'bounty':
    case 'hunt':
      return ending;

    default:
      return null;
  }
}

function stepsOf(record: HandRecord, table: Denominated): ReplayStep[] {
  const steps: ReplayStep[] = [];
  const ends = eventsToTheEnd(record.events);

  record.events.forEach((event, nth) => {
    const telling: Telling = { record, table, nth, over: nth >= ends };
    const line = said(event, telling);

    if (placed(event, telling).opens) {
      steps.push({ events: nth, part: steps.at(-1)?.part ?? STREET_TITLES.preflop, lines: [] });
    }

    const step = steps.at(-1)!;

    step.events = nth + 1;
    step.part = partBegun(event, telling) ?? step.part;
    step.lines.push(...(line === null ? [] : [line]), ...(event[0] === 'deal' ? postLines(telling) : []));
  });

  return steps;
}

/** Whether a record's events, played back, end on the stacks, boards and cards the record says the hand ended on. */
function retold(record: HandRecord): boolean {
  const end = replayHand(record.events);

  return (
    end !== null &&
    JSON.stringify(end.seats.map(({ seat, stack, cards }) => [seat, stack, cards])) === JSON.stringify(record.players.map((player) => [player.seat, player.endStack, player.cards])) &&
    JSON.stringify(end.boards) === JSON.stringify(record.boards)
  );
}

/**
 * The steps a finished hand is played back in, the first being the hand as it was dealt, with the
 * blinds in. Null for a hand that cannot be played back: one recorded without its events, or whose
 * events do not end where the record says the hand did, which is then told as text and never as a
 * table that might be wrong. `table` says how the hand's amounts are written.
 */
export function replaySteps(record: HandRecord, table: Denominated): ReplayStep[] | null {
  try {
    return retold(record) ? stepsOf(record, table) : null;
  } catch {
    // Events that cannot be followed at all, as in a record from a version that wrote them otherwise
    return null;
  }
}

/** The steps at which a part of the hand starts, by their place among `steps`. */
export function partStarts(steps: readonly ReplayStep[]): number[] {
  return steps.flatMap((step, at) => (at === 0 || step.part !== steps[at - 1]!.part ? [at] : []));
}

/**
 * How far the hand had come once `count` of its events had happened. The events say it late or not at
 * all in two places, which a finished hand settles by what came next: players are picking how many
 * times to run it from the moment their hands turn up, and a hand with nothing left to happen is over.
 */
function stageAt(record: HandRecord, position: ReplayPosition, count: number): HandStage {
  const next = record.events[count];

  if (position.stage === 'done' || count >= eventsToTheEnd(record.events)) {
    return 'done';
  }

  return next![0] === 'vote' || (next![0] === 'runs' && next![2] !== undefined) ? 'ritVote' : position.stage;
}

/**
 * The hand's result as far as it had been paid: the pots awarded so far, with what each seat had won
 * of them. Once every pot is paid and the bounty with it, that is the record's own result.
 */
function resultSoFar(record: HandRecord, position: ReplayPosition, bountyPaid: boolean): HandResult {
  const { result } = record;
  let left = position.awards.length;

  if (left === result.pots.flatMap((pot) => pot.awards).length) {
    return bountyPaid ? result : { ...result, bounty: null };
  }

  const pots: PotResult[] = result.pots.flatMap((pot) => {
    const awards = pot.awards.slice(0, left);

    left -= awards.length;

    return awards.length > 0 ? [{ ...pot, awards }] : [];
  });

  const winnings = new Map<number, number>();
  for (const award of pots.flatMap((pot) => pot.awards)) {
    winnings.set(award.seat, (winnings.get(award.seat) ?? 0) + award.amount);
  }

  return { ...result, pots, winnings: [...winnings].map(([seat, amount]) => ({ seat, amount })), bounty: null };
}

/**
 * The viewer's own cards in a hand, as their browser kept them, when they can be the cards of that
 * hand: two cards, agreeing with whatever the table saw of the viewer's and with nothing else it saw.
 */
function ownCards(record: HandRecord, seat: number, kept: readonly Card[] | null): Card[] | null {
  const mine = record.players.find((player) => player.seat === seat)!;
  const hunted = record.events.flatMap((event) => (event[0] === 'hunt' ? event[1].flat() : []));
  const elsewhere = new Set([...record.boards.flat(), ...hunted, ...record.players.flatMap((player) => (player === mine ? [] : player.cards))]);

  if (!kept || kept.length !== HOLE_CARDS || new Set(kept).size !== HOLE_CARDS) {
    return null;
  }

  return kept.every((card, nth) => !elsewhere.has(card) && (mine.cards[nth] ?? card) === card) ? [...kept] : null;
}

/**
 * The table as a finished hand left it at one step, for the page's table to be drawn from like any
 * view. `table` is the viewer's view of the table now, which says who they are and how the table
 * writes its amounts; everything of the hand comes from the record. `kept` are the viewer's own two
 * cards in that hand where their browser kept them, the only cards here that the record does not
 * hold: without them the viewer's hand is face down until the table saw it, like everyone's.
 *
 * Nothing in it can be acted on: nobody is on a clock, and the viewer may do nothing.
 */
export function replayView(record: HandRecord, step: ReplayStep, table: TableView, kept: readonly Card[] | null = null): TableView {
  const position = replayHand(record.events, step.events)!;
  const next = record.events[step.events];
  const stage = stageAt(record, position, step.events);
  const me = record.players.find((player) => player.playerId !== '' && player.playerId === table.you.id);
  const own = me ? ownCards(record, me.seat, kept) : null;
  // Bets leave the front of the players once no more betting can happen, which the events say only when the next card comes
  const betsOut = stage === 'betting' || stage === 'chop';
  const inFront = position.seats.reduce((sum, seat) => sum + seat.bet, 0);

  const seats = Array.from({ length: Math.max(table.seats.length, ...record.players.map((player) => player.seat + 1)) }, (): SeatView | null => null);

  for (const seat of position.seats) {
    seats[seat.seat] = {
      seat: seat.seat,
      playerId: record.players.find((player) => player.seat === seat.seat)?.playerId ?? '',
      name: seat.name,
      stack: seat.stack,
      sittingOut: false,
      away: false,
      leaving: false,
      straddles: [],
      alwaysChop: false,
      pendingAdd: 0,
      moveTo: null,
      owesBigBlind: false,
      owesSmallBlind: false,
      comesIn: null,
      inHand: true,
      bet: betsOut ? seat.bet : 0,
      folded: seat.folded,
      allIn: seat.allIn,
      lastAction: seat.lastAction,
      cards: seat.seat === me?.seat && own ? own : seat.cards,
      shown: seat.cards.map((card) => card !== null),
      ritVote: seat.ritVote,
    };
  }

  const hand: HandView = {
    number: position.number,
    stage,
    street: position.street,
    boards: position.boards,
    runs: position.runs,
    maxRuns: position.runs,
    button: position.button,
    sbSeat: position.sbSeat,
    bbSeat: position.bbSeat,
    straddles: [],
    passedOver: null,
    bigBlind: position.bigBlind,
    bombPot: position.bombPot,
    pot: position.pot + inFront,
    pots: buildPots(position.seats),
    currentBet: betsOut ? Math.max(0, ...position.seats.map((seat) => seat.bet)) : 0,
    toAct: betsOut && next ? placed(next, { record, table: table.config, nth: step.events, over: false }).by : null,
    turn: 0,
    deadline: null,
    options: null,
    canOfferChop: false,
    foldChops: false,
    canAnswerChop: false,
    canVote: false,
    canShow: false,
    canHunt: false,
    hunted: position.hunted,
    result: stage === 'done' ? resultSoFar(record, position, record.events.slice(0, step.events).some((event) => event[0] === 'bounty')) : null,
    events: record.events.slice(0, step.events),
    // No bounty is pointed out on the viewer's cards: a record does not say which hands paid one when it was dealt
    holding: me && own && !position.seats.find((seat) => seat.seat === me.seat)!.folded ? { reads: position.boards.map((board) => readHand(own, board)), bounty: null } : null,
  };

  return {
    ...table,
    you: { ...table.you, role: 'member', seat: me?.seat ?? null },
    seats,
    hand,
    running: true,
    nextHandAt: null,
    shuffleAfterHand: false,
    requests: [],
    reactions: [],
    // Whoever holds the night's high hand now may not have held it then, which the record does not say
    tonight: { ...table.tonight, highHand: { ...table.tonight.highHand, next: null } },
  };
}
