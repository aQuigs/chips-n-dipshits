import { rankOf, splitWrittenCards, SUIT_SYMBOLS, suitOf } from '../engine/cards.ts';
import type { Card } from '../engine/cards.ts';
import { cardSaid, hasCards, inWords } from './spoken.ts';

export type Child = Node | string | number | null | undefined | false | Child[];

type Props = {
  [key: string]: unknown;
};

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) {
    return;
  }

  if (Array.isArray(child)) {
    for (const nested of child) {
      append(parent, nested);
    }
    return;
  }

  parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

/**
 * Builds an element. The tag may carry classes ("button.btn.primary"). Props starting with "on" are
 * listeners, `style` takes an object of CSS properties, and everything else is set as an attribute,
 * skipping false and null so optional attributes read naturally.
 */
export function h<K extends keyof HTMLElementTagNameMap>(spec: K | `${K}.${string}`, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(spec: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const [tag, ...classes] = spec.split('.');
  const element = document.createElement(tag!);

  if (classes.length > 0) {
    element.className = classes.join(' ');
  }

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === false || value === null || value === undefined) {
      continue;
    }

    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [property, setting] of Object.entries(value as Record<string, string>)) {
        element.style.setProperty(property, setting);
      }
    } else if (key === 'class') {
      element.className = [element.className, value].filter(Boolean).join(' ');
    } else if (key === 'value' && 'value' in element) {
      (element as HTMLInputElement).value = String(value);
    } else {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(element, children);

  return element;
}

/**
 * What a button that sends something says, and with it, unseen in the same place until the button is held
 * (`holdWhile`), what it says it is doing while the table has not answered. Both have their room from the
 * start, so that pressing the button moves nothing beside it. The second is drawn by the style sheet and
 * is no part of the button's text: whoever reads a button by its words, a row that names its buttons or a
 * check, reads what it says.
 */
export function sends(says: string, doing: string): HTMLElement {
  return h('span.sends', null, h('span', null, says), h('span.doing', { 'data-says': doing }));
}

/** A press that is not answered yet, and a button it holds: another element once its part has been drawn anew (`Slot`). */
interface Hold {
  button: HTMLButtonElement;
  /** Whether it is the button that was pressed, or one that is held with it (`heldTogether`). */
  pressed: boolean;
}

const holds = new Set<Hold>();

const together = new WeakMap<HTMLButtonElement, HTMLButtonElement[]>();

/**
 * Buttons that answer one and the same thing, as a question's two answers or Approve and Deny of one
 * request: while one of them is held for the table's answer (`holdWhile`), none of the others can be
 * pressed. What was pressed has gone out, so a Cancel beside it would cancel nothing, and a second
 * answer would race the first.
 */
export function heldTogether(...buttons: HTMLButtonElement[]): HTMLButtonElement[] {
  for (const button of buttons) {
    together.set(button, buttons);
  }

  return buttons;
}

// The button that had the keyboard when it was held. A button that cannot be pressed loses the keyboard to
// nothing, so it is owed back: to that button when it is free again, or to the one drawn in its place (`Slot`)
let heldWithKeyboard: HTMLButtonElement | null = null;

// Held, a button cannot be pressed, and the one that was pressed shows the other thing it has to say (`sends`, widgets.css)
function setHeld({ button, pressed }: Hold, held: boolean): void {
  button.disabled = held;

  if (held && pressed) {
    button.setAttribute('aria-busy', 'true');
  } else {
    button.removeAttribute('aria-busy');
  }
}

// The keyboard is on nothing, or where a dialog puts it meanwhile when it finds it on nothing (`Modal`)
function keyboardIsFree(button: HTMLButtonElement): boolean {
  const on = document.activeElement;

  return on === document.body || (on instanceof HTMLElement && on.tabIndex < 0 && on.contains(button));
}

/**
 * Runs what a button was pressed for, and keeps it from being pressed again until that has finished:
 * switched off, and saying what it is doing when it has that to say (`sends`). The buttons that answer
 * the same thing are switched off with it (`heldTogether`). However the action ends, they are as they
 * were again, unless what it did has taken them off the page.
 */
