/*
 * A table set up by hand for a browser check: known players in known seats, cards chosen by the check,
 * and a clock the check can move. Players are driven through the service directly, which takes
 * milliseconds, and a browser is opened only for the screens the check wants to look at.
 */
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { chromium } from 'playwright';
import type { APIResponse, Browser, BrowserContext, BrowserContextOptions, Page, Route } from 'playwright';

import { CHOICES, FLEETING, MOVES } from '../src/client/connection.ts';
import { GIF_HOSTS } from '../src/client/gifs.ts';
import { startDevServer } from '../src/dev/server.ts';
import type { Answering, DevServer } from '../src/dev/server.ts';
import { onTheClock } from '../src/engine/index.ts';
import type { Command, Hand, TableConfig, TableState, TableView } from '../src/engine/index.ts';
import type { ApiRequest, ApiResponse, Auth } from '../src/server/api.ts';
import { MemoryErrorLog } from '../src/server/memoryErrorLog.ts';
import { MemoryPlayerStore } from '../src/server/memoryPlayerStore.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryResultStore } from '../src/server/memoryResultStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import { seededRng, TestTable } from '../tests/helpers.ts';
import type { DealOptions } from '../tests/helpers.ts';
import { assertInvariants } from '../tests/invariants.ts';
import { clientPage } from './bundle.ts';
import { PAGE_NOW, RIG_PAGE, soundOf, STILL } from './pageSpies.ts';
import type { PageNow } from './pageSpies.ts';

// Names a font to draw every screen in. CI's browser has other fonts than the machine a check was written on,
// and what fails only there usually fails here in a narrower font ('Times New Roman') or a wider one ('Verdana').
const FONT_OVERRIDE = process.env.RIG_FONT;
const STEP_TIMEOUT_MS = 15_000;

// Enough to ask a page of a check that failed what it shows, and to take its picture
const LAST_LOOK_TIMEOUT_MS = 5000;

/**
 * How long, in milliseconds, the pages of every rig hear nothing after each step that changes the table:
 * RIG_STALL, and 0 when it is not set. Longer than a toast stays up is what finds the most.
 */
export const STALL_MS = stallAsked();

// How long the server of a stalled rig sits on any request before it hears it: longer than a check takes to go from a tap to its next line
const STALLED_ANSWER_MS = 300;

// How many stalls a page hears nothing for while the check is not waiting on it
const UNWATCHED_STALLS = 2;

// How long after anything else a poll is heard, so that what a page asks for itself gets there before the page's news does
const POLL_LAST_MS = 100;

// How often a request that is held back looks whether the check has turned to its page
const LOOK_MS = 50;

// What a stalled rig's pages put on their requests, so its server knows which page is asking
const PAGE_HEADER = 'x-rig-page';

function stallAsked(): number {
  const asked = process.env.RIG_STALL;
  const ms = asked === undefined ? 0 : Number(asked);
  assert.ok(Number.isInteger(ms) && ms >= 0, `RIG_STALL is how long the pages hear nothing after each step, in whole milliseconds, not "${asked}"`);

  return ms;
}

/** The ways a stalled rig's pages are slow, each of which a check has to hold under: see `Stall`. */
export const STALL_WAYS = ['deaf', 'behind'] as const;
export type StallWay = (typeof STALL_WAYS)[number];

/** An answer of the server's that brings a table. */
interface ViewAnswer {
  kind: 'view';
  view: { version: number };
}

const bringsView = (answer: unknown): answer is ViewAnswer => (answer as { kind?: string } | null)?.kind === 'view';

/** A page that is behind, at one table: see `Stall`. */
interface Behind {
  tableId: string;
  /** Its last poll, and the server it was sent to, for asking again in its name. */
  body: unknown;
  server: Answering;
  /** How many polls it has sent, the last of which is the one it listens to, and how many of them the server has not answered. */
  polls: number;
  unanswered: number;
  /** The views it has coming, oldest first, and the version of the newest of them or of the one it has. */
  views: ViewAnswer[];
  newest: number;
}

/**
 * What makes a rig as slow as a machine too busy to keep up, in a run that asks for it with RIG_STALL.
 * A check's steps are done at once, as ever, but its pages hear of none of them until the stall after
 * the last is over, and the server sits on every request a while before it hears it. To a page that is
 * the step itself coming late, since the game's clock stands still meanwhile. A page the check is not
 * waiting on hears later still, as the page a busy machine gets to last.
 *
 * A slow page is slow in one of two ways. `deaf`, it hears nothing and then only how the table stands:
 * it skips every view in between, and what it asks for itself is answered before its news. `behind`,
 * it is given every view the server had for it as the check went, in order and late: it shows the
 * table of a step ago when the check has long moved on. So what loses a race once in a hundred runs on
 * a slow runner loses it here every time.
 */
class Stall {
  private readonly ms: number;
  private readonly way: StallWay;
  private steppedAt = -Infinity;
  private over = false;

  /** For each page, how many things the check has asked of it and not yet got. */
  private readonly asked = new Map<string, { pending: number }>();

  /** Each page that is behind, by the page and the table it asks about. */
  private readonly behind = new Map<string, Behind>();
  private looking = false;

