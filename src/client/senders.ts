import type { FeedEntry } from '../engine/types.ts';
import type { MuteList } from './mutes.ts';
import type { AppPreferences } from './prefs.ts';

/** What a sender sends that this page may hide: their chat lines, the nudges their lines give the viewer, and their reactions and throws. */
export type Sent = 'chat' | 'nudges' | 'reactions';

/**
 * Whose `what` this page shows, by who sent it. The viewer's own always show. Anyone else's show unless
 * the viewer has muted them, and reactions also unless the viewer has switched everyone else's off.
 * Everything filtered by sender goes through here, so a new way to hide one is another clause here.
 */
export function sendersShown(prefs: AppPreferences, mutes: MuteList, viewer: string, what: Sent): (sender: string) => boolean {
  // Read once, since a filter is asked of every line of the chat: whoever wants it as it stands later makes another
  const muted = new Set(mutes.ids());
  const othersShown = what !== 'reactions' || prefs.get('reactions');

  return (sender) => sender === viewer || (!muted.has(sender) && othersShown);
}

/** Whether a chat line shows, by `shown` for chat. The play-by-play shows whoever it is about, and so does a line kept from before lines had a sender. */
export function chatLineShown(entry: FeedEntry, shown: (sender: string) => boolean): boolean {
  return entry.kind !== 'chat' || entry.by === undefined || shown(entry.by);
}
