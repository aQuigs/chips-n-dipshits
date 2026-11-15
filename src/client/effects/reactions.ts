import type { TableEffect } from '../effects.ts';
import { reactionsShown, showReactions } from '../reactions.ts';
import { sendersShown } from '../senders.ts';

/** Other players' reactions and throws over their seats as they reach the page, and the viewer's own as they make them. */
export function reactions(): TableEffect {
  return {
    run: (change, context) => {
      context.marks.follow();
      showReactions(reactionsShown(change, sendersShown(context.prefs, context.mutes, change.view.you.id, 'reactions')), context);
    },
  };
}