  constructor(ms: number, way: StallWay) {
    this.ms = ms;
    this.way = way;
  }

  /** The check has changed the table or moved its clock. */
  stepped(): void {
    this.steppedAt = performance.now();

    // Once the check next waits for anything, which is the first moment a server could have answered a poll
    if (this.way === 'behind' && !this.looking) {
      this.looking = true;
      setImmediate(() => {
        this.looking = false;

        if (this.over) {
          return;
        }

        // Only for a poll the server has: one a gate stopped on its way, or a page that is gone, was told nothing by a server that kept up either
        for (const page of this.behind.values()) {
          if (page.unanswered === 0) {
            continue;
          }

          try {
            this.keepNews(page);
          } catch {
            // A server a check has broken: the page meets the same failure with its own poll, which is where a check looks for it
          }
        }
      });
    }
  }

  /** The rig is closing: whatever is still held back is let go at once, to a page that is gone. */
  end(): void {
    this.over = true;
  }

  /**
   * Counts whatever the check asks of a page from now on, a wait, a read or a tap, as the check waiting
   * on that page until it has its answer. Only what is asked of the page itself: a wait through a
   * locator is not seen, and its page hears as one not waited on, later and no worse.
   * `id` is what the page's requests carry in `PAGE_HEADER`.
   */
  watch(page: Page, id: string): void {
    const asked = { pending: 0 };
    const methods = Object.getPrototypeOf(page) as Record<string, unknown>;

    this.asked.set(id, asked);

    for (const name of Object.getOwnPropertyNames(methods)) {
      const method = methods[name];

      if (name === 'constructor' || name.startsWith('_') || typeof method !== 'function') {
        continue;
      }

      (page as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        const result: unknown = method.apply(page, args);

        if (result instanceof Promise) {
          const got = () => (asked.pending -= 1);

          asked.pending += 1;
          result.then(got, got);
        }

        return result;
      };
    }
  }

  /**
   * Answers a request that has just reached the server as late as the stall has it. `page` is who asks,
   * when it said, and `server` the server's own way of answering.
   */
  async answer(page: string | undefined, body: unknown, server: Answering): Promise<unknown> {
    const { op, tableId, since } = (body ?? {}) as { op?: string; tableId?: string; since?: number };
    const poll = op === 'poll';

    if (this.way === 'behind' && poll && tableId !== undefined && typeof since === 'number') {
      return this.inTurn(page, body, { tableId, since }, server);
    }

    await server.untilNews(body);
    await sleep(STALLED_ANSWER_MS);

    while (!this.mayHear(page, poll)) {
      await sleep(LOOK_MS);
    }

    return server.handle(body);
  }

  /** Whether a page may be told something now: the stall after the last step is over, twice over for a page the check is not waiting on. */
  private mayHear(page: string | undefined, poll: boolean): boolean {
    const asked = page === undefined ? undefined : this.asked.get(page);
    const waitedOn = !asked || asked.pending > 0;

    return this.over || performance.now() >= this.steppedAt + (waitedOn ? 1 : UNWATCHED_STALLS) * this.ms + (poll ? POLL_LAST_MS : 0);
  }

  /**
   * A poll of a page that is behind. For as long as the server has the poll, it is asked in the page's
   * name after every step of the check, as it would have answered a page that kept up, and each view
   * it gives is kept. When the page may hear, it gets the oldest view it has not had, and the next
   * with its next poll.
   */
  private async inTurn(id: string | undefined, body: unknown, { tableId, since }: { tableId: string; since: number }, server: Answering): Promise<unknown> {
    const key = `${id} ${tableId}`;
    const page = this.behind.get(key) ?? { tableId, body, server, polls: 0, unanswered: 0, views: [], newest: since };
    const mine = (page.polls += 1);

    this.behind.set(key, page);
    page.body = body;
    page.unanswered += 1;

    try {
      // A page asking for the whole table gets it as it stands, and one the answer to a move brought a newer table has no use for an older
      page.views = since < 0 ? [] : page.views.filter((answer) => answer.view.version > since);

      if (page.views.length === 0) {
        page.newest = since;
      }

      let nothing = this.keepNews(page);

      await server.untilNews(body);
      await sleep(STALLED_ANSWER_MS);

      if (page.views.length === 0 && nothing === undefined) {
        // The wait for news ran out with none, and the server says so
        nothing = this.keepNews(page, true);
      }

      while (!this.over) {
        if (this.mayHear(id, true)) {
          // A page listens to the last poll it sent and to no other: an older one is answered, and takes nothing of what the page has coming
          if (mine !== page.polls) {
            return page.views[0] ?? server.handle(body);
          }

          if (page.views.length > 0 || nothing !== undefined) {
            return page.views.shift() ?? nothing;
          }
        }

        await sleep(LOOK_MS);
        nothing = this.keepNews(page) ?? nothing;
      }

      return server.handle(body);
    } finally {
      page.unanswered -= 1;
    }
  }

