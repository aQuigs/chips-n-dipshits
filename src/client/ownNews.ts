/*
 * What the page tells a player of something that happened to them alone, which everyone else reads
 * in the play-by-play if at all: in the bar under the table for as long as it stands, and once in a
 * toast (`effects/ownNews.ts`). One wording for both places.
 */
import { actorName } from '../engine/hosts.ts';
import { turnedDownWords } from '../engine/seats.ts';
import type { RequestKind } from '../engine/types.ts';
import type { SeatView, TableView } from '../engine/view.ts';
import { nightOver } from './render/night.ts';
import type { TableChange } from './tableChange.ts';

// How many hands dealt since a request was turned down the bar goes on saying so: the rest of the one
// on the table and the whole of the next, so the line is never gone seconds after it came
const HANDS_SAID = 2;

/**
 * To a player the clock ran out on, for as long as they are away: nothing else marks a seat `away`,
 * and it is taken off when they are back. Until then a hand they still hold is played for them.
 */
export function timedOutText(view: TableView, seat: SeatView): string {
  if (seat.inHand && seat.folded) {
    return 'You ran out of time. Your hand was folded and you are sitting out.';
  }

  if (seat.inHand && view.hand?.stage !== 'done') {
    return 'You ran out of time. Your hand is checked or folded until you are back.';
  }

  return 'You ran out of time. You are sitting out.';
}

/** To a player whose request was turned down. It names nobody: a co-host may have been the one. */
export const turnedDownText = (kind: RequestKind): string => `Your request for ${kind === 'seat' ? 'a seat' : 'chips'} was turned down`;

const requestOf = (view: TableView) => view.requests.find((request) => request.playerId === view.you.id);

const rebuysOf = (view: TableView): number => view.tonight.players.find((row) => row.playerId === view.you.id)?.rebuys ?? 0;

const chipsComing = (view: TableView): number => (view.you.seat === null ? 0 : (view.seats[view.you.seat]?.pendingAdd ?? 0));

/**
 * A request granted leaves a mark on the view, where one turned down leaves none: the seat they are
 * in, chips waiting for the hand to end, or one more rebuy in the night's numbers.
 */
const granted = (before: TableView, view: TableView, kind: RequestKind): boolean =>
  kind === 'seat' ? view.you.seat !== null : chipsComing(view) > chipsComing(before) || rebuysOf(view) > rebuysOf(before);

/**
 * The kind of request of the viewer's that `view` shows turned down since `before`: theirs was waiting
 * and is gone, and the play-by-play has a new line that says who turned it down. Nothing else that
 * takes a request away says that: one granted, taken back, or dropped because its seat was taken.
 * A view can be more than one step on from the last, as on a phone that slept: a request turned
 * down, asked again elsewhere and granted since is not told as turned down.
 */
export function turnedDown(before: TableView, view: TableView): RequestKind | null {
  const asked = requestOf(before);

  if (!asked || requestOf(view) || granted(before, view, asked.kind)) {
    return null;
  }

  const known = new Map(before.feed.map((entry) => [entry.seq, entry.at]));
  const words = turnedDownWords(view.you.name, asked.kind);
  // The whole line, as each of those who may turn a request down would have it written: a name can end in the words of another player's line
  const lines = new Set(view.members.filter((member) => member.id === view.hostId || view.cohostIds.includes(member.id)).map((member) => `${actorName(view, member)}${words}`));
  const said = view.feed.some((entry) => entry.kind === 'system' && known.get(entry.seq) !== entry.at && lines.has(entry.text));

  return said ? asked.kind : null;
}

/**
 * Follows the viewer's requests through the views of one table screen, and remembers one turned down
 * for as long as the bar says so: until they ask again, until it is beside the point, or until a
 * couple of hands have been dealt. A page opened after it was turned down never knew of it.
 */
export class RequestNews {
  private last: { kind: RequestKind; handCount: number } | null = null;

  /** What the bar has to say of a request turned down, or null. */
  get turnedDown(): RequestKind | null {
    return this.last?.kind ?? null;
  }

  /** Takes a change on its way to the screen, and marks the one that shows a request of the viewer's turned down. */
  see(change: TableChange): TableChange {
    const { before, view } = change;
    const kind = before && !change.wentBack ? turnedDown(before, view) : null;

    if (kind) {
      this.last = { kind, handCount: view.handCount };
    } else if (this.last && this.over(this.last, view)) {
      this.last = null;
    }

    return kind ? { ...change, turnedDown: kind } : change;
  }

  private over(last: { kind: RequestKind; handCount: number }, view: TableView): boolean {
    const dealt = view.handCount - last.handCount;
    // A seat is beside the point to someone seated, and chips to someone who is not
    const moot = (last.kind === 'seat') === (view.you.seat !== null);

    return requestOf(view) !== undefined || moot || nightOver(view) || dealt < 0 || dealt >= HANDS_SAID;
  }
}
