import { editableAmount, formatAmount, hasDecimals, parseAmount, shortAmount } from '../../engine/amounts.ts';
import type { Denominated } from '../../engine/amounts.ts';
import type { BettingAction } from '../../engine/betting.ts';
import { bombPotName } from '../../engine/bombPots.ts';
import { capitalized, cardWords } from '../../engine/handNames.ts';
import { preActionFor } from '../../engine/preAction.ts';
import { timesText } from '../../engine/runVote.ts';
import { straddlesAllowed } from '../../engine/straddles.ts';
import type { Command, PassedOver } from '../../engine/types.ts';
import type { HandView, SeatView, TableView } from '../../engine/view.ts';
import { askedSays, chipsAsked, outOfChips, roomToAdd } from '../buyIns.ts';
import { lastOnRecord } from '../handRecords.ts';
import { HOTKEYS } from '../hotkeys.ts';
import { choiceOn } from '../pendingChoice.ts';
import { AHEAD_ORDER, aheadLabel } from '../preActions.ts';
import { FIT_ROW, fitted } from '../rowFit.ts';
import { showOffer } from '../showing.ts';
import type { Waiting } from '../shownTable.ts';
import { amountSaid, LABELS, NOT_ON_OFFER, sizedSaid } from '../spoken.ts';
import { standingOf, standingSays } from '../standing.ts';
import { cardEl, h, holdWhile } from '../ui.ts';
import type { Child } from '../ui.ts';
import { lastHandsText, nightOver, onLastHand } from './night.ts';

export interface ControlHandlers {
  /** Resolves once the server has answered, or failed to. */
  send(command: Command): Promise<unknown>;
  /** Shows the table the player's cards at `places` of that hand, 0 on their left. Resolves as `send` does. */
  showCards(hand: number, places: number[]): Promise<unknown>;
  openRebuy(): void;
  /** Opens what the player has asked the host for in chips, where they can take it back. */
  openAsked(): void;
  /** Opens the player's standing choices: the straddles and the chop the table does for them. */
  openStanding(): void;
  /** Plays hand number `hand` back over the table, from the history. Resolves once it is up, or once the viewer has been told why not. */
  replay(hand: number): Promise<unknown>;
  sizing: Sizing;
  /** Says a line to a screen reader alone: what a press changed that the screen shows only on another control. */
  say(message: string): void;
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
function commandButton(spec: `button.${string}`, action: string, label: Child, send: () => Promise<unknown>): HTMLButtonElement {
  const button = h(spec, { type: 'button', 'data-action': action }, label);
  button.addEventListener('click', () => holdWhile(button, send));

  return button;
}

/** What a move button says: the move and its amount as two pieces, so a narrow button breaks between them instead of cutting the amount off. */
function moveLabel(move: string, amount: number, table: Denominated): (HTMLElement | string)[] {
  // The space is for whoever reads the button as text; laid out, the two pieces are spaced by the button
  return [h('span', null, move), ' ', h('span.amount-of', { title: formatAmount(amount, table) }, shortAmount(amount, table, 'up'))];
}

/** The decision a move answers: which hand, and which turn of it. */
const decisionOf = (hand: HandView): string => `${hand.number}.${hand.turn}`;

/**
 * Marks every button of a decision's bar with the decision it answers, as the bet's box is (`data-keep`),
 * and gives the bar back. A button for the next decision is another button, though it says the same and
 * lies in the same place, to whatever tells controls apart across a redraw. The tap guard takes it for a
 * new one, and the keyboard is never carried to it (`Slot`): on "Call 5" become "Call 30", or with Enter
 * held down, the next press would make a move nobody chose.
 */
function answering<Bar extends HTMLElement>(hand: HandView, bar: Bar): Bar {
  for (const button of bar.querySelectorAll('button')) {
    button.dataset.keep = decisionOf(hand);
  }

  return bar;
}

/** A move button with its label, named aloud with the amount in full where the label shortens it to fit. */
function nameMove(button: HTMLElement, move: string, amount: number, table: Denominated): void {
  button.replaceChildren(...moveLabel(move, amount, table));
  button.setAttribute('aria-label', sizedSaid(move, amount, table));
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

  const decision = decisionOf(hand);
  const raiseButton = h('button.btn.raise', { type: 'button', 'data-action': 'raise', 'data-hotkey': HOTKEYS.raise });
  // A bet being sized outlasts the bar being drawn again for the same decision (`Slot`), as when the host approves chips mid-turn
  const slider = h('input', { type: 'range', id: 'raise-slider', min: minRaiseTo, max: maxRaiseTo, step: 1, 'aria-label': 'Bet size', 'data-keep': decision });
  const amount = h('input', { type: 'text', id: 'raise-amount', inputmode: hasDecimals(table) ? 'decimal' : 'numeric', autocomplete: 'off', 'aria-label': 'Bet size', 'data-keep': decision });

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
    amount.removeAttribute('aria-invalid');
    // The slider counts in the table's smallest unit, which is not how an amount is said
    slider.setAttribute('aria-valuetext', amountSaid(raiseTo, table));
    raiseButton.removeAttribute('aria-disabled');
    nameMove(raiseButton, raiseMove(), raiseTo, table);
  };

