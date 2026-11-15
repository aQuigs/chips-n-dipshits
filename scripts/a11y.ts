/*
 * What the browser checks use to tell how the page stands with someone who cannot see it or cannot
 * use a pointer: a spy on everything the page says to a screen reader, and a rule engine run over a
 * screen as it stands.
 *
 * Neither is a screen reader. They show that the page says the right things once, names what it
 * shows and breaks no rule a machine can check; what VoiceOver or TalkBack make of it only someone
 * using them can say.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import type { Page } from 'playwright';

/** A line the page said: how, and its words. */
export interface Said {
  /**
   * `log`, `status` and `alert` are the three ways the page speaks (`Announcer`): each is a line added
   * to a region that was already there, which is what a screen reader says. `drawn` is a region that
   * came onto the page with words already in it, which some screen readers say and some do not: the
   * page must not depend on it, and a redraw must never cause it.
   */
  how: 'log' | 'status' | 'alert' | 'drawn';
  text: string;
}

/**
 * Run in the page before anything of its own: writes down every line put into a live region, in
 * order, as `window.spoken`. A region that is not rendered says nothing, and neither does one put
 * out of reach behind a dialog.
 */
export const SPOKEN = `(() => {
  window.spoken = [];

  const LIVE = '[role="log"], [role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]';
  const howOf = (region) => (region.getAttribute('role') === 'alert' || region.getAttribute('aria-live') === 'assertive' ? 'alert' : region.getAttribute('role') === 'log' ? 'log' : 'status');
  const silent = (region) => region.getClientRects().length === 0 || region.closest('[inert], [aria-hidden="true"]') !== null;
  const say = (how, text) => text.trim() && window.spoken.push({ how, text: text.trim().replace(/\\s+/g, ' ') });

  const added = (node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const region = element?.closest(LIVE);

    if (region && region !== node) {
      if (!silent(region)) {
        say(howOf(region), node.textContent ?? '');
      }

      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    for (const drawn of [...(node.matches(LIVE) ? [node] : []), ...node.querySelectorAll(LIVE)]) {
      if (!silent(drawn)) {
        say('drawn', drawn.textContent ?? '');
      }
    }
  };

  new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === 'characterData') {
        added(change.target);
      }

      change.addedNodes.forEach(added);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
})()`;

/**
 * How much a page has said so far: the place to read on from. Taken before the step whose words a check
 * is about, so that what is counted is tied to the step and never to what happened to be left in a list.
 */
export const marked = (page: Page) => page.evaluate('window.spoken.length') as Promise<number>;

/** Everything a page has said since `mark`, oldest first, as "how: words". The record is kept whole. */
export async function spoken(page: Page, mark = 0): Promise<string[]> {
  const said = (await page.evaluate(`window.spoken.slice(${mark})`)) as Said[];

  return said.map(({ how, text }) => `${how}: ${text}`);
}

/** Resolves once a page has said this line, in the way given, since `mark`. */
export const heard = (page: Page, line: string, mark = 0) =>
  page.waitForFunction(`window.spoken.slice(${mark}).some((said) => said.how + ': ' + said.text === ${JSON.stringify(line)})`);

/** A rule the engine holds against a part of the page that is left standing, and why. */
export interface Exception {
  /** The engine's name for the rule. */
  rule: string;
  /** Part of what the engine says of the finding, or of where it found it: what tells this one from any other of the rule. */
  says: string;
  why: string;
}

/**
 * Every finding of the rule engine that the checks let stand. Each is a decision, with its reason: a
 * new finding fails the check until it is fixed or written down here.
 */
export const EXCEPTIONS: readonly Exception[] = [
  {
    rule: 'color-contrast',
    says: 'foreground color: #d9675c, background color: #1a2a23',
    why: 'Card Room writes a loss and a fold in its red on a panel at 4.31 to 1, short of 4.5. The themes there were keep their look; the high-contrast theme is for whoever needs more, and the sign before the amount says the same as the color.',
  },
  {
    rule: 'color-contrast-enhanced',
    says: 'at button[data-theme="',
    why: 'In the theme picker each button is a sample of its theme, drawn in that theme’s colors whichever is in use, so the small print on another theme’s button is at that theme’s contrast, not the 7 to 1 of the high-contrast one. Its name is in the theme’s text color, which every theme holds to 7 to 1.',
  },
  {
    rule: 'region',
    says: 'at .above',
    why: 'The layer over the table holds the reactions panel and, for a few seconds each, the reactions over the seats. It is empty the rest of the time, and a part of the page that is nearly always empty is no help as a landmark. The panel takes the keyboard when it opens and gives it back, and each reaction is said as it comes.',
  },
];

