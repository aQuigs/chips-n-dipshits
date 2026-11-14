import { formatAmount } from './amounts.ts';
import { bettingIsClosed, bettingOptions, owesAction } from './betting.ts';
import { prettyCards, rankOf, shuffledDeck } from './cards.ts';
import type { Card } from './cards.ts';
import type { HandEvent } from './events.ts';
import { evaluateHand } from './handRank.ts';
import type { HandValue } from './handRank.ts';
import { buildPots, splitAmount } from './pots.ts';
import { addFeed, addPendingChips, clockwiseAfter, clockwiseFrom, eligibleSeats, seatsClockwiseAfter, vacateSeat } from './seats.ts';
import { GameError } from './types.ts';
import type { BountyResult, Ctx, Hand, HandPlayer, HandResult, PotAward, PotResult, ShownHand, Street, TableState } from './types.ts';

export const TIMING = {
  /** Added to the action clock so a click made at the buzzer still counts after the round trip. */
  actionGraceMs: 2000,
  startDelayMs: 3000,
  ritVoteMs: 12000,
  runoutStepMs: 1800,
  uncontestedPauseMs: 3500,
  showdownPauseMs: 7000,
  runTwicePauseMs: 10000,
};

const HOLE_CARDS = 2;
const BOARD_SIZE = 5;
const FLOP_SIZE = 3;
const STRADDLE_BIG_BLINDS = 2;

// A hand's log is saved with the table on every action, so a raising war can't be allowed to grow it without end
const LOG_LIMIT = 240;
const LOG_HEAD = 40;
const LOG_GAP = '… a long stretch of the action is left out …';

/**
 * Events are saved with the table on every action too, and unlike the log they are no use with a
 * stretch missing. A hand that runs longer than any real one stops being recorded altogether.
 */
export const EVENT_LIMIT = 320;

const STREET_BY_BOARD_LENGTH: Record<number, Street> = { 3: 'flop', 4: 'turn', 5: 'river' };
const STREET_TITLES: Record<Street, string> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };

export type BettingAction = { type: 'fold' } | { type: 'check' } | { type: 'call' } | { type: 'raise'; to: number };

function narrate(state: TableState, ctx: Ctx, text: string): void {
  addFeed(state, ctx.now, 'dealer', null, text);

  const log = state.hand?.log;
  if (!log) {
    return;
  }

  log.push(text);

  // Past the limit the start and the latest lines are kept, with one line standing in for the middle
  if (log.length > LOG_LIMIT) {
    if (log[LOG_HEAD] === LOG_GAP) {
      log.splice(LOG_HEAD + 1, log.length - LOG_LIMIT);
    } else {
      log.splice(LOG_HEAD, log.length - LOG_LIMIT + 1, LOG_GAP);
    }
  }
}

/** Adds to the hand's events, which are either the whole hand from its start or nothing. */
function record(hand: Hand, event: HandEvent): void {
  // Empty past the start means the hand can't be followed: it was under way before events were kept, or it outgrew the limit
  if (hand.events.length === 0 && event[0] !== 'start') {
    return;
  }

  if (hand.events.length >= EVENT_LIMIT) {
    hand.events = [];
    return;
  }

  hand.events.push(event);
}

function playerAt(hand: Hand, seat: number): HandPlayer | undefined {
  return hand.players.find((p) => p.seat === seat);
}

function livePlayers(hand: Hand): HandPlayer[] {
  return hand.players.filter((p) => !p.folded);
}

/** Turns a player's cards face up for the table. `made` names the hand they make, where that is known. */
function show(state: TableState, ctx: Ctx, player: HandPlayer, made = ''): void {
  player.shown = true;
  record(state.hand!, ['show', player.seat, [...player.cards]]);
  narrate(state, ctx, `${player.name} shows ${prettyCards(player.cards)}${made}`);
}

function pay(state: TableState, player: HandPlayer, amount: number): void {
  const seat = state.seats[player.seat]!;

  seat.stack -= amount;
  player.bet += amount;
  player.committed += amount;

  if (seat.stack === 0) {
    player.allIn = true;
  }
}

