/*
 * The host or a co-host moving a player to an open seat on the page: by picking one on the table after
 * choosing Move in the Players dialog, which works on any screen, or by dragging the player's seat onto
 * an open one with a mouse.
 */
import type { Command } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';
import { hostOrCohost } from './render/roles.ts';
import { h } from './ui.ts';

// How far the mouse has to travel with the button down before a press becomes a drag
const DRAG_FROM_PX = 6;

export interface SeatMovesHost {
  /** The table as it was last drawn. */
  view(): TableView | null;
  send(command: Command): void;
  /** Picking started or ended, so the table and the banner need drawing again. */
  changed(): void;
}

interface Drag {
  playerId: string;
  from: number;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

export class SeatMoves {
  /** The player whose new seat is being picked on the table, or null. */
  picking: string | null = null;

  private readonly stage: HTMLElement;
  private readonly host: SeatMovesHost;
  private drag: Drag | null = null;
  private readonly onMove = (event: PointerEvent) => this.dragMove(event);
  private readonly onUp = (event: PointerEvent) => this.dragEnd(event, true);
  private readonly onCancel = (event: PointerEvent) => this.dragEnd(event, false);

  /** `stage` is the element the table is drawn in, which stays while the table inside it is redrawn. */
  constructor(stage: HTMLElement, host: SeatMovesHost) {
    this.stage = stage;
    this.host = host;
    stage.addEventListener('pointerdown', (event) => this.dragStart(event));
  }

  pick(playerId: string): void {
    this.picking = playerId;
    this.host.changed();
  }

  /** Stops picking, or drops a drag that is under way. Says whether there was anything to stop. */
  cancel(): boolean {
    if (this.drag) {
      this.endDrag();
      return true;
    }

    if (this.picking === null) {
      return false;
    }

    this.picking = null;
    this.host.changed();
    return true;
  }

  /** What the table offers while a seat is being picked. */
  tableHandlers(): { playerId: string; to(seat: number): void } | undefined {
    const playerId = this.picking;
    if (playerId === null) {
      return undefined;
    }

    return {
      playerId,
      to: (seat) => {
        this.cancel();
        this.host.send({ type: 'moveSeat', playerId, seat });
      },
    };
  }

  /** A new view may leave nothing to pick for: the player gone, no seat open, or the viewer no longer allowed. */
  follow(view: TableView): void {
    const still = hostOrCohost(view) && view.seats.includes(null);

    if (this.picking !== null && !(still && view.seats.some((seat) => seat?.playerId === this.picking))) {
      this.cancel();
    }

    if (this.drag && !(still && view.seats[this.drag.from]?.playerId === this.drag.playerId)) {
      this.endDrag();
    }
  }

  /** The table was drawn again, which replaced the seat being dragged: the new one takes up where it left off. */
  redrawn(): void {
    const drag = this.drag;
    if (drag?.dragging) {
      this.seatEl(drag.from)?.classList.add('dragging');
    }
  }

  dispose(): void {
    this.endDrag();
  }

  // ---- Dragging with a mouse ----

  private dragStart(event: PointerEvent): void {
    // On a touch screen a drag across the table would fight scrolling and taps, so moving there is by picking
    if (event.pointerType === 'touch' || event.button !== 0 || this.drag || this.picking !== null) {
      return;
    }

    const seat = (event.target as Element).closest<HTMLElement>('.table.movable .seat[data-seat]');
    const from = Number(seat?.dataset.seat);
    const playerId = this.host.view()?.seats[from]?.playerId;
    if (!seat || playerId === undefined) {
      return;
    }

    this.drag = { playerId, from, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onCancel);
  }

  private dragMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (!drag.dragging && Math.hypot(dx, dy) < DRAG_FROM_PX) {
      return;
    }

    drag.dragging = true;
    this.stage.style.setProperty('--drag-x', `${dx}px`);
    this.stage.style.setProperty('--drag-y', `${dy}px`);
    this.seatEl(drag.from)?.classList.add('dragging');

    for (const open of this.stage.querySelectorAll('.seat.drop')) {
      open.classList.remove('drop');
    }
    this.openSeatAt(event)?.classList.add('drop');
  }

  private dragEnd(event: PointerEvent, drop: boolean): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const to = drop && drag.dragging ? this.openSeatAt(event)?.dataset.openSeat : undefined;
    this.endDrag();

    if (to !== undefined) {
      this.host.send({ type: 'moveSeat', playerId: drag.playerId, seat: Number(to) });
    }
  }

  private endDrag(): void {
    this.drag = null;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);

    for (const element of this.stage.querySelectorAll('.seat.dragging, .seat.drop')) {
      element.classList.remove('dragging', 'drop');
    }
  }

  private seatEl(seat: number): HTMLElement | null {
    return this.stage.querySelector<HTMLElement>(`.seat[data-seat="${seat}"]`);
  }

  /** The dragged seat lets the pointer through to what is under it, so this finds the open seat it is over. */
  private openSeatAt(event: PointerEvent): HTMLElement | null {
    return document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-open-seat]') ?? null;
  }
}

/** The banner while a seat is being picked: for whom, when the move happens, and the way out. */
export function movePromptEl(view: TableView, playerId: string, onCancel: () => void): HTMLElement | null {
  const seat = view.seats.find((s) => s?.playerId === playerId);
  if (!seat) {
    return null;
  }

  return h(
    'div.banner.move-prompt',
    null,
    h('span', null, 'Pick an open seat for ', h('b', null, seat.name), seat.inHand ? '. They move when this hand ends.' : ''),
    h('button.btn.small', { type: 'button', 'data-action': 'cancel-move', onclick: onCancel }, 'Cancel'),
  );
}
