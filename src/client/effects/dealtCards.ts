import type { TableEffect } from '../effects.ts';

/** Keeps the viewer's own cards of every hand they are shown, in their browser, for when the hand is played back. */
export function dealtCards(): TableEffect {
  return {
    run: ({ view }, { dealt }) => dealt.see(view),
  };
}
