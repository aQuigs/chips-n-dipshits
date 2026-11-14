import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { BuildGate, UNSTAMPED_BUILD } from '../server/build.ts';
import { ByteRng } from '../server/byteRng.ts';
import { MemoryStore } from '../server/memoryStore.ts';
import { PokerService } from '../server/service.ts';

const MAX_HOLD_MS = 25_000;
const HOLD_CHECK_MS = 50;
const MAX_BODY_BYTES = 100_000;
const RANDOM_BATCH_BYTES = 256;

export interface DevServerOptions {
  /** 0 picks any free port. */
  port: number;
  /** Produces the game page. Called for every page load, so edits show up on refresh. */
  page: () => Promise<string>;
  /** The game to serve. Left out, it is a fresh one on the real clock; a check passes its own to fix the cards and move time. */
  service?: PokerService;
}

export interface DevServer {
  url: string;
  /**
   * From here on the server is another build of the game, as the deployed one is after a deploy: its
   * answers say so, and the page it serves is that build's. Pages already open are left as they are.
   */
  deploy(build: string): void;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request too large'));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The game on this machine: the same service and page as the deployed one, with tables kept in memory
 * instead of a Sheet. For trying changes and for the browser tests.
 */
export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const game =
    options.service ??
    new PokerService({
      store: new MemoryStore(),
      clock: { now: () => Date.now() },
      rng: new ByteRng(() => [...randomBytes(RANDOM_BATCH_BYTES)]),
    });
  let service = new BuildGate(game, UNSTAMPED_BUILD);
  let closing = false;

  /** Holds a poll open until there is news, like the deployed script does. */
  const holdUntilNews = async (request: unknown): Promise<void> => {
    const wait = service.waitFor(request);
    if (!wait) {
      return;
    }

    const until = Date.now() + Math.min(wait.ms, MAX_HOLD_MS);

    while (!closing && Date.now() < until && !service.hasNews(wait.tableId, wait.since)) {
      await sleep(HOLD_CHECK_MS);
    }
  };

  const respond = (response: ServerResponse, status: number, type: string, body: string): void => {
    response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(body);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      // The page is built unstamped, and says it is whichever build the server is when it is served
      respond(response, 200, 'text/html', (await options.page()).replaceAll(UNSTAMPED_BUILD, () => service.build));
      return;
    }

    if (request.method === 'POST' && path === '/api') {
      const body: unknown = JSON.parse(await readBody(request));

      await holdUntilNews(body);
      respond(response, 200, 'application/json', JSON.stringify(service.handle(body)));
      return;
    }

    respond(response, 404, 'text/plain', 'Not found');
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      console.error(error);

      if (!response.headersSent) {
        respond(response, 500, 'application/json', JSON.stringify({ ok: false, code: 'internal', error: 'Something went wrong on the server, try again' }));
      }
    });
  });

  // This machine only: the tables here are for trying things out, not for the rest of the network
  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    deploy: (build) => {
      service = new BuildGate(game, build);
    },
    close: () => {
      closing = true;
      server.closeAllConnections();

      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
