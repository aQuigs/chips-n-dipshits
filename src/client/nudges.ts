import { nudges } from '../engine/mentions.ts';
import type { Attention } from './attention.ts';
import type { MuteList } from './mutes.ts';
import type { AppPreferences } from './prefs.ts';
import { sendersShown } from './senders.ts';
import type { TableChange } from './tableChange.ts';

/**
 * Whether the lines `change` brings nudge its viewer: a line someone else said, from a sender `shown`
 * lets through, that names them and that the table did not quiet. Only news counts, so never a line
 * from before the page opened, one that reached it late, or one on a view the page made up itself.
 */
export function nudged({ feed, view }: TableChange, shown: (sender: string) => boolean): boolean {
  const you = view.you.id;

  return feed.some((line) => line.by !== undefined && line.by !== you && shown(line.by) && (line.mentions ?? []).some((mention) => mention[0] === you && nudges(mention)));
}

/** Gets the viewer's attention, by the ways they have switched on, when someone they have not muted names them in the chat. */
export function nudge(change: TableChange, { prefs, mutes, attention }: { prefs: AppPreferences; mutes: MuteList; attention: Attention }): void {
  if (nudged(change, sendersShown(prefs, mutes, change.view.you.id, 'nudges'))) {
    attention.call({ why: 'mention', table: { id: change.view.id, name: change.view.config.name } });
  }
}