function postBlind(state: TableState, ctx: Ctx, player: HandPlayer, amount: number, blind: 'small blind' | 'big blind' | 'straddle'): void {
  const posted = Math.min(amount, state.seats[player.seat]!.stack);

  pay(state, player, posted);
  player.lastAction = blind;
  record(state.hand!, ['post', player.seat, blind, posted, state.seats[player.seat]!.stack]);
  narrate(state, ctx, `${player.name} posts ${blind} ${formatAmount(posted, state.config)}${player.allIn ? ' and is all in' : ''}`);
}

export function startHand(state: TableState, ctx: Ctx): void {
  const eligible = eligibleSeats(state);
  if (eligible.length < 2) {
    throw new Error('A hand needs at least two players');
  }

  const { smallBlind, bigBlind, allowStraddle, sevenDeuceBounty } = state.config;
  const button = state.buttonSeat === null ? eligible[ctx.rng.int(eligible.length)]! : seatsClockwiseAfter(eligible, state.buttonSeat)[0]!;

  // Clockwise from the button's left, so the button comes last
  const order = seatsClockwiseAfter(eligible, button);
  const headsUp = eligible.length === 2;
  const sbSeat = headsUp ? button : order[0]!;
  const bbSeat = headsUp ? order[0]! : order[1]!;

  const players: HandPlayer[] = eligible.map((seat) => {
    const playerId = state.seats[seat]!.playerId;

    return {
      seat,
      playerId,
      name: state.members.find((m) => m.id === playerId)!.name,
      cards: [],
      startStack: state.seats[seat]!.stack,
      bet: 0,
      committed: 0,
      folded: false,
      allIn: false,
      hasActed: false,
      shown: false,
      ritVote: null,
      lastAction: null,
    };
  });

  const deck = shuffledDeck(ctx.rng);
  for (let round = 0; round < HOLE_CARDS; round++) {
    for (const seat of order) {
      players.find((p) => p.seat === seat)!.cards.push(deck.pop()!);
    }
  }

  state.handCount += 1;
  state.buttonSeat = button;
  state.nextHandAt = null;

  const hand: Hand = {
    number: state.handCount,
    startedAt: ctx.now,
    smallBlind,
    bigBlind,
    button,
    sbSeat,
    bbSeat,
    straddleSeat: null,
    bounty: sevenDeuceBounty,
    deck,
    boards: [[]],
    runs: 1,
    runIndex: 0,
    sharedBoardLength: 0,
    street: 'preflop',
    stage: 'betting',
    players,
    currentBet: bigBlind,
    minRaise: bigBlind,
    toAct: null,
    lastAggressor: null,
    deadline: null,
    result: null,
    log: [],
    events: [],
  };
  state.hand = hand;

  record(hand, ['start', hand.number, button, smallBlind, bigBlind, players.map((p) => [p.seat, p.name, p.startStack])]);
  narrate(state, ctx, `Hand #${hand.number} · blinds ${formatAmount(smallBlind, state.config)}/${formatAmount(bigBlind, state.config)} · ${playerAt(hand, button)!.name} has the button`);
  postBlind(state, ctx, playerAt(hand, sbSeat)!, smallBlind, 'small blind');
  postBlind(state, ctx, playerAt(hand, bbSeat)!, bigBlind, 'big blind');

  // Under the gun is the seat after the big blind, which three-handed is the button
  const underTheGun = order[2];
  const straddle = STRADDLE_BIG_BLINDS * bigBlind;
  if (allowStraddle && underTheGun !== undefined) {
    const seat = state.seats[underTheGun]!;

    if (seat.straddle && seat.stack >= straddle) {
      postBlind(state, ctx, playerAt(hand, underTheGun)!, straddle, 'straddle');
      hand.straddleSeat = underTheGun;

      // A straddle plays as a third, bigger blind: it is the bet to call and the least a raise can add
      hand.currentBet = straddle;
      hand.minRaise = straddle;
    }
  }

  record(hand, ['deal']);
  advance(state, ctx, hand.straddleSeat ?? bbSeat);
}

