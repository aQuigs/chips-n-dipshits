import type { ApiRequest, ApiResponse, Auth, Built } from '../server/api.ts';
import type { Transport } from './transport.ts';

/** What the page is told when it is served: where it lives and which table the link points at. */
export interface Boot {
  /** The page's own address, for building links. Only needed where the page can't read it itself. */
  baseUrl?: string;
  table?: string | null;
  /** A member's id and token joined by a dot, from a personal link. */
  me?: string | null;
  /** Where to send API calls over HTTP. */
  api?: string;
}

/** How the page reads and writes the table in its own address, and builds links to share. */
export interface Links {
  tableLink(tableId: string): string;
  /** A link that carries a member's credentials, to carry on from another device. */
  memberLink(tableId: string, auth: Auth): string;
  /**
   * Points the address bar at a table, or at the lobby. Where the browser can't be relied on to
   * remember who the player is, the member rides along in the address, so a reload still finds their seat.
   */
  showTable(tableId: string | null, auth?: Auth): void;
  /**
   * For loading the page again at the table and seat its address names. Null where the page can simply
   * reload itself. In another site's frame it can't, and the only way out is a link opened at the top
   * of the window: this is where that link goes.
   */
  reloadLink(): string | null;
}

/** Small values remembered in this browser. Never throws: a browser that refuses storage just forgets. */
export interface Memory {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface Platform {
  transport: Transport;
  links: Links;
  memory: Memory;
  boot: Boot;
  /** Which build of the game this page is, as the build wrote it into the page. */
  build: string;
}

interface ScriptRunner {
  withSuccessHandler(handler: (result: string) => void): ScriptRunner;
  withFailureHandler(handler: (error: Error) => void): ScriptRunner;
  api(body: string): void;
}

interface AppsScriptHost {
  script: {
    run: ScriptRunner;
    history: { replace(state: unknown, parameters: Record<string, string>, hash: string): void };
  };
}

declare const google: AppsScriptHost | undefined;

/** Calls the script directly, which is what a page served by Apps Script itself can do. */
class AppsScriptTransport implements Transport {
  private readonly host: AppsScriptHost;

  constructor(host: AppsScriptHost) {
    this.host = host;
  }

  send(request: ApiRequest & Built): Promise<ApiResponse & Built> {
    return new Promise((resolve, reject) => {
      this.host.script.run
        .withSuccessHandler((json) => resolve(JSON.parse(json) as ApiResponse & Built))
        .withFailureHandler(reject)
        .api(JSON.stringify(request));
    });
  }
}

class HttpTransport implements Transport {
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async send(request: ApiRequest & Built): Promise<ApiResponse & Built> {
    // Sent as plain text so the browser makes one request, with no permission check first
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`The server answered ${response.status}`);
    }

    return (await response.json()) as ApiResponse & Built;
  }
}

function linkTo(base: string, parameters: Record<string, string>): string {
  const query = new URLSearchParams(parameters).toString();

  return query ? `${base}?${query}` : base;
}

function memberParameter(auth: Auth): string {
  return `${auth.id}.${auth.token}`;
}

/** What follows the web app's own address: the table, and with it the member. */
function addressOf(table?: string | null, me?: string | null): Record<string, string> {
  return table ? { table, ...(me ? { me } : {}) } : {};
}

/**
 * Inside Apps Script the page sits in a frame from another site. It can't see the real address, so
 * that is handed in and changed through the host; and browsers treat what such a frame stores as
 * disposable (Safari forgets it when it restarts), so the member is kept in the address as well.
 */
function appsScriptLinks(host: AppsScriptHost, boot: Boot): Links {
  const baseUrl = boot.baseUrl ?? '';

  // The frame can't read the address either, so what was served and what has been put there since is kept
  let address = addressOf(boot.table, boot.me);

  return {
    tableLink: (tableId) => linkTo(baseUrl, { table: tableId }),
    memberLink: (tableId, auth) => linkTo(baseUrl, { table: tableId, me: memberParameter(auth) }),
    showTable: (tableId, auth) => {
      address = addressOf(tableId, auth && memberParameter(auth));
      host.script.history.replace(null, address, '');
    },
    reloadLink: () => linkTo(baseUrl, address),
  };
}

/** A page on its own site keeps what it stores, so the member never needs to show in the address. */
function browserLinks(): Links {
  const base = `${location.origin}${location.pathname}`;

  return {
    tableLink: (tableId) => linkTo(base, { table: tableId }),
    memberLink: (tableId, auth) => linkTo(base, { table: tableId, me: memberParameter(auth) }),
    showTable: (tableId) => history.replaceState(null, '', tableId ? linkTo(location.pathname, { table: tableId }) : location.pathname),
    reloadLink: () => null,
  };
}

function browserMemory(): Memory {
  const fallback = new Map<string, string>();

  return {
    get(key) {
      try {
        return localStorage.getItem(key) ?? fallback.get(key) ?? null;
      } catch {
        return fallback.get(key) ?? null;
      }
    },
    set(key, value) {
      fallback.set(key, value);
      try {
        localStorage.setItem(key, value);
      } catch {
        // Kept for this visit only
      }
    },
    remove(key) {
      fallback.delete(key);
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing stored, nothing to remove
      }
    },
  };
}

/** Works out where the page is running and returns the matching way to talk, link and remember. */
export function detectPlatform(boot: Boot, build: string): Platform {
  const memory = browserMemory();

  if (typeof google !== 'undefined' && google?.script?.run) {
    return { transport: new AppsScriptTransport(google), links: appsScriptLinks(google, boot), memory, boot, build };
  }

  const query = new URLSearchParams(location.search);

  return {
    transport: new HttpTransport(boot.api ?? 'api'),
    links: browserLinks(),
    memory,
    boot: { ...boot, table: boot.table ?? query.get('table'), me: boot.me ?? query.get('me') },
    build,
  };
}
