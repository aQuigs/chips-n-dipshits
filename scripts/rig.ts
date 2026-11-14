/*
 * A table set up by hand for a browser check: known players in known seats, cards chosen by the check,
 * and a clock the check can move. Players are driven through the service directly, which takes
 * milliseconds, and a browser is opened only for the screens the check wants to look at.
 */
import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import type { APIResponse, Browser, BrowserContext, BrowserContextOptions, Page, Route } from 'playwright';

import { MOVES } from '../src/client/connection.ts';
import { startDevServer } from '../src/dev/server.ts';
import type { DevServer } from '../src/dev/server.ts';
import type { Command, TableConfig, TableState, TableView } from '../src/engine/index.ts';
import type { ApiRequest, ApiResponse, Auth } from '../src/server/api.ts';
import { MemoryPresetStore } from '../src/server/memoryPresetStore.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import { seededRng, TestTable } from '../tests/helpers.ts';
import type { DealOptions } from '../tests/helpers.ts';
import { assertInvariants } from '../tests/invariants.ts';
import { clientPage } from './bundle.ts';
import { STILL } from './pageSpies.ts';

// Names a font to draw every screen in. CI's browser has other fonts than the machine a check was written on,
// and what fails only there usually fails here in a narrower font ('Times New Roman') or a wider one ('Verdana').
const FONT_OVERRIDE = process.env.RIG_FONT;
const STEP_TIMEOUT_MS = 15_000;

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

export const SCREENS = {
  phone: { width: 375, height: 667 },
  smallPhone: { width: 360, height: 640 },
  tallPhone: { width: 390, height: 844 },
  phoneSideways: { width: 844, height: 390 },
  desktop: { width: 1280, height: 800 },
} as const;

export type ScreenName = keyof typeof SCREENS;

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

      return { save: state, effects: [], result: null };
    });
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
      const name = hand?.stage === 'betting' && hand.toAct !== null ? view.seats[hand.toAct]?.name : voter?.name;
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
  /** What the pages of this rig threw, each with whose page it was. */
  readonly pageErrors: string[] = [];
  private readonly browser: Browser;
  private readonly service: PokerService;
  private readonly server: DevServer;
  /** The game's time, which stands still until the check moves it: running, it would play a hand on under a check that is looking at it. */
  private readonly clock: { ms: number };
  private readonly contexts: BrowserContext[] = [];
  private closing: Promise<void> | null = null;

  private constructor(parts: { store: MemoryStore; presets: MemoryPresetStore; browser: Browser; service: PokerService; server: DevServer; clock: { ms: number } }) {
    this.store = parts.store;
    this.presets = parts.presets;
    this.browser = parts.browser;
    this.service = parts.service;
    this.server = parts.server;
    this.clock = parts.clock;
  }

  /** A rig with nothing on it yet, whose pages open in `browser`. */
  static async start(browser: Browser): Promise<Rig> {
    const store = new MemoryStore();
    const presets = new MemoryPresetStore();
    const clock = { ms: Date.now() };
    const service = new PokerService({ store, presets, clock: { now: () => clock.ms }, rng: seededRng(20261113) });
    const html = await (built ??= clientPage({}));
    const server = await startDevServer({ port: 0, page: async () => html, service });

    return new Rig({ store, presets, browser, service, server, clock });
  }

  get url(): string {
    return this.server.url;
  }

  now(): number {
    return this.clock.ms;
  }

  /** Moves the game's clock forward. Pages follow, since they take the time from the server's answers. */
  advance(ms: number): void {
    this.clock.ms += ms;
  }

  ask(request: unknown): ApiResponse {
    return this.service.handle(request);
  }

  /** Updates the game under the pages that are open, as a deploy does: they are now pages of another build. */
  deploy(build: string): void {
    this.server.deploy(build);
  }

  /** A browser page on a screen of the given size, with nothing in it yet and its table kept still. `who` names it when it throws. */
  async page(screen: ScreenName, who: string, { moving = false }: PageOptions = {}): Promise<Page> {
    const touch = screen !== 'desktop';
    const context = await this.context({ viewport: SCREENS[screen], ...(touch ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();

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

    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    page.on('pageerror', (error) => this.pageErrors.push(`${who}: ${error.message}`));

    return page;
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
    await context.route(FONTS, answerFont);

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

  /** Closes this rig's pages and its server. The browser stays open, for the rig of the next check. */
  close(): Promise<void> {
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

  /** A new rig, which whoever asks closes when done with it. */
  async rig(): Promise<Rig> {
    if (!this.browser?.isConnected()) {
      this.browser = await chromium.launch();
    }

    return Rig.start(this.browser);
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}

/** Which of a page's requests a gate stands in the way of: the moves of a hand, or the polls for news of the table. */
export type Gated = 'moves' | 'polls';

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
    const mine = this.what === 'polls' ? body.op === 'poll' : body.op === 'act' && MOVES.has(body.command.type);

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

export function overlap(a: Box, b: Box): boolean {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

/** The text of every element matching a selector that has less room than its text needs, so not all of it can be read. */
export async function squeezed(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.textContent.trim().slice(0, 40))`,
  ) as Promise<string[]>;
}
