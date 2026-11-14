import type { AppPreferences } from './prefs.ts';

/**
 * Whose reactions and throws this page shows, by who sent them. The viewer's own always show; anyone
 * else's show unless the viewer has switched others' off. Whatever else comes to hide a sender, such as
 * muting one player, is another clause here, so everything filtered by sender follows it.
 */
export function sendersShown(prefs: AppPreferences, viewer: string): (sender: string) => boolean {
  return (sender) => sender === viewer || prefs.get('reactions');
}
