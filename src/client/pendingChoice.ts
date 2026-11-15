import { preActionFor } from '../engine/preAction.ts';
import type { TableView } from '../engine/view.ts';
import type { Choice } from './connection.ts';
import { moveMadeFor } from './preActions.ts';
import type { TableChange } from './tableChange.ts';

/** The choice of `what` as a player looking at `view` makes it; null when the view offers them no choice. */
export function choiceOn(view: TableView, what: Choice['what']): Choice | null {
  const hand = view.hand;

  return hand?.ahead ? { type: 'preAct', what, hand: hand.number, street: hand.street, facing: hand.currentBet } : null;
}

/** Whether `view` still shows the spot the choice was made in, where the table would set it: the same hand, street and bet, with the action still to reach the viewer. */
function inSpot(view: TableView, choice: Choice): boolean {
  const hand = view.hand;

  return hand !== null && hand.ahead !== null && hand.number === choice.hand && hand.street === choice.street && hand.currentBet === choice.facing;
}

/**
 * The move the player last chose ahead of their turn, or took back, shown from the tap until the
 * table has accounted for it (`settle`). Until then every view of the spot it was made in is shown
 * with it, so neither a view from before the table heard of it nor the answer to an earlier choice
 * puts the control back. A view of any other spot is shown with nothing chosen, which is what the
 * table comes to there: it sets a choice nowhere but in its spot, and one that arrives late takes off
 * the choice it was to replace.
 */
export class PendingChoice {
  private choice: Choice | null = null;

  begin(choice: Choice): void {
    this.choice = choice;
  }

  /** `view` as it shows while the choice stands; the view itself once it does not. */
  shown(view: TableView): TableView {
    const choice = this.choice;

    if (!choice) {
      return view;
    }

    return { ...view, preAction: choice.what !== null && inSpot(view, choice) ? preActionFor(choice.what, view.hand!.ahead!) : null };
  }

  /**
   * `change` as a page that has been showing the choice sees it, and with which of the viewer's moves
   * the table made for them. A player still waiting for the action taps no move, so with a choice at
   * the table, or one on its way there whose answer the news overtook, a move of theirs is the
   * table's doing. Call for every view from the server, before it is drawn.
   */
  see(change: TableChange): TableChange {
    const madeAhead = (this.choice || change.before?.preAction ? moveMadeFor(change.events, change.view.you.seat) : null) ?? undefined;

    return { ...change, before: change.before && this.shown(change.before), view: this.shown(change.view), madeAhead };
  }

  /** Every choice sent is accounted for, so the table's word is what shows. Says whether one stood. */
  settle(): boolean {
    const stood = this.choice !== null;

    this.choice = null;

    return stood;
  }
}
