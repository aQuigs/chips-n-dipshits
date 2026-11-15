import type { Denominated } from '../engine/amounts.ts';
import { partStarts, replaySteps } from '../engine/replay.ts';
import type { ReplayStep } from '../engine/replay.ts';
import type { HandRecord } from '../engine/types.ts';

/** How long a step is shown while a replay plays at its own pace, in milliseconds. */
export const STEP_MS = 1400;

/** The paces a replay plays at, as how many times its own: the one after the last is the first again. */
export const REPLAY_SPEEDS = [1, 2, 4, 0.5];

/** The way to have something happen later, which a test puts its own clock behind. */
export interface Ticker {
  /** Runs `run` once, `ms` from now. Gives back the way to call it off. */
  after(ms: number, run: () => void): () => void;
}

export const pageTicker: Ticker = {
  after(ms, run) {
    const timer = setTimeout(run, ms);

    return () => clearTimeout(timer);
  },
};

/**
 * What the history says of a hand that cannot be played back, in place of the way to; null for one
 * that can. A hand from before events were recorded has no big blind in its record either, which is
 * how it is told from one that lost its events since: it ran longer than a hand is recorded for.
 */
export function noReplayLine(record: HandRecord, table: Denominated): string | null {
  if (replaySteps(record, table)) {
    return null;
  }

  return record.events.length === 0 && record.bigBlind === 0 ? 'This hand was recorded before hands could be replayed, so here it is as text.' : 'This hand cannot be replayed, so here it is as text.';
}

/**
 * Where a replay stands among the steps of its hand, and what its controls do to that: a step back or
 * forward, a jump to where a street starts, any step at all, and playing on from here at a pace. It
 * knows nothing of the page, which draws whatever step this says whenever `changed` is called.
 */
export class ReplayPlayer {
  readonly steps: readonly ReplayStep[];
  /** The steps at which a part of the hand starts, by their place among the steps. */
  readonly starts: readonly number[];
  private readonly ticker: Ticker;
  private readonly changed: () => void;
  private place: number;
  private pace = REPLAY_SPEEDS[0]!;
  private stopTick: (() => void) | null = null;

  /** `at` is the step to start on: the first, unless the replay is being picked up where it was left. */
  constructor(steps: readonly ReplayStep[], ticker: Ticker, changed: () => void, at = 0) {
    this.steps = steps;
    this.starts = partStarts(steps);
    this.ticker = ticker;
    this.changed = changed;
    this.place = this.within(at);
  }

  /** The step shown, counted from 0. */
  get at(): number {
    return this.place;
  }

  get step(): ReplayStep {
    return this.steps[this.place]!;
  }

  get atStart(): boolean {
    return this.place === 0;
  }

  get atEnd(): boolean {
    return this.place === this.steps.length - 1;
  }

  get playing(): boolean {
    return this.stopTick !== null;
  }

  /** How many times its own pace it plays at. */
  get speed(): number {
    return this.pace;
  }

  /** Goes to a step, wherever it is. Whoever chooses a step has the replay in hand, so it stops playing. */
  seek(to: number): void {
    this.pause();
    this.show(to);
  }

  back(): void {
    this.seek(this.place - 1);
  }

  forward(): void {
    this.seek(this.place + 1);
  }

  /** To where the street being shown starts, and from there to where the one before it does. */
  previousPart(): void {
    this.seek([...this.starts].reverse().find((start) => start < this.place) ?? 0);
  }

  /** To where the next street starts, and from the last street to the end of the hand. */
  nextPart(): void {
    this.seek(this.starts.find((start) => start > this.place) ?? this.steps.length - 1);
  }

  /** Plays on from the step shown, or stops. Played from its end, a hand starts over. */
  toggle(): void {
    if (this.playing) {
      this.pause();
      this.changed();
      return;
    }

    if (this.atEnd) {
      this.place = 0;
    }

    this.tickLater();
    this.changed();
  }

  /** Takes the next pace. A step being shown is given its whole time again at the new one. */
  changeSpeed(): void {
    this.pace = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(this.pace) + 1) % REPLAY_SPEEDS.length]!;

    if (this.playing) {
      this.tickLater();
    }

    this.changed();
  }

  private within(step: number): number {
    return Math.max(0, Math.min(this.steps.length - 1, Math.round(step) || 0));
  }

  private show(step: number): void {
    const to = this.within(step);

    if (to !== this.place) {
      this.place = to;
      this.changed();
    }
  }

  /** Stops playing without a word to the page: for a move that then says where it is, or a replay being closed. */
  pause(): void {
    this.stopTick?.();
    this.stopTick = null;
  }

  private tickLater(): void {
    this.pause();

    // Nothing comes after the end, so a hand of one step is over as it starts
    if (this.atEnd) {
      return;
    }

    this.stopTick = this.ticker.after(STEP_MS / this.pace, () => {
      this.stopTick = null;
      this.place += 1;
      this.tickLater();
      this.changed();
    });
  }
}
