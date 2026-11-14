import type { Attention } from './attention.ts';
import { handSounds } from './effects/handSounds.ts';
import { yourTurn } from './effects/yourTurn.ts';
import type { AppPreferences } from './prefs.ts';
import type { Sounds } from './sound.ts';
import type { TableChange } from './tableChange.ts';

export interface EffectContext {
  prefs: AppPreferences;
  /** Where the viewer sits, or null while they are only watching. */
  seat: number | null;
  /** The element the table is drawn in, for an effect that moves something on it or draws over it. */
  stage: HTMLElement;
  /** The way to make a sound, held to the viewer's sound switch and volume. */
  sounds: Sounds;
  /** The way to get the viewer's attention, for a reason: a chime, a buzz, a flash, a notification. */
  attention: Attention;
}

/** Something that happens on the page when the table changes: a sound, an animation, an alert. */
export interface TableEffect {
  /**
   * Runs once for every view put on screen, after it is drawn. Whatever in `change` is a list holds
   * only what is news, so an effect reacts to all of it and need not remember what it has done.
   */
  run(change: TableChange, context: EffectContext): void;
  /** Stops whatever the effect left going, when the table is left. */
  dispose?(): void;
}

/**
 * Every effect, as a function that makes one for a table screen. A new effect is a file in effects/
 * and a line here, one to a line: .gitattributes joins the lines two branches add to this file.
 */
const TABLE_EFFECTS: (() => TableEffect)[] = [
  handSounds,
  yourTurn,
];

/** The effects of one table screen. */
export class TableEffects {
  private readonly prefs: AppPreferences;
  private readonly stage: HTMLElement;
  private readonly sounds: Sounds;
  private readonly attention: Attention;
  private readonly effects = TABLE_EFFECTS.map((make) => make());

  constructor(prefs: AppPreferences, stage: HTMLElement, sounds: Sounds, attention: Attention) {
    this.prefs = prefs;
    this.stage = stage;
    this.sounds = sounds;
    this.attention = attention;
  }

  /** Call once for every view put on screen, with what it brought. */
  run(change: TableChange): void {
    const context: EffectContext = { prefs: this.prefs, seat: change.view.you.seat, stage: this.stage, sounds: this.sounds, attention: this.attention };

    for (const effect of this.effects) {
      // An effect that fails must not be what stops the table from updating, or the other effects from happening
      try {
        effect.run(change, context);
      } catch (error) {
        console.error(error);
      }
    }
  }

  dispose(): void {
    for (const effect of this.effects) {
      effect.dispose?.();
    }
  }
}
