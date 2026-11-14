import { editableAmount, formatAmount, hasDecimals, parseAmount, shortAmount } from '../../engine/amounts.ts';
import type { Denominated } from '../../engine/amounts.ts';
import type { BettingAction } from '../../engine/betting.ts';
import { bombPotName } from '../../engine/bombPots.ts';
import { straddlesAllowed } from '../../engine/straddles.ts';
import type { Command, PassedOver } from '../../engine/types.ts';
import type { HandView, SeatView, TableView } from '../../engine/view.ts';
import { HOTKEYS } from '../hotkeys.ts';
import type { Waiting } from '../shownTable.ts';
import { h, holdWhile } from '../ui.ts';
import { lastHandsText, nightOver, onLastHand } from './night.ts';

export interface ControlHandlers {
  /** Resolves once the server has answered, or failed to. */
  send(command: Command): Promise<unknown>;
  openRebuy(): void;
  /** Opens the player's own choice of straddles, at a table that allows more than one kind. */
  openStraddles(): void;
  sizing: Sizing;
}

/**
 * The bet a player is sizing, kept apart from the buttons, so that a panel drawn again for the same
 * decision still has it: after a move the server refused, the buttons come back as they were left.
 */
export interface Sizing {
  /** What stood in the amount box for the decision numbered `turn`; null when nothing was kept for it. */
  typed(turn: number): string | null;
  keep(turn: number, typed: string): void;
}

/** A `Sizing` that remembers the latest decision only, which is the only one a panel is ever drawn for. */
export function sizingMemory(): Sizing {
  let kept: { turn: number; typed: string } | null = null;

  return {
    typed: (turn) => (kept?.turn === turn ? kept.typed : null),
    keep: (turn, typed) => {
      kept = { turn, typed };
    },
  };
}

interface SizePreset {
  label: string;
  /** Share of the pot to bet, counting the call first when there is one. Null means the smallest raise. */
  potShare: number | null;
}

