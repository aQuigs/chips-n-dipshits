/** Enough of a host to know whose site it is; a longer one keeps its end, which is the part that says. */
const SHOWN_HOST_LENGTH = 24;

/** Where a call's address leads, as the browser reads it, and that host `shown` short enough for the button. */
export function callHost(address: string): { host: string; shown: string } | null {
  let host: string;
  try {
    host = new URL(address).hostname;
  } catch {
    return null;
  }

  const bare = host.replace(/^www\./, '');
  const shown = bare.length > SHOWN_HOST_LENGTH ? `…${bare.slice(1 - SHOWN_HOST_LENGTH)}` : bare;

  return { host, shown };
}
