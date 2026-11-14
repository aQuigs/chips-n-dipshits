import type { HandEvent } from '../engine/events.ts';
import type { SoundName } from './sound.ts';

/**
 * What one hand event sounds like to the viewer at `viewer`: the table of which event makes which
 * sound. A new kind of event takes a case here, a sound or silence, and the build fails until it has one.
 */
function soundOf(event: HandEvent, viewer: number | null): SoundName | null {
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

    // Every street sounds the same, on either board of a hand run twice
    case 'street':
      return 'street';

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
const MOST_PER_VIEW = 3;

/**
 * What the hand's new events sound like to the viewer at `seat`, in order. Each sound plays once,
 * where it last came, and only the last few, so a burst of moves reads as how it ended, not as noise.
 * The viewer's own pot needs no second, smaller one for someone else's beside it.
 */
export function soundsHeard(events: readonly HandEvent[], seat: number | null): SoundName[] {
  const heard = events.map((event) => soundOf(event, seat)).filter((sound) => sound !== null);
  const once = heard.filter((sound, index) => heard.lastIndexOf(sound) === index && !(sound === 'win' && heard.includes('myWin')));

  return once.slice(-MOST_PER_VIEW);
}
