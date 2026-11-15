import type { TableEffect } from '../effects.ts';
import { reactionsShown } from '../reactions.ts';
import { gifOf } from '../render/chatLine.ts';
import { chatLineShown, sendersShown } from '../senders.ts';
import { dealtSaid, lineSaid, requestsSaid, resultSaid, turnSaid, voteSaid } from '../spoken.ts';
import type { TableChange } from '../tableChange.ts';
import { NewTurns, turnOf } from '../yourTurn.ts';
import type { Card } from '../../engine/cards.ts';

/** The viewer's own cards when this view is the one that deals them: face up to them, and not theirs in the view before. */
function dealt({ before, view, current }: TableChange): Card[] | null {
  const mine = (of: TableChange['before']) => (of?.hand && of.you.seat !== null ? (of.seats[of.you.seat]?.cards ?? null) : null);
  const cards = mine(view);

  if (!current || !before || !cards || cards.includes(null)) {
    return null;
  }

  return mine(before) === null || before.hand?.number !== view.hand?.number ? (cards as Card[]) : null;
}

/**
 * The game as a screen reader hears it. The play-by-play and the chat are said line by line as they
 * come, with the viewer's own cards when they are dealt and their stack when the hand is over: all in
 * order, when the reader is free. Their turn is said at once, over whatever is being read, with what
 * they face: missing it costs the hand.
 *
 * Everything said here is news (`TableChange`), so a view that changes nothing says nothing.
 */
export function spokenPlay(): TableEffect {
  const turns = new NewTurns();

  return {
    run(change, { say, prefs, mutes }) {
      const { before, view } = change;
      const me = view.you.id;
      const chat = sendersShown(prefs, mutes, me, 'chat');
      const lines = change.feed.filter((entry) => chatLineShown(entry, chat)).map((entry) => lineSaid(entry, entry.kind === 'chat' && gifOf(entry, prefs.get('gifs')) !== null));
      const cards = dealt(change);

      if (cards) {
        lines.push(dealtSaid(cards));
      }

      // Said as the feed would say them, by whoever this page shows them from: switched off or muted, they are not said either
      lines.push(...reactionsShown(change, sendersShown(prefs, mutes, me, 'reactions')).map((reaction) => `${reaction.label}.`));

      lines.push(...resultSaid(change));

      if (before) {
        lines.push(...requestsSaid(before, view));
      }

      if (lines.length > 0) {
        say.log(lines);
      }

      // A page that opens on the viewer's own turn says so too: nothing else would, and the clock is running
      const told = turns.take(change) !== null || (before === null && turnOf(view, view.you.seat) !== null);
      const turn = told ? turnSaid(view) : null;
      const vote = view.hand && !before?.hand?.canVote ? voteSaid(view.hand) : null;

      for (const line of [turn, vote]) {
        if (line) {
          say.alert(line);
        }
      }
    },
  };
}
