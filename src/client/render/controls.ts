import { editableAmount, formatAmount, hasDecimals, parseAmount, shortAmount } from '../../engine/amounts.ts';
import type { Denominated } from '../../engine/amounts.ts';
import type { Command } from '../../engine/types.ts';
import type { HandView, SeatView, TableView } from '../../engine/view.ts';
import { h, holdWhile } from '../ui.ts';

export interface ControlHandlers {
  /** Resolves once the server has answered, or failed to. */
  send(command: Command): Promise<unknown>;
  openRebuy(): void;
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

  const raiseButton = h('button.btn.raise', { type: 'button', 'data-action': 'raise' });
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
  raiseButton.addEventListener('click', () => {
    if (amount.reportValidity()) {
      void handlers.send({ type: 'raise', to: raiseTo, turn });
    }
  });
  choose(minRaiseTo);

  const presetButtons = PRESETS.map((preset) => {
    const target = preset.potShare === null ? minRaiseTo : hand.currentBet + preset.potShare * (hand.pot + callAmount);

    return h('button.chip-btn', { type: 'button', onclick: () => choose(target) }, preset.label);
  });
  presetButtons.push(h('button.chip-btn', { type: 'button', onclick: () => choose(maxRaiseTo) }, 'All in'));

  const callLabel = callAmount >= stack ? 'Call all in' : 'Call';
  const passButton = options.canCheck
    ? h('button.btn.call', { type: 'button', 'data-action': 'check', onclick: () => void handlers.send({ type: 'check', turn }) }, 'Check')
    : h('button.btn.call', { type: 'button', 'data-action': 'call', onclick: () => void handlers.send({ type: 'call', turn }) }, moveLabel(callLabel, callCost, table));

  return h(
    'div.turn',
    null,
    options.canRaise ? h('div.sizing', null, h('div.presets', null, presetButtons), h('div.amount', null, slider, amount)) : null,
    h(
      'div.buttons',
      null,
      h('button.btn.fold', { type: 'button', 'data-action': 'fold', onclick: () => void handlers.send({ type: 'fold', turn }) }, 'Fold'),
      passButton,
      options.canRaise ? raiseButton : null,
    ),
  );
}

function toggle(label: string, on: boolean, action: string, onChange: (next: boolean) => Promise<unknown>): HTMLElement {
  const button = h('button.toggle', { type: 'button', role: 'switch', 'aria-checked': String(on), 'data-action': action }, h('i'), label);
  button.addEventListener('click', () => holdWhile(button, () => onChange(!on)));

  return button;
}

function waitingText(view: TableView, hand: HandView | null): string {
  if (!hand || hand.stage === 'done') {
    if (!view.running) {
      return view.handCount === 0 ? 'The game has not started yet' : 'The game is paused';
    }

    return hand || view.nextHandAt !== null ? 'Next hand coming up' : 'Waiting for at least two players with chips';
  }

  if (hand.stage === 'betting' && hand.toAct !== null) {
    return `Waiting for ${view.seats[hand.toAct]?.name ?? 'the next player'}`;
  }

  if (hand.stage === 'ritVote') {
    return 'Waiting for the run-it-twice votes';
  }

  if (hand.stage === 'runout') {
    return 'Running it out';
  }

  return '';
}

function seatedControls(view: TableView, seat: SeatView, handlers: ControlHandlers): HTMLElement {
  const hand = view.hand;
  const myRequest = view.requests.find((request) => request.playerId === view.you.id);
  const room = view.config.maxBuyIn - seat.stack - seat.pendingAdd;

  let main: HTMLElement;
  if (hand?.options) {
    main = turnPanel(view.config, hand, seat.stack, handlers);
  } else if (hand?.canVote) {
    main = h(
      'div.turn',
      null,
      h('div.prompt', null, 'The betting is over. Run the rest of the board twice?'),
      h(
        'div.buttons',
        null,
        h('button.btn.fold', { type: 'button', 'data-action': 'rit-no', onclick: () => void handlers.send({ type: 'ritVote', agree: false }) }, 'Once'),
        h('button.btn.raise', { type: 'button', 'data-action': 'rit-yes', onclick: () => void handlers.send({ type: 'ritVote', agree: true }) }, 'Twice'),
      ),
    );
  } else {
    main = h('div.waiting', null, waitingText(view, hand));
  }

  const showCards = hand?.canShow ? commandButton('button.chip-btn', 'show', 'Show my cards', () => handlers.send({ type: 'showCards' })) : null;

  // On the way out, nothing else here would still take effect: the seat is gone when the hand is
  if (seat.leaving) {
    return h('div.controls.seated', null, h('div.waiting', null, 'You leave your seat when this hand ends'), h('div.extras', null, showCards));
  }

  const extras: HTMLElement[] = [];

  if (seat.sittingOut || seat.away) {
    extras.push(commandButton('button.chip-btn.strong', 'sit-in', "I'm back", () => handlers.send({ type: 'sitIn' })));
  } else {
    extras.push(toggle('Sit out next hand', false, 'sit-out', () => handlers.send({ type: 'sitOut' })));
  }

  if (view.config.allowStraddle) {
    extras.push(toggle('Straddle', seat.straddle, 'straddle', (on) => handlers.send({ type: 'setStraddle', on })));
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

/** Everything the viewer can do right now, for the bar under the table. */
export function controlsEl(view: TableView, handlers: ControlHandlers): HTMLElement {
  const seat = view.you.seat === null ? null : view.seats[view.you.seat];

  if (seat) {
    return seatedControls(view, seat, handlers);
  }

  const myRequest = view.requests.find((request) => request.playerId === view.you.id);
  if (myRequest) {
    return h(
      'div.controls',
      null,
      h('div.waiting', null, `Asked the host for seat ${myRequest.seat + 1} with ${formatAmount(myRequest.amount, view.config)}`),
      h('div.extras', null, commandButton('button.chip-btn', 'cancel-request', 'Cancel request', () => handlers.send({ type: 'cancelRequest' }))),
    );
  }

  return h('div.controls', null, h('div.waiting', null, 'You are watching. Pick an open seat to play.'));
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
    seat && [seat.stack, seat.pendingAdd, seat.sittingOut, seat.away, seat.straddle, seat.leaving],
    hand && [hand.number, hand.stage, hand.street, hand.toAct, hand.turn, hand.currentBet, hand.pot, hand.options, hand.canVote, hand.canShow],
    [view.running, view.nextHandAt !== null, view.handCount === 0],
    view.requests.filter((request) => request.playerId === view.you.id),
    [view.config.allowStraddle, view.config.maxBuyIn],
  ]);
}
