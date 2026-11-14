/*
 * The picker for reactions and throws: a button in the top corner of the table, as far from the bar of
 * moves under it as the table goes, which opens a panel over the top of the table. A reaction is one
 * tap there; a throw is the thing, then who to throw it at, by name. Seats themselves take no new tap.
 */
import { REACTIONS } from '../../engine/reactions.ts';
import type { ReactionKind } from '../../engine/reactions.ts';
import type { TableView } from '../../engine/view.ts';
import { PICKER_MARK } from '../reactions.ts';
import { h, Slot } from '../ui.ts';

export interface PickerHost {
  /** The player picked a reaction, or a throw and who to throw it at. */
  react(kind: string, to?: string): void;
}

const capitalized = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** What a control for a kind says aloud. */
export const reactionLabel = (kind: ReactionKind): string => (kind.thrown ? `Throw ${kind.name}` : capitalized(kind.name));

export class ReactionPicker {
  private readonly slot = new Slot(h('div.react-picker'));
  private readonly host: PickerHost;
  private open = false;
  /** The thing picked to throw, while who to throw it at is being picked. */
  private throwing: ReactionKind | null = null;
  private last: { view: TableView; refusal: string | null } | null = null;

  // A tap anywhere else puts the panel away, and still does what it was for
  private readonly onPointer = (event: PointerEvent) => {
    if (this.open && !this.slot.element.contains(event.target as Node)) {
      this.close();
    }
  };

  constructor(host: PickerHost) {
    this.host = host;
    document.addEventListener('pointerdown', this.onPointer, true);
  }

  get element(): HTMLElement {
    return this.slot.element;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Draws the picker for `view`. `refusal` says why a reaction now would be refused, and stills every choice while it stands. */
  draw(view: TableView, refusal: string | null): void {
    this.last = { view, refusal };

    const seated = view.you.seat !== null;
    if (!seated) {
      this.open = false;
      this.throwing = null;
    }

    const others = view.seats.flatMap((seat) => (seat && seat.seat !== view.you.seat ? [{ id: seat.playerId, name: seat.name }] : []));

    this.slot.draw([seated, this.open, this.throwing?.id, others, refusal], () => {
      if (!seated) {
        return null;
      }

      const toggle = h(
        'button.react-toggle',
        { type: 'button', 'aria-label': 'Reactions', 'aria-expanded': String(this.open), 'data-action': 'reactions', onclick: () => this.toggle() },
        PICKER_MARK,
      );

      return [toggle, this.open ? this.panel(others, refusal) : null];
    });
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
      this.draw(this.last.view, this.last.refusal);
    }
  }

  private panel(others: { id: string; name: string }[], refusal: string | null): HTMLElement {
    const still = refusal !== null;
    const throwing = this.throwing;

    if (throwing) {
      return h(
        'div.react-panel',
        { role: 'group', 'aria-label': `${reactionLabel(throwing)} at` },
        h('div.react-heading', null, `Throw ${throwing.mark} at…`),
        h(
          'div.react-targets',
          null,
          others.map((other) => h('button.btn.small', { type: 'button', 'data-throw-at': other.id, disabled: still, onclick: () => this.pick(throwing, other.id) }, other.name)),
        ),
        h('button.btn.small.react-back', { type: 'button', 'data-action': 'react-back', onclick: () => ((this.throwing = null), this.redraw()) }, 'Back'),
        still ? h('div.react-note', null, refusal) : null,
      );
    }

    const choice = (kind: ReactionKind, disabled: boolean) =>
      h(
        'button.react-choice',
        { type: 'button', 'aria-label': reactionLabel(kind), title: reactionLabel(kind), 'data-react': kind.id, disabled, onclick: () => (kind.thrown ? ((this.throwing = kind), this.redraw()) : this.pick(kind)) },
        kind.mark,
      );

    return h(
      'div.react-panel',
      { role: 'group', 'aria-label': 'Reactions' },
      h('div.react-heading', null, 'React'),
      h('div.react-row', null, REACTIONS.filter((kind) => !kind.thrown).map((kind) => choice(kind, still))),
      h('div.react-heading', null, others.length > 0 ? 'Throw at someone' : 'Throw at someone, once someone else sits down'),
      h('div.react-row', null, REACTIONS.filter((kind) => kind.thrown).map((kind) => choice(kind, still || others.length === 0))),
      still ? h('div.react-note', null, refusal) : null,
    );
  }

  private pick(kind: ReactionKind, to?: string): void {
    this.open = false;
    this.throwing = null;
    this.redraw();
    this.host.react(kind.id, to);
  }
}
