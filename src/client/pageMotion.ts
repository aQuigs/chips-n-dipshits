import { confettiBurst } from './confetti.ts';
import { MOVE_MS, stillMotion } from './motion.ts';
import type { MotionPlayer, Move, MoveName, Watching } from './motion.ts';
import { drawnTable } from './render/table.ts';
import type { DrawnTable, Point } from './render/table.ts';
import { h } from './ui.ts';

/** How a move looks at its far end: the end away from where what moves is drawn. */
interface Look {
  /** What moves: what the table has standing where the move ends, a stand-in of this kind for what it no longer draws, or a piece of confetti. */
  mover: 'standing' | 'chips' | 'cards' | 'card' | 'confetti';
  /** A stand-in that shows only once it sets off, where others lie at their start while they wait. */
  appears?: boolean;
  easing: string;
  /** How it is shrunk, shifted or turned at the far end. */
  shape: string;
  opacity: number;
}

const SMALL = 'scale(0.6)';

const LOOKS: Record<MoveName, Look> = {
  // Quick off the deck and slowing onto the seat
  deal: { mover: 'standing', easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)', shape: SMALL, opacity: 0 },
  // The deck sits where the board does, so a board card only drops the last of the way onto its place
  board: { mover: 'standing', easing: 'ease-out', shape: 'translateY(-35%) scale(0.92)', opacity: 0 },
  // Turned over on its long edge
  show: { mover: 'standing', easing: 'ease-out', shape: 'rotateY(90deg)', opacity: 1 },
  bet: { mover: 'standing', easing: 'ease-out', shape: SMALL, opacity: 0 },
  chips: { mover: 'chips', easing: 'ease-in-out', shape: SMALL, opacity: 0 },
  muck: { mover: 'cards', easing: 'ease-in', shape: SMALL, opacity: 0 },
  // A card turned over on its long edge, the back going away and then the face coming
  facedown: { mover: 'card', easing: 'ease-in', shape: 'rotateY(90deg)', opacity: 1 },
  reveal: { mover: 'standing', easing: 'ease-out', shape: 'rotateY(90deg)', opacity: 0 },
  // Thrown out fast and slowing, each piece with a spin of its own (`burst`)
  confetti: { mover: 'confetti', easing: 'cubic-bezier(0.1, 0.7, 0.3, 1)', shape: '', opacity: 0, appears: true },
};

// The share of a move over which what moves fades in as it leaves, or out as it lands
const FADE = 0.3;

// The share of its move over which a stand-in that appears fades in
const APPEAR = 0.08;

/** One piece of a move, ready to fly: what moves, and the middle of the place at its far end, or null when it moves where it lies. */
interface Piece {
  name: MoveName;
  element: HTMLElement;
  look: Look;
  far: Point | null;
  ms: number;
  after: number;
}

/** Something in flight. A stand-in is taken off the table when it lands. */
interface Flight {
  animation: Animation;
  standIn: boolean;
}

/**
 * Plays moves with the browser's own animations, on the table drawn in `stage`. Only transform and
 * opacity are animated, and by animations that write nothing into the page: what the table draws
 * moves without leaving its place in the layout, and when a move ends the element is as it was drawn.
 *
 * While anything is in flight the stage carries `data-moving`, which is what a browser check waits on.
 */
class PageMotion implements MotionPlayer {
  private readonly stage: HTMLElement;
  private readonly flights = new Map<HTMLElement, Flight>();
  private waiting: (() => void)[] = [];
  /** How big the stage was when what is in flight was measured. */
  private measured = { width: 0, height: 0 };
  private readonly resized: ResizeObserver;
  private readonly redrawn: MutationObserver;
  private readonly onHide = () => document.hidden && this.cancel();

  constructor(stage: HTMLElement) {
    this.stage = stage;

    // A phone turned, or a keyboard opened: everything in flight was aimed at places that have moved
    this.resized = new ResizeObserver(() => {
      if (stage.clientWidth !== this.measured.width || stage.clientHeight !== this.measured.height) {
        this.cancel();
      }
    });
    this.resized.observe(stage);

    // A table drawn again takes what was moving on the old one with it
    this.redrawn = new MutationObserver(() => this.sweep());
    this.redrawn.observe(stage, { childList: true });

    // A page out of sight stops its animations where they are, and would play the rest on coming back
    document.addEventListener('visibilitychange', this.onHide);
  }

  play(moves: readonly Move[]): void {
    const table = drawnTable(this.stage);
    if (!table) {
      return;
    }

    this.sweep();

    // What is moved again rests first, so a stand-in laid out by it is laid out where it rests
    for (const move of moves.filter((move) => LOOKS[move.name].mover === 'standing')) {
      table.standing(move.to).forEach((element) => this.flights.get(element)?.animation.cancel());
    }

    // Read, then written, then read again, each all at once: the page is laid out twice however many moves there are.
    // A move for something already moving takes the place of the one it had, in this list or in flight
    const pieces = [...new Map(moves.flatMap((move) => this.pieces(table, move)).map((piece) => [piece.element, piece])).values()];

    for (const { element, look } of pieces) {
      this.flights.get(element)?.animation.cancel();

      if (look.mover !== 'standing') {
        table.element.append(element);
      }
    }

    const rests = pieces.map(({ element }) => {
      const style = getComputedStyle(element);

      return { middle: table.middleOf(element), transform: style.transform === 'none' ? '' : style.transform, opacity: style.opacity };
    });

    this.measured = { width: this.stage.clientWidth, height: this.stage.clientHeight };

    pieces.forEach((piece, index) => this.fly(piece, rests[index]!));
  }

