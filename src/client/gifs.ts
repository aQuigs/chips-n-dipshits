/*
 * A GIF shown in the chat in place of its link. A chat line is text another player typed, and showing
 * its picture makes every browser at the table fetch it, so the address is taken apart by the browser's
 * own parser and rebuilt from the parts that passed, never matched out of the text: only a secure
 * address, on a host on the list exactly, with nothing in its path that could make it point anywhere else.
 */

/** The hosts that serve GIFs themselves, for the services people paste from: Giphy, Tenor and Imgur. */
export const GIF_HOSTS: ReadonlySet<string> = new Set([
  'media.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'i.giphy.com',
  'media.tenor.com',
  'media1.tenor.com',
  'c.tenor.com',
  'i.imgur.com',
]);

/** Giphy's own pages for a GIF, whose picture is at a known address on its media host. */
const GIPHY_PAGES: ReadonlySet<string> = new Set(['giphy.com', 'www.giphy.com']);

/** Letters, digits and the few marks file names on these hosts use. A % (an encoded character), an @, a : or a \ never passes. */
const PATH = /^(?:\/[A-Za-z0-9_.-]+)+$/;

const GIPHY_ID = /^[A-Za-z0-9]+$/;

/** Anything that could hide a second address in a line or split one: the URL parser drops tabs and newlines silently. */
const SPACE_OR_CONTROL = /[\s\p{C}]/u;

/**
 * The address of the GIF a chat line is, or null when the line is anything else. The whole line has to
 * be the one address. Its query and fragment are dropped, so nothing typed after the file's name rides
 * along to the host. A Giphy page (giphy.com/gifs/some-words-ID) is turned into its picture's address.
 */
export function gifAddress(line: string): string | null {
  const text = line.trim();
  if (text === '' || SPACE_OR_CONTROL.test(text)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  // An explicit :443 reads back as no port at all, which is the same address
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || !PATH.test(url.pathname)) {
    return null;
  }

  if (GIF_HOSTS.has(url.hostname) && url.pathname.toLowerCase().endsWith('.gif')) {
    return `https://${url.hostname}${url.pathname}`;
  }

  if (GIPHY_PAGES.has(url.hostname)) {
    const [, gifs, slug, ...rest] = url.pathname.split('/');
    const id = slug?.split('-').at(-1) ?? '';

    if (gifs === 'gifs' && rest.length === 0 && GIPHY_ID.test(id)) {
      return `https://media.giphy.com/media/${id}/giphy.gif`;
    }
  }

  return null;
}
