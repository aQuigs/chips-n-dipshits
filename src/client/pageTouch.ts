import type { Touch } from './touch.ts';

/** One set of listeners for the whole page, shared by everything that waits for a touch. */
class PageTouch implements Touch {
  touched = false;
  private readonly listeners: (() => void)[] = [];

  constructor(page: Document) {
    // A touch only counts as the visitor's own gesture once the finger lifts, which is the click. Each is
    // heard on its way down, before what it lands on can spend the gesture the browser allows sound for
    for (const gesture of ['pointerdown', 'click', 'keydown']) {
      page.addEventListener(gesture, () => this.heard(), { capture: true });
    }
  }

  onTouch(listener: () => void): void {
    this.listeners.push(listener);
  }

  private heard(): void {
    // A finger going down is not yet a gesture the browser accepts, and what needs one draws a warning then
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      return;
    }

    this.touched = true;

    for (const listener of this.listeners) {
      listener();
    }
  }
}

let shared: Touch | null = null;

export function pageTouch(): Touch {
  shared ??= new PageTouch(document);

  return shared;
}