function actionDeadline(state: TableState, now: number): number | null {
  const seconds = state.config.actionSeconds;

  return seconds > 0 ? now + seconds * 1000 + TIMING.actionGraceMs : null;
}

/** The clock setting changed: whoever is being waited for gets the new one, counted from now. */
export function restartActionClock(state: TableState, now: number): void {
  const hand = state.hand;

  if (hand && hand.stage === 'betting' && hand.toAct !== null) {
    hand.deadline = actionDeadline(state, now);
  }
}

/** Moves the hand on from the seat that just acted: to the next player, the next street, or the end. */
function advance(state: TableState, ctx: Ctx, afterSeat: number): void {
  const hand = state.hand!;
  let from = afterSeat;

  hand.toAct = null;
  hand.deadline = null;

  for (;;) {
    const live = livePlayers(hand);

    if (live.length === 1) {
      finishUncontested(state, ctx, live[0]!);
      return;
    }

    if (bettingIsClosed(hand)) {
      refundUncalledBet(state, ctx);

      if (hand.street === 'river') {
        revealAtShowdown(state, ctx);
        settleShowdown(state, ctx);
        return;
      }

      if (live.filter((p) => !p.allIn).length <= 1) {
        beginRunout(state, ctx);
        return;
      }

      dealNextStreet(state, ctx);
      from = hand.button;
      continue;
    }

    const next = clockwiseAfter(hand.players, from).find((p) => owesAction(hand, p))!;
    const seat = state.seats[next.seat]!;

    if (seat.away || seat.leaving) {
      checkOrFold(state, ctx, next);
      from = next.seat;
      continue;
    }

    hand.toAct = next.seat;
    state.turn += 1;
    hand.deadline = actionDeadline(state, ctx.now);
    return;
  }
}

/** Gives back the part of the biggest bet that nobody was able to call. */
function refundUncalledBet(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const byStake = [...hand.players].sort((a, b) => b.committed - a.committed);
  const top = byStake[0]!;
  const excess = top.committed - byStake[1]!.committed;

  if (excess <= 0 || top.folded) {
    return;
  }

  top.committed -= excess;
  top.bet -= excess;
  top.allIn = false;
  state.seats[top.seat]!.stack += excess;

  record(hand, ['return', top.seat, excess]);
  narrate(state, ctx, `Uncalled bet of ${formatAmount(excess, state.config)} returned to ${top.name}`);
}

/** Deals the next street onto one of the hand's boards. */
function dealBoardCards(hand: Hand, boardIndex: number): Street {
  const board = hand.boards[boardIndex]!;
  const count = board.length === 0 ? FLOP_SIZE : 1;
  const dealt: Card[] = [];

  for (let i = 0; i < count; i++) {
    dealt.push(hand.deck.pop()!);
  }

  board.push(...dealt);
  record(hand, ['street', boardIndex, dealt]);

  return STREET_BY_BOARD_LENGTH[board.length]!;
}

function dealNextStreet(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const board = hand.boards[0]!;

  hand.street = dealBoardCards(hand, 0);
  hand.currentBet = 0;
  hand.minRaise = hand.bigBlind;
  hand.lastAggressor = null;

  for (const player of hand.players) {
    player.bet = 0;
    player.hasActed = false;

    if (!player.folded) {
      player.lastAction = null;
    }
  }

  narrate(state, ctx, `${STREET_TITLES[hand.street]}: ${prettyCards(board)}`);
}

/** Bets leave the front of the players once no more betting can happen. */
function collectBets(hand: Hand): void {
  for (const player of hand.players) {
    player.bet = 0;
  }
}