  /**
   * Asks the server for a page that is behind when it has news for it, or `anyway`, and keeps a view it
   * gives. Gives back what the server says when that is no view: that nothing has changed, or a refusal.
   */
  private keepNews(page: Behind, anyway = false): unknown {
    if (!anyway && !page.server.hasNews(page.tableId, page.newest)) {
      return undefined;
    }

    const answer = page.server.handle({ ...(page.body as object), since: page.newest });

    if (!bringsView(answer)) {
      return answer;
    }

    page.views.push(answer);
    page.newest = answer.view.version;

    return undefined;
  }
}

/** A table's hand in the words a failed check's report has for what a page shows of it. */
function handInWords(hand: Hand | null): string {
  if (!hand) {
    return 'no hand';
  }

  const onClock = onTheClock(hand);

  return [`Hand #${hand.number}`, hand.stage, onClock === null ? 'nobody to act' : `seat ${onClock} to act`, `board ${hand.boards.flat().join(' ') || 'empty'}`].join(', ');
}

/** The moves a page set off, in order: for each version of the table it had been brought, how many of each. */
function movesTold(flights: [version: number, name: string][]): string {
  const told: { version: number; counts: Map<string, number> }[] = [];

  for (const [version, name] of flights) {
    if (told.at(-1)?.version !== version) {
      told.push({ version, counts: new Map() });
    }

    const { counts } = told.at(-1)!;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return told.map(({ version, counts }) => `for version ${version}, ${[...counts].map(([name, count]) => `${count} ${name}`).join(', ')}`).join('; ');
}

// Built once for the whole run, since no check can change the page
let built: Promise<string> | undefined;

// All a page asks of the outside is its fonts, and it does not count as loaded until their stylesheet has
// come. Asked for once in a run and answered from here after: asked by every page, one slow answer from
// Google is a page that never loaded, on a machine with nothing wrong with it
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const fonts = new Map<string, Promise<{ status: number; headers: Record<string, string>; body: Buffer }>>();

async function answerFont(route: Route): Promise<void> {
  const url = route.request().url();
  let answer = fonts.get(url);

  if (!answer) {
    answer = route.fetch().then(async (response) => {
      assert.ok(response.ok(), `${url} answered ${response.status()}`);

      return { status: response.status(), headers: response.headers(), body: await response.body() };
    });
    fonts.set(url, answer);
    // Not kept when it fails, so the next page asks again
    answer.catch(() => fonts.delete(url));
  }

  try {
    await route.fulfill(await answer);
  } catch {
    // The answer never came, or the page has gone: left to the browser, as if nobody had stepped in
    await route.continue().catch(() => undefined);
  }
}

/**
 * The GIF hosts, answered here so no check depends on the network or on what a host serves today. Every
 * picture is a small one, but for one whose file name says `tall` (far taller than it is wide) and one
 * whose name says `missing`, which is not found. Each request is written down with the page it came from
 * and whether it told the host that page, so a check can say when nothing was fetched.
 */
export interface GifRequest {
  url: string;
  referer: string | null;
}

const isGifHost = (url: URL) => url.protocol === 'https:' && GIF_HOSTS.has(url.hostname);

function gifPicture(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#7a3ce0"/><text x="50%" y="50%" fill="#fff" font-size="${Math.min(width, height) / 3}" text-anchor="middle" dominant-baseline="middle">GIF</text></svg>`;
}

async function answerGif(route: Route, asked: GifRequest[]): Promise<void> {
  const request = route.request();
  const name = new URL(request.url()).pathname;

  asked.push({ url: request.url(), referer: (await request.allHeaders()).referer ?? null });

  if (name.includes('missing')) {
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
  } else {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: name.includes('tall') ? gifPicture(40, 2000) : gifPicture(240, 180) });
  }
}

export const SCREENS = {
  phone: { width: 375, height: 667 },
  smallPhone: { width: 360, height: 640 },
  tallPhone: { width: 390, height: 844 },
  phoneSideways: { width: 844, height: 390 },
  desktop: { width: 1280, height: 800 },
} as const;

export type ScreenName = keyof typeof SCREENS;

/** How much wider than tall a table must be to lie down: WIDE_ASPECT in src/client/render/table.ts. */
export const WIDE_ASPECT = 1.15;

export interface RigPlayer {
  name: string;
  stack: number;
  /** Left out, players take seats 0, 1, 2… in the order given. */
  seat?: number;
}

export type RigDeal = DealOptions & { button: number };

export interface PageOptions {
  /** Leaves animations on, as a new player has them. Only for a check that is about motion: it waits for `.stage:not([data-moving])` before it measures anything. */
  moving?: boolean;
}

/** One table on the rig. The first player given is the host. */
export class RigTable {
  readonly id: string;
  private readonly rig: Rig;
  private readonly host: string;
  private readonly auths = new Map<string, Auth>();

  constructor(rig: Rig, id: string, host: string, auth: Auth) {
    this.rig = rig;
    this.id = id;
    this.host = host;
    this.auths.set(host, auth);
  }

  auth(name: string): Auth {
    const auth = this.auths.get(name);
    assert.ok(auth, `${name} is not at the table`);

    return auth;
  }

  /** Joins the table as a new member, who is only watching until they are seated. */
  join(name: string): void {
    const joined = this.rig.ask({ op: 'join', tableId: this.id, name });
    assert.ok(joined.ok && joined.kind === 'joined', JSON.stringify(joined));
    this.auths.set(name, joined.auth);
  }

