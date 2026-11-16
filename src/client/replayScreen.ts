import type { Card } from '../engine/cards.ts';
import { BOARD_NAMES } from '../engine/handWords.ts';
import { replayView } from '../engine/replay.ts';
import type { ReplayStep } from '../engine/replay.ts';
import type { HandRecord } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';
import { stillMotion } from './motion.ts';
import { ReplayPlayer } from './replayPlayer.ts';
import type { Ticker } from './replayPlayer.ts';
import { shapeFor, tableEl } from './render/table.ts';
import type { Shape } from './render/table.ts';
import { spotsOf, TableChances } from './tableChances.ts';
import type { Pace } from './tableChances.ts';
import { h, readableText, Slot } from './ui.ts';

/** A finished hand to play back, and for whom. */
export interface ReplayOf {
  record: HandRecord;
  steps: readonly ReplayStep[];
  /** The table as the viewer has it now: who they are, and how the table writes its amounts. */
  table: TableView;
  /** The viewer's own two cards in the hand, where this browser kept them. */
  kept: Card[] | null;
}

export interface ReplayHost {
  /** What the replay lies over, which is out of reach of the keyboard and of whatever reads the page aloud while it does. */
  under: HTMLElement;
  ticker: Ticker;
  /** Spreads out the working out of chances, as for the live table. */
  pace: Pace;
  /** The deck the viewer chose, for the cards written in a step's lines. */
  deck(): string;
  /** Called once the replay has been closed, by its own button or by `close`. */
  closed(): void;
  /** Takes the replay, and whatever it was opened from, off the table, which the game is waiting on the viewer at. */
  toTable(): void;
}

// What nobody can do at a table that is being played back
const NO_HANDLERS = { onStart: () => Promise.resolve(), onPlayOn: () => Promise.resolve(), onHunt: () => undefined };

/** What marks a part of the hand on the bar: its first letter, and for a board run after the first, which would share one with a street, its number. */
function markOf(part: string): string {
  const board = BOARD_NAMES.indexOf(part);

  return board > 0 ? String(board + 1) : part[0]!;
}

/** Everything of one replay that is open. */
interface Open {
  replay: ReplayOf;
  player: ReplayPlayer;
  chances: TableChances;
  stage: Slot;
  shape: Shape;
  resized: ResizeObserver;
  /** The step the lines were last written for, so that a draw for anything else does not say them again. */
  told: number | null;
  /** What had the keyboard before the replay took it. */
  opener: Element | null;
  count: HTMLElement;
  leave: HTMLButtonElement;
  line: HTMLElement;
  log: HTMLElement;
  scrub: HTMLInputElement;
  buttons: Record<'previousPart' | 'back' | 'play' | 'forward' | 'nextPart' | 'speed', HTMLButtonElement>;
}

/**
 * A finished hand played back over the table: the table as the hand left it at each step, drawn by
 * the code that draws the live one, with the controls to move through it. It lies over the whole app
 * and touches nothing under it, so the game goes on there and is as it was when the replay closes.
 *
 * Nothing here moves or sounds, and nothing is asked of the server: a step is drawn at once, from the
 * record the history brought.
 */
export class ReplayScreen {
  readonly element = h('section.replay', { hidden: true, role: 'dialog', 'aria-modal': 'true', tabindex: -1 });
  private readonly host: ReplayHost;
  private open: Open | null = null;
  /** Whether the game under the replay is waiting on the viewer. */
  private waiting = false;
  /** The hand and the step a replay was at when it was set aside, for that hand to open on again. */
  private left: { hand: number; at: number } | null = null;

  constructor(host: ReplayHost) {
    this.host = host;
  }

  get isOpen(): boolean {
    return this.open !== null;
  }

  /**
   * Told whether the live game is waiting on the viewer. A replay opened while it is has, where its
   * way out is, the way straight back to the table, so the turn is never out of sight or a tap away.
   */
  turn(mine: boolean): void {
    if (mine !== this.waiting) {
      this.waiting = mine;
      this.draw();
    }
  }

