import { h } from '../ui.ts';
import type { Child } from '../ui.ts';

/** A part of a form or a dialog under a heading of its own, which folds away under one line saying what it holds. */
export interface FoldSection {
  element: HTMLDetailsElement;
  /** Its heading, which a press folds and unfolds it by. */
  summary: HTMLElement;
  /** Says what it holds now, on the line shown while it is folded. */
  hold(line: string): void;
}

/**
 * `key` marks the section and its heading on the page (`data-section`), so each is found again and no
 * two are taken for one another. Folded, its content keeps its place in a form: a field in it is still
 * sent and still checked, so whoever points a player at one opens the section first.
 */
export function foldSection(key: string, label: string, open: boolean, ...content: Child[]): FoldSection {
  const holds = h('span.holds');
  const summary = h('summary', { 'data-section': key }, h('h3', null, label), h('span.fold', { 'aria-hidden': 'true' }, '▾'), holds);
  const element = h('details.fold-section', { 'data-section': key, open }, summary, h('div.fold-body', null, content));

  // Opened by hand near the foot of what scrolls, a section would unfold out of sight and seem to do nothing
  summary.addEventListener('click', () => requestAnimationFrame(() => element.open && element.scrollIntoView({ block: 'nearest' })));

  return {
    element,
    summary,
    hold: (line) => {
      holds.textContent = line;
    },
  };
}
