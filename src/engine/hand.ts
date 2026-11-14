import { formatAmount } from './amounts.ts';
import { bettingIsClosed, bettingOptions, chipsFor, objectionTo, onTheClock, passesTo } from './betting.ts';
import type { BettingAction } from './betting.ts';
import { boardsComplete, dealStreet, newBoards, potShares, runOut } from './boards.ts';
import { boardsDealt, bombPotName, claimBombPot } from './bombPots.ts';
import { isSevenDeuce, prettyCards, shuffledDeck } from './cards.ts';
import { answerUnasked, chopsUnasked, mayOfferChop } from './chop.ts';
import { takesEvent } from './events.ts';
import type { HandEvent } from './events.ts';
import { openingBet } from './forcedBets.ts';
import type { ForcedBet } from './forcedBets.ts';
import { madeHandName, midSentence } from './handNames.ts';
import { planHand, takeUp } from './handPlan.ts';
import { playerHand } from './handRank.ts';
import type { HandValue } from './handRank.ts';
import { buildPots, splitAmount } from './pots.ts';
import { addFeed, clockwiseAfter, clockwiseFrom, eligibleSeats, seatsClockwiseAfter } from './seats.ts';
import { stakesText } from './stakes.ts';
import { GameError } from './types.ts';
import type { AnteFrom, BombPot, BountyResult, Ctx, Hand, HandPlayer, HandRecord, HandResult, PotAward, PotResult, ShownHand, Street, TableState } from './types.ts';

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

// A hand's log is saved with the table on every action, so a raising war can't be allowed to grow it without end
const LOG_LIMIT = 240;
const LOG_HEAD = 40;
const LOG_GAP = '… a long stretch of the action is left out …';

const STREET_TITLES: Record<Street, string> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };

/** What the play-by-play calls each board of a hand played on several. */
const BOARD_NAMES = ['First board', 'Second board'];

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
  if (takesEvent(hand.events, event)) {
    hand.events.push(event);
  } else {
    hand.events = [];
  }
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

/** Takes chips from a player's stack into the hand. `as` says how they count there; a call or a raise is a live bet, like a blind. */
function pay(state: TableState, player: HandPlayer, amount: number, as: ForcedBet['as'] = 'live'): void {
  const seat = state.seats[player.seat]!;

  seat.stack -= amount;

  if (as === 'live') {
    player.bet += amount;
  }

  if (as === 'dead') {
    player.dead += amount;
  } else {
    player.committed += amount;
  }

  if (seat.stack === 0) {
    player.allIn = true;
  }
}

/** Splits a hand's forced bets where one kind of bet ends and the next begins. */
function byKind(bets: readonly ForcedBet[]): ForcedBet[][] {
  const kinds: ForcedBet[][] = [];

  for (const bet of bets) {
    const kind = kinds[kinds.length - 1];

    if (kind && kind[0]!.what === bet.what && kind[0]!.amount === bet.amount) {
      kind.push(bet);
    } else {
      kinds.push([bet]);
    }
  }

  return kinds;
}

/**
 * Posts a hand's forced bets in the order they are listed, each as far as its player's stack goes.
 * A bet the whole table posts is told in one line, and only a player it leaves short or all in gets a
 * line of their own: an ante apiece on top of every hand would bury the chat.
 */
function postForcedBets(state: TableState, ctx: Ctx, bets: readonly ForcedBet[]): void {
  const hand = state.hand!;
  const tell = (who: string, bet: ForcedBet, posted: number, allIn: boolean) =>
    narrate(state, ctx, `${who} posts ${bet.what} ${formatAmount(posted, state.config)}${allIn ? ' and is all in' : ''}`);

  for (const kind of byKind(bets)) {
    const fromEveryone = kind.length === hand.players.length;
    const inFull: HandPlayer[] = [];

    for (const bet of kind) {
      const player = playerAt(hand, bet.seat)!;
      const seat = state.seats[bet.seat]!;
      const posted = Math.min(bet.amount, seat.stack);

      // An earlier forced bet took the whole stack, so there is nothing left to post this one with
      if (posted === 0) {
        continue;
      }

      pay(state, player, posted, bet.as);
      record(hand, bet.as === 'live' ? ['post', bet.seat, bet.what, posted, seat.stack] : ['post', bet.seat, bet.what, posted, seat.stack, bet.as]);

      // The label by a seat names what is in front of it
      if (bet.as === 'live') {
        player.lastAction = bet.what;
      }

      if (fromEveryone && !player.allIn) {
        inFull.push(player);
      } else {
        tell(player.name, bet, posted, player.allIn);
      }
    }

    if (inFull.length === 1) {
      tell(inFull[0]!.name, kind[0]!, kind[0]!.amount, false);
    } else if (inFull.length > 1) {
      tell(inFull.length === kind.length ? 'Everyone' : 'Everyone else', kind[0]!, kind[0]!.amount, false);
    }
  }
}