  /** Seats a member with the host's approval. */
  seat(name: string, seat: number, stack: number): void {
    this.act(name, { type: 'requestSeat', seat, buyIn: stack });
    if (name !== this.host) {
      this.act(this.host, { type: 'approve', playerId: this.auth(name).id });
    }
  }

  /** Does what a player's page would send, and fails the check if the table refuses it or it leaves the table in a state no table may be in. */
  act(name: string, command: Command): TableView {
    const answer = this.tryAct(name, command);
    assert.ok(answer.ok && answer.kind === 'view', `${name} ${JSON.stringify(command)}: ${JSON.stringify(answer)}`);
    assertInvariants(this.rig.store.read(this.id)!, this.rig.now());

    return answer.view;
  }

  tryAct(name: string, command: Command): ApiResponse {
    return this.rig.ask({ op: 'act', tableId: this.id, auth: this.auth(name), command });
  }

  /** The table as a player sees it now. Like any poll, it also lets whatever came due happen. */
  view(name: string): TableView {
    const answer = this.rig.ask({ op: 'poll', tableId: this.id, auth: this.auth(name), since: -1 });
    assert.ok(answer.ok && answer.kind === 'view', JSON.stringify(answer));

    return answer.view;
  }

  /** Changes the saved table directly, for what no player could do: fixing the cards, moving the button. */
  alter(change: (state: TableState) => void): void {
    this.rig.store.transact(this.id, (state) => {
      assert.ok(state, 'the table is gone');
      change(state);
      state.version += 1;

      return { save: state, at: this.rig.now(), effects: [], result: null };
    });
    this.rig.stepped();
  }

  /** Starts the game if need be and deals a hand with the button and the cards fixed: a new game, with the blinds left of that button. */
  deal(deal: RigDeal): TableView {
    return this.dealFixed(deal);
  }

  /** Deals the hand that follows the last one, as the table itself would: the button, the blinds and who is dealt in go by the rule, and only the cards are fixed. */
  dealNext(cards: Omit<DealOptions, 'button'> = {}): TableView {
    return this.dealFixed(cards);
  }

  private dealFixed(deal: DealOptions): TableView {
    if (!this.view(this.host).running) {
      this.act(this.host, { type: 'start' });
    }

    // Dealt here, before the table's clock deals it at random, from a deck stacked beforehand: cards a hand
    // turns up as it starts, such as the flop of a bomb pot, are then the ones asked for
    this.alter((state) => {
      assert.ok(!state.hand, 'a hand is on the table already, with cards nobody chose');

      const dealer = TestTable.adopt(state);
      dealer.now = this.rig.now();
      dealer.deal(deal);
    });

    return this.view(this.host);
  }

  /** Whoever is on the clock does `move` (given their view), until `done` says the table has got where the check wants it. */
  play(move: (view: TableView, name: string) => Command | null, done: (view: TableView) => boolean): TableView {
    for (let step = 0; step < 500; step++) {
      const view = this.view(this.host);
      if (done(view)) {
        return view;
      }

      const hand = view.hand;
      const voter = hand?.stage === 'ritVote' ? view.seats.find((seat) => seat && seat.inHand && !seat.folded && seat.ritVote === null) : null;
      // Named from the table, not from where players were first seated: the host may have moved them since
      const onClock = hand ? onTheClock(hand) : null;
      const name = onClock !== null ? view.seats[onClock]?.name : voter?.name;
      const command = name ? move(this.view(name), name) : null;

      if (name && command) {
        this.act(name, command);
      } else if (hand?.deadline !== null && hand?.deadline !== undefined) {
        this.rig.advance(Math.max(1, hand.deadline - this.rig.now()));
      } else if (view.nextHandAt !== null) {
        this.rig.advance(Math.max(1, view.nextHandAt - this.rig.now()));
      } else {
        throw new Error(`the table is waiting on something this check does not do (stage ${hand?.stage ?? 'no hand'})`);
      }
    }

    throw new Error('the table never got where the check wanted it');
  }

  /**
   * Resolves once a page has taken up the table as it stands now, by the version only the server's answer
   * brings. Taken up is not shown where the page holds something back in its own time, as it does the end
   * of an all-in hand: that has a sign of its own to wait for.
   */
  async heardBy(page: Page): Promise<void> {
    await page.waitForFunction(`window.rig.version >= ${this.version}`);
  }

  /**
   * How many times the table has been saved. Taken before a step, it tells what a page did for that
   * step from what it did for the ones before, however late the page hears of them.
   */
  get version(): number {
    return this.view(this.host).version;
  }

  /** The table in a browser, as one of its members, on a screen of the given size. `init` runs in the page before anything of its own. */
  async open(name: string, screen: ScreenName, init?: string, options?: PageOptions): Promise<Page> {
    const { id, token } = this.auth(name);
    const page = await this.rig.page(screen, name, options);

    if (init) {
      await page.addInitScript(init);
    }

    await page.goto(`${this.rig.url}?table=${this.id}&me=${id}.${token}`);
    await page.click('[data-action="confirm-member"]');
    await page.waitForSelector('.stage .table');
    await page.evaluate('document.fonts.ready.then(() => undefined)');

    return page;
  }
}