export function holdWhile(button: HTMLButtonElement, action: () => Promise<unknown>): void {
  // One that is switched off for a reason of its own stays out of it: the end of the hold would switch it on
  const beside = (together.get(button) ?? []).filter((other) => other !== button && !other.disabled);
  const pressed: Hold = { button, pressed: true };
  const held = [pressed, ...beside.map((other) => ({ button: other, pressed: false }))];

  if (document.activeElement === button) {
    heldWithKeyboard = button;
  }

  for (const hold of held) {
    holds.add(hold);
    setHeld(hold, true);
  }

  void action().finally(() => {
    for (const hold of held) {
      holds.delete(hold);
      setHeld(hold, false);
    }

    if (heldWithKeyboard === pressed.button) {
      heldWithKeyboard = null;

      // Still there, and the keyboard has gone nowhere else since
      if (pressed.button.isConnected && keyboardIsFree(pressed.button)) {
        pressed.button.focus({ preventScroll: true });
      }
    }
  });
}

/** A button for something that is sent and answered: held from the press until `press` has finished (`holdWhile`). */
export function sendingButton(spec: `button.${string}`, props: Props, label: Child, press: () => Promise<unknown>): HTMLButtonElement {
  const button = h(spec, { type: 'button', ...props }, label);

  button.addEventListener('click', () => holdWhile(button, press));

  return button;
}

const alike = (within: Element, key: string): Element[] => [...within.querySelectorAll('*')].filter((element) => controlKey(element) === key);

/**
 * A part of the screen that is rebuilt only when what it shows has changed. Rebuilding on every
 * update from the server would swallow a tap that lands mid-rebuild and wipe anything half-entered.
 *
 * A rebuild takes the control that had the keyboard with it, and a keyboard left on nothing starts
 * again from the top of the page. So the keyboard is put back on the same control in what was built,
 * and where that control is gone, on the part itself when it can take it (a `tabindex` of -1): never
 * on another control, which a key still held down would then press.
 *
 * What was being typed into that control goes with the keyboard when the control says what it is
 * for (`data-keep`) and the one built in its place is for the same: a bet half typed for one decision
 * is kept through a rebuild, and never carried to the next decision.
 *
 * A button that is held for an answer (`holdWhile`) is held still in what was built: the table's news
 * drawing its part anew does not make a press that is still on its way pressable a second time.
 */
export class Slot {
  readonly element: HTMLElement;
  private readonly redrawn: Redrawn | undefined;
  private drawn: string | null = null;

  /** `redrawn` is told of every rebuild: a part whose controls come up by themselves, under a finger, is given the page's tap guard. */
  constructor(element: HTMLElement, redrawn?: Redrawn) {
    this.element = element;
    this.redrawn = redrawn;
  }

  /**
   * `shows` is everything the content depends on; `build` runs only when that differs from last time. Says whether it ran.
   * `settle` runs with the new content on the page, before `redrawn` is told of it: it puts back what a
   * rebuild loses of its reader's place, how far they had scrolled, so the content is seen where they have it.
   */
  draw(shows: unknown, build: () => Child, settle?: () => void): boolean {
    const signature = JSON.stringify(shows);
    if (signature === this.drawn) {
      return false;
    }

    const putBack = this.keyboardKept();
    const holdAgain = this.holdsKept();

    this.drawn = signature;
    this.redrawn?.leaving();
    this.element.replaceChildren();
    append(this.element, build());
    settle?.();
    // Before `redrawn` looks: a bet put back in its box changes what the button beside it says, and with that where things lie
    putBack?.();
    // After the keyboard: it goes to the button as built, and is owed back to it once the hold is over
    holdAgain();
    this.redrawn?.drawn();

    return true;
  }

  /**
   * The way to find `control` again in what is built in its place: the control with its marks
   * (`controlKey`), and of several alike, as a button on each row of a list, the same one only while
   * there are as many as there were.
   */
  private again(control: Element): () => Element | undefined {
    const key = controlKey(control);
    const before = alike(this.element, key);
    const nth = before.indexOf(control);

    return () => {
      const after = alike(this.element, key);

      return after.length === before.length ? after[nth] : undefined;
    };
  }

  /** The way to hold, in what is built, every button that is held in here now. */
  private holdsKept(): () => void {
    const kept = [...holds].filter((hold) => this.element.contains(hold.button)).map((hold) => ({ hold, again: this.again(hold.button) }));

    return () => {
      for (const { hold, again } of kept) {
        const button = again();

        // Gone with what the press did, or built switched off for a reason of its own, there is nothing left on the page to hold
        if (!(button instanceof HTMLButtonElement) || button.disabled) {
          continue;
        }

        if (heldWithKeyboard === hold.button) {
          heldWithKeyboard = button;
        }

        hold.button = button;
        setHeld(hold, true);
      }
    };
  }