function perform(state: TableState, ctx: Ctx, player: HandPlayer, action: BettingAction): void {
  const hand = state.hand!;
  const options = bettingOptions(state, hand, player);

  switch (action.type) {
    case 'fold': {
      player.folded = true;
      player.lastAction = 'fold';
      record(hand, ['fold', player.seat]);
      narrate(state, ctx, `${player.name} folds`);
      break;
    }

    case 'check': {
      if (!options.canCheck) {
        throw new GameError(`You can't check, there is a bet of ${formatAmount(hand.currentBet, state.config)} to you`);
      }

      player.lastAction = 'check';
      record(hand, ['check', player.seat]);
      narrate(state, ctx, `${player.name} checks`);
      break;
    }

    case 'call': {
      if (options.canCheck) {
        throw new GameError('There is nothing to call');
      }

      pay(state, player, options.callAmount);
      player.lastAction = 'call';
      record(hand, ['call', player.seat, options.callAmount, state.seats[player.seat]!.stack]);
      narrate(state, ctx, `${player.name} calls ${formatAmount(options.callAmount, state.config)}${player.allIn ? ' and is all in' : ''}`);
      break;
    }

    case 'raise': {
      if (!options.canRaise) {
        throw new GameError("You can't raise here");
      }

      const { to } = action;
      if (!Number.isInteger(to) || to < options.minRaiseTo || to > options.maxRaiseTo) {
        throw new GameError(`A raise here must be between ${formatAmount(options.minRaiseTo, state.config)} and ${formatAmount(options.maxRaiseTo, state.config)}`);
      }

      const opening = hand.currentBet === 0;
      const raisedBy = to - hand.currentBet;

      pay(state, player, to - player.bet);

      // Only a full raise sets the new minimum; a short all-in leaves it where it was
      if (raisedBy >= hand.minRaise) {
        hand.minRaise = raisedBy;
      }

      hand.currentBet = to;
      hand.lastAggressor = player.seat;
      player.lastAction = opening ? 'bet' : 'raise';
      record(hand, [opening ? 'bet' : 'raise', player.seat, to, state.seats[player.seat]!.stack]);
      narrate(state, ctx, `${player.name} ${opening ? 'bets' : 'raises to'} ${formatAmount(to, state.config)}${player.allIn ? ' and is all in' : ''}`);
      break;
    }
  }

  player.hasActed = true;
}

function checkOrFold(state: TableState, ctx: Ctx, player: HandPlayer): void {
  const canCheck = bettingOptions(state, state.hand!, player).canCheck;

  perform(state, ctx, player, { type: canCheck ? 'check' : 'fold' });
}

/**
 * A player's own decision when the action is on them. `turn` is the decision they were looking at:
 * an answer that was slow to arrive, or sent twice, must not be played on a later one they never saw.
 */
export function act(state: TableState, ctx: Ctx, seatIndex: number, action: BettingAction, turn?: number): void {
  const hand = state.hand;
  if (!hand || hand.stage !== 'betting' || hand.toAct !== seatIndex) {
    throw new GameError("It's not your turn");
  }

  if (turn !== undefined && turn !== state.turn) {
    throw new GameError('The hand moved on before that arrived, so it was not played');
  }

  perform(state, ctx, playerAt(hand, seatIndex)!, action);

  // Acting proves a player who timed out earlier is back
  const seat = state.seats[seatIndex]!;
  if (seat.away) {
    seat.away = false;
    seat.sittingOut = false;
  }

  advance(state, ctx, seatIndex);
}

/** The clock ran out on the player to act: they check or fold and sit out until they come back. */
function timeOut(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const player = playerAt(hand, hand.toAct!)!;
  const seat = state.seats[player.seat]!;

  seat.away = true;
  seat.sittingOut = true;
  record(hand, ['timeout', player.seat]);
  narrate(state, ctx, `${player.name} ran out of time`);

  checkOrFold(state, ctx, player);
  advance(state, ctx, player.seat);
}

/** A player gave up their seat mid-hand, so nothing in the hand may wait for them. */
export function stopWaitingFor(state: TableState, ctx: Ctx, seatIndex: number): void {
  const hand = state.hand;
  const player = hand ? playerAt(hand, seatIndex) : undefined;
  if (!hand || !player) {
    return;
  }

  if (hand.stage === 'betting' && hand.toAct === seatIndex) {
    checkOrFold(state, ctx, player);
    advance(state, ctx, seatIndex);
  } else if (hand.stage === 'ritVote' && !player.folded && player.ritVote === null) {
    narrate(state, ctx, `${player.name} left without voting, so it runs once`);
    startRunout(state, ctx, 1);
  }
}