/**
 * The local server with a game whose cards and clock belong to the check. Every check gets a rig of its
 * own, so its tables, its presets, its clock and what its pages threw are nobody else's.
 */
export class Rig {
  readonly store: MemoryStore;
  /** The group's presets, empty when the check starts. */
  readonly presets: MemoryPresetStore;
  /** What the server's error log was told. */
  readonly errors: MemoryErrorLog;
  /** The players the game knows, nobody when the check starts. A table made by the rig adds none: only someone who says who they are is known. */
  readonly players: MemoryPlayerStore;
  /** What the game keeps of its players' nights, for a check to put nights on record without playing them. */
  readonly results: MemoryResultStore;
  /** What the pages of this rig threw, each with whose page it was. */
  readonly pageErrors: string[] = [];
  /** Every picture the pages of this rig asked a GIF host for, in order. */
  readonly gifs: GifRequest[] = [];
  private readonly browser: Browser;
  private readonly service: PokerService;
  private readonly server: DevServer;
  /** The game's time, which stands still until the check moves it: running, it would play a hand on under a check that is looking at it. */
  private readonly clock: { ms: number };
  private readonly contexts: BrowserContext[] = [];
  /** Whose page each is, for telling of it. */
  private readonly whose = new Map<Page, string>();
  private readonly stall: Stall | null;
  /** How many pages have been asked for, which names each to a stalled rig's server. */
  private opened = 0;
  private tellingTheTime = false;
  private closing: Promise<void> | null = null;

  /** What a check throws in a page on purpose, which is then no failure of the check. */
  private readonly meant: string[] = [];

  private constructor(parts: { store: MemoryStore; presets: MemoryPresetStore; players: MemoryPlayerStore; results: MemoryResultStore; errors: MemoryErrorLog; browser: Browser; service: PokerService; server: DevServer; clock: { ms: number }; stall: Stall | null }) {
    this.store = parts.store;
    this.presets = parts.presets;
    this.players = parts.players;
    this.results = parts.results;
    this.errors = parts.errors;
    this.browser = parts.browser;
    this.service = parts.service;
    this.server = parts.server;
    this.clock = parts.clock;
    this.stall = parts.stall;
  }

  /** A rig with nothing on it yet, whose pages open in `browser`; given `way`, a stalled one whose pages are slow that way. */
  static async start(browser: Browser, way?: StallWay): Promise<Rig> {
    const clock = { ms: Date.now() };
    const results = new MemoryResultStore(() => clock.ms);
    const store = new MemoryStore(results);
    const presets = new MemoryPresetStore();
    // Ids from a source of their own, so that who is known changes no card the check's seed deals
    const players = new MemoryPlayerStore(seededRng(20261114));
    const errors = new MemoryErrorLog({ now: () => clock.ms });
    const service = new PokerService({ store, presets, players, results, clock: { now: () => clock.ms }, rng: seededRng(20261113), errors });
    const html = await (built ??= clientPage({}));
    const stall = way ? new Stall(STALL_MS, way) : null;
    const server = await startDevServer({
      port: 0,
      page: async () => html,
      service,
      answer: stall ? (body, request, server) => stall.answer(request.headers[PAGE_HEADER] as string | undefined, body, server) : undefined,
    });

    return new Rig({ store, presets, players, results, errors, browser, service, server, clock, stall });
  }

  get url(): string {
    return this.server.url;
  }

  now(): number {
    return this.clock.ms;
  }

  /** Moves the game's clock forward, and with it the clock of every page: the rig's time is the only time its pages have. */
  advance(ms: number): void {
    this.clock.ms += ms;
    this.stepped();
    this.tellTheTime();
  }

  /** Puts the clock of every open page to the rig's, once for all the moves of the clock made in one go. */
  private tellTheTime(): void {
    if (this.tellingTheTime) {
      return;
    }

    this.tellingTheTime = true;
    queueMicrotask(() => {
      this.tellingTheTime = false;

      for (const page of this.pages()) {
        // Through the frame, which a stalled rig does not take for the check waiting on the page. A page
        // that has gone, or is between two documents, gets the time with the server's next answer
        void page.mainFrame().evaluate(`window.rig?.forward(${this.clock.ms})`).catch(() => undefined);
      }
    });
  }

  ask(request: unknown): ApiResponse {
    if (!this.stall) {
      return this.service.handle(request);
    }

    // A request is a step when it changes its table, which a look may too (a poll lets whatever came due happen), or names none
    const { tableId } = request as { tableId?: string };
    const version = () => (tableId ? this.store.peek(tableId)?.version : undefined);
    const before = version();
    const answer = this.service.handle(request);

    if (!tableId || version() !== before) {
      this.stepped();
    }

    return answer;
  }

  /** Told of every step that changes a table or moves the clock, which is what a stalled rig's pages hear of late. */
  stepped(): void {
    this.stall?.stepped();
  }

  /** Updates the game under the pages that are open, as a deploy does: they are now pages of another build. */
  deploy(build: string): void {
    this.server.deploy(build);
  }

