/*
 * A table set up by hand for a browser check: known players in known seats, cards chosen by the check,
 * and a clock the check can move. Players are driven through the service directly, which takes
 * milliseconds, and a browser is opened only for the screens the check wants to look at.
 */
import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

import { startDevServer } from '../src/dev/server.ts';
import type { DevServer } from '../src/dev/server.ts';
import type { Command, TableConfig, TableState, TableView } from '../src/engine/index.ts';
import type { ApiResponse, Auth } from '../src/server/api.ts';
import { MemoryStore } from '../src/server/memoryStore.ts';
import { PokerService } from '../src/server/service.ts';
import { seededRng, TestTable } from '../tests/helpers.ts';
import type { DealOptions } from '../tests/helpers.ts';
import { assertInvariants } from '../tests/invariants.ts';
import { clientPage } from './bundle.ts';

// Names a font to draw every screen in. CI's browser has other fonts than the machine a check was written on,
// and what fails only there usually fails here in a narrower font ('Times New Roman') or a wider one ('Verdana').
const FONT_OVERRIDE = process.env.RIG_FONT;
const STEP_TIMEOUT_MS = 15_000;

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

  /** Starts the game if need be and deals the next hand with the button and the cards fixed. */
  deal(deal: RigDeal): TableView {
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
  async open(name: string, screen: ScreenName, init?: string): Promise<Page> {
    const { id, token } = this.auth(name);
    const page = await this.rig.page(screen, name);

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

/** The local server with a game whose cards and clock belong to the check. */
export class Rig {
  readonly store: MemoryStore;
  readonly browser: Browser;
  readonly pageErrors: string[] = [];
  private readonly service: PokerService;
  private readonly server: DevServer;
  /** How far the game's clock runs ahead of the real one. */
  private readonly lead: { ms: number };

  private constructor(parts: { store: MemoryStore; browser: Browser; service: PokerService; server: DevServer; lead: { ms: number } }) {
    this.store = parts.store;
    this.browser = parts.browser;
    this.service = parts.service;
    this.server = parts.server;
    this.lead = parts.lead;
  }

  static async start(): Promise<Rig> {
    const store = new MemoryStore();
    const lead = { ms: 0 };
    const service = new PokerService({ store, clock: { now: () => Date.now() + lead.ms }, rng: seededRng(20261113) });
    const html = await clientPage({});
    const server = await startDevServer({ port: 0, page: async () => html, service });

    return new Rig({ store, browser: await chromium.launch(), service, server, lead });
  }

  get url(): string {
    return this.server.url;
  }

  now(): number {
    return Date.now() + this.lead.ms;
  }

  /** Moves the game's clock forward. Pages follow, since they take the time from the server's answers. */
  advance(ms: number): void {
    this.lead.ms += ms;
  }

  ask(request: unknown): ApiResponse {
    return this.service.handle(request);
  }

  /** Updates the game under the pages that are open, as a deploy does: they are now pages of another build. */
  deploy(build: string): void {
    this.server.deploy(build);
  }

  /** A browser page on a screen of the given size, with nothing in it yet. `who` names it when it throws. */
  async page(screen: ScreenName, who: string): Promise<Page> {
    const touch = screen !== 'desktop';
    const context = await this.browser.newContext({ viewport: SCREENS[screen], ...(touch ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();

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

  async close(): Promise<void> {
    await this.browser.close();
    await this.server.close();
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
