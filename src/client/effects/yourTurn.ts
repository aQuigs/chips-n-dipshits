import type { TableEffect } from '../effects.ts';
import { YourTurn } from '../yourTurn.ts';

/** A chime, a buzz, a flash and, from another tab, a notification and the tab's title, when the action reaches the viewer. */
export function yourTurn(): TableEffect {
  let turns: YourTurn | null = null;

  return {
    run(change, { attention }) {
      turns ??= new YourTurn(attention);
      turns.see(change);
    },
    dispose: () => turns?.end(),
  };
}