  /** A browser page on a screen of the given size, with nothing in it yet and its table kept still. `who` names it when it throws. */
  async page(screen: ScreenName, who: string, { moving = false }: PageOptions = {}): Promise<Page> {
    const touch = screen !== 'desktop';
    const id = String((this.opened += 1));
    const context = await this.context({ viewport: SCREENS[screen], ...(touch ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}), ...(this.stall ? { extraHTTPHeaders: { [PAGE_HEADER]: id } } : {}) });
    const page = await context.newPage();

    this.stall?.watch(page, id);

    if (!moving) {
      await context.addInitScript(STILL);
    }

    if (FONT_OVERRIDE) {
      await context.addInitScript(`document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = '* { font-family: ${FONT_OVERRIDE}, sans-serif !important; }';
        document.head.append(style);
      });`);
    }

    this.whose.set(page, who);
    // In a stalled run a page nobody was waiting on takes that much longer to hear of the last step
    page.setDefaultTimeout(STEP_TIMEOUT_MS + UNWATCHED_STALLS * STALL_MS);
    page.on('pageerror', (error) => {
      if (!this.meant.some((text) => error.message.includes(text))) {
        this.pageErrors.push(`${who}: ${error.message}`);
      }
    });

    return page;
  }

  /** Has a page throw `message` on its own, outside anything the page called, as a bug would; for this check that is no failure. */
  async throwIn(page: Page, message: string): Promise<void> {
    this.meant.push(message);
    // Thrown by a script of its own, which is uncaught at once and needs no timer, so it is the same on a page whose clock is held
    await page.evaluate(`(() => {
      const script = document.createElement('script');
      script.textContent = ${JSON.stringify(`throw new Error(${JSON.stringify(message)})`)};
      document.head.append(script);
      script.remove();
    })()`);
  }

  /** The front page, as someone who has not joined any table. */
  async lobby(screen: ScreenName): Promise<Page> {
    const page = await this.page(screen, 'a visitor');

    await page.goto(this.url);
    await page.waitForSelector('#host-name');
    await page.evaluate('document.fonts.ready.then(() => undefined)');

    return page;
  }

  /** A new table with everyone seated and the game not yet started. The first player is the host. */
  table(players: RigPlayer[], config: Partial<TableConfig> = {}): RigTable {
    const [host, ...others] = players;
    assert.ok(host, 'a table needs a host');

    const created = this.ask({ op: 'create', name: host.name, config: { minBuyIn: 1, maxBuyIn: 1_000_000_000, actionSeconds: 0, ...config } });
    assert.ok(created.ok && created.kind === 'joined', JSON.stringify(created));

    const table = new RigTable(this, created.view.id, host.name, created.auth);
    table.seat(host.name, host.seat ?? 0, host.stack);

    others.forEach((player, index) => {
      table.join(player.name);
      table.seat(player.name, player.seat ?? index + 1, player.stack);
    });

    return table;
  }

  /** A browser context that goes when the rig does. */
  private async context(options: BrowserContextOptions): Promise<BrowserContext> {
    const context = await this.browser.newContext(options);
    this.contexts.push(context);
    await context.addInitScript(RIG_PAGE(this.clock.ms));
    await context.route(FONTS, answerFont);
    await context.route(isGifHost, (route) => answerGif(route, this.gifs));

    // A check stopped for running out of time may still be going, and what it opens now nobody would close
    if (this.closing) {
      await context.close();
      throw new Error('This rig is closed');
    }

    return context;
  }

  pages(): Page[] {
    return this.contexts.flatMap((context) => context.pages());
  }

  /**
   * What every open page shows right now, in words and as a picture saved at `pathStart` and the page's
   * number: for a check that failed or was stopped, whose error names one thing it waited for and
   * nothing of what was there in its place.
   */
  lastLook(pathStart: string): Promise<string[]> {
    const inTime = <T>(asked: Promise<T>): Promise<T | null> => Promise.race([asked, sleep(LAST_LOOK_TIMEOUT_MS, null)]).catch(() => null);

    return Promise.all(
      this.pages().map(async (page, index) => {
        const path = `${pathStart}-${index + 1}.png`;
        const [now, picture] = await Promise.all([inTime(page.evaluate(PAGE_NOW) as Promise<PageNow>), inTime(page.screenshot({ path }))]);
        const lines = [`Page ${index + 1}, ${this.whose.get(page) ?? 'opened by the page before it'}: ${picture ? path : 'no picture could be taken'}`];

        if (!now) {
          return `${lines[0]}\n  it did not say what it shows`;
        }

        const table = now.table === null ? null : this.store.read(now.table);

        lines.push(
          table ? `has taken up version ${now.version} of its table, which is at ${table.version}` : 'is at no table of this rig',
          `its clock is ${now.clock === null ? 'not the rig\'s' : `${this.clock.ms - now.clock} ms behind the rig's`}`,
          `the table: ${now.stage}`,
          ...(table ? [`the table as the rig has it: ${handInWords(table.hand)}`] : []),
          `under the table: ${now.controls}`,
          ...(now.over ? [`over the table: ${now.over}`] : []),
          `the last lines of the play-by-play: ${now.feed.length > 0 ? now.feed.map((line) => JSON.stringify(line)).join(', ') : 'none'}`,
          `toasts told: ${now.toasts.length > 0 ? now.toasts.map((toast) => JSON.stringify(toast)).join(', ') : 'none'}${now.toastUp ? ', the last still up' : ''}`,
          ...(now.sounds ? [`sounds played: ${now.sounds.map(soundOf).join(', ') || 'none'}`] : []),
          ...(now.flights ? [`set moving: ${movesTold(now.flights) || 'nothing'}`] : []),
          ...Object.entries(now.spies).map(([spy, wrote]) => `${spy}: ${wrote}`),
        );

        return lines.join('\n  ');
      }),
    );
  }

  /** Closes this rig's pages and its server. The browser stays open, for the rig of the next check. */
  close(): Promise<void> {
    this.stall?.end();

    // A context that will not close has lost its browser, and went with it
    this.closing ??= Promise.all(this.contexts.map((context) => context.close().catch(() => undefined))).then(() => this.server.close());

    return this.closing;
  }
}

