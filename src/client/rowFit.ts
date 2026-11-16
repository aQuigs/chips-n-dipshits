/*
 * A row of the bar under the table that is held to one line. Under a phone's table a second line of
 * switches is taken from the table's height, enough on a small phone to lay the table on its side, so
 * such a row never takes one: it says less instead, by one rule, which is here.
 */
import { h } from './ui.ts';
import type { Words } from './words.ts';

/** The mark of a row held to one line. */
export const FIT_ROW = 'fit-row';

const LABEL = 'fitted';

/** The mark of a control whose words may take a second line inside it; the control stays as tall as it was (controls.css). */
const BREAKS = 'breaks';

/** The mark of a row set in the standard size of text, whatever size the player reads the rest in. */
const STANDARD_SIZE = 'standard-size';

/** Words for a control of a fitted row, said in full until the row is fitted. */
export function fitted({ full, brief }: Words): HTMLElement {
  return h(`span.${LABEL}`, { 'data-full': full, 'data-brief': brief }, full);
}

/**
 * Gives `row` the most it can say on one line, trying in turn: every label in full; a label in brief,
 * one more at a time from the row's start; a second line of words inside each control that takes more
 * than an even share of the row; one inside every control; and those in the standard size of text. A
 * row that is let wrap, as beside a table lying down, has all the room it wants and says everything in full.
 */
function fitRow(row: HTMLElement): void {
  const controls = [...row.children] as HTMLElement[];
  const labels = [...row.querySelectorAll<HTMLElement>(`.${LABEL}`)];
  const breakIn = (some: HTMLElement[]) => some.forEach((control) => control.classList.add(BREAKS));
  // On the one line, and no control squeezed until its words take more lines than it is tall
  const holds = () => row.scrollWidth <= row.clientWidth && controls.every((control) => !control.classList.contains(BREAKS) || control.scrollHeight <= control.clientHeight);

  row.classList.remove(STANDARD_SIZE);
  controls.forEach((control) => control.classList.remove(BREAKS));
  labels.forEach((label) => (label.textContent = label.dataset.full!));

  for (const label of labels) {
    if (holds()) {
      return;
    }

    label.textContent = label.dataset.brief!;
  }

  if (holds()) {
    return;
  }

  // Measured before any of them breaks: each is still as wide as its words on one line make it
  const share = row.clientWidth / controls.length;

  breakIn(controls.filter((control) => control.offsetWidth > share));

  if (holds()) {
    return;
  }

  breakIn(controls);

  if (!holds()) {
    row.classList.add(STANDARD_SIZE);
  }
}

/**
 * Keeps the fitted rows of a part of the page fitted: when the part is drawn, and from then on whenever
 * a row or anything on it changes size, whatever the reason: the screen turned, another size of text,
 * a font that arrived late, a theme with another face.
 */
export class RowFit {
  private readonly within: HTMLElement;
  private readonly byItself: (change: () => void) => void;
  private readonly sizes = new ResizeObserver(() => this.changed());
  private frame: number | null = null;
  private fittedFor = '';

  /** `byItself` runs a fit that no redraw is around, for whoever has to see the page before and after its buttons move: the tap guard. */
  constructor(within: HTMLElement, byItself: (change: () => void) => void) {
    this.within = within;
    this.byItself = byItself;
  }

  /** The part was drawn anew. Its rows are fitted at once, before anything looks at where its controls lie. */
  drawn(): void {
    this.sizes.disconnect();

    for (const row of this.rows()) {
      this.sizes.observe(row);

      for (const control of row.children) {
        this.sizes.observe(control);
      }
    }

    this.fit();
  }

  dispose(): void {
    this.sizes.disconnect();
    cancelAnimationFrame(this.frame ?? 0);
  }

  private rows(): HTMLElement[] {
    return [...this.within.querySelectorAll<HTMLElement>(`.${FIT_ROW}`)];
  }

  private fit(): void {
    this.rows().forEach(fitRow);
    this.fittedFor = this.sizesNow();
  }

  private changed(): void {
    // Fitting changes sizes too, and so does being watched for the first time: only a size the rows were not fitted for is news
    if (this.sizesNow() === this.fittedFor) {
      return;
    }

    // In the next frame: a row changed inside the observer's own callback is a loop to the browser, which reports it as an error of the page
    this.frame ??= requestAnimationFrame(() => {
      this.frame = null;
      this.byItself(() => this.fit());
    });
  }

  private sizesNow(): string {
    return this.rows()
      .map((row) => [row.clientWidth, ...[...row.children].map((control) => (control as HTMLElement).offsetWidth)].join(' '))
      .join('|');
  }
}