export function startHand(state: TableState, ctx: Ctx): void {
  if (eligibleSeats(state).length < 2) {
    throw new Error('A hand needs at least two players');
  }

  const { smallBlind, bigBlind, sevenDeuceBounty } = state.config;
  const bombPot = claimBombPot(state);

  // Worked out while every stack is still whole: what the hand starts with is settled before any of it is posted
  const plan = planHand(state, bombPot, ctx.rng);
  const { button, order, sbSeat, bbSeat, bets: forced } = plan;

  // A bomb pot has no bet to call before the flop, and no betting there
  const opening = bombPot ? null : openingBet(forced);

  // Kept in seat order, whatever order they are dealt in
  const players: HandPlayer[] = [...order].sort((a, b) => a - b).map((seat) => {
    const playerId = state.seats[seat]!.playerId;

    return {
      seat,
      playerId,
      name: state.members.find((m) => m.id === playerId)!.name,
      cards: [],
      startStack: state.seats[seat]!.stack,
      bet: 0,
      committed: 0,
      dead: 0,
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
  state.nextHandAt = null;
  takeUp(state, plan);

  const hand: Hand = {
    number: state.handCount,
    startedAt: ctx.now,
    smallBlind,
    bigBlind,
    button,
    sbSeat,
    bbSeat,
    straddles: plan.straddles,
    passedOver: plan.passedOver,
    bounty: sevenDeuceBounty,
    bombPot,
    chopOffered: false,
    deck,
    ...newBoards(boardsDealt(bombPot)),
    street: 'preflop',
    stage: 'betting',
    players,
    currentBet: opening?.amount ?? 0,
    minRaise: opening?.amount ?? bigBlind,
    toAct: null,
    lastAggressor: null,
    deadline: null,
    result: null,
    log: [],
    events: [],
  };
  state.hand = hand;

  const stacks = players.map((p): [number, string, number] => [p.seat, p.name, p.startStack]);
  const terms = bombPot ? `${bombPotName(bombPot)} ${formatAmount(bombPot.amount, state.config)}` : `blinds ${stakesText(state.config)}`;

  const onTheButton = playerAt(hand, button);

  record(hand, ['start', hand.number, button, smallBlind, bigBlind, stacks, ...startTerms(state, bombPot)]);
  narrate(state, ctx, `Hand #${hand.number} · ${terms} · ${onTheButton ? `${onTheButton.name} has the button` : `dead button on seat ${button + 1}`}`);

  // Said, since a hand that starts with one blind looks like a mistake: whoever had the big blind is not in this hand
  if (!bombPot && !order.includes(sbSeat)) {
    narrate(state, ctx, 'No small blind this hand');
  }

  postForcedBets(state, ctx, forced);

  record(hand, ['deal']);

  if (opening) {
    advance(state, ctx, opening.seat);
    return;
  }

  // The flop comes whoever is all in, on every board. What nobody could match goes back first, so it is dealt to the pot it is played for
  refundUncalledBet(state, ctx);
  dealNextStreet(state, ctx);
  advance(state, ctx, button);
}

/** What a hand's first event says beyond the blinds, each part left out of a hand it plays no part in. */
function startTerms(state: TableState, bombPot: BombPot | null): [ante?: number, anteFrom?: AnteFrom, bombPot?: BombPot] {
  const { ante, anteFrom } = state.config;

  // A bomb pot is played without the table's ante
  if (bombPot) {
    return [0, anteFrom, bombPot];
  }

  return ante > 0 ? [ante, anteFrom] : [];
}

function actionDeadline(state: TableState, now: number): number | null {
  const seconds = state.config.actionSeconds;

  return seconds > 0 ? now + seconds * 1000 + TIMING.actionGraceMs : null;
}

/** The clock setting changed: whoever is being waited for gets the new one, counted from now. */
export function restartActionClock(state: TableState, now: number): void {
  const hand = state.hand;

  if (hand && onTheClock(hand) !== null) {
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

    const next = passesTo(hand, from)!;
    const seat = state.seats[next.seat]!;

    if (chopsUnasked(state, hand, next.seat)) {
      chopTheBlinds(state, ctx);
      return;
    }

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

  // More than the bet when part of an ante went unmatched too: an ante is a stake, and no part of the bet
  const beyondTheBet = excess > top.bet;

  top.committed -= excess;
  top.bet = Math.max(0, top.bet - excess);
  top.allIn = false;
  state.seats[top.seat]!.stack += excess;

  record(hand, ['return', top.seat, excess]);
  narrate(state, ctx, beyondTheBet ? `${formatAmount(excess, state.config)} that nobody could match returned to ${top.name}` : `Uncalled bet of ${formatAmount(excess, state.config)} returned to ${top.name}`);
}

/** Deals the next street, on every board it is due on, and tells the table. */
function dealAndTell(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;

  for (const { board, street, cards } of dealStreet(hand)) {
    const which = hand.runs > 1 ? `${BOARD_NAMES[board]}, ` : '';

    hand.street = street;
    record(hand, ['street', board, cards]);
    narrate(state, ctx, `${which}${STREET_TITLES[street]}: ${prettyCards(hand.boards[board]!)}`);
  }
}

/** Deals the next street and opens its round of betting. */
function dealNextStreet(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;

  dealAndTell(state, ctx);
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
  const objection = objectionTo(action, options, hand.currentBet, state.config);

  if (objection) {
    throw new GameError(objection);
  }

  const paid = chipsFor(action, options, player.bet);

  switch (action.type) {
    case 'fold': {
      player.folded = true;
      player.lastAction = 'fold';
      record(hand, ['fold', player.seat]);
      narrate(state, ctx, `${player.name} folds`);
      break;
    }

    case 'check': {
      player.lastAction = 'check';
      record(hand, ['check', player.seat]);
      narrate(state, ctx, `${player.name} checks`);
      break;
    }

    case 'call': {
      pay(state, player, paid);
      player.lastAction = 'call';
      record(hand, ['call', player.seat, paid, state.seats[player.seat]!.stack]);
      narrate(state, ctx, `${player.name} calls ${formatAmount(paid, state.config)}${player.allIn ? ' and is all in' : ''}`);
      break;
    }

    case 'raise': {
      const { to } = action;
      const opening = hand.currentBet === 0;
      const raisedBy = to - hand.currentBet;

      pay(state, player, paid);

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
 * Refuses a decision sent for another than the one open. `turn` is the decision the player was looking
 * at: an answer that was slow to arrive, or sent twice, must not be played on a later one they never saw.
 */
function requireTurn(state: TableState, turn: number | undefined): void {
  if (turn !== undefined && turn !== state.turn) {
    throw new GameError('The hand moved on before that arrived, so it was not played');
  }
}

/** A player's own decision when the action is on them, for the decision `turn` when it is given. */
export function act(state: TableState, ctx: Ctx, seatIndex: number, action: BettingAction, turn?: number): void {
  const hand = state.hand;
  if (!hand || hand.stage !== 'betting' || hand.toAct !== seatIndex) {
    throw new GameError("It's not your turn");
  }

  requireTurn(state, turn);

  perform(state, ctx, playerAt(hand, seatIndex)!, action);

  // Acting proves a player who timed out earlier is back
  const seat = state.seats[seatIndex]!;
  if (seat.away) {
    seat.away = false;
    seat.sittingOut = false;
  }

  advance(state, ctx, seatIndex);
}

/**
 * The small blind offers to chop the blinds instead of a move, on their turn (`turn`, when given). The
 * big blind is asked, unless what they would say is already known (`answerUnasked`).
 */
export function offerChop(state: TableState, ctx: Ctx, seatIndex: number, turn?: number): void {
  const hand = state.hand;
  if (!hand || hand.stage !== 'betting' || hand.toAct !== seatIndex) {
    throw new GameError("It's not your turn");
  }

  requireTurn(state, turn);

  if (!state.config.allowChop) {
    throw new GameError("This table doesn't chop the blinds");
  }

  if (hand.chopOffered) {
    throw new GameError('You already offered to chop in this hand');
  }

  if (!mayOfferChop(state, seatIndex)) {
    throw new GameError('Only the small blind can offer to chop, when everyone else has folded and the pot is just the blinds');
  }

  const big = playerAt(hand, hand.bbSeat)!;

  hand.chopOffered = true;
  record(hand, ['chopOffer', seatIndex]);
  narrate(state, ctx, `${playerAt(hand, seatIndex)!.name} offers to chop the blinds`);

  const unasked = answerUnasked(state.seats[big.seat]!);
  if (unasked !== null) {
    settleChop(state, ctx, big, unasked, false);
    return;
  }

  hand.stage = 'chop';
  hand.toAct = big.seat;
  state.turn += 1;
  hand.deadline = actionDeadline(state, ctx.now);
}

/** The big blind answers the offer to chop, for the decision `turn` when it is given. */
export function answerChop(state: TableState, ctx: Ctx, seatIndex: number, agree: boolean, turn?: number): void {
  const hand = state.hand;
  if (!hand || hand.stage !== 'chop' || hand.toAct !== seatIndex) {
    throw new GameError('There is no chop for you to answer');
  }

  requireTurn(state, turn);
  settleChop(state, ctx, playerAt(hand, seatIndex)!, agree, true);
}

/**
 * The offer to chop is answered: by the big blind (`given`), or for them by their standing choice, the
 * clock or their leaving. Yes chops the blinds. No takes the offer off for the hand and puts the small
 * blind back on a fresh clock with the usual choices, or folds for them if they are away or leaving.
 */
function settleChop(state: TableState, ctx: Ctx, big: HandPlayer, agree: boolean, given: boolean): void {
  const hand = state.hand!;

  record(hand, ['chopAnswer', big.seat, agree]);

  if (agree) {
    narrate(state, ctx, `${big.name} agrees to chop`);
    chopTheBlinds(state, ctx);
    return;
  }

  narrate(state, ctx, given ? `${big.name} says no to the chop` : `${big.name} did not answer, so there is no chop`);
  hand.stage = 'betting';

  // The small blind is the one player after the big blind still to act
  advance(state, ctx, big.seat);
}

/** Each blind goes back to the seat that posted it, and the hand is over with no winner and nothing shown. */
function chopTheBlinds(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const blinds = [playerAt(hand, hand.sbSeat)!, playerAt(hand, hand.bbSeat)!];

  record(hand, ['chop', blinds.map((player): [number, number] => [player.seat, player.committed])]);

  for (const player of blinds) {
    state.seats[player.seat]!.stack += player.committed;
    player.bet = 0;
    player.committed = 0;
    player.allIn = false;
  }

  narrate(state, ctx, `${blinds[0]!.name} and ${blinds[1]!.name} chop the blinds: each takes back their own`);

  finishHand(state, ctx, { uncontested: true, chopped: true, pots: [], winnings: [], hands: [], bounty: null });
}

/** The clock ran out on the player it was on: they check or fold, or say no to a chop, and sit out until they come back. */
function timeOut(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const player = playerAt(hand, hand.toAct!)!;
  const seat = state.seats[player.seat]!;

  seat.away = true;
  seat.sittingOut = true;
  record(hand, ['timeout', player.seat]);
  narrate(state, ctx, `${player.name} ran out of time`);

  if (hand.stage === 'chop') {
    settleChop(state, ctx, player, seat.alwaysChop, false);
    return;
  }

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
  } else if (hand.stage === 'chop' && hand.toAct === seatIndex) {
    settleChop(state, ctx, player, state.seats[seatIndex]!.alwaysChop, false);
  } else if (hand.stage === 'ritVote' && !player.folded && player.ritVote === null) {
    narrate(state, ctx, `${player.name} left without voting, so it runs once`);
    startRunout(state, ctx, 1);
  }
}

function beginRunout(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const live = livePlayers(hand);

  collectBets(hand);

  for (const player of live) {
    if (!player.shown) {
      show(state, ctx, player);
    }
  }

  // A second board is offered only to a hand on one: boards dealt apart from the start are already two
  const everyoneCanVote = live.every((p) => !state.seats[p.seat]!.away && !state.seats[p.seat]!.leaving);
  if (hand.runs === 1 && state.config.allowRunItTwice && everyoneCanVote) {
    hand.stage = 'ritVote';
    hand.deadline = ctx.now + TIMING.ritVoteMs;
    return;
  }

  startRunout(state, ctx, hand.runs);
}

function startRunout(state: TableState, ctx: Ctx, runs: number): void {
  const hand = state.hand!;

  hand.stage = 'runout';
  runOut(hand, runs);
  hand.deadline = ctx.now + TIMING.runoutStepMs;
  record(hand, ['runs', runs]);
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
    narrate(state, ctx, 'Everyone agreed to run it twice');
  }
}

/** Deals the next street of an all-in runout, and settles the hand once every board is complete. */
function runoutStep(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;

  dealAndTell(state, ctx);

  if (boardsComplete(hand)) {
    settleShowdown(state, ctx);
    return;
  }

  hand.deadline = ctx.now + TIMING.runoutStepMs;
}

/** What every player still in makes on each of the hand's boards, by seat. */
function handsByBoard(hand: Hand): Map<number, HandValue>[] {
  const live = livePlayers(hand);

  return hand.boards.map((board) => new Map(live.map((p) => [p.seat, playerHand(p.cards, board)])));
}

/**
 * Turns hands face up in showdown order: the last player to bet or raise on the river goes first, or
 * the first player left of the button if the river was checked around. After that a player shows only
 * if they can still win a pot on some board, and mucks otherwise.
 */
function revealAtShowdown(state: TableState, ctx: Ctx): void {
  const hand = state.hand!;
  const live = livePlayers(hand);
  const pots = buildPots(hand.players);
  const values = handsByBoard(hand);

  const aggressor = live.find((p) => p.seat === hand.lastAggressor);
  const order = aggressor ? clockwiseFrom(live, aggressor.seat) : clockwiseAfter(live, hand.button);
  const shown: number[] = [];

  for (const player of order) {
    const canStillWin = pots.some((pot) => {
      if (!pot.eligible.includes(player.seat)) {
        return false;
      }

      const against = shown.filter((seat) => pot.eligible.includes(seat));

      return values.some((onBoard) => against.every((seat) => onBoard.get(player.seat)!.score >= onBoard.get(seat)!.score));
    });

    if (canStillWin) {
      shown.push(player.seat);
      show(state, ctx, player, ` (${values.map((onBoard) => madeHandName(onBoard.get(player.seat)!)).join(' / ')})`);
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
  const values = handsByBoard(hand);

  const potResults: PotResult[] = [];
  const winnings = new Map<number, number>();
  const mainPotWinners = new Set<number>();

  pots.forEach((pot, potIndex) => {
    const awards: PotAward[] = [];

    potShares(hand, pot.amount).forEach((amount, run) => {
      if (amount === 0) {
        return;
      }

      const best = Math.max(...pot.eligible.map((seat) => values[run]!.get(seat)!.score));
      const winners = pot.eligible.filter((seat) => values[run]!.get(seat)!.score === best);

      // Taken from the hands, not the payouts: in a tie over a single chip only one player is paid
      if (potIndex === 0) {
        winners.forEach((seat) => mainPotWinners.add(seat));
      }

      const runLabel = hand.runs > 1 ? ` on the ${midSentence(BOARD_NAMES[run]!)}` : '';

      for (const [seat, share] of splitAmount(amount, seatsClockwiseAfter(winners, hand.button))) {
        if (share === 0) {
          continue;
        }

        awards.push({ seat, amount: share, run });
        winnings.set(seat, (winnings.get(seat) ?? 0) + share);
        record(hand, ['win', seat, share, potIndex, run]);

        const winner = playerAt(hand, seat)!;
        const handName = midSentence(madeHandName(values[run]!.get(seat)!));
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
        hands.push({ seat: player.seat, run, name: madeHandName(value), cards: value.cards });
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

  // A big blind posted with no small blind and no ante, and folded to, went back as an uncalled bet: nothing is left to win
  narrate(state, ctx, total > 0 ? `${winner.name} wins ${formatAmount(total, state.config)}` : `Everyone folded to ${winner.name}`);

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

/** Takes the finished hand off the table and writes it to the record, which is all that is kept of it. */
function clearHand(state: TableState, ctx: Ctx): HandRecord {
  const hand = state.hand!;
  const record: HandRecord = {
    at: ctx.now,
    tableId: state.id,
    number: hand.number,
    summary: hand.log.join('\n'),
    boards: hand.boards,
    bigBlind: hand.bigBlind,
    bombPot: hand.bombPot,
    players: hand.players.map((p) => ({
      seat: p.seat,
      playerId: p.playerId,
      name: p.name,
      startStack: p.startStack,
      endStack: state.seats[p.seat]!.stack,
      cards: p.shown ? p.cards : null,
    })),
    result: hand.result!,
    events: hand.events,
  };

  ctx.effects.push({ type: 'hand', record });
  state.hand = null;

  return record;
}

/**
 * Does whatever the hand's deadline was waiting for. Only call once the deadline has passed. A step
 * that ends the hand gives back its record, for `handEnded` to be called with; any other gives null.
 */
export function stepHand(state: TableState, ctx: Ctx): HandRecord | null {
  const hand = state.hand!;

  switch (hand.stage) {
    case 'betting':
    case 'chop':
      timeOut(state, ctx);
      return null;
    case 'ritVote':
      narrate(state, ctx, 'Not everyone voted in time, so it runs once');
      startRunout(state, ctx, 1);
      return null;
    case 'runout':
      runoutStep(state, ctx);
      return null;
    case 'done':
      return clearHand(state, ctx);
  }
}