/**
 * The browser of one worker, whose checks use it one after the other, each on a rig of its own. It is
 * launched when first asked for, and again when it has died, so a crash costs the check it happened
 * under and no other worker's.
 */
export class RigBrowser {
  private browser: Browser | null = null;

  /** A new rig, which whoever asks closes when done with it; given `way`, a stalled one whose pages are slow that way. */
  async rig(way?: StallWay): Promise<Rig> {
    if (!this.browser?.isConnected()) {
      this.browser = await chromium.launch();
    }

    return Rig.start(this.browser, way);
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}

/** Which of a page's requests a gate stands in the way of: the moves of a hand, the choices of a move ahead of a turn, the polls for news of the table, reactions, showing cards after a hand, or asking for the list of known players, the standings, or one player's nights. */
export type Gated = 'moves' | 'choices' | 'polls' | 'reactions' | 'shows' | 'players' | 'presets' | 'standings' | 'nights';

/** The requests a gate stops that are not commands, by what they ask for. */
const GATED_OPS: Partial<Record<Gated, ApiRequest['op']>> = { polls: 'poll', players: 'players', presets: 'presets', standings: 'standings', nights: 'nights' };

/** The commands a gate for each other kind of request stops. */
const GATED_COMMANDS: Partial<Record<Gated, ReadonlySet<Command['type']>>> = { moves: MOVES, choices: CHOICES, reactions: FLEETING, shows: new Set(['showCards']) };

/** Where a closed gate stops things: on their way to the server, which then has heard nothing, or on the way back from it. */
export type GateSide = 'requests' | 'answers';

interface Stopped {
  route: Route;
  /** Let through to the server. */
  sent: boolean;
  /** The server's answer, once it is back at the gate. */
  answer: APIResponse | null;
  /** What becomes of an answer still on its way from the server when the check has already said. */
  onArrival: 'hold' | 'pass' | 'drop';
}

/**
 * A gate between one page and the server, for a check that looks at the page while a request is on its
 * way. The server here answers at once, where the deployed one takes a second or two, so without one
 * a check never sees what the page shows in between. A check closes the gate, does what makes the page
 * ask, waits for the gate to be `holding`, looks, and opens it: it never waits a length of time.
 * A gate starts open. Two gates on one page, one for its moves and one for its polls, work apart.
 */
export class Gate {
  private readonly page: Page;
  private readonly what: Gated;
  private side: GateSide | null = null;
  private stopped: Stopped[] = [];
  private waiting: (() => void)[] = [];

  private constructor(page: Page, what: Gated) {
    this.page = page;
    this.what = what;
  }

  static async on(page: Page, what: Gated): Promise<Gate> {
    const gate = new Gate(page, what);

    await page.route('**/api', (route) => gate.meet(route));

    return gate;
  }

  /**
   * From now on, stops what the gate is for. Closed on `requests`, nothing reaches the server. Closed on
   * `answers`, the server hears and acts, and what it says back waits here; requests already stopped go
   * on to it. A page always has a poll out, which a gate closed later never met: closing a gate for polls
   * has the page ask afresh, which is the one poll it then listens to, and waits for that poll to be here.
   */
  async close(side: GateSide): Promise<void> {
    const wasOpen = this.side === null;

    this.side = side;

    if (side === 'answers') {
      this.stopped.filter((stopped) => !stopped.sent).forEach((stopped) => this.send(stopped));
    }

    if (this.what === 'polls' && wasOpen) {
      await this.page.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
      await this.until(() => this.stopped.length > 0);
    }
  }

  /** Resolves once the gate holds something: a request the server has not heard, or an answer the page has not, by the side it is closed on. */
  holding(): Promise<void> {
    return this.until(() => this.stopped.some((stopped) => this.side === 'requests' || stopped.answer !== null));
  }

  /** Lets through everything held, and everything that comes after. */
  async open(): Promise<void> {
    this.side = null;

    await Promise.all(
      this.stopped.splice(0).map((stopped) => {
        stopped.onArrival = 'pass';

        if (!stopped.sent) {
          return stopped.route.continue();
        }

        return stopped.answer ? stopped.route.fulfill({ response: stopped.answer }) : undefined;
      }),
    );
  }