function beginRunout(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const live = livePlayers(hand);

  collectBets(hand);
  hand.sharedBoardLength = hand.boards[0]!.length;

  for (const player of live) {
    if (!player.shown) {
      show(state, ctx, player);
    }
  }

  const everyoneCanVote = live.every((p) => !state.seats[p.seat]!.away && !state.seats[p.seat]!.leaving);
  if (state.config.allowRunItTwice && everyoneCanVote) {
    hand.stage = 'ritVote';
    hand.deadline = ctx.now + TIMING.ritVoteMs;
    return;
  }

  startRunout(state, ctx, 1);
}

function startRunout(state: TableState, ctx: Ctx, runs: number): void {
  const hand = state.hand!;

  hand.stage = 'runout';
  hand.runs = runs;
  hand.runIndex = 0;
  hand.deadline = ctx.now + TIMING.runoutStepMs;
  record(hand, ['runs', runs]);

  if (runs > 1) {
    narrate(state, ctx, 'Everyone agreed to run it twice');
  }
}

export function voteRunItTwice(state: TableState, ctx: Ctx, seatIndex: number, agree: boolean): void {
  const hand = state.hand;
  const player = hand ? playerAt(hand, seatIndex) : undefined;

  if (!hand || hand.stage !== 'ritVote' || !player || player.folded) {
    throw new GameError('There is no run-it-twice vote for you right now');
  }

  if (player.ritVote !== null) {
    throw new GameError('You already voted');
  }

  player.ritVote = agree;
  record(hand, ['vote', seatIndex, agree]);

  if (!agree) {
    narrate(state, ctx, `${player.name} wants to run it once`);
    startRunout(state, ctx, 1);
    return;
  }

  if (livePlayers(hand).every((p) => p.ritVote === true)) {
    startRunout(state, ctx, 2);
  }
}

/** Deals the next street of an all-in runout, and settles the hand once every board is complete. */
function runoutStep(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const board = hand.boards[hand.runIndex]!;

  hand.street = dealBoardCards(hand, hand.runIndex);

  const boardLabel = hand.runs > 1 ? (hand.runIndex === 0 ? 'First board, ' : 'Second board, ') : '';
  narrate(state, ctx, `${boardLabel}${STREET_TITLES[hand.street]}: ${prettyCards(board)}`);

  if (board.length < BOARD_SIZE) {
    hand.deadline = ctx.now + TIMING.runoutStepMs;
    return;
  }

  if (hand.runIndex + 1 < hand.runs) {
    hand.runIndex += 1;
    hand.boards.push(hand.boards[0]!.slice(0, hand.sharedBoardLength));
    hand.deadline = ctx.now + TIMING.runoutStepMs;
    return;
  }

  settleShowdown(state, ctx);
}

/**
 * Turns hands face up in showdown order: the last player to bet or raise on the river goes first, or
 * the first player left of the button if the river was checked around. After that a player shows only
 * if they can still win a pot, and mucks otherwise.
 */
function revealAtShowdown(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const live = livePlayers(hand);
  const board = hand.boards[0]!;
  const pots = buildPots(hand.players);
  const values = new Map(live.map((p) => [p.seat, evaluateHand([...p.cards, ...board])]));

  const aggressor = live.find((p) => p.seat === hand.lastAggressor);
  const order = aggressor ? clockwiseFrom(live, aggressor.seat) : clockwiseAfter(live, hand.button);
  const shown: number[] = [];

  for (const player of order) {
    const mine = values.get(player.seat)!;
    const canStillWin = pots.some((pot) => {
      if (!pot.eligible.includes(player.seat)) {
        return false;
      }

      return shown.filter((seat) => pot.eligible.includes(seat)).every((seat) => mine.score >= values.get(seat)!.score);
    });

    if (canStillWin) {
      shown.push(player.seat);
      show(state, ctx, player, ` (${mine.name})`);
    } else {
      record(hand, ['muck', player.seat]);
      narrate(state, ctx, `${player.name} mucks`);
    }
  }
}

