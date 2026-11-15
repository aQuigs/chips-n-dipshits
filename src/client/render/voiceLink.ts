import { callHost } from '../callHost.ts';
import { h } from '../ui.ts';

/**
 * The button that opens the table's call. A real link the player taps: the page sits in Google's frame,
 * where a script can't be sure of opening a window, and must never take the frame itself somewhere else.
 */
export function voiceLinkEl(address: string): HTMLElement | null {
  const place = callHost(address);
  if (!place) {
    return null;
  }

  return h(
    'a.btn.small.voice-link',
    { href: address, target: '_blank', rel: 'noopener noreferrer', title: `Join the voice chat at ${place.host}, in a new tab` },
    h('span', null, h('b', null, 'Voice'), ` · ${place.shown}`),
  );
}
