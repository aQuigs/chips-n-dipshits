import type { TableView } from '../engine/view.ts';
import type { Attention } from './attention.ts';
import { celebrations } from './effects/celebrations.ts';
import { handMoves } from './effects/handMoves.ts';
import { handSounds } from './effects/handSounds.ts';
import { honorToasts } from './effects/honorToasts.ts';
import { nightRecap } from './effects/nightRecap.ts';
import { yourTurn } from './effects/yourTurn.ts';
import type { TableMotion } from './motion.ts';
import type { AppPreferences } from './prefs.ts';
import type { Dialog } from './render/dialogs/index.ts';
import type { Sounds } from './sound.ts';
import type { TableChange } from './tableChange.ts';

/** The way to put a dialog in front of the viewer that they did not ask for. */
export interface DialogOffers {
  /**
   * Opens the dialog without taking anything from the viewer: at once when they are doing nothing
   * else, and otherwise once they have closed the dialog they had open, placed the player they were
   * moving, or sent or left what they were typing. `still` is asked at that moment, and a dialog
   * whose time has passed stays shut. One that is open already is left as it is.
   */
  offer(dialog: Dialog, still: (view: TableView) => boolean): void;
}

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
  /** The way to move something across the table, held to the viewer's switch and to a device that asks for less motion. */
  motion: TableMotion;
  dialogs: DialogOffers;
  /** Shows the viewer a line at the top of the screen for a few seconds. */
  toast(message: string): void;
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
  handMoves,
  // After the hand's own moves, so the turn it gives a board's last card takes the place of the drop they give it
  celebrations,
  yourTurn,
  nightRecap,
  honorToasts,
];

/** The effects of one table screen. */
export class TableEffects {
  private readonly context: Omit<EffectContext, 'seat'>;
  private readonly effects = TABLE_EFFECTS.map((make) => make());

  /** `context` is what every effect is handed but where the viewer sits, which each view says. */
  constructor(context: Omit<EffectContext, 'seat'>) {
    this.context = context;
  }

  /** Call once for every view put on screen, with what it brought. */
  run(change: TableChange): void {
    const context: EffectContext = { ...this.context, seat: change.view.you.seat };

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