  /** The way to put the keyboard back where it is now once the content has been replaced, or null when it is not in here. */
  private keyboardKept(): (() => void) | null {
    const held = document.activeElement === document.body ? heldWithKeyboard : document.activeElement;
    if (!(held instanceof HTMLElement) || held === this.element || !this.element.contains(held)) {
      return null;
    }

    const found = this.again(held);
    const typed = held instanceof HTMLInputElement && held.dataset.keep !== undefined ? { value: held.value, for: held.dataset.keep } : null;

    return () => {
      const again = found();
      const target = again instanceof HTMLElement && !again.matches(':disabled') ? again : this.element.hasAttribute('tabindex') ? this.element : null;

      target?.focus({ preventScroll: true });

      if (typed && target instanceof HTMLInputElement && target.dataset.keep === typed.for && target.value !== typed.value) {
        target.value = typed.value;
        // As if typed: whatever follows the box, as a button that names the amount in it, hears of it the way it always does
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
  }
}

/** Told of every rebuild of a part, around it. */
export interface Redrawn {
  /** What is drawn is about to be taken away and is still on the page: the one moment to see where things lay. */
  leaving(): void;
  /** What replaces it is on the page. */
  drawn(): void;
}

/**
 * What a control is known by once its part is drawn anew and it is a new element: its id, else its tag
 * with every `data-*`, `name` and `value` attribute. Never its class, what it says or where it lies.
 */
export function controlKey(control: Element): string {
  if (control.id !== '') {
    return `#${control.id}`;
  }

  const marks = [...control.attributes]
    .filter(({ name }) => name.startsWith('data-') || name === 'name' || name === 'value')
    .map(({ name, value }) => `${name}=${value}`)
    .sort();

  return [control.tagName, ...marks].join(' ');
}

const RANK_LABELS: Record<number, string> = { 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

/** What follows the viewer's own name in a list of players. */
export const youMark = (): HTMLElement => h('span.you', null, ' (you)');

/** A playing card, face up, or face down when given null. It is one picture with one name, said in words. */
export function cardEl(card: Card | null): HTMLElement {
  if (card === null) {
    return h('div.card.back', { role: 'img', 'aria-label': 'Face-down card' });
  }

  const rank = rankOf(card);
  const suit = suitOf(card);
  const label = RANK_LABELS[rank] ?? String(rank);

  return h(
    'div',
    { class: `card suit-${suit}`, role: 'img', 'aria-label': cardSaid(card), 'data-card': card },
    h('span.rank', null, label),
    h('span.pip', null, SUIT_SYMBOLS[suit]),
  );
}

/**
 * Whether cards written in text are marked for the stylesheet to color. Only the four-color deck
 * colors them, and with any other the text is left whole: split, its glyphs move by a fraction of a
 * pixel, and a player who chose nothing would see the page change.
 */
export const marksCards = (deck: string): boolean => deck === 'four';

/** Text with each card written in it marked with its suit, when the deck colors them. */
export function cardText(text: string, deck: string): (string | HTMLElement)[] {
  if (!marksCards(deck)) {
    return [text];
  }

  return splitWrittenCards(text).map((part) => (part.suit ? h('span.card-text', { class: `suit-${part.suit}` }, part.text) : part.text));
}

/**
 * Text that may have cards written in it, for the page: drawn as `cardText` draws it, and said with
 * each card in words. The drawn text is one picture to a screen reader, named by the words: the one
 * way to have other words said than are written that every screen reader honors, and it adds no text
 * to the page, so not a glyph of what is drawn moves.
 */
export function readableText(text: string, deck: string): (string | HTMLElement)[] {
  const drawn = cardText(text, deck);

  return hasCards(text) ? [h('span', { role: 'img', 'aria-label': inWords(text) }, drawn)] : drawn;
}

/** Text of several lines, each said as `readableText` says it, so that a screen reader goes through it line by line. */
export function readableLines(text: string, deck: string): (string | HTMLElement)[] {
  return text.split('\n').flatMap((line, nth) => [...(nth === 0 ? [] : ['\n']), ...readableText(line, deck)]);
}

/** Whole seconds left until a server time, given how far the local clock is from the server's. */
export function secondsUntil(serverTime: number, clockOffset: number): number {
  return Math.max(0, Math.ceil((serverTime - (Date.now() + clockOffset)) / 1000));
}