  const raiseMove = () => (raiseTo === maxRaiseTo ? 'All in' : opening ? 'Bet' : 'Raise to');

  /**
   * What is in the box can't be read as an amount. No other amount is put in its place: the button
   * names none and plays none until the box reads. The reason is said when the button is pressed, not
   * while typing: "1," is on its way to "1,000".
   */
  const refuse = (problem: string): void => {
    const move = opening ? 'Bet' : 'Raise';

    amount.setCustomValidity(problem);
    amount.setAttribute('aria-invalid', 'true');
    raiseButton.setAttribute('aria-disabled', 'true');
    raiseButton.replaceChildren(h('span', null, move));
    // The button says why it will not go, since the box that says so is another control
    raiseButton.setAttribute('aria-label', `${move}: ${problem}`);
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

  // A size button changes the amount on the button beside it and says nothing itself, so what it set is said
  const size = (value: number): void => {
    choose(value);
    handlers.say(sizedSaid(raiseMove(), raiseTo, table));
  };

  const typedBefore = handlers.sizing.typed(turn);
  if (typedBefore !== null) {
    amount.value = typedBefore;
    readBox();
  }

  const presetButtons = PRESETS.map((preset) => {
    const target = preset.potShare === null ? minRaiseTo : hand.currentBet + preset.potShare * (hand.pot + callAmount);

    return h('button.chip-btn', { type: 'button', onclick: () => size(target) }, preset.label);
  });
  presetButtons.push(h('button.chip-btn', { type: 'button', onclick: () => size(maxRaiseTo) }, 'All in'));
  HOTKEYS.sizes.forEach((key, index) => presetButtons[index]?.setAttribute('data-hotkey', key));

  // Beside Fold, the other way to leave the hand without playing it: the small blind with only the blinds in, folded to
  const chopButton = hand.canOfferChop
    ? h('button.btn.chop', { type: 'button', 'data-action': 'offer-chop', onclick: () => play({ type: 'offerChop' }) }, 'Chop')
    : null;

  const callLabel = callAmount >= stack ? 'Call all in' : 'Call';
  const passButton = options.canCheck
    ? h('button.btn.call', { type: 'button', 'data-action': 'check', 'data-hotkey': HOTKEYS.pass, onclick: () => play({ type: 'check' }) }, 'Check')
    : h('button.btn.call', { type: 'button', 'data-action': 'call', 'data-hotkey': HOTKEYS.pass, 'aria-label': sizedSaid(callLabel, callCost, table), onclick: () => play({ type: 'call' }) }, moveLabel(callLabel, callCost, table));

  return h(
    'div.turn',
    null,
    options.canRaise ? h('div.sizing', null, h('div.presets', { role: 'group', 'aria-label': LABELS.sizes }, presetButtons), h('div.amount', null, slider, amount)) : null,
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

/** How many times to run the rest, up to what the hand allows: picking is a move, like any on the clock. */
function runsQuestion(hand: HandView, handlers: ControlHandlers): HTMLElement {
  const pick = (runs: number) =>
    h(
      runs === 1 ? 'button.btn.fold' : 'button.btn.raise',
      { type: 'button', 'data-action': `rit-${runs}`, 'data-hotkey': HOTKEYS.runs[runs - 1], onclick: () => void handlers.send({ type: 'ritVote', runs }) },
      capitalized(timesText(runs)),
    );

  return h(
    'div.turn.runs-question',
    null,
    h('div.prompt', null, 'The betting is over. How many times to run the rest? The fewest picked wins'),
    h(
      'div.buttons',
      null,
      Array.from({ length: hand.maxRuns }, (_pick, nth) => pick(nth + 1)),
    ),
  );
}

function toggle(label: Child, on: boolean, action: string, onChange: (next: boolean) => Promise<unknown>): HTMLElement {
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

    // As for a bet: the big blind sees this only while their own answer is out, and it is for the server to say what comes
    if (hand.toAct === view.you.seat) {
      return 'Waiting for the dealer';
    }

    return view.you.seat === hand.sbSeat ? `You offered to chop. Waiting for ${big}` : `${smallBlindName(view, hand)} offered to chop. Waiting for ${big}`;
  }

  if (hand.stage === 'ritVote') {
    return 'Waiting for everyone to pick how many times to run it';
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

  // Short, since they share a line of a phone: the note above them says the rest
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

/**
 * What the bar says to a player who asked to straddle and posted none in the hand on the table. A name
 * in it is a piece of its own, which a bar with a height to keep cuts short: the whole of it is its title.
 */
function passedOverText(view: TableView, passed: PassedOver): (HTMLElement | string)[] {
  const reason = (): (HTMLElement | string)[] => {
    switch (passed.why) {
      case 'two players':
        return ['there are only two players'];
      case 'blind':
        return ['you posted a blind'];
      case 'right': {
        const name = view.seats[passed.ahead]?.name ?? 'Another player';

        return [h('span.named', { title: name }, name), ' had the right before you'];
      }
      case 'short':
        return [`you could not cover the ${formatAmount(passed.amount, view.config)}`];
    }
  };

  return ['No straddle this hand: ', ...reason()];
}

/** A line the bar has for the viewer alone, under what everyone is waiting for: about blinds they owe, or a straddle they did not get to post. */
interface OwnNote {
  about: 'owed' | 'straddle';
  text: (HTMLElement | string)[];
}

/** What tells the choices of a move ahead apart from the buttons of a turn, wherever one is looked for by its action. */
export const AHEAD_ACTION = 'ahead-';

/**
 * The moves a player waiting for the action can choose ahead of their turn, as buttons that stay
 * pressed: one at most, so pressing another takes its place and pressing the one that is set takes it
 * back. Null when the table offers them none. All five are always drawn, each in its place, and the
 * ones not on offer are dimmed; the one that is set can be taken back whatever is on offer by now, as
 * a Check/Fold that a bet has turned into a fold. A press says which spot it was made in, as shown,
 * and the bar is drawn again at once with the choice on it. None has a key: the keys of a turn pressed
 * a moment early must not choose anything.
 */
function aheadEl(view: TableView, hand: HandView, stack: number, handlers: ControlHandlers): HTMLElement | null {
  const facing = hand.ahead;

  if (!facing) {
    return null;
  }

  const buttons = AHEAD_ORDER.map((what) => {
    const on = view.preAction?.[0] === what;
    const { move, amount } = aheadLabel(what, facing, stack);
    // A narrow button breaks its words after the stroke, as it breaks a call before its amount
    const words = amount === null ? move.split('/').flatMap((part, nth) => (nth === 0 ? [part] : ['/', h('wbr'), part])) : moveLabel(move, amount, view.config);
    const press = (): void => {
      const choice = choiceOn(view, on ? null : what);

      if (choice) {
        void handlers.send(choice);
      }
    };

    const offered = on || preActionFor(what, facing) !== null;
    const said = amount === null ? move : sizedSaid(move, amount, view.config);

    return h(
      `button.chip-btn.ahead-btn.ahead-${what}`,
      // Dimmed says nothing aloud, so a choice that cannot be made says so in its name. And a choice is the same choice
      // only while it says the same, amount in full: "Call 50" in the place of "Call 20" is another, as on the turn
      { type: 'button', 'aria-pressed': String(on), 'aria-label': offered ? said : `${said}, ${NOT_ON_OFFER}`, 'data-action': `${AHEAD_ACTION}${what}`, 'data-keep': said, disabled: !offered, onclick: press },
      h('span', null, words),
    );
  });

  return h('div.ahead', { role: 'group', 'aria-label': 'Your move when the action reaches you' }, h('span.ahead-title', null, 'On your turn'), buttons);
}

/** What the bar says while the viewer has no move to make. With `sharing`, a line of buttons under it (`spareLine`) comes out of the same height, and the notes are set closer for it (pre-action.css). */
function waitingEl(text: string, view: TableView, own: OwnNote | null = null, ahead: HTMLElement | null = null, sharing = false): HTMLElement {
  const note = nextHandNote(view);

  return h(
    'div.waiting',
    { class: [ahead && 'choosing', (ahead || sharing) && 'set-close'].filter(Boolean).join(' ') },
    ahead,
    // Beside the choices the bar keeps the height of a turn, and its first line is cut short before it takes a second: the whole of it is its title
    ahead ? h('span.waiting-for', { title: text }, text) : text,
    note.length > 0 ? h('div.next-hand', null, note.map((part) => h('span', null, part))) : null,
    own ? h(`div.own-note.${own.about}-note`, null, own.text) : null,
  );
}

/** The viewer's own line: a player in a hand owes nothing, so there is never more than one thing to say. */
function ownNote(owed: string | null, hand: HandView | null, view: TableView): OwnNote | null {
  if (owed) {
    return { about: 'owed', text: [owed] };
  }

  return hand?.passedOver ? { about: 'straddle', text: passedOverText(view, hand.passedOver) } : null;
}

function seatedControls(view: TableView, seat: SeatView, handlers: ControlHandlers, waiting: Waiting | null): HTMLElement {
  const hand = view.hand;
  // With the night over no hand is coming to settle anything in; the seat still says who is waiting
  const settling = nightOver(view) ? { note: null, buttons: [] } : settlingOf(view, seat, handlers);
  const own = ownNote(settling.note, hand, view);
  const showCards = showCardsEl(view, seat, handlers);
  const replay = own ? null : replayEl(view, seat, handlers);
  // Once the night is over the bar offers the last hand to see again, and nothing else
  const line = nightOver(view) ? spareLine(replay) : spareLine(replay, showCards, ...settling.buttons);

  let main: HTMLElement;
  if (waiting === 'sent') {
    // A move of theirs is out that the page shows nothing of. The buttons that made it are gone until the table has
    // answered, whatever they were: this comes first, so the buttons of a kind of move added later go the same way
    main = waitingEl(waitingText(view, hand), view, own);
  } else if (hand?.options) {
    main = answering(hand, turnPanel(view.config, hand, seat.stack, handlers));
  } else if (hand?.canAnswerChop) {
    main = answering(hand, chopQuestion(view, hand, handlers));
  } else if (hand?.canVote) {
    main = answering(hand, runsQuestion(hand, handlers));
  } else {
    const text = waiting === 'unconfirmed' ? `Waiting for the table to confirm your ${seat.lastAction ?? 'move'}…` : waitingText(view, hand);

    main = waitingEl(text, view, own, hand && aheadEl(view, hand, seat.stack, handlers), line !== null);
  }

  // On the way out, nothing else here would still take effect: the seat is gone when the hand is
  if (seat.leaving) {
    return h('div.controls.seated', null, h('div.waiting', null, 'You leave your seat when this hand ends'), spareLine(showCards));
  }

  // Sitting out, straddling and adding chips are all for hands that are not coming
  if (nightOver(view)) {
    return h('div.controls.seated', null, main, line);
  }

  const extras: HTMLElement[] = [];

  // Coming back owing blinds is a choice between two ways of settling them, on the line above, which takes the place of the one button
  if (!seat.sittingOut && !seat.away) {
    extras.push(toggle(fitted({ full: 'Sit out next hand', brief: 'Sit out' }), false, 'sit-out', () => handlers.send({ type: 'sitOut' })));
  } else if (settling.buttons.length === 0) {
    extras.push(commandButton('button.chip-btn.strong', 'sit-in', "I'm back", () => handlers.send({ type: 'sitIn' })));
  }

  const standing = standingOf(view);

  // What a player sets once a night is a tap away, in a dialog. A straddle that is on stands out: it costs chips every round
  if (standing) {
    extras.push(h('button.chip-btn', { type: 'button', class: standing.straddling.length > 0 ? 'strong' : '', 'data-action': 'straddles', onclick: handlers.openStanding }, fitted(standingSays(standing))));
  }

  const asked = chipsAsked(view);

  if (asked) {
    extras.push(h('button.chip-btn.asked', { type: 'button', 'data-action': 'chips-asked', onclick: handlers.openAsked }, fitted(askedSays(asked, view.config))));
  } else if (roomToAdd(view) > 0) {
    extras.push(h('button.chip-btn', { type: 'button', class: outOfChips(view) ? 'strong' : '', 'data-action': 'rebuy', onclick: handlers.openRebuy }, 'Add chips'));
  }

  return h('div.controls.seated', null, main, line, h(`div.extras.${FIT_ROW}`, null, extras));
}

/**
 * A line of buttons between what the bar says and its row of switches: the hand just played to see
 * again and, once it is over, the player's cards to show, or the ways to settle the blinds a player
 * owes. It comes out of the height the bar keeps for a turn (controls.css), the one room at the table
 * nothing else is using while the player has no move to make, so the table gives up nothing for it.
 */
function spareLine(...buttons: (HTMLElement | null)[]): HTMLElement | null {
  return buttons.some((button) => button !== null) ? h(`div.spare-line.${FIT_ROW}`, null, buttons) : null;
}

/**
 * The number of the hand just played, for a seated player with nothing left to play in the one on the
 * table. With its result up that is the hand on the table itself, which is on record only once it is
 * cleared away: the page waits for that (`App.replayHand`), since the hand before it is not the one
 * anybody means. For a player out of a hand still being played, and between hands, it is the last one
 * on record. A player still in a hand has that one to play.
 */
function handToReplay(view: TableView, seat: SeatView): number | null {
  const hand = view.hand;

  if (hand?.stage === 'done') {
    return hand.number;
  }

  const free = !hand || !seat.inHand || seat.folded;
  const last = lastOnRecord(view);

  return free && last > 0 ? last : null;
}

/**
 * A button to see the last hand again, for the bar's spare line (`spareLine`). The line's height is
 * spare while the bar says one thing: word of the hands to come needs it, as a line for the player
 * alone does, and the button is left out.
 */
function replayEl(view: TableView, seat: SeatView, handlers: ControlHandlers): HTMLElement | null {
  const number = handToReplay(view, seat);

  if (number === null || nextHandNote(view).length > 0) {
    return null;
  }

  const button = commandButton('button.chip-btn.replay-last', 'replay-last', fitted({ full: `Replay hand #${number}`, brief: 'Replay' }), () => handlers.replay(number));

  // The button for another hand is another button
  button.dataset.hand = String(number);

  return button;
}

/**
 * Once the hand is over, a button for each of the player's cards still face down to the table, the
 * card itself drawn on it, and while both are down one for both: one tap shows, and nothing takes it back.
 */
function showCardsEl(view: TableView, seat: SeatView, handlers: ControlHandlers): HTMLElement | null {
  const offer = showOffer(view);
  if (!offer) {
    return null;
  }

  const show = (places: number[]) => () => handlers.showCards(offer.hand, places);
  const buttons = offer.places.map((place) => {
    const card = seat.cards![place]!;
    const button = commandButton('button.chip-btn.show-card', 'show-card', '', show([place]));

    // Which hand's card, so the offer after the next hand is another button
    button.dataset.keep = String(offer.hand);
    button.dataset.place = String(place);
    // The card in this place of another hand is another card to show
    button.dataset.keep = String(offer.hand);
    button.setAttribute('aria-label', `Show ${cardWords(card)}`);
    button.append(cardEl(card));

    return button;
  });

  if (offer.places.length > 1) {
    const both = commandButton('button.chip-btn', 'show', 'Both', show(offer.places));

    // Which hand's cards, as on the button for each
    both.dataset.keep = String(offer.hand);

    both.setAttribute('aria-label', 'Show both cards');
    buttons.push(both);
  }

  return h('div.show-cards', { role: 'group', 'aria-label': 'Show your cards to the table' }, h('span.show-label', { 'aria-hidden': 'true' }, 'Show'), buttons);
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
      h(`div.extras.${FIT_ROW}`, null, commandButton('button.chip-btn', 'cancel-request', 'Cancel request', () => handlers.send({ type: 'cancelRequest' }))),
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
    seat && [seat.stack, seat.pendingAdd, seat.sittingOut, seat.away, seat.straddles, seat.alwaysChop, seat.leaving, seat.owesBigBlind, seat.owesSmallBlind, seat.comesIn, seat.shown],
    hand && [hand.number, hand.stage, hand.street, hand.toAct, hand.turn, hand.currentBet, hand.pot, hand.options, hand.canOfferChop, hand.canAnswerChop, hand.canVote, hand.canShow, hand.passedOver],
    [hand?.ahead, view.preAction],
    [view.running, view.nextHandAt !== null, view.handCount === 0, nightOver(view), hand?.stage === 'done' && onLastHand(view), seat && handToReplay(view, seat)],
    view.requests.filter((request) => request.playerId === view.you.id),
    [straddlesAllowed(view.config).map((kind) => kind.what), view.config.allowChop, view.config.maxBuyIn, view.config.smallBlind, view.config.bigBlind],
    nextHandNote(view),
  ]);
}
