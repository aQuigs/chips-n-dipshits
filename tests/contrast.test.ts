import assert from 'node:assert/strict';
import test from 'node:test';

import { textSizeFor } from '../src/client/deviceWishes.ts';
import { PREFERENCES } from '../src/client/prefs.ts';
import { HIGH_CONTRAST_THEME, THEMES } from '../src/client/themes.ts';
import { contrast } from './colorVision.ts';
import { rules, themeTokens } from './styleRules.ts';

// WCAG's figures: what is written, at AA and at AAA, and an edge or a mark that has to be found
const READABLE = 4.5;
const ENHANCED = 7;
const FINDABLE = 3;

const GROUNDS = ['--bg', '--bg-raised', '--panel', '--panel-raised'];
const FILLS = [
  ['--accent-ink', '--accent'],
  ['--good-ink', '--good'],
  ['--bad-ink', '--bad'],
] as const;
const SUITS = ['--suit-s', '--suit-h', '--suit-d', '--suit-c', '--suit-four-s', '--suit-four-h', '--suit-four-d', '--suit-four-c'];

/** Every color a theme's token comes to, with each var() looked up: one for a flat color, the stops of a gradient. */
function colorsOf(theme: string): (token: string) => string[] {
  const tokens = themeTokens(theme);
  const resolve = (value: string): string => value.replace(/var\((--[\w-]+)\)/g, (_all, name: string) => resolve(tokens.get(name) ?? assert.fail(`${name} is not set`)));

  return (token) => resolve(tokens.get(token) ?? assert.fail(`${token} is not set`)).match(/#[0-9a-f]{6}/gi) ?? assert.fail(`${token} names no color`);
}

/** The least contrast of an ink with a ground, over every color either comes to. */
function least(colors: (token: string) => string[], ink: string, ground: string): number {
  return Math.min(...colors(ink).flatMap((a) => colors(ground).map((b) => contrast(a, b))));
}

function holds(theme: string, pairs: readonly (readonly [string, string])[], atLeast: number): void {
  const colors = colorsOf(theme);

  for (const [ink, ground] of pairs) {
    const found = least(colors, ink, ground);

    assert.ok(found >= atLeast, `${theme}: ${ink} on ${ground} is ${found.toFixed(2)} to 1, under ${atLeast}`);
  }
}

const on = (inks: string[], grounds: string[]) => inks.flatMap((ink) => grounds.map((ground) => [ink, ground] as const));

test('in every theme the text reads on every ground, the words on a filled button read, and the ring around what has the keyboard can be found', () => {
  for (const theme of THEMES) {
    holds(theme.id, on(['--text'], GROUNDS), ENHANCED);
    holds(theme.id, [...on(['--muted'], GROUNDS), ...FILLS], READABLE);
    // The ring is the accent everywhere but on the felt, where it is the felt's ink
    holds(theme.id, [...on(['--focus'], GROUNDS), ['--felt-ink', '--felt']], FINDABLE);
  }
});

test('the high-contrast theme holds everything written to 7 to 1, on the page, on the felt and on a card', () => {
  const inks = ['--text', '--muted', '--accent', '--good', '--bad', '--win'];

  holds(HIGH_CONTRAST_THEME, [...on(inks, [...GROUNDS, '--felt']), ...on(['--felt-ink', '--felt-muted', '--felt-win'], ['--felt']), ...FILLS, ...on(SUITS, ['--card'])], ENHANCED);
});

test('the high-contrast theme holds every edge and mark to 3 to 1: lines, the rail, a card and its back on the felt, a chip', () => {
  holds(HIGH_CONTRAST_THEME, [...on(['--line'], [...GROUNDS, '--felt']), ...on(['--rail', '--card', '--card-edge', '--card-back', '--chip'], ['--felt', '--bg'])], FINDABLE);
});

test('each step of text size enlarges prose more than the last and the table’s figures less than prose, and a browser set to larger text gets the step that does not outdo it', () => {
  const sheet = rules('accessibility.css');
  const scales = PREFERENCES.textSize.options.map(({ value }) => {
    const step = new Map([...sheet.get('[data-text-size]')!, ...(sheet.get(`[data-text-size='${value}']`) ?? [])]);

    return { value, prose: Number(step.get('--text-scale')), table: Number(step.get('--table-text-scale')) };
  });

  assert.deepEqual(scales[0], { value: PREFERENCES.textSize.default, prose: 1, table: 1 }, 'with nothing chosen every size is as it was drawn');

  for (const [index, step] of scales.entries()) {
    if (index > 0) {
      assert.ok(step.prose > scales[index - 1]!.prose && step.table > scales[index - 1]!.table, `${step.value} is no larger than the step before it`);
      assert.ok(step.table < step.prose, `${step.value}: the table grows as much as prose`);
      assert.equal(textSizeFor(16 * step.prose), step.value);
      assert.equal(textSizeFor(16 * step.prose - 0.1), index > 1 ? scales[index - 1]!.value : null);
    }
  }

  // Chrome's own settings: medium as shipped, then large and very large
  assert.deepEqual([12, 16, 20, 24].map(textSizeFor), [null, null, 'large', 'largest']);
});
