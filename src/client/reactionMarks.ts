import { LANDED_MS, POPPED_MS } from './reactions.ts';
import type { SeatMark, SeatMarks } from './reactions.ts';
import { h } from './ui.ts';

// The space between marks that stand side by side on one seat, in their own size
const GAP_EM = 0.15;

interface Showing {
  mark: SeatMark;
  element: HTMLElement;
}

/**
 * The marks over the seats, on `layer`, which lies exactly over `stage` where the table is drawn. Each is
 * placed over the middle of its seat's plate; several on one seat stand side by side, the latest last.
 */
export class ReactionMarks implements SeatMarks {
  private readonly layer: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly showing: Showing[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly resized: ResizeObserver;

  constructor(layer: HTMLElement, stage: HTMLElement) {
    this.layer = layer;
    this.stage = stage;
    this.resized = new ResizeObserver(() => this.follow());
    this.resized.observe(layer);
  }

  show(mark: SeatMark, after: number): void {
    const stays = mark.kind.thrown ? LANDED_MS : POPPED_MS;

    this.later(after, () => {
      const element = h(
        'span.seat-reaction',
        { class: [mark.kind.thrown ? 'landed' : 'popped', mark.moving ? 'moving' : ''].join(' '), role: 'img', 'aria-label': mark.label, 'data-reaction': mark.kind.id, 'data-seat': mark.seat, style: { '--stays': `${stays}ms` } },
        mark.kind.mark,
      );
      const showing = { mark, element };

      this.showing.push(showing);
      this.layer.append(element);
      this.follow();

      this.later(stays, () => {
        this.showing.splice(this.showing.indexOf(showing), 1);
        element.remove();
        this.follow();
      });
    });
  }

  follow(): void {
    // Runs with every change of the table, where it would otherwise lay the page out for nothing
    if (this.showing.length === 0) {
      return;
    }

    const frame = this.layer.getBoundingClientRect();
    // The page may be drawn smaller than life, as the frames of the theme showcase are
    const zoom = frame.width / this.layer.offsetWidth || 1;
    const width = frame.width / zoom;
    const gap = GAP_EM * parseFloat(getComputedStyle(this.showing[0]!.element).fontSize);

    for (const seat of new Set(this.showing.map(({ mark }) => mark.seat))) {
      const here = this.showing.filter(({ mark }) => mark.seat === seat);
      const plate = this.stage.querySelector(`.table .seat[data-seat="${seat}"] .plate`)?.getBoundingClientRect();

      here.forEach(({ element }) => (element.hidden = !plate));
      if (!plate) {
        continue;
      }

      // Laid out by the width each is drawn at, which differs from one device's emoji to another's, and
      // moved in together at the table's edge, so none is cut off
      // The width it is laid out at: whole pixels would let the last one run past the edge, and a box would be scaled by its bounce
      const widths = here.map(({ element }) => parseFloat(getComputedStyle(element).width));
      const total = widths.reduce((sum, each) => sum + each, 0) + gap * (here.length - 1);
      const middle = (plate.left + plate.width / 2 - frame.left) / zoom;
      let left = Math.max(0, Math.min(middle - total / 2, width - total));

      here.forEach(({ element }, index) => {
        element.style.setProperty('left', `${left + widths[index]! / 2}px`);
        element.style.setProperty('top', `${(plate.top - frame.top) / zoom}px`);
        left += widths[index]! + gap;
      });
    }
  }

  /** Takes everything off, when the table is left. */
  dispose(): void {
    this.resized.disconnect();
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.showing.splice(0).forEach(({ element }) => element.remove());
  }

  private later(ms: number, then: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      then();
    }, ms);

    this.timers.add(timer);
  }
}