  cancel(): void {
    for (const [element, flight] of this.flights) {
      this.end(element, flight);
    }

    this.settle();
  }

  idle(): Promise<void> {
    return this.flights.size === 0 ? Promise.resolve() : new Promise((resolve) => this.waiting.push(resolve));
  }

  seen(): boolean {
    return true;
  }

  dispose(): void {
    this.cancel();
    this.resized.disconnect();
    this.redrawn.disconnect();
    document.removeEventListener('visibilitychange', this.onHide);
  }

  /** What a move sets in flight: whatever stands at its end, a seat's two cards together, or one stand-in at its start. */
  private pieces(table: DrawnTable, move: Move): Piece[] {
    const look = LOOKS[move.name];
    const ms = MOVE_MS[move.name];

    if (look.mover === 'standing') {
      const far = move.from ? table.middle(move.from) : null;

      return table.standing(move.to).map((element) => ({ name: move.name, element, look, far, ms, after: move.after }));
    }

    if (look.mover === 'confetti') {
      return this.burst(table, move, look);
    }

    const far = table.middle(move.to);
    const element = far && move.from ? table.standIn(look.mover, move.from, move.amount) : null;

    return element ? [{ name: move.name, element, look, far, ms, after: move.after }] : [];
  }

  /** The pieces of a burst of confetti, thrown from `from` toward the middle of the table and fanning out. */
  private burst(table: DrawnTable, move: Move, look: Look): Piece[] {
    const from = move.from && table.middle(move.from);
    const middle = table.middle({ at: 'deck' });
    if (!from || !middle) {
      return [];
    }

    const style = getComputedStyle(table.element);
    const reach = Math.min(parseFloat(style.width), parseFloat(style.height));
    const toward = Math.atan2(middle.y - from.y, middle.x - from.x);

    return confettiBurst(move.seed ?? 0).map((piece) => {
      const angle = toward + (piece.angle * Math.PI) / 180;
      const far = { x: from.x + Math.cos(angle) * piece.reach * reach, y: from.y + Math.sin(angle) * piece.reach * reach };
      const element = h('i.confetti.stand-in', { class: `c${piece.color}`, 'aria-hidden': 'true', style: { left: `${from.x}px`, top: `${from.y}px` } });

      return { name: move.name, element, look: { ...look, shape: `rotate(${piece.spin}deg)` }, far, ms: MOVE_MS.confetti, after: move.after + piece.after };
    });
  }

  private fly({ name, element, look, far, ms, after }: Piece, rest: { middle: Point; transform: string; opacity: string }): void {
    const standIn = look.mover !== 'standing';
    const across = far ? `translate(${far.x - rest.middle.x}px, ${far.y - rest.middle.y}px)` : '';

    const here = { transform: rest.transform || 'none', opacity: rest.opacity };
    const away = { transform: `${across} ${rest.transform} ${look.shape}`, opacity: String(look.opacity) };

    // What the table draws arrives and a stand-in leaves. Either is whole for all of the move but the end that is away.
    // One that appears slows down along its way but fades by the clock, so it is seen for most of its flight
    const leaves = look.appears ? [{ ...here, opacity: '0', easing: look.easing }, { opacity: rest.opacity, offset: APPEAR }] : [here];
    const frames = standIn ? [...leaves, { opacity: rest.opacity, offset: 1 - FADE }, away] : [away, { opacity: rest.opacity, offset: FADE }, here];

    // What the table draws is filled backwards only, so nothing of the animation is on it once it lands.
    // A stand-in is taken off the table when it lands, and until then must not show where it started.
    // The move's name goes on the animation, for a browser check to tell which it is
    const easing = look.appears ? 'linear' : look.easing;
    const animation = element.animate(frames, { id: name, duration: ms, delay: after, easing, fill: standIn ? 'both' : 'backwards' });
    const flight = { animation, standIn };

    animation.addEventListener('finish', () => {
      if (this.flights.get(element) === flight) {
        this.end(element, flight);
        this.settle();
      }
    });

    this.flights.set(element, flight);
    this.stage.dataset.moving = '';
  }

  private end(element: HTMLElement, flight: Flight): void {
    this.flights.delete(element);
    flight.animation.cancel();

    if (flight.standIn) {
      element.remove();
    }
  }

  /** Lets go of whatever was moving on a table that has since been drawn again. */
  private sweep(): void {
    for (const [element, flight] of this.flights) {
      if (!this.stage.contains(element)) {
        this.end(element, flight);
      }
    }

    this.settle();
  }

  private settle(): void {
    if (this.flights.size > 0) {
      return;
    }

    delete this.stage.dataset.moving;

    // Told once whatever is being done to the page is done: a view that ends what was moving sets its own moving next
    queueMicrotask(() => {
      if (this.flights.size === 0) {
        this.waiting.splice(0).forEach((resolve) => resolve());
      }
    });
  }
}

/** The player for the table drawn in `stage`, or one that does nothing in a browser that cannot animate. */
export function pageMotion(stage: HTMLElement): MotionPlayer {
  return typeof stage.animate === 'function' ? new PageMotion(stage) : stillMotion;
}

/** What this page knows that decides whether anything moves. */
export function pageWatching(): Watching {
  const lessMotion = matchMedia('(prefers-reduced-motion: reduce)');

  return { reduced: () => lessMotion.matches, inView: () => !document.hidden };
}
