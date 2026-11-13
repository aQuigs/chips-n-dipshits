/**
 * What a dialog owes the keyboard: focus goes into it when it opens, the page behind it can't be
 * reached while it is up, and focus goes back to where it was when it closes.
 */
export class Modal {
  private readonly overlay: HTMLElement;
  private opener: Element | null = null;
  private showing = false;

  /** `overlay` holds the dialog and is a sibling of everything the dialog covers. */
  constructor(overlay: HTMLElement) {
    this.overlay = overlay;
  }

  /** Call whenever a dialog has been drawn, redrawn or taken away. */
  update(showing: boolean): void {
    // Called on every poll, and with no dialog before or now there is nothing to undo
    if (!showing && !this.showing) {
      return;
    }

    if (showing && !this.showing) {
      this.opener = document.activeElement;
    }

    for (const sibling of this.overlay.parentElement?.children ?? []) {
      if (sibling !== this.overlay) {
        (sibling as HTMLElement).inert = showing;
      }
    }

    // A redraw takes the focused button with it, and focus left on nothing would start again from the top of the page
    if (showing && !this.overlay.contains(document.activeElement)) {
      this.overlay.querySelector<HTMLElement>('[role="dialog"]')?.focus();
    }

    if (!showing && this.showing) {
      const back = this.opener instanceof HTMLElement && this.opener.isConnected ? this.opener : this.overlay.parentElement?.querySelector<HTMLElement>('[data-action="menu"]');

      back?.focus();
      this.opener = null;
    }

    this.showing = showing;
  }
}
