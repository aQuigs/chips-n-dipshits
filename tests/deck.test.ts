import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PREFERENCES, Preferences } from '../src/client/prefs.ts';
import type { Pref, PrefHost } from '../src/client/prefs.ts';
import { THEMES } from '../src/client/themes.ts';
import { splitWrittenCards } from '../src/engine/cards.ts';
import { contrast, distance, VISIONS } from './colorVision.ts';

const SUITS = ['s', 'h', 'd', 'c'] as const;

// Small enough for a card's rank on a phone, so held to the contrast normal text needs
const MIN_CONTRAST = 4.5;
// Suits closer than this are easy to mistake at a glance
const MIN_DISTANCE = 20;

type Rules = Map<string, Map<string, string>>;

/** The stylesheet's rules by selector, each the properties it sets. Enough for the flat files in src/client/styles. */
function rules(file: string): Rules {
  const css = readFileSync(new URL(`../src/client/styles/${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Rules = new Map();

  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const properties = new Map<string, string>();

    for (const declaration of body!.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) {
        properties.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim().replace(/\s+/g, ' '));
      }
    }

    found.set(selector!.trim().replace(/\s+/g, ' '), properties);
  }

  return found;
}

const TOKENS = rules('tokens.css');
const DECK = rules('deck.css');

/** A theme's tokens: the first block's, which every theme starts from, then its own. */
function themeTokens(id: string): Map<string, string> {
  return new Map([...TOKENS.get(':root, [data-theme]')!, ...(TOKENS.get(`[data-theme='${id}']`) ?? [])]);
}

/** What the app's own element ends up with for a choice, in a theme, with every var() looked up. */
function shown(attribute: string, option: string, theme: string): (property: string) => string {
  const scope = new Map([...themeTokens(theme), ...DECK.get(`[${attribute}]`)!, ...(DECK.get(`[${attribute}='${option}']`) ?? [])]);
  const resolve = (value: string): string => value.replace(/var\((--[\w-]+)\)/g, (_all, name: string) => resolve(scope.get(name) ?? assert.fail(`${name} is not set`)));

  return (property) => resolve(scope.get(property)!);
}

function fakeHost(): PrefHost {
  return { dataset: {}, style: { setProperty: () => undefined } };
}

const memory = () => {
  const kept = new Map<string, string>();

  return { get: (key: string) => kept.get(key) ?? null, set: (key: string, value: string) => void kept.set(key, value) };
};

test('the deck and the back are shown on the app for the stylesheet, and start as the theme draws them', () => {
  const host = fakeHost();
  const prefs = new Preferences(PREFERENCES, memory(), host);

  assert.equal(host.dataset.deck, 'theme');
  assert.equal(host.dataset.cardBack, 'theme');

  prefs.set('deck', 'four');
  prefs.set('cardBack', 'dots');
  assert.equal(host.dataset.deck, 'four');
  assert.equal(host.dataset.cardBack, 'dots');
});

test('with nothing chosen, every theme draws its cards in its own colors and on its own back', () => {
  for (const theme of THEMES) {
    const tokens = themeTokens(theme.id);
    const deck = shown('data-deck', 'theme', theme.id);

    for (const suit of SUITS) {
      assert.equal(deck(`--deck-${suit}`), tokens.get(`--suit-${suit}`), `${theme.name}: ${suit}`);
    }

    assert.equal(shown('data-card-back', 'theme', theme.id)('--back'), tokens.get('--card-back'), theme.name);
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
    const card = themeTokens(theme.id).get('--card')!;
    const deck = shown('data-deck', 'four', theme.id);
    const colors = SUITS.map((suit) => deck(`--deck-${suit}`));

    assert.deepEqual(
      SUITS.map((suit) => deck(`--deck-${suit}`)),
      SUITS.map((suit) => themeTokens(theme.id).get(`--suit-four-${suit}`)),
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
    assert.match(cards.get(`.card.suit-${suit}`)!.get('color')!, new RegExp(`var\\(--deck-${suit}\\b`));
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
  assert.deepEqual(splitWrittenCards('XA♠ and ♠'), [{ text: 'XA♠ and ♠', suit: null }], 'a suit inside a word or on its own is not a card');
  assert.deepEqual(splitWrittenCards(''), []);
});