function potLabel(index: number, count: number): string {
  if (count === 1) {
    return '';
  }

  return index === 0 ? ' from the main pot' : ` from side pot ${index}`;
}

function settleShowdown(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const live = livePlayers(hand);

  collectBets(hand);

  const pots = buildPots(hand.players);
  const values: Map<number, HandValue>[] = hand.boards.map(
    (board) => new Map(live.map((p) => [p.seat, evaluateHand([...p.cards, ...board])])),
  );

  const potResults: PotResult[] = [];
  const winnings = new Map<number, number>();
  const mainPotWinners = new Set<number>();

  pots.forEach((pot, potIndex) => {
    const awards: PotAward[] = [];

    // Run twice, each board plays for half the pot and the first board gets the odd chip
    const firstHalf = Math.ceil(pot.amount / hand.runs);
    const amounts = hand.runs === 1 ? [pot.amount] : [firstHalf, pot.amount - firstHalf];

    amounts.forEach((amount, run) => {
      if (amount === 0) {
        return;
      }

      const best = Math.max(...pot.eligible.map((seat) => values[run]!.get(seat)!.score));
      const winners = pot.eligible.filter((seat) => values[run]!.get(seat)!.score === best);

      // Taken from the hands, not the payouts: in a tie over a single chip only one player is paid
      if (potIndex === 0) {
        winners.forEach((seat) => mainPotWinners.add(seat));
      }

      const runLabel = hand.runs > 1 ? (run === 0 ? ' on the first board' : ' on the second board') : '';

      for (const [seat, share] of splitAmount(amount, seatsClockwiseAfter(winners, hand.button))) {
        if (share === 0) {
          continue;
        }

        awards.push({ seat, amount: share, run });
        winnings.set(seat, (winnings.get(seat) ?? 0) + share);
        record(hand, ['win', seat, share, potIndex, run]);

        const winner = playerAt(hand, seat)!;
        const handName = values[run]!.get(seat)!.name;
        narrate(state, ctx, `${winner.name} wins ${formatAmount(share, state.config)}${potLabel(potIndex, pots.length)}${runLabel} with ${handName}`);
      }
    });

    potResults.push({ amount: pot.amount, eligible: pot.eligible, awards });
  });

  for (const [seat, amount] of winnings) {
    state.seats[seat]!.stack += amount;
  }

  const hands: ShownHand[] = [];
  hand.boards.forEach((_board, run) => {
    for (const player of live) {
      if (player.shown) {
        const value = values[run]!.get(player.seat)!;
        hands.push({ seat: player.seat, run, name: value.name, cards: value.cards });
      }
    }
  });

  // The bounty is for winning the hand outright: the whole main pot, on every board
  const soleWinner = mainPotWinners.size === 1 ? [...mainPotWinners][0]! : null;
  const bounty = soleWinner === null ? null : payBounty(state, ctx, soleWinner);

  finishHand(state, ctx, {
    uncontested: false,
    pots: potResults,
    winnings: [...winnings].map(([seat, amount]) => ({ seat, amount })),
    hands,
    bounty,
  });
}

function finishUncontested(state: TableState, ctx: Ctx, winner: HandPlayer): void {
  const hand = state.hand!;

  refundUncalledBet(state, ctx);
  collectBets(hand);

  const pots = buildPots(hand.players);
  const total = pots.reduce((sum, pot) => sum + pot.amount, 0);

  state.seats[winner.seat]!.stack += total;
  pots.forEach((pot, potIndex) => record(hand, ['win', winner.seat, pot.amount, potIndex, 0]));
  narrate(state, ctx, `${winner.name} wins ${formatAmount(total, state.config)}`);

  finishHand(state, ctx, {
    uncontested: true,
    pots: pots.map((pot) => ({
      amount: pot.amount,
      eligible: pot.eligible,
      awards: [{ seat: winner.seat, amount: pot.amount, run: 0 }],
    })),
    winnings: [{ seat: winner.seat, amount: total }],
    hands: [],
    bounty: payBounty(state, ctx, winner.seat),
  });
}

