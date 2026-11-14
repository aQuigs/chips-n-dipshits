/*
 * The picker for reactions and throws: a button at the end of the chat's bar, which is in the same place
 * in every shape of the page and never beside a bet, and a panel it opens over the top of the table. A
 * reaction is one tap there; a throw is the thing, then who to throw it at, by name. Seats themselves
 * take no new tap.
 */
import { REACTIONS } from '../../engine/reactions.ts';
import type { ReactionKind } from '../../engine/reactions.ts';
import type { TableView } from '../../engine/view.ts';
import { PICKER_MARK } from '../reactions.ts';
import { h, Slot } from '../ui.ts';

export interface PickerHost {
  /** The player picked a reaction, or a throw and who to throw it at. */
  react(kind: string, to?: string): void;
  /** Why a reaction now would be refused, or null when one would go. Asked each time the picker is drawn. */
  refusal(view: TableView): string | null;
}

const capitalized = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** What a control for a kind says aloud. */
export const reactionLabel = (kind: ReactionKind): string => (kind.thrown ? `Throw ${kind.name}` : capitalized(kind.name));

export class ReactionPicker {
  // Built once and kept, so it keeps the keyboard's focus as it opens and closes the panel
  private readonly button = h(
    'button.react-toggle',
    { type: 'button', hidden: true, 'aria-label': 'Reactions', 'aria-expanded': 'false', 'aria-controls': 'react-panel', 'data-action': 'reactions', onclick: () => this.toggle() },
    PICKER_MARK,
  );
  private readonly slot = new Slot(h('div.react-picker'));
  private readonly host: PickerHost;
  private open = false;
  /** The thing picked to throw, while who to throw it at is being picked. */
  private throwing: ReactionKind | null = null;
  private last: TableView | null = null;

  // A tap anywhere else puts the panel away, and still does what it was for
  private readonly onPointer = (event: PointerEvent) => {
    const target = event.target as Node;

    if (this.open && !this.slot.element.contains(target) && !this.button.contains(target)) {
      this.close();
    }
  };

  constructor(host: PickerHost) {
    this.host = host;
    document.addEventListener('pointerdown', this.onPointer, true);
  }

  /** The button that opens the picker, for the chat's bar. */
  get toggleElement(): HTMLElement {
    return this.button;
  }

  /** The panel, for the layer over the table. */
  get panelElement(): HTMLElement {
    return this.slot.element;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Draws the picker for `view`, every choice stilled while the host says a reaction now would be refused. */
  draw(view: TableView): void {
    this.last = view;

    const seated = view.you.seat !== null;
    if (!seated) {
      this.open = false;
      this.throwing = null;
    }

    const others = view.seats.flatMap((seat) => (seat && seat.seat !== view.you.seat ? [{ id: seat.playerId, name: seat.name }] : []));

    this.button.hidden = !seated;
    this.button.setAttribute('aria-expanded', String(this.open));
    this.slot.draw([this.open, this.throwing?.id, others], () => (this.open ? this.panel(others) : null));
    this.still(this.open ? this.host.refusal(view) : null, others.length === 0);
  }

  /**
   * Stills every choice while `refusal` stands, on the buttons already drawn: the wait starting or ending
   * never draws them again, so a tap that lands as it does is taken or plainly refused, never lost.
   */
  private still(refusal: string | null, alone: boolean): void {
    const panel = this.slot.element;

    panel.querySelectorAll<HTMLButtonElement>('[data-react], [data-throw-at]').forEach((button) => {
      button.disabled = refusal !== null || (alone && button.dataset.thrown !== undefined);
    });

    const note = panel.querySelector('.react-note');
    if (note) {
      note.textContent = refusal ?? '';
    }
  }

  close(): void {
    if (this.open) {
      this.open = false;
      this.throwing = null;
      this.redraw();
    }
  }

  dispose(): void {
    document.removeEventListener('pointerdown', this.onPointer, true);
  }

  private toggle(): void {
    this.open = !this.open;
    this.throwing = null;
    this.redraw();
  }

  private redraw(): void {
    if (this.last) {
      this.draw(this.last);
    }
  }

  private panel(others: { id: string; name: string }[]): HTMLElement {
    const throwing = this.throwing;

    if (throwing) {
      return h(
        'div.react-panel',
        { id: 'react-panel', role: 'group', 'aria-label': `${reactionLabel(throwing)} at` },
        h('div.react-heading', null, `Throw ${throwing.mark} at…`),
        h(
          'div.react-targets',
          null,
          others.map((other) => h('button.btn.small', { type: 'button', 'data-throw-at': other.id, onclick: () => this.pick(throwing, other.id) }, other.name)),
        ),
        h('button.btn.small.react-back', { type: 'button', 'data-action': 'react-back', onclick: () => ((this.throwing = null), this.redraw()) }, 'Back'),
        h('div.react-note', { 'aria-live': 'polite' }),
      );
    }

    const choice = (kind: ReactionKind) =>
      h(
        'button.react-choice',
        {
          type: 'button',
          'aria-label': reactionLabel(kind),
          title: reactionLabel(kind),
          'data-react': kind.id,
          'data-thrown': kind.thrown ? '' : null,
          onclick: () => (kind.thrown ? ((this.throwing = kind), this.redraw()) : this.pick(kind)),
        },
        kind.mark,
      );

    return h(
      'div.react-panel',
      { id: 'react-panel', role: 'group', 'aria-label': 'Reactions' },
      h('div.react-heading', null, 'React'),
      h('div.react-row', null, REACTIONS.filter((kind) => !kind.thrown).map(choice)),
      h('div.react-heading', null, others.length > 0 ? 'Throw at someone' : 'Throw at someone, once someone else sits down'),
      h('div.react-row', null, REACTIONS.filter((kind) => kind.thrown).map(choice)),
      h('div.react-note', { 'aria-live': 'polite' }),
    );
  }

  private pick(kind: ReactionKind, to?: string): void {
    this.close();
    this.host.react(kind.id, to);
  }
}
