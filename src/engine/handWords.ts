/*
 * Words the play-by-play has for parts of a hand, which a hand played back from its record says too.
 * Apart from `hand.ts`, so that the page can say them without the rules that deal a hand.
 */
import { prettyCards } from './cards.ts';
import type { Card } from './cards.ts';
import { midSentence } from './handNames.ts';
import type { Street } from './types.ts';

export const STREET_TITLES: Record<Street, string> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };

/** What the play-by-play calls each board of a hand played on several. */
export const BOARD_NAMES = ['First board', 'Second board', 'Third board'];

/** Which pot a share was won from, as it follows the amount: nothing when the hand has only one. */
export function potLabel(index: number, count: number): string {
  if (count === 1) {
    return '';
  }

  return index === 0 ? ' from the main pot' : ` from side pot ${index}`;
}

/** The hunted cards as the play-by-play says them, a board at a time when there are more. */
export function huntedText(hunted: readonly Card[][]): string {
  if (hunted.length === 1) {
    return prettyCards(hunted[0]!);
  }

  return hunted.flatMap((cards, board) => (cards.length === 0 ? [] : [`${midSentence(BOARD_NAMES[board]!)} ${prettyCards(cards)}`])).join(', ');
}