function isSevenDeuce(cards: readonly Card[]): boolean {
  const ranks = cards.map(rankOf).sort((a, b) => a - b);

  return ranks[0] === 2 && ranks[1] === 7;
}

/** Whoever wins a hand holding seven-deuce collects the bounty from everyone else who was dealt in. */
function payBounty(state: TableState, ctx: Ctx, winnerSeat: number): BountyResult | null {
  const hand = state.hand!;
  const winner = playerAt(hand, winnerSeat)!;

  if (hand.bounty <= 0 || !isSevenDeuce(winner.cards)) {
    return null;
  }

  const payments: BountyResult['payments'] = [];
  let total = 0;

  for (const player of hand.players) {
    if (player === winner) {
      continue;
    }

    const seat = state.seats[player.seat]!;
    const amount = Math.min(hand.bounty, seat.stack);

    if (amount > 0) {
      seat.stack -= amount;
      total += amount;
      payments.push({ seat: player.seat, amount });
    }
  }

  // Everyone who owes it lost their last chip in the hand, so there is no bounty to announce
  if (total === 0) {
    return null;
  }

  if (!winner.shown) {
    show(state, ctx, winner);
  }

  state.seats[winnerSeat]!.stack += total;
  record(hand, ['bounty', winnerSeat, payments.map((payment): [number, number] => [payment.seat, payment.amount])]);
  narrate(state, ctx, `${winner.name} won with seven-deuce and collects a bounty of ${formatAmount(total, state.config)}`);

  return { seat: winnerSeat, payments };
}

function finishHand(state: TableState, ctx: Ctx, result: HandResult): void {
  const hand = state.hand!;
  let pause = TIMING.showdownPauseMs;

  if (result.uncontested) {
    pause = TIMING.uncontestedPauseMs;
  } else if (hand.runs > 1) {
    pause = TIMING.runTwicePauseMs;
  }

  hand.result = result;
  hand.stage = 'done';
  hand.toAct = null;
  hand.deadline = ctx.now + pause;
}

/** After a hand is over, anyone who was dealt in may turn their cards face up. */
export function showCards(state: TableState, ctx: Ctx, seatIndex: number): void {
  const hand = state.hand;
  const player = hand ? playerAt(hand, seatIndex) : undefined;

  if (!hand || hand.stage !== 'done' || !player) {
    throw new GameError('You can show your cards once the hand is over');
  }

  if (player.shown) {
    throw new GameError('Your cards are already showing');
  }

  show(state, ctx, player);
}

/** Takes the finished hand off the table, writes it to the record and applies everything that was waiting for it. */
function clearHand(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;

  ctx.effects.push({
    type: 'hand',
    record: {
      at: ctx.now,
      tableId: state.id,
      number: hand.number,
      summary: hand.log.join('\n'),
      boards: hand.boards,
      players: hand.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        startStack: p.startStack,
        endStack: state.seats[p.seat]!.stack,
        cards: p.shown ? p.cards : null,
      })),
      result: hand.result!,
      events: hand.events,
    },
  });

  state.hand = null;

  state.seats.forEach((seat, index) => {
    if (!seat) {
      return;
    }

    if (seat.leaving) {
      vacateSeat(state, ctx, index);
    } else {
      addPendingChips(state, ctx, index);
    }
  });
}

/** Does whatever the hand's deadline was waiting for. Only call once the deadline has passed. */
export function stepHand(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;

  switch (hand.stage) {
    case 'betting':
      timeOut(state, ctx);
      break;
    case 'ritVote':
      narrate(state, ctx, 'Not everyone voted in time, so it runs once');
      startRunout(state, ctx, 1);
      break;
    case 'runout':
      runoutStep(state, ctx);
      break;
    case 'done':
      clearHand(state, ctx);
      break;
  }
}
