import type { TableEffect } from '../effects.ts';
import { nudge } from '../nudges.ts';

/** A chime, a buzz and, from another tab, a notification and the tab's title, when someone names the viewer in the chat. */
export function chatNudges(): TableEffect {
  return { run: (change, context) => nudge(change, context) };
}