  /**
   * Loses everything held: the page gets no answer to it, as when a phone drops off the network. Whether
   * the server heard depends on the side the gate was closed on. The gate stays closed.
   */
  async lose(): Promise<void> {
    await Promise.all(
      this.stopped.splice(0).map((stopped) => {
        stopped.onArrival = 'drop';

        return stopped.route.abort('failed');
      }),
    );
  }

  /**
   * Answers everything held the way the server does when it could not get to the table in time: a
   * refusal, with nothing played. Only for a gate closed on `requests`, where the server has heard
   * none of it. The gate stays closed.
   */
  async refuse(): Promise<void> {
    assert.equal(this.side, 'requests', 'a request the server has heard is past refusing');

    await Promise.all(
      this.stopped.splice(0).map((stopped) => {
        // Answered as the build that asked, or the page would take the answer for a newer server's
        const { build } = JSON.parse(stopped.route.request().postData() ?? '{}') as { build?: string };

        return stopped.route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'busy', error: 'The table is busy, try again', build }) });
      }),
    );
  }

  private meet(route: Route): Promise<void> | void {
    const body = JSON.parse(route.request().postData() ?? '{}') as ApiRequest;
    const mine = body.op === 'act' ? GATED_COMMANDS[this.what]?.has(body.command.type) : body.op === GATED_OPS[this.what];

    if (this.side === null || !mine) {
      return route.fallback();
    }

    const stopped: Stopped = { route, sent: false, answer: null, onArrival: 'hold' };

    this.stopped.push(stopped);

    if (this.side === 'answers') {
      this.send(stopped);
    }

    this.changed();
  }

  private send(stopped: Stopped): void {
    stopped.sent = true;

    stopped.route.fetch().then(
      (answer) => {
        if (stopped.onArrival === 'pass') {
          return stopped.route.fulfill({ response: answer });
        }

        if (stopped.onArrival === 'hold') {
          stopped.answer = answer;
          this.changed();
        }
      },
      // The page was closed with its request still out
      () => undefined,
    );
  }

  private changed(): void {
    this.waiting.splice(0).forEach((look) => look());
  }

  private async until(reached: () => boolean): Promise<void> {
    while (!reached()) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }
}

/** A box on the screen, in CSS pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where everything matching a selector is drawn, skipping what is not shown. */
export async function boxes(page: Page, selector: string): Promise<Box[]> {
  return page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
      .map((box) => ({ left: box.left, top: box.top, right: box.right, bottom: box.bottom }))`,
  ) as Promise<Box[]>;
}

/** Where the text of everything matching a selector is drawn, which is often less than the box of the element holding it. */
export async function textBoxes(page: Page, selector: string): Promise<Box[]> {
  return page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})]
      .map((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);

        return range.getBoundingClientRect();
      })
      .filter((box) => box.width > 0 && box.height > 0)
      .map((box) => ({ left: box.left, top: box.top, right: box.right, bottom: box.bottom }))`,
  ) as Promise<Box[]>;
}

/**
 * Makes the table's part of the screen this tall. How much of a phone the table gets depends on how the buttons
 * under it wrap, and so on the fonts of the machine; a check about the table's shape sets the height itself.
 */
export async function setStageHeight(page: Page, height: number): Promise<void> {
  const viewport = page.viewportSize();
  const [stage] = await boxes(page, '.stage');
  assert.ok(viewport && stage, 'no table on the page to resize');

  await page.setViewportSize({ width: viewport.width, height: Math.round(viewport.height + height - (stage.bottom - stage.top)) });

  const [resized] = await boxes(page, '.stage');
  assert.ok(resized && Math.abs(resized.bottom - resized.top - height) <= 1, `the table's part of the screen is ${resized && resized.bottom - resized.top} tall, not ${height}`);
}

/**
 * A field of a form that puts its settings away in sections, with its section unfolded the way whoever
 * means to use the field would unfold it: by a press on the section's heading. Resolves to the selector
 * it was given, so a check goes straight on with the field: `page.fill(await unfolded(page, '#table-ante'), '5')`.
 */
export async function unfolded(page: Page, selector: string): Promise<string> {
  await page.waitForSelector(selector, { state: 'attached' });

  const heading = page.locator(`details.fold-section:not([open]):has(${selector}) > summary`);

  if ((await heading.count()) > 0) {
    await ((await page.evaluate('matchMedia("(pointer: coarse)").matches')) ? heading.tap() : heading.click());
  }

  return selector;
}

export function overlap(a: Box, b: Box): boolean {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

/**
 * What each element matching a selector says in full. On a row of the bar held to one line a label may
 * be said in brief (src/client/rowFit.ts), and how much of it depends on the screen and the font.
 */
export function saidInFull(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((one) => one.querySelector('.fitted')?.dataset.full ?? one.innerText)`) as Promise<string[]>;
}

/** The text of every element matching a selector that has less room than its text needs, so not all of it can be read. */
export async function squeezed(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.textContent.trim().slice(0, 40))`,
  ) as Promise<string[]>;
}
