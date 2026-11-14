import type { HandEvent } from '../engine/events.ts';
import type { SoundName } from './sound.ts';

/**
 * What one hand event sounds like to the viewer at `viewer`, in a hand dealt on `dealtOn` boards from
 * its first card: the table of which event makes which sound. A new kind of event takes a case here,
 * a sound or silence, and the build fails until it has one.
 */
function soundOf(event: HandEvent, viewer: number | null, dealtOn: number): SoundName | null {
  // A player's own move is silent to them: they made it, and the server's answer comes a moment after the tap
  const byOther = (seat: number) => seat !== viewer;

  switch (event[0]) {
    case 'deal':
      return 'deal';

    case 'fold':
      return byOther(event[1]) ? 'fold' : null;

    case 'check':
      return byOther(event[1]) ? 'knock' : null;

    case 'call':
    case 'bet':
    case 'raise':
      return byOther(event[1]) ? (event[3] === 0 ? 'allIn' : 'chips') : null;

    // Every street sounds the same, and once: boards dealt together, as in a double-board bomb pot, get a street at the
    // same moment, and the first board's event is the one heard, whether or not the others' arrive with it. A board run
    // out after another, as when a hand is run twice, has streets of its own
    case 'street':
      return event[1] === 0 || event[1] >= dealtOn ? 'street' : null;

    case 'win':
      return byOther(event[1]) ? 'win' : 'myWin';

    // The bounty's chips changing hands, after the pot it was won with
    case 'bounty':
      return 'chips';

    // The cards coming out is what announces a new hand, whatever was posted for it (blinds, antes, a bomb pot), and the fold or check made for a player who ran out of time is what is heard of it
    case 'start':
    case 'post':
    case 'timeout':
    case 'return':
    case 'vote':
    case 'runs':
    case 'show':
    case 'muck':
      return null;

    default:
      // An event this page does not know, from a newer server, is silent
      event satisfies never;
      return null;
  }
}

// The most sounds one view of the table plays: a slow answer that catches up on a whole street plays only how it ended
export const MOST_PER_VIEW = 3;

/** A sound a view plays, and which of its events it is heard for, counted from the first. */
export interface Heard {
  sound: SoundName;
  event: number;
}

/**
 * What the hand's new events sound like to the viewer at `seat`, in order, each with the event it is
 * heard for. Each sound plays once, where it last came, and only the last few, so a burst of moves
 * reads as how it ended, not as noise. The viewer's own pot needs no second, smaller one for someone
 * else's beside it. `dealtOn` is how many boards the hand was dealt on from its first card.
 */
export function soundsPlaced(events: readonly HandEvent[], seat: number | null, dealtOn = 1): Heard[] {
  const heard = events.flatMap((event, nth) => {
    const sound = soundOf(event, seat, dealtOn);

    return sound === null ? [] : [{ sound, event: nth }];
  });
  const sounds = heard.map(({ sound }) => sound);
  const once = heard.filter(({ sound }, index) => sounds.lastIndexOf(sound) === index && !(sound === 'win' && sounds.includes('myWin')));

  return once.slice(-MOST_PER_VIEW);
}

/** The sounds of `soundsPlaced` alone, as whatever plays them needs them. */
export function soundsHeard(events: readonly HandEvent[], seat: number | null, dealtOn = 1): SoundName[] {
  return soundsPlaced(events, seat, dealtOn).map(({ sound }) => sound);
}
