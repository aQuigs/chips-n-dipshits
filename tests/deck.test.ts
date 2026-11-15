import assert from 'node:assert/strict';
import test from 'node:test';

import { PREFERENCES } from '../src/client/prefs.ts';
import type { Pref } from '../src/client/prefs.ts';
import { THEMES } from '../src/client/themes.ts';
import { splitWrittenCards } from '../src/engine/cards.ts';
import { contrast, distance, VISIONS } from './colorVision.ts';
import { rules, themeTokens } from './styleRules.ts';

const SUITS = ['s', 'h', 'd', 'c'] as const;

// Small enough for a card's rank on a phone, so held to the contrast normal text needs
const MIN_CONTRAST = 4.5;
// Suits closer than this are easy to mistake at a glance
const MIN_DISTANCE = 20;

const DECK = rules('deck.css');

/** What the app's own element ends up with for a choice, in a theme, with every var() looked up. */
function shown(attribute: string, option: string, theme: string): (property: string) => string {
  const scope = new Map([...themeTokens(theme), ...DECK.get(`[${attribute}]`)!, ...(DECK.get(`[${attribute}='${option}']`) ?? [])]);
  const resolve = (value: string): string => value.replace(/var\((--[\w-]+)\)/g, (_all, name: string) => resolve(scope.get(name) ?? assert.fail(`${name} is not set`)));

  return (property) => resolve(scope.get(property)!);
}

test('with nothing chosen, every theme draws its cards in its own colors and on its own back', () => {
  for (const theme of THEMES) {
    const tokens = themeTokens(theme.id);
    const deck = shown('data-deck', PREFERENCES.deck.default, theme.id);

    for (const suit of SUITS) {
      assert.equal(deck(`--deck-${suit}`), tokens.get(`--suit-${suit}`), `${theme.name}: ${suit}`);
    }

    assert.equal(shown('data-card-back', PREFERENCES.cardBack.default, theme.id)('--back'), tokens.get('--card-back'), theme.name);
  }
});

test('two colors pairs clubs with spades and diamonds with hearts, in every theme', () => {
  for (const theme of THEMES) {
    const deck = shown('data-deck', 'two', theme.id);

    assert.equal(deck('--deck-c'), deck('--deck-s'), theme.name);
    assert.equal(deck('--deck-d'), deck('--deck-h'), theme.name);
  }
});

test('four colors reads on every theme’s cards, and the suits stay apart with each common kind of color blindness', () => {
  for (const theme of THEMES) {
    const tokens = themeTokens(theme.id);
    const card = tokens.get('--card')!;
    const deck = shown('data-deck', 'four', theme.id);
    const colors = SUITS.map((suit) => deck(`--deck-${suit}`));

    assert.deepEqual(
      colors,
      SUITS.map((suit) => tokens.get(`--suit-four-${suit}`)),
      `${theme.name} does not draw the four-color deck from its tokens`,
    );

    colors.forEach((color, index) => {
      assert.ok(contrast(color, card) >= MIN_CONTRAST, `${theme.name}: ${SUITS[index]} ${color} on ${card} is only ${contrast(color, card).toFixed(2)}:1`);
    });

    for (const [vision, matrix] of Object.entries(VISIONS)) {
      for (let a = 0; a < SUITS.length; a++) {
        for (let b = a + 1; b < SUITS.length; b++) {
          const apart = distance(colors[a]!, colors[b]!, matrix);
          assert.ok(apart >= MIN_DISTANCE, `${theme.name}, ${vision}: ${SUITS[a]} and ${SUITS[b]} are only ${apart.toFixed(1)} apart`);
        }
      }
    }
  }
});

test('every back has a look of its own, and the cards are drawn from the choice', () => {
  const backs = PREFERENCES.cardBack.options.map((option) => shown('data-card-back', option.value, 'cardroom')('--back'));
  assert.equal(new Set(backs).size, backs.length, 'two backs look the same');

  const cards = rules('cards.css');
  assert.match(cards.get('.card.back')!.get('background')!, /var\(--back\b/);
  for (const suit of SUITS) {
    assert.match(cards.get(`:is(.card, .card-text).suit-${suit}`)!.get('color')!, new RegExp(`var\\(--deck-${suit}\\b`));
  }
});

test('a choice drawn as samples is shown on the page, where the stylesheet can draw each sample', () => {
  for (const [key, pref] of Object.entries(PREFERENCES) as [string, Pref][]) {
    if (pref.kind === 'choice' && pref.preview) {
      assert.equal(pref.css, 'attribute', `${key} has samples the stylesheet cannot tell apart`);
    }
  }
});

test('cards the dealer writes are picked out of the text with their suits, and nothing else is', () => {
  assert.deepEqual(splitWrittenCards('Flop: 10♣ 9♦ J♥'), [
    { text: 'Flop: ', suit: null },
    { text: '10♣', suit: 'c' },
    { text: ' ', suit: null },
    { text: '9♦', suit: 'd' },
    { text: ' ', suit: null },
    { text: 'J♥', suit: 'h' },
  ]);
  assert.deepEqual(splitWrittenCards('Quigs shows A♠ K♠ (Flush)'), [
    { text: 'Quigs shows ', suit: null },
    { text: 'A♠', suit: 's' },
    { text: ' ', suit: null },
    { text: 'K♠', suit: 's' },
    { text: ' (Flush)', suit: null },
  ]);
  assert.deepEqual(splitWrittenCards('Seat 10 wins 2,000'), [{ text: 'Seat 10 wins 2,000', suit: null }]);
  assert.deepEqual(splitWrittenCards('XA♠ and K♦ing and ♠'), [{ text: 'XA♠ and K♦ing and ♠', suit: null }], 'a suit inside a word or on its own is not a card');
  assert.deepEqual(splitWrittenCards(''), []);
});