const PRESETS: SizePreset[] = [
  { label: 'Min', potShare: null },
  { label: '½ pot', potShare: 0.5 },
  { label: '¾ pot', potShare: 0.75 },
  { label: 'Pot', potShare: 1 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A button for something other than a move in the hand. It waits for its own answer before it can be pressed again. */
function commandButton(spec: `button.${string}`, action: string, label: string, send: () => Promise<unknown>): HTMLButtonElement {
  const button = h(spec, { type: 'button', 'data-action': action }, label);
  button.addEventListener('click', () => holdWhile(button, send));

  return button;
}

/** What a move button says: the move and its amount as two pieces, so a narrow button breaks between them instead of cutting the amount off. */
function moveLabel(move: string, amount: number, table: Denominated): (HTMLElement | string)[] {
  // The space is for whoever reads the button as text; laid out, the two pieces are spaced by the button
  return [h('span', null, move), ' ', h('span.amount-of', { title: formatAmount(amount, table) }, shortAmount(amount, table, 'up'))];
}

/**
 * The buttons for the player on the clock. Keeps the chosen raise size itself, so it survives until
 * the turn changes. Every move names the decision it answers, so it can't be played on a later one.
 */
function turnPanel(table: Denominated, hand: HandView, stack: number, handlers: ControlHandlers): HTMLElement {
  const options = hand.options!;
  const { minRaiseTo, maxRaiseTo, callAmount, callCost } = options;
  const opening = hand.currentBet === 0;
  const turn = hand.turn;

  const raiseButton = h('button.btn.raise', { type: 'button', 'data-action': 'raise', 'data-hotkey': HOTKEYS.raise });
  const slider = h('input', { type: 'range', id: 'raise-slider', min: minRaiseTo, max: maxRaiseTo, step: 1, 'aria-label': 'Bet size' });
  const amount = h('input', { type: 'text', id: 'raise-amount', inputmode: hasDecimals(table) ? 'decimal' : 'numeric', autocomplete: 'off', 'aria-label': 'Bet size' });

  let raiseTo = minRaiseTo;

  // The slider and the size buttons work in the table's smallest unit, so whatever they pick is an amount that can be bet
  const choose = (value: number, from?: HTMLInputElement): void => {
    raiseTo = clamp(Math.round(value) || minRaiseTo, minRaiseTo, maxRaiseTo);

    if (from !== slider) {
      slider.value = String(raiseTo);
    }

    if (from !== amount) {
      amount.value = editableAmount(raiseTo, table);
    }

    amount.setCustomValidity('');
    raiseButton.removeAttribute('aria-disabled');
    raiseButton.replaceChildren(...moveLabel(raiseTo === maxRaiseTo ? 'All in' : opening ? 'Bet' : 'Raise to', raiseTo, table));
  };

  /**
   * What is in the box can't be read as an amount. No other amount is put in its place: the button
   * names none and plays none until the box reads. The reason is said when the button is pressed, not
   * while typing: "1," is on its way to "1,000".
   */
  const refuse = (problem: string): void => {
    amount.setCustomValidity(problem);
    raiseButton.setAttribute('aria-disabled', 'true');
    raiseButton.replaceChildren(h('span', null, opening ? 'Bet' : 'Raise'));
  };

  const readBox = (): void => {
    // An empty box is the smallest raise, as it has always been
    const typed = parseAmount(amount.value.trim() || '0', table);

    if (typed.ok) {
      choose(typed.amount, amount);
    } else {
      refuse(typed.problem);
    }
  };

  slider.addEventListener('input', () => choose(Number(slider.value), slider));
  amount.addEventListener('input', readBox);
  // Only the box is tidied. The box loses the keyboard as a press on Raise begins, and a button redrawn under that press never hears it
  amount.addEventListener('blur', () => {
    if (amount.validity.valid) {
      amount.value = editableAmount(raiseTo, table);
    }
  });
  // What is in the box is kept as a move goes out: should the move come off again, the panel drawn then has the bet as it was left
  const play = (move: BettingAction | { type: 'offerChop' }): void => {
    handlers.sizing.keep(turn, amount.value);
    void handlers.send({ ...move, turn });
  };

  raiseButton.addEventListener('click', () => {
    if (amount.reportValidity()) {
      play({ type: 'raise', to: raiseTo });
    }
  });

  choose(minRaiseTo);

  const typedBefore = handlers.sizing.typed(turn);
  if (typedBefore !== null) {
    amount.value = typedBefore;
    readBox();
  }

  const presetButtons = PRESETS.map((preset) => {
    const target = preset.potShare === null ? minRaiseTo : hand.currentBet + preset.potShare * (hand.pot + callAmount);

    return h('button.chip-btn', { type: 'button', onclick: () => choose(target) }, preset.label);
  });
  presetButtons.push(h('button.chip-btn', { type: 'button', onclick: () => choose(maxRaiseTo) }, 'All in'));
  HOTKEYS.sizes.forEach((key, index) => presetButtons[index]?.setAttribute('data-hotkey', key));

  // Beside Fold, the other way to leave the hand without playing it: the small blind with only the blinds in, folded to
  const chopButton = hand.canOfferChop
    ? h('button.btn.chop', { type: 'button', 'data-action': 'offer-chop', onclick: () => play({ type: 'offerChop' }) }, 'Chop')
    : null;

  const callLabel = callAmount >= stack ? 'Call all in' : 'Call';
  const passButton = options.canCheck
    ? h('button.btn.call', { type: 'button', 'data-action': 'check', 'data-hotkey': HOTKEYS.pass, onclick: () => play({ type: 'check' }) }, 'Check')
    : h('button.btn.call', { type: 'button', 'data-action': 'call', 'data-hotkey': HOTKEYS.pass, onclick: () => play({ type: 'call' }) }, moveLabel(callLabel, callCost, table));

  return h(
    'div.turn',
    null,
    options.canRaise ? h('div.sizing', null, h('div.presets', null, presetButtons), h('div.amount', null, slider, amount)) : null,
    h(
      'div.buttons',
      null,
      h('button.btn.fold', { type: 'button', 'data-action': 'fold', 'data-hotkey': HOTKEYS.fold, onclick: () => play({ type: 'fold' }) }, 'Fold'),
      chopButton,
      passButton,
      options.canRaise ? raiseButton : null,
    ),
  );
}

const smallBlindName = (view: TableView, hand: HandView) => view.seats[hand.sbSeat]?.name ?? 'The small blind';

/** The big blind's question when the small blind offers to chop: an answer is a move, like any on the clock. */
function chopQuestion(view: TableView, hand: HandView, handlers: ControlHandlers): HTMLElement {
  const answer = (agree: boolean) => () => void handlers.send({ type: 'answerChop', agree, turn: hand.turn });

  return h(
    'div.turn.chop-question',
    null,
    h('div.prompt', null, `${smallBlindName(view, hand)} offers to chop: you each take back your blind and the hand ends`),
    h(
      'div.buttons',
      null,
      h('button.btn.call', { type: 'button', 'data-action': 'chop-no', onclick: answer(false) }, 'Play on'),
      h('button.btn.chop', { type: 'button', 'data-action': 'chop-yes', onclick: answer(true) }, 'Chop'),
    ),
  );
}

function toggle(label: string, on: boolean, action: string, onChange: (next: boolean) => Promise<unknown>): HTMLElement {
  const button = h('button.toggle', { type: 'button', role: 'switch', 'aria-checked': String(on), 'data-action': action }, h('i'), label);
  button.addEventListener('click', () => holdWhile(button, () => onChange(!on)));

  return button;
}

function waitingText(view: TableView, hand: HandView | null): string {
  if (nightOver(view)) {
    return 'The night is over';
  }

  if (!hand || hand.stage === 'done') {
    if (onLastHand(view)) {
      return 'That was the last hand';
    }

    if (!view.running) {
      return view.handCount === 0 ? 'The game has not started yet' : 'The game is paused';
    }

    return hand || view.nextHandAt !== null ? 'Next hand coming up' : 'Waiting for at least two players with chips';
  }

  if (hand.stage === 'betting') {
    // Nobody is named while the viewer's own move waits for the server's answer, which says what comes next: one that
    // ends the street, or one the page shows nothing of, which leaves the action on the viewer
    return hand.toAct === null || hand.toAct === view.you.seat ? 'Waiting for the dealer' : `Waiting for ${view.seats[hand.toAct]?.name ?? 'the next player'}`;
  }

  if (hand.stage === 'chop') {
    const big = view.seats[hand.bbSeat]?.name ?? 'the big blind';

    return view.you.seat === hand.sbSeat ? `You offered to chop. Waiting for ${big}` : `${smallBlindName(view, hand)} offered to chop. Waiting for ${big}`;
  }

  if (hand.stage === 'ritVote') {
    return 'Waiting for the run-it-twice votes';
  }

  if (hand.stage === 'runout') {
    return 'Running it out';
  }

  return '';
}

/**
 * What the bar says about the hands to come: how many are left tonight, and whether the next is a
 * bomb pot, when there is a next one. Left out while the viewer has a decision to make, so calling
 * a bomb pot or changing the count never redraws a bet being sized.
 */
function nextHandNote(view: TableView): string[] {
  const deciding = view.hand?.options || view.hand?.canVote || view.hand?.canAnswerChop;
  if (deciding) {
    return [];
  }

  // Once the last hand is over, the line above says so
  const countdown = onLastHand(view) && view.hand!.stage === 'done' ? null : lastHandsText(view);
  const bombPot = view.nextBombPot ? `Next hand is a ${bombPotName(view.nextBombPot)}: ${formatAmount(view.nextBombPot.amount, view.config)} each` : null;

  return [countdown, bombPot].filter((part) => part !== null);
}

/** What the bar says to a player who owes blinds about getting back into the game, and the buttons they settle it with. */
interface Settling {
  note: string | null;
  buttons: HTMLElement[];
}

function settlingOf(view: TableView, seat: SeatView, handlers: ControlHandlers): Settling {
  const amount = (seat.owesBigBlind ? view.config.bigBlind : 0) + (seat.owesSmallBlind ? view.config.smallBlind : 0);
  const owed = formatAmount(amount, view.config);

  // Short, since they share a row of a phone with the switch for sitting out: the line above them says the rest
  const post = (label: string) => commandButton('button.chip-btn', 'post-blinds', label, () => handlers.send({ type: 'comeIn', post: true }));
  const wait = (spec: `button.${string}`) => commandButton(spec, 'wait-for-blind', 'Wait for big blind', () => handlers.send({ type: 'comeIn', post: false }));

  if (amount === 0) {
    return { note: null, buttons: [] };
  }

  if (seat.sittingOut || seat.away) {
    return { note: `You owe ${owed} for the blinds you missed`, buttons: [wait('button.chip-btn.strong'), post(`Post ${owed} and play`)] };
  }

  switch (seat.comesIn) {
    case 'big blind':
      return { note: 'You are dealt in when the big blind reaches you', buttons: [post(`Post ${owed} instead`)] };

    case 'button':
      return { note: `You post ${owed} and are dealt in once the button has passed you`, buttons: [wait('button.chip-btn')] };

    case 'posting':
      // A bomb pot has no blinds to post, so it is dealt to them like anyone and the posting waits for the hand after
      return { note: view.nextBombPot ? `You post ${owed} in the hand after the bomb pot` : `You post ${owed} and are dealt in next hand`, buttons: [wait('button.chip-btn')] };

    default:
      return { note: null, buttons: [] };
  }
}

/** What the bar says to a player who asked to straddle and posted none in the hand on the table. */
function passedOverText(view: TableView, passed: PassedOver): string {
  const reason = (): string => {
    switch (passed.why) {
      case 'two players':
        return 'there are only two players';
      case 'blind':
        return 'you posted a blind';
      case 'right':
        return `${view.seats[passed.ahead]?.name ?? 'Another player'} had the right before you`;
      case 'short':
        return `you could not cover the ${formatAmount(passed.amount, view.config)}`;
    }
  };

  return `No straddle this hand: ${reason()}`;
}

/** A line the bar has for the viewer alone, under what everyone is waiting for: about blinds they owe, or a straddle they did not get to post. */
interface OwnNote {
  about: 'owed' | 'straddle';
  text: string;
}

function waitingEl(text: string, view: TableView, own: OwnNote | null = null): HTMLElement {
  const note = nextHandNote(view);

  return h('div.waiting', null, text, note.length > 0 ? h('div.next-hand', null, note.map((part) => h('span', null, part))) : null, own ? h(`div.own-note.${own.about}-note`, null, own.text) : null);
}

/** The viewer's own line: a player in a hand owes nothing, so there is never more than one thing to say. */
function ownNote(owed: string | null, hand: HandView | null, view: TableView): OwnNote | null {
  if (owed) {
    return { about: 'owed', text: owed };
  }

  return hand?.passedOver ? { about: 'straddle', text: passedOverText(view, hand.passedOver) } : null;
}

function seatedControls(view: TableView, seat: SeatView, handlers: ControlHandlers, waiting: Waiting | null): HTMLElement {
  const hand = view.hand;
  const myRequest = view.requests.find((request) => request.playerId === view.you.id);
  const room = view.config.maxBuyIn - seat.stack - seat.pendingAdd;
  // With the night over no hand is coming to settle anything in; the seat still says who is waiting
  const settling = nightOver(view) ? { note: null, buttons: [] } : settlingOf(view, seat, handlers);

  let main: HTMLElement;
  if (waiting === 'sent') {
    // A move of theirs is out that the page shows nothing of. The buttons that made it are gone until the table has
    // answered, whatever they were: this comes first, so the buttons of a kind of move added later go the same way
    main = waitingEl(waitingText(view, hand), view, ownNote(settling.note, hand, view));
  } else if (hand?.options) {
    main = turnPanel(view.config, hand, seat.stack, handlers);
  } else if (hand?.canAnswerChop) {
    main = chopQuestion(view, hand, handlers);
  } else if (hand?.canVote) {
    main = h(
      'div.turn',
      null,
      h('div.prompt', null, 'The betting is over. Run the rest of the board twice?'),
      h(
        'div.buttons',
        null,
        h('button.btn.fold', { type: 'button', 'data-action': 'rit-no', 'data-hotkey': HOTKEYS.once, onclick: () => void handlers.send({ type: 'ritVote', agree: false }) }, 'Once'),
        h('button.btn.raise', { type: 'button', 'data-action': 'rit-yes', 'data-hotkey': HOTKEYS.twice, onclick: () => void handlers.send({ type: 'ritVote', agree: true }) }, 'Twice'),
      ),
    );
  } else {
    main = waitingEl(waiting === 'unconfirmed' ? `Waiting for the table to confirm your ${seat.lastAction ?? 'move'}…` : waitingText(view, hand), view, ownNote(settling.note, hand, view));
  }

  const showCards = hand?.canShow ? commandButton('button.chip-btn', 'show', 'Show my cards', () => handlers.send({ type: 'showCards' })) : null;

  // On the way out, nothing else here would still take effect: the seat is gone when the hand is
  if (seat.leaving) {
    return h('div.controls.seated', null, h('div.waiting', null, 'You leave your seat when this hand ends'), h('div.extras', null, showCards));
  }

  // Sitting out, straddling and adding chips are all for hands that are not coming
  if (nightOver(view)) {
    return h('div.controls.seated', null, main);
  }

  const extras: HTMLElement[] = [];

  // Coming back owing blinds is a choice between two ways of settling them, which takes the place of the one button
  if (!seat.sittingOut && !seat.away) {
    extras.push(toggle('Sit out next hand', false, 'sit-out', () => handlers.send({ type: 'sitOut' })));
  } else if (settling.buttons.length === 0) {
    extras.push(commandButton('button.chip-btn.strong', 'sit-in', "I'm back", () => handlers.send({ type: 'sitIn' })));
  }

  extras.push(...settling.buttons);

  const straddles = straddlesAllowed(view.config);
  const [only] = straddles;

  // One kind is a switch, as it always was. Several would not fit under a phone's table, so they are chosen in a dialog
  if (only && straddles.length === 1) {
    // The kind every table starts with is the one players know as the straddle; any other alone has to say which it is
    const name = only.byDefault ? 'Straddle' : only.label;

    extras.push(toggle(name, seat.straddles.includes(only.what), 'straddle', (on) => handlers.send({ type: 'setStraddle', kind: only.what, on })));
  } else if (only) {
    const on = seat.straddles.length;

    extras.push(h('button.chip-btn', { type: 'button', 'data-action': 'straddles', onclick: handlers.openStraddles }, `Straddles: ${on > 0 ? `${on} on` : 'off'}`));
  }

  if (view.config.allowChop) {
    extras.push(toggle('Always chop', seat.alwaysChop, 'always-chop', (on) => handlers.send({ type: 'setAlwaysChop', on })));
  }

  if (showCards) {
    extras.push(showCards);
  }

  if (myRequest?.kind === 'rebuy') {
    extras.push(
      commandButton('button.chip-btn', 'cancel-request', `Rebuy of ${formatAmount(myRequest.amount, view.config)} waiting for the host · Cancel`, () => handlers.send({ type: 'cancelRequest' })),
    );
  } else if (room > 0) {
    extras.push(h('button.chip-btn', { type: 'button', class: seat.stack === 0 ? 'strong' : '', 'data-action': 'rebuy', onclick: handlers.openRebuy }, 'Add chips'));
  }

  return h('div.controls.seated', null, main, h('div.extras', null, extras));
}

/**
 * Everything the viewer can do right now, for the bar under the table. `waiting` says how a move of
 * theirs that is out with the server is to be taken (`ShownTable.waiting`): with no buttons for one
 * that is only sent, and with a line that says so for one the server has been slow to confirm.
 */
export function controlsEl(view: TableView, handlers: ControlHandlers, waiting: Waiting | null): HTMLElement {
  const seat = view.you.seat === null ? null : view.seats[view.you.seat];

  if (seat) {
    return seatedControls(view, seat, handlers, waiting);
  }

  const myRequest = view.requests.find((request) => request.playerId === view.you.id);
  if (myRequest) {
    return h(
      'div.controls',
      null,
      waitingEl(`Asked the host for seat ${myRequest.seat + 1} with ${formatAmount(myRequest.amount, view.config)}`, view),
      h('div.extras', null, commandButton('button.chip-btn', 'cancel-request', 'Cancel request', () => handlers.send({ type: 'cancelRequest' }))),
    );
  }

  return h('div.controls', null, waitingEl(nightOver(view) ? 'The night is over' : 'You are watching. Pick an open seat to play.', view));
}

/**
 * Locks or frees the buttons that play a move, in place. Rebuilding the controls for this would throw
 * away a bet that is being sized.
 */
export function lockTurn(controls: HTMLElement, locked: boolean): void {
  for (const button of controls.querySelectorAll<HTMLButtonElement>('.turn .buttons button')) {
    button.disabled = locked;
  }
}

/** Changes whenever the controls need to be rebuilt; anything else leaves them, and a half-chosen bet, alone. */
export function controlsSignature(view: TableView): string {
  const seat = view.you.seat === null ? null : view.seats[view.you.seat];
  const hand = view.hand;

  return JSON.stringify([
    seat && [seat.stack, seat.pendingAdd, seat.sittingOut, seat.away, seat.straddles, seat.alwaysChop, seat.leaving, seat.owesBigBlind, seat.owesSmallBlind, seat.comesIn],
    hand && [hand.number, hand.stage, hand.street, hand.toAct, hand.turn, hand.currentBet, hand.pot, hand.options, hand.canOfferChop, hand.canAnswerChop, hand.canVote, hand.canShow, hand.passedOver],
    [view.running, view.nextHandAt !== null, view.handCount === 0, nightOver(view), hand?.stage === 'done' && onLastHand(view)],
    view.requests.filter((request) => request.playerId === view.you.id),
    [straddlesAllowed(view.config).map((kind) => kind.what), view.config.allowChop, view.config.maxBuyIn, view.config.smallBlind, view.config.bigBlind],
    nextHandNote(view),
  ]);
}
