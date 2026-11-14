import type { AppPreferences } from './prefs.ts';

/** Every sound the page can make. Each is one short recipe in `soundRecipes.ts`. */
export type SoundName = 'deal' | 'chips' | 'knock' | 'fold' | 'allIn' | 'street' | 'win' | 'myWin' | 'turn';

/** What makes the sounds: the Web Audio synthesizer in a browser, or silence where there is none. */
export interface SoundMaker {
  /** Plays a sound `delay` seconds from now at `volume`, from 0 to 1, or does nothing when it can't. */
  play(sound: SoundName, volume: number, delay: number): void;
}

export const silentSounds: SoundMaker = { play: () => undefined };

/** What the page knows that decides whether and when a sound is heard. */
export interface Listening {
  /** Milliseconds, from any fixed start. */
  now(): number;
  /** False while the page is out of sight: another tab, a phone asleep. */
  inView(): boolean;
}

// Sounds asked for together play one after another, this far apart, so they never land as one chord
export const SOUND_GAP_MS = 120;

// A sound that would have to wait longer than this behind others is dropped, so a burst never queues up
export const MOST_WAIT_MS = 400;

// What calls the player back to the table: it plays while the page is out of sight, and waits behind other sounds rather than being dropped
const CALLS_BACK: ReadonlySet<SoundName> = new Set(['turn']);

// Once the volume slider rests this long, a sample plays at the new volume
const SAMPLE_AFTER_MS = 200;

/**
 * The sounds one viewer hears. Whatever on the page makes a sound plays it through here, which is
 * what holds it to their sound switch and volume and keeps sounds from landing on top of each other.
 */
export class Sounds {
  private readonly maker: SoundMaker;
  private readonly prefs: AppPreferences;
  private readonly listening: Listening;
  private nextAt = -Infinity;
  private sample: ReturnType<typeof setTimeout> | undefined;

  constructor(maker: SoundMaker, prefs: AppPreferences, listening: Listening) {
    this.maker = maker;
    this.prefs = prefs;
    this.listening = listening;

    prefs.watch('volume', () => {
      clearTimeout(this.sample);
      this.sample = setTimeout(() => this.play('chips'), SAMPLE_AFTER_MS);
    });
  }

  play(sound: SoundName): void {
    const volume = this.prefs.get('volume') / 100;
    const callsBack = CALLS_BACK.has(sound);

    if (!this.prefs.get('sound') || volume <= 0 || (!this.listening.inView() && !callsBack)) {
      return;
    }

    const now = this.listening.now();
    const at = Math.max(now, this.nextAt);

    if (at - now > MOST_WAIT_MS && !callsBack) {
      return;
    }

    this.nextAt = at + SOUND_GAP_MS;
    this.maker.play(sound, volume, (at - now) / 1000);
  }
}
