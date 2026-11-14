import type { ApiRequest, ApiResponse, Built } from '../server/api.ts';

/**
 * How requests reach the game's backend. Each goes out with the page's build on it and comes back with
 * the server's. Kept apart from the browser's own things in platform.ts, so that what talks to the
 * server can be tested without a browser.
 */
export interface Transport {
  send(request: ApiRequest & Built): Promise<ApiResponse & Built>;
}
