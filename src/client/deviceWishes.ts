import type { Wishes } from './prefs.ts';

/** The size of text a browser ships with, which every size on the page was drawn against. */
const SHIPPED_PX = 16;

/**
 * The step of the text-size preference for a browser whose own text is set to `browserPx`: the largest
 * step that enlarges no more than the browser asks, and none where it asks for the size it shipped
 * with or less. The figures are the scales of styles/accessibility.css.
 */
export function textSizeFor(browserPx: number): string | null {
  const asked = browserPx / SHIPPED_PX;

  return asked >= 1.3 ? 'largest' : asked >= 1.15 ? 'large' : null;
}

/** What the device asks for where its player has chosen nothing. `pageWishes` reads it off the browser. */
export interface DeviceWishes {
  wished: Wishes;
  /** Calls `listener` when what the device asks for changes while the page is open. */
  onChange(listener: () => void): void;
}
