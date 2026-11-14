import type { HandEvent } from '../engine/events.ts';
import type { SoundName } from './sound.ts';

type Kind = HandEvent[0];

/** The event of one kind, with its fields typed. */
type EventOf<K extends Kind> = HandEvent extends infer E ? (E extends [infer Of, ...unknown[]] ? (K extends Of ? E : never) : never) : never;

/** What an event of one kind sounds like to the viewer at `seat`: a sound, or silence. */
type Hearing<K extends Kind> = SoundName | null | ((event: EventOf<K>, seat: number | null) => SoundName | null);

/** A player's own move is silent to them: they made it, and the server's answer comes a moment after the tap. */
const othersOnly =
  (sound: SoundName) =>
  ([, seat]: [Kind, number, ...unknown[]], viewer: number | null): SoundName | null =>
    seat === viewer ? null : sound;

const chipsIn = ([, seat, , stackLeft]: [Kind, number, number, number], viewer: number | null): SoundName | null =>
  seat === viewer ? null : stackLeft === 0 ? 'allIn' : 'chips';

/**
 * The sound of each kind of hand event. A new kind of event takes a line here, a sound or `null` for
 * silence, and the build fails until it has one.
 */
const EVENT_SOUNDS: { [K in Kind]: Hearing<K> } = {
  // The cards coming out is what announces a new hand, blinds and all
  start: null,
  post: null,
  deal: 'deal',
  fold: othersOnly('fold'),
  check: othersOnly('knock'),
  call: chipsIn,
  bet: chipsIn,
  raise: chipsIn,
  // The fold or check made for the player is what is heard
  timeout: null,
  return: null,
  // Every street sounds the same, on either board of a hand run twice
  street: 'street',
  vote: null,
  runs: null,
  show: null,
  muck: null,
  win: ([, seat], viewer) => (seat === viewer ? 'myWin' : 'win'),
  // The bounty's chips changing hands, after the pot it was won with
  bounty: 'chips',
};

// The most sounds one view of the table plays: a slow answer that catches up on a whole street plays only how it ended
export const MOST_PER_VIEW = 3;

// A sound that stands for another when both come at once: the viewer's own pot needs no second, smaller one
const COVERS: Partial<Record<SoundName, SoundName>> = { myWin: 'win' };

function soundOf(event: HandEvent, viewer: number | null): SoundName | null {
  // An event this page does not know, from a newer server, is silent
  const hearing = (EVENT_SOUNDS as Partial<Record<string, Hearing<Kind>>>)[event[0]] ?? null;

  return typeof hearing === 'function' ? hearing(event as never, viewer) : hearing;
}

/**
 * What the hand's new events sound like to the viewer at `seat`, in order. Each sound plays once,
 * where it last came, and only the last few, so a burst of moves reads as how it ended, not as noise.
 */
export function soundsHeard(events: readonly HandEvent[], seat: number | null): SoundName[] {
  const heard = events.map((event) => soundOf(event, seat)).filter((sound) => sound !== null);
  const covered = new Set(heard.map((sound) => COVERS[sound]));
  const once = heard.filter((sound, index) => heard.lastIndexOf(sound) === index && !covered.has(sound));

  return once.slice(-MOST_PER_VIEW);
}