interface Finding {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[]; failureSummary?: string }[];
}

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
let engine: Promise<string> | undefined;

/** What the rule engine is asked to hold a screen to, beyond what it always does. */
export interface Held {
  /** Text against its ground at 7 to 1, which the high-contrast theme promises; left out, 4.5 to 1. */
  enhancedContrast?: boolean;
  /** Rules left out for this screen altogether, each for a reason said where it is left out. */
  without?: string[];
}

/**
 * Runs the rule engine over the page as it stands and returns what it found, less the exceptions, as
 * lines fit to print. The engine is put into the page by the check: it is no part of what is served.
 */
export async function findings(page: Page, held: Held = {}): Promise<string[]> {
  await page.evaluate(await (engine ??= readFile(AXE, 'utf8')));

  const rules = Object.fromEntries([...(held.enhancedContrast ? [['color-contrast-enhanced', { enabled: true }]] : []), ...(held.without ?? []).map((rule) => [rule, { enabled: false }])]);
  const found = (await page.evaluate(`axe.run(document, { resultTypes: ['violations'], rules: ${JSON.stringify(rules)} }).then((results) => results.violations)`)) as Finding[];

  return found.flatMap((finding) =>
    finding.nodes
      .map((node) => `${finding.id} (${finding.impact}) at ${node.target.join(' ')}: ${(node.failureSummary ?? finding.help).replace(/\s+/g, ' ')}`)
      .filter((line) => !EXCEPTIONS.some((exception) => exception.rule === finding.id && line.includes(exception.says))),
  );
}

/** The names and roles a screen reader is given for a part of the page, as Playwright reads the accessibility tree. */
export const tree = (page: Page, selector: string) => page.locator(selector).ariaSnapshot();

/** The parts of the page that are drawn anew whenever what they show has changed, each a `Slot`. */
const REDRAWN = ['.topbar', '.banners', '.stage', '.controls-slot', '.overlay', '.react-picker', '.who-list', '.replay-stage'];

// Run in the page on a control: what tells it from the others of its part, reckoned as `controlKey` in src/client/ui.ts does
const MARKS = `((control) => control.id ? '#' + control.id : [control.tagName, ...[...control.attributes].filter(({ name }) => name.startsWith('data-') || name === 'name' || name === 'value').map(({ name, value }) => name + '=' + value).sort()].join(' '))`;
// Run in the page on a control: what it is called
const SAYS = `((control) => (control.getAttribute('aria-label') ?? control.textContent).trim().replace(/\\s+/g, ' '))`;
const CONTROLS = 'button, input, select, textarea, summary, a[href]';

/** A control as a redraw knows it: what tells it apart in its part of the page, and what it says. */
export interface Control {
  marks: string;
  says: string;
}

/**
 * The controls of a part of the page. A redraw puts the keyboard back on the control that had it, found
 * by its marks: a control that keeps its marks from one drawing to the next is the same control to the
 * keyboard, whatever it has come to say.
 */
export const controls = (page: Page, part: string) =>
  page.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${part} :is(${CONTROLS})`)})].map((control) => ({ marks: ${MARKS}(control), says: ${SAYS}(control) }))`) as Promise<Control[]>;

/**
 * The controls in the redrawn parts of a page that nothing tells apart but their place among their
 * like. Of two alike the keyboard can be put back on the other, which in a list of players is the same
 * button on someone else's row.
 */
export async function alike(page: Page): Promise<string[]> {
  const found: string[] = [];

  for (const part of REDRAWN) {
    const seen = new Map<string, string[]>();

    for (const { marks, says } of await controls(page, part)) {
      seen.set(marks, [...(seen.get(marks) ?? []), says]);
    }

    for (const [marks, names] of seen) {
      if (names.length > 1) {
        found.push(`${names.length} controls of ${part} are told apart only by their place (${marks}): ${names.join(' | ')}`);
      }
    }
  }

  return found;
}

/** Whether the keyboard is on, or inside, what `selector` matches. */
export const focusIn = (page: Page, selector: string) => page.evaluate(`document.activeElement?.closest(${JSON.stringify(selector)}) !== null`) as Promise<boolean>;

/** What has the keyboard, by what tells it apart on the page. */
export const focused = (page: Page) =>
  page.evaluate(`(() => {
    const element = document.activeElement;

    if (!element || element === document.body) {
      return 'nothing';
    }

    return element.id ? '#' + element.id : element.dataset.action ?? element.getAttribute('aria-label') ?? element.className ?? element.tagName;
  })()`) as Promise<string>;
