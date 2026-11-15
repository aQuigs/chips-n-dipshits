import { h } from './ui.ts';

/**
 * The way to say something to a screen reader. There are three ways a line is said, and which one a
 * line takes is decided by what missing it would cost:
 *
 * - `log` is the running account of the game: every line is said once, in order, when the reader has
 *   finished what it was saying.
 * - `status` is a passing word, such as a toast: said when the reader is free, and dropped for a
 *   later one.
 * - `alert` is said at once, over whatever is being read: the viewer's turn, their clock running
 *   down, something that went wrong.
 */
export interface Announcer {
  log(lines: readonly string[]): void;
  status(message: string): void;
  alert(message: string): void;
}

// The account of the game keeps its last lines for whoever goes looking, and no more than a view brings past that: the chat has all of them
const LOG_LINES = 12;

/**
 * An announcer made of live regions on the page. They are built once and never drawn again, which is
 * what keeps a line from being said twice: a screen reader says what is added to a region, and nothing
 * here is added but through these three calls. Each line goes in as a new element, so the same words
 * said twice running, as two turns in a row are, are still heard twice.
 */
export class PageAnnouncer implements Announcer {
  private readonly logEl: HTMLElement;
  private readonly statusEl = h('p.unseen', { role: 'status' });
  // Apart from the lines said for a screen reader alone, so that one of each in the same moment are both heard whole
  private readonly toastEl = h('p.unseen', { role: 'status' });
  private readonly alertEl = h('p.unseen', { role: 'alert' });
  /**
   * What was put on the page in this turn of it, which a screen reader has not been told yet: a region
   * that took a line, where a second line joins the first instead of taking its place unheard, and
   * each line of the account, which stays until the turn is over.
   */
  private readonly fresh = new Set<HTMLElement>();

  /** `logLabel` names the account of the game for whoever comes across it while reading the page. */
  constructor(logLabel: string) {
    this.logEl = h('div.unseen', { role: 'log', 'aria-label': logLabel });
  }

  /** The regions, to be kept on the page for as long as it is up, outside anything that is drawn again. */
  get elements(): HTMLElement[] {
    return [this.statusEl, this.toastEl, this.alertEl, this.logEl];
  }

  log(lines: readonly string[]): void {
    const added = lines.map((line) => h('div', null, line));

    this.logEl.append(...added);
    this.keepFresh(added);

    // Only lines of earlier turns make way. A line put in and taken out in one turn is never said, and
    // a view that brings a whole hand at once, to a phone that was slow, has more lines than are kept
    while (this.logEl.childElementCount > LOG_LINES && !this.fresh.has(this.logEl.firstElementChild as HTMLElement)) {
      this.logEl.firstElementChild!.remove();
    }
  }

  status(message: string): void {
    this.say(this.statusEl, message);
  }

  alert(message: string): void {
    this.say(this.alertEl, message);
  }

  /** The words of a line shown at the top of the screen for a few seconds, said when the reader is free. */
  toast(message: string): void {
    this.say(this.toastEl, message);
  }

  /** Puts a line in a region that is read whole whenever it changes: in place of what it said before, or beside what it was given a moment ago. */
  private say(region: HTMLElement, message: string): void {
    const line = h('span', null, message);

    if (this.fresh.has(region)) {
      region.append(' ', line);
      return;
    }

    region.replaceChildren(line);
    this.keepFresh([region]);
  }

  private keepFresh(put: HTMLElement[]): void {
    put.forEach((element) => this.fresh.add(element));
    setTimeout(() => put.forEach((element) => this.fresh.delete(element)));
  }

  /** Empties the account of the game, as when the table is left: what is found there is of the table the page is at. */
  forget(): void {
    this.logEl.replaceChildren();
  }
}