  /** Plays a hand back from its start, or from where it was when it was last set aside. */
  show(replay: ReplayOf): void {
    this.close();

    const at = this.left?.hand === replay.record.number ? this.left.at : 0;
    const player = new ReplayPlayer(replay.steps, this.host.ticker, () => this.draw(), at);

    this.left = null;
    const button = (action: string, label: string, text: string, press: () => void) =>
      h('button.btn', { type: 'button', 'data-replay': action, 'aria-label': label, title: label, onclick: press }, text) as HTMLButtonElement;
    const stage = new Slot(h('div.replay-stage'));
    const scrub = h('input', {
      type: 'range',
      min: 0,
      max: replay.steps.length - 1,
      step: 1,
      'data-replay': 'scrub',
      'aria-label': 'Step of the hand',
      oninput: () => player.seek(Number(scrub.value)),
    }) as HTMLInputElement;

    const open: Open = {
      replay,
      player,
      chances: new TableChances(stillMotion, this.host.pace, () => this.draw()),
      stage,
      shape: 'wide',
      resized: new ResizeObserver(() => this.reshape()),
      told: null,
      opener: document.activeElement,
      count: h('span.replay-count'),
      leave: h('button.btn.small', { type: 'button', 'data-replay': 'close', onclick: () => (this.waiting ? this.host.toTable() : this.close()) }) as HTMLButtonElement,
      line: h('div.replay-line', { role: 'status', 'aria-live': 'polite' }),
      log: h('ol.replay-log', { 'aria-label': 'The hand so far' }),
      scrub,
      buttons: {
        previousPart: button('previous-street', 'Previous street', '« Street', () => player.previousPart()),
        back: button('back', 'Back one step', '‹ Back', () => player.back()),
        play: h('button.btn', { type: 'button', 'data-replay': 'play', onclick: () => player.toggle() }) as HTMLButtonElement,
        forward: button('forward', 'Forward one step', 'Forward ›', () => player.forward()),
        nextPart: button('next-street', 'Next street', 'Street »', () => player.nextPart()),
        speed: button('speed', 'Speed', 'Speed', () => player.changeSpeed()),
      },
    };

    // Where each street starts, along the bar the way the steps lie along it
    const marks = player.starts.map((start) =>
      h('span', { style: { '--at': String(replay.steps.length > 1 ? start / (replay.steps.length - 1) : 0) }, title: replay.steps[start]!.part }, markOf(replay.steps[start]!.part)),
    );
    const { previousPart, back, play, forward, nextPart, speed } = open.buttons;

    this.open = open;
    this.element.setAttribute('aria-label', `Replay of hand #${replay.record.number}`);
    this.element.replaceChildren(
      h('header.replay-head', null, h('h2', null, `Hand #${replay.record.number}`, open.count), open.leave),
      stage.element,
      h('div.replay-told', null, open.log, open.line),
      h('div.replay-controls', null, h('div.replay-scrub', null, scrub, h('div.replay-marks', { 'aria-hidden': 'true' }, marks)), h('div.replay-buttons', null, previousPart, back, play, forward, nextPart, speed)),
    );
    this.element.hidden = false;
    this.host.under.inert = true;

    open.resized.observe(stage.element);
    this.reshape();
    this.draw();
    play.focus();
  }

  /** Closes the replay, if one is open, and hands the keyboard back to where it was. */
  close(): void {
    const open = this.open;
    if (!open) {
      return;
    }

    this.open = null;
    open.player.pause();
    open.chances.end();
    open.resized.disconnect();
    this.element.hidden = true;
    this.element.replaceChildren();
    this.host.under.inert = false;
    this.host.closed();

    if (open.opener instanceof HTMLElement && open.opener.isConnected) {
      open.opener.focus();
    }
  }

