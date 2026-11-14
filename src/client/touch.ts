/**
 * Whether the visitor has touched the page yet: tapped it, clicked it or pressed a key. Browsers hold
 * sound and vibration back until then, and complain about any tried before.
 */
export interface Touch {
  readonly touched: boolean;
  /** Calls `listener` from inside each touch, the only place a browser allows what needs one. */
  onTouch(listener: () => void): void;
}
