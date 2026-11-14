import { rankOf, splitWrittenCards, SUIT_SYMBOLS, suitOf } from '../engine/cards.ts';
import type { Card } from '../engine/cards.ts';

type Child = Node | string | number | null | undefined | false | Child[];

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

/** Runs what a button was pressed for, and keeps it from being pressed again until that has finished. */
export function holdWhile(button: HTMLButtonElement, action: () => Promise<unknown>): void {
  button.disabled = true;

  void action().finally(() => {
    button.disabled = false;
  });
}

/**
 * A part of the screen that is rebuilt only when what it shows has changed. Rebuilding on every
 * update from the server would swallow a tap that lands mid-rebuild and wipe anything half-entered.
 */
export class Slot {
  readonly element: HTMLElement;
  private drawn: string | null = null;

  constructor(element: HTMLElement) {
    this.element = element;
  }

  /** `shows` is everything the content depends on; `build` runs only when that differs from last time. */
  draw(shows: unknown, build: () => Child): void {
    const signature = JSON.stringify(shows);
    if (signature === this.drawn) {
      return;
    }

    this.drawn = signature;
    this.element.replaceChildren();
    append(this.element, build());
  }
}

const RANK_LABELS: Record<number, string> = { 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

/** A playing card, face up, or face down when given null. */
export function cardEl(card: Card | null): HTMLElement {
  if (card === null) {
    return h('div.card.back', { 'aria-label': 'Face-down card' });
  }

  const rank = rankOf(card);
  const suit = suitOf(card);
  const label = RANK_LABELS[rank] ?? String(rank);

  return h(
    'div',
    { class: `card suit-${suit}`, 'aria-label': `${label}${SUIT_SYMBOLS[suit]}`, 'data-card': card },
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

/** Whole seconds left until a server time, given how far the local clock is from the server's. */
export function secondsUntil(serverTime: number, clockOffset: number): number {
  return Math.max(0, Math.ceil((serverTime - (Date.now() + clockOffset)) / 1000));
}