  /** Closes the replay for the game to have the viewer, keeping its place. False when none was open. */
  setAside(): boolean {
    const open = this.open;
    if (!open) {
      return false;
    }

    this.close();
    this.left = { hand: open.replay.record.number, at: open.player.at };

    return true;
  }

  /**
   * A key pressed while the replay is open: the arrows step, with shift a street at a time, Home and
   * End go to either end, the space bar plays or stops, and Escape closes. A key the thing in focus
   * has a use of its own for, the bar or a button, is left to it.
   */
  key(event: KeyboardEvent): void {
    const open = this.open;
    if (!open) {
      return;
    }

    const { player, scrub } = open;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => (event.shiftKey ? player.previousPart() : player.back()),
      ArrowRight: () => (event.shiftKey ? player.nextPart() : player.forward()),
      Home: () => player.seek(0),
      End: () => player.seek(player.steps.length - 1),
      ' ': () => player.toggle(),
      Escape: () => this.close(),
    };
    const move = moves[event.key];
    const ownUse = event.key !== 'Escape' && (event.target === scrub ? event.key !== ' ' : event.target instanceof HTMLButtonElement && event.key === ' ');

    if (move && !ownUse && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      move();
    }
  }

  private reshape(): void {
    const open = this.open;
    if (!open) {
      return;
    }

    const shape = shapeFor(open.stage.element.getBoundingClientRect());
    if (shape !== open.shape) {
      open.shape = shape;
      this.draw();
    }

    // A screen turned on its side may be the first to show the hand so far, which is read from its end
    open.log.scrollTop = open.log.scrollHeight;
  }

  private draw(): void {
    const open = this.open;
    if (!open) {
      return;
    }

    const { replay, player, chances, stage, buttons } = open;
    const { steps } = replay;
    const view: TableView = replayView(replay.record, player.step, replay.table, replay.kept);
    const deck = this.host.deck();

    // The chances of hands face up with cards to come, worked out as for the live table, from what the record holds
    chances.follow(spotsOf(view));
    stage.draw([player.at, open.shape, chances.shown], () => tableEl(view, open.shape, 0, NO_HANDLERS, [], chances.shown));
    stage.element.toggleAttribute('data-chances-pending', chances.pending);
    chances.played();

    open.count.textContent = `Step ${player.at + 1} of ${steps.length} · ${player.step.part}`;
    open.leave.textContent = this.waiting ? 'Your turn' : 'Close';
    open.leave.title = this.waiting ? 'Back to the table, where it is your turn' : 'Back to the hand history';
    open.leave.classList.toggle('primary', this.waiting);

    if (open.told !== player.at) {
      const lineEl = (line: string) => h('li', null, readableText(line, deck));

      open.told = player.at;
      open.line.replaceChildren(...player.step.lines.map((line) => h('div', null, readableText(line, deck))));
      open.line.scrollTop = 0;
      open.log.replaceChildren(...steps.slice(0, player.at).flatMap((step) => step.lines.map(lineEl)));
      open.log.scrollTop = open.log.scrollHeight;
    }

    // Set only when it differs, so a thumb being dragged is never moved from under the finger
    if (Number(open.scrub.value) !== player.at) {
      open.scrub.value = String(player.at);
    }
    open.scrub.setAttribute('aria-valuetext', `Step ${player.at + 1} of ${steps.length}, ${player.step.part}`);

    buttons.previousPart.disabled = buttons.back.disabled = player.atStart;
    buttons.nextPart.disabled = buttons.forward.disabled = player.atEnd;
    buttons.play.textContent = player.playing ? 'Pause' : 'Play';
    buttons.play.dataset.playing = String(player.playing);
    buttons.speed.textContent = `Speed ${player.speed}×`;
    buttons.speed.setAttribute('aria-label', `${buttons.speed.textContent}, press to change`);
  }
}
