import { formatAmount } from '../../../engine/amounts.ts';
import type { Denominated } from '../../../engine/amounts.ts';
import { bombPotName } from '../../../engine/bombPots.ts';
import type { HandRecord } from '../../../engine/index.ts';
import { lastOnRecord } from '../../handRecords.ts';
import { noReplayLine } from '../../replayPlayer.ts';
import { h, readableLines } from '../../ui.ts';
import { everyone, frame } from './dialog.ts';
import type { DialogHandlers, DialogKind } from './dialog.ts';

/** What an opening of the dialog keeps for as long as it stays open. */
interface Kept {
  list: HTMLElement;
  /** How many times it has asked for the hands, and the latest of those askings whose answer is in the list. */
  asked: number;
  answered: number;
}

/**
 * Drawn again because a hand went on record, the dialog is the same list with that hand added to it:
 * whoever is reading keeps the hand they have open, and their place.
 */
const KEPT = new WeakMap<object, Kept>();

function handEl(hand: HandRecord, table: Denominated, handlers: DialogHandlers): HTMLElement {
  const bounty = hand.result.bounty;
  const collected = bounty ? bounty.payments.reduce((sum, payment) => sum + payment.amount, 0) : 0;
  const winners = hand.result.winnings.flatMap((win) => {
    const withBounty = win.amount + (bounty?.seat === win.seat ? collected : 0);

    // A hand folded to a big blind that was its only chips was won by nobody
    return withBounty > 0 ? [`${hand.players.find((p) => p.seat === win.seat)?.name ?? '?'} +${formatAmount(withBounty, table)}`] : [];
  });

  const title = `Hand #${hand.number}${hand.bombPot ? ` · ${bombPotName(hand.bombPot)}` : ''}`;
  const outcome = hand.result.chopped ? 'Blinds chopped' : winners.join(', ');

  const noReplay = noReplayLine(hand, table);
  // Each control of a hand carries which hand it is of: drawn again with a hand added, the dialog has the keyboard on the hand it was on
  const marks = { 'data-hand': hand.number };
  const replay = noReplay === null ? h('button.btn.small.replay-open', { type: 'button', 'data-action': 'replay', ...marks, 'aria-label': `Replay this hand, number ${hand.number}`, onclick: () => handlers.replay(hand) }, 'Replay this hand') : h('p.note.no-replay', null, noReplay);

  return h('details', marks, h('summary', marks, title, h('small', null, outcome)), replay, h('pre', null, readableLines(hand.summary, handlers.prefs.get('deck'))));
}

/** Puts `hands` in the list, newest first, keeping the element of every hand already in it and its reader's place. */
function fill(list: HTMLElement, hands: HandRecord[], table: Denominated, handlers: DialogHandlers): void {
  if (hands.length === 0) {
    list.replaceChildren(h('p.note', null, 'No finished hands yet.'));

    return;
  }

  const drawn = new Map([...list.querySelectorAll<HTMLElement>(':scope > details')].map((element) => [element.dataset.hand, element]));
  const newestFirst = [...hands].reverse();
  const scroller = list.closest('.dialog-body');

  const keyboard = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null;

  // Someone with a hand open, scrolled down, or with the keyboard on a hand, is reading: a hand that stays
  // in the list is held where it was, since new hands go in above it and the oldest drops off the end. At
  // the top with none open, the new hand is what they see come in
  const reading = scroller !== null && (scroller.scrollTop > 0 || keyboard !== null || list.querySelector(':scope > details[open]') !== null);
  const held = reading ? newestFirst.map((hand) => drawn.get(String(hand.number))).find((element) => element !== undefined) : undefined;
  const was = held?.getBoundingClientRect().top;

  list.replaceChildren(...newestFirst.map((hand) => drawn.get(String(hand.number)) ?? handEl(hand, table, handlers)));

  // A hand that stays is the element it was, and taking it out to put it back took the keyboard off it. The keyboard
  // on a hand that dropped off the end goes to the dialog, as it does whenever what had it is gone
  if (keyboard) {
    (keyboard.isConnected ? keyboard : list.closest<HTMLElement>('[role$="dialog"]'))?.focus({ preventScroll: true });
  }

  if (scroller && held && was !== undefined) {
    scroller.scrollTop += held.getBoundingClientRect().top - was;
  }
}

function history(table: Denominated, handlers: DialogHandlers, opening: object): HTMLElement {
  const kept = KEPT.get(opening) ?? { list: h('div.history', null, h('p.note', null, 'Loading…')), asked: 0, answered: 0 };
  const asking = (kept.asked += 1);

  KEPT.set(opening, kept);

  handlers.loadHistory().then(
    (hands) => {
      // Answers can come back out of order: one that was asked for before what the list already shows adds nothing
      if (asking > kept.answered) {
        kept.answered = asking;
        fill(kept.list, hands, table, handlers);
      }
    },
    () => {
      // A list that has hands in it stays as it was, and one still waited for by a later asking says nothing yet
      if (kept.answered === 0 && asking === kept.asked) {
        kept.list.replaceChildren(h('p.note', null, 'Could not load the hand history. Close this and try again.'));
      }
    },
  );

  return frame('Hand history', handlers, kept.list);
}

export const historyDialog: DialogKind<'history'> = {
  kind: 'history',
  menu: { label: 'Hand history', who: everyone },
  // Hands are added to the record while the dialog is open, most of all the one whose result its reader came to look at
  shows: (view) => lastOnRecord(view),
  draw: (view, handlers, opening) => history(view.config, handlers, opening as object),
};
