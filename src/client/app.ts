import type { Command, HandRecord, TableConfig } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';
import type { ApiError, ApiResponse, Auth, TableInfo } from '../server/api.ts';
import type { Platform } from './platform.ts';
import { controlsEl, controlsSignature } from './render/controls.ts';
import { dialogEl, isLive } from './render/dialogs.ts';
import type { Dialog, DialogHandlers } from './render/dialogs.ts';
import { createFeed } from './render/feed.ts';
import type { Feed } from './render/feed.ts';
import { joinEl, lobbyEl, noticeEl, welcomeBackEl } from './render/lobby.ts';
import { tableEl } from './render/table.ts';
import type { Shape } from './render/table.ts';
import { playTurnChime } from './sound.ts';
import { DEFAULT_THEME, fontsUrl, themeById } from './themes.ts';
import { chips, h, secondsUntil, Slot } from './ui.ts';

// How long the server may sit on a poll before answering "nothing new"
const HOLD_MS = 20_000;

// A server that can't hold a poll answers at once, so those are spaced out instead
const QUICK_POLL_GAP_MS = 1200;

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 10_000;
const COUNTDOWN_TICK_MS = 250;
const TOAST_MS = 4500;

// Wider than this and the table lies down; narrower and it stands up, as on a phone
const WIDE_ASPECT = 1.15;

const NAME_KEY = 'cnd.name';
const THEME_KEY = 'cnd.theme';
const SOUND_KEY = 'cnd.sound';
const seatKey = (tableId: string) => `cnd.seat.${tableId}`;

const FONTS_LINK_ID = 'theme-fonts';

interface Session {
  tableId: string;
  auth: Auth;
}

/** The parts of the table screen that are built once and then filled in as views arrive. */
interface TableScreen {
  topbar: Slot;
  banners: Slot;
  stage: Slot;
  controls: Slot;
  overlay: HTMLElement;
  feed: Feed;
  shape: Shape;
  seenCards: Set<string>;
  resizeObserver: ResizeObserver;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMember(value: string | null | undefined): Auth | null {
  const [id, token] = (value ?? '').split('.');

  return id && token ? { id, token } : null;
}

/** Runs the whole page: which screen is up, the conversation with the server, and keeping the table drawn. */
export class App {
  private readonly root: HTMLElement;
  private readonly platform: Platform;
  private readonly themeHost: HTMLElement;
  private readonly toastEl = h('div.toast', { role: 'status', hidden: true });

  private session: Session | null = null;
  private view: TableView | null = null;
  private screen: TableScreen | null = null;
  private dialog: Dialog | null = null;

  /** Server time minus this device's time, so countdowns agree with the server's clock. */
  private clockOffset = 0;
  private busy = false;
  private offline = false;

  /** Bumped to retire the running poll loop when the table changes or is left. */
  private pollRun = 0;
  private toastTimer = 0;

  /**
   * `themeHost` is the element whose look the app controls: the whole page by default, or one frame
   * of it when several apps share a page.
   */
  constructor(root: HTMLElement, platform: Platform, themeHost: HTMLElement = document.documentElement) {
    this.root = root;
    this.platform = platform;
    this.themeHost = themeHost;

    root.classList.add('cnd');
  }

  start(): void {
    this.begin();

    const { table, me } = this.platform.boot;
    const tableId = table?.trim().toUpperCase();

    if (!tableId) {
      this.showLobby();
      return;
    }

    const linked = parseMember(me);

    // A link naming a member this browser doesn't know may have been passed on by mistake, so it asks first
    if (linked && linked.token !== this.rememberedSeat(tableId)?.token) {
      void this.confirmMember(tableId, linked);
    } else {
      this.openTable(tableId);
    }
  }

  /** Starts seated at a table as a member who is already known, skipping the lobby. */
  startAt(tableId: string, auth: Auth): void {
    this.begin();
    this.remember(tableId, auth);
    this.enterTable({ tableId, auth }, null);
  }

  private begin(): void {
    this.applyTheme(this.theme());
    setInterval(() => this.tickCountdowns(), COUNTDOWN_TICK_MS);
  }

  /** Switches the look and remembers it for this browser. */
  setTheme(id: string): void {
    this.platform.memory.set(THEME_KEY, themeById(id).id);
    this.applyTheme(id);
  }

  setSound(on: boolean): void {
    this.platform.memory.set(SOUND_KEY, on ? 'on' : 'off');
  }

  // ---- Screens ----

  private showLobby(): void {
    this.leaveTableScreen();
    this.platform.links.showTable(null);

    const draw = (busy: boolean): void => {
      this.mount(
        lobbyEl(this.rememberedName(), busy, {
          create: (name, config) => void this.createTable(name, config, draw),
          openTable: (code) => this.openTable(code.trim().toUpperCase()),
        }),
      );
    };

    draw(false);
  }

  private openTable(tableId: string): void {
    const auth = this.rememberedSeat(tableId);

    if (auth) {
      this.enterTable({ tableId, auth }, null);
    } else {
      void this.showJoin(tableId);
    }
  }

  /** Someone arrived by a link that says who they are: shows whose seat it is and lets them say it isn't theirs. */
  private async confirmMember(tableId: string, auth: Auth): Promise<void> {
    this.leaveTableScreen();
    this.mount(noticeEl('Looking for your seat…'));

    const response = await this.request({ op: 'poll', tableId, auth, since: -1 });
    if (!response?.ok || response.kind !== 'view') {
      // A personal link that no longer works is still a link to the table
      void this.showJoin(tableId);
      return;
    }

    const view = response.view;

    this.mount(
      welcomeBackEl(view.you.name, view.config.name, {
        yes: () => {
          this.remember(tableId, auth);
          this.enterTable({ tableId, auth }, view);
        },
        no: () => void this.showJoin(tableId),
      }),
    );
  }

  private async showJoin(tableId: string): Promise<void> {
    this.leaveTableScreen();
    this.platform.links.showTable(tableId);

    let info: TableInfo | null = null;
    const draw = (busy: boolean): void => {
      this.mount(
        joinEl(tableId, info, this.rememberedName(), busy, {
          join: (name) => void this.joinTable(tableId, name, draw),
          toLobby: () => this.showLobby(),
        }),
      );
    };

    draw(false);

    const response = await this.request({ op: 'info', tableId });
    if (response?.ok && response.kind === 'info') {
      info = response.table;
      draw(false);
    } else {
      this.showLobby();
      this.toast(response && !response.ok && response.code === 'not_found' ? `There is no table with the code ${tableId}.` : 'Could not reach the table. Try the link again.');
    }
  }

  private async createTable(name: string, config: Partial<TableConfig>, draw: (busy: boolean) => void): Promise<void> {
    draw(true);

    const response = await this.request({ op: 'create', name, config });
    if (response?.ok && response.kind === 'joined') {
      this.platform.memory.set(NAME_KEY, response.view.you.name);
      this.remember(response.view.id, response.auth);
      this.enterTable({ tableId: response.view.id, auth: response.auth }, response.view);
      this.openDialog({ kind: 'invite' });
      return;
    }

    draw(false);
    this.toast(response && !response.ok ? response.error : 'Could not create the table. Check your connection and try again.');
  }

  private async joinTable(tableId: string, name: string, draw: (busy: boolean) => void): Promise<void> {
    draw(true);

    const response = await this.request({ op: 'join', tableId, name });
    if (response?.ok && response.kind === 'joined') {
      this.platform.memory.set(NAME_KEY, response.view.you.name);
      this.remember(tableId, response.auth);
      this.enterTable({ tableId, auth: response.auth }, response.view);
      return;
    }

    draw(false);
    this.toast(response && !response.ok ? response.error : 'Could not join the table. Check your connection and try again.');
  }

  private enterTable(session: Session, view: TableView | null): void {
    this.leaveTableScreen();
    this.session = session;
    this.platform.links.showTable(session.tableId, session.auth);

    const feed = createFeed((text) => void this.send({ type: 'chat', text }));
    const stage = new Slot(h('div.stage'));
    const screen: TableScreen = {
      topbar: new Slot(h('header.topbar')),
      banners: new Slot(h('div.banners')),
      stage,
      controls: new Slot(h('div.controls-slot')),
      overlay: h('div.overlay', { hidden: true }),
      feed,
      shape: 'wide',
      seenCards: new Set(),
      resizeObserver: new ResizeObserver(() => this.reshape()),
    };

    screen.overlay.addEventListener('click', (event) => {
      if (event.target === screen.overlay) {
        this.closeDialog();
      }
    });

    this.screen = screen;
    this.mount(h('div.app', null, screen.topbar.element, screen.banners.element, stage.element, screen.controls.element, feed.element, screen.overlay));
    screen.resizeObserver.observe(stage.element);

    if (view) {
      this.applyView(view);
    } else {
      stage.element.appendChild(h('div.loading', null, 'Finding your seat…'));
    }

    this.pollRun += 1;
    void this.poll(this.pollRun);
  }

  private leaveTableScreen(): void {
    this.pollRun += 1;
    this.screen?.resizeObserver.disconnect();
    this.screen = null;
    this.session = null;
    this.view = null;
    this.dialog = null;
    this.offline = false;
  }

  private mount(content: HTMLElement): void {
    this.root.replaceChildren(content, this.toastEl);
  }

  // ---- Talking to the server ----

  /** One request; null when the server could not be reached at all. */
  private async request(request: Parameters<Platform['transport']['send']>[0]): Promise<ApiResponse | null> {
    try {
      return await this.platform.transport.send(request);
    } catch {
      return null;
    }
  }

  private async send(command: Command): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }

    this.setBusy(true);
    const response = await this.request({ op: 'act', tableId: session.tableId, auth: session.auth, command });
    this.setBusy(false);

    if (session !== this.session) {
      return;
    }

    if (!response) {
      this.toast('That did not go through. Check your connection and try again.');
    } else if (!response.ok) {
      this.fail(response);
    } else if (response.kind === 'view') {
      this.applyView(response.view);
    }
  }

  private fail(error: ApiError): void {
    if (error.code === 'unauthorized' || error.code === 'not_found') {
      this.dropSession(error);
    } else {
      this.toast(error.error);
    }
  }

  /** The server no longer knows this browser at the table, so start over from the join screen or the lobby. */
  private dropSession(error: ApiError): void {
    const tableId = this.session?.tableId;

    if (tableId) {
      this.platform.memory.remove(seatKey(tableId));
    }

    if (tableId && error.code === 'unauthorized') {
      void this.showJoin(tableId);
    } else {
      this.showLobby();
    }

    this.toast(error.code === 'not_found' ? 'That table no longer exists.' : 'This browser is not at the table anymore. Join again to keep playing.');
  }

  private async poll(run: number): Promise<void> {
    let retryIn = 0;

    while (run === this.pollRun && this.session) {
      const { tableId, auth } = this.session;
      const asked = Date.now();
      const response = await this.request({ op: 'poll', tableId, auth, since: this.view?.version ?? -1, holdMs: HOLD_MS });

      if (run !== this.pollRun) {
        return;
      }

      if (!response || (!response.ok && response.code !== 'unauthorized' && response.code !== 'not_found')) {
        retryIn = Math.min(MAX_RETRY_MS, retryIn ? retryIn * 2 : FIRST_RETRY_MS);
        this.setOffline(true);
        await sleep(retryIn);
        continue;
      }

      retryIn = 0;
      this.setOffline(false);

      if (!response.ok) {
        this.dropSession(response);
        return;
      }

      if (response.kind === 'view') {
        this.applyView(response.view);
      } else if (response.kind === 'unchanged') {
        this.clockOffset = response.now - Date.now();

        if (Date.now() - asked < QUICK_POLL_GAP_MS) {
          await sleep(QUICK_POLL_GAP_MS);
        }
      }
    }
  }

  private applyView(view: TableView): void {
    const previous = this.view;

    // An action's answer and a poll can cross; the older picture never replaces the newer one
    if (previous && view.version <= previous.version) {
      return;
    }

    this.clockOffset = view.now - Date.now();
    this.view = view;

    const mySeat = view.you.seat;
    const myTurn = mySeat !== null && view.hand?.stage === 'betting' && view.hand.toAct === mySeat;
    const wasMyTurn = previous?.hand?.stage === 'betting' && previous.hand.toAct === previous.you.seat && previous.hand.number === view.hand?.number && previous.hand.street === view.hand?.street;

    if (myTurn && !wasMyTurn && this.soundOn()) {
      playTurnChime();
    }

    this.drawTable();
  }

  // ---- Drawing the table screen ----

  private drawTable(): void {
    const screen = this.screen;
    const view = this.view;
    if (!screen || !view) {
      return;
    }

    this.drawTopbar(screen, view);
    this.drawBanners(screen, view);
    this.drawStage(screen, view);
    this.drawControls(screen, view);
    screen.feed.update(view.feed);

    if (this.dialog && isLive(this.dialog)) {
      this.drawDialog();
    }
  }

  private drawControls(screen: TableScreen, view: TableView): void {
    screen.controls.draw(controlsSignature(view, this.busy), () =>
      controlsEl(view, this.busy, {
        send: (command) => void this.send(command),
        openRebuy: () => this.openDialog({ kind: 'rebuy' }),
      }),
    );
  }

  private drawTopbar(screen: TableScreen, view: TableView): void {
    const waiting = view.you.isHost ? view.requests.length : 0;
    let state = '';

    if (view.hand) {
      state = `Hand #${view.hand.number}`;
    } else if (!view.running) {
      state = view.handCount === 0 ? 'Not started' : 'Paused';
    }

    const stakes = `${chips(view.config.smallBlind)}/${chips(view.config.bigBlind)} hold’em`;

    screen.topbar.draw([waiting, state, view.config.name, stakes], () => [
      h('button.icon.menu-button', { type: 'button', 'aria-label': 'Menu', 'data-action': 'menu', onclick: () => this.openDialog({ kind: 'menu' }) }, '☰', waiting > 0 ? h('span.dot', null, String(waiting)) : null),
      h('div.title', null, h('b', null, view.config.name), h('span', null, stakes)),
      state ? h('span.pill', null, state) : null,
      h('button.btn.small', { type: 'button', 'data-action': 'invite', onclick: () => this.openDialog({ kind: 'invite' }) }, 'Invite'),
    ]);
  }

  private drawBanners(screen: TableScreen, view: TableView): void {
    const requests = view.you.isHost ? view.requests : [];

    screen.banners.draw([this.offline, requests], () => [
      this.offline ? h('div.banner.warn', null, 'Lost the connection to the table. Trying again…') : null,
      requests.map((request) => {
        const what = request.kind === 'seat' ? `wants seat ${request.seat + 1} with ${chips(request.amount)}` : `wants to add ${chips(request.amount)}`;

        return h(
          'div.banner',
          null,
          h('span', null, h('b', null, request.name), ` ${what}`),
          h('button.btn.small.primary', { type: 'button', 'data-action': 'approve', onclick: () => void this.send({ type: 'approve', playerId: request.playerId }) }, 'Approve'),
          h('button.btn.small', { type: 'button', 'data-action': 'deny', onclick: () => void this.send({ type: 'deny', playerId: request.playerId }) }, 'Deny'),
        );
      }),
    ]);
  }

  private drawStage(screen: TableScreen, view: TableView): void {
    const myRequest = view.requests.find((request) => request.playerId === view.you.id);
    const shows = [screen.shape, view.you, view.hostId, view.running, view.nextHandAt, view.config.actionSeconds, view.seats, view.hand, myRequest];

    screen.stage.draw(shows, () => {
      const table = tableEl(view, screen.shape, this.clockOffset, {
        onSit: (seat) => this.openDialog({ kind: 'sit', seat }),
        onStart: () => void this.send({ type: 'start' }),
      });

      // Only cards that were not on the table a moment ago get the dealing animation
      const visible = new Set<string>();
      for (const card of table.querySelectorAll<HTMLElement>('.card[data-card]')) {
        const owner = card.closest<HTMLElement>('[data-seat]')?.dataset.seat ?? `board${card.closest<HTMLElement>('[data-run]')?.dataset.run ?? ''}`;
        const key = `${view.hand?.number}:${owner}:${card.dataset.card}`;

        visible.add(key);
        if (!screen.seenCards.has(key)) {
          card.classList.add('fresh');
        }
      }

      screen.seenCards = visible;

      return table;
    });

    this.tickCountdowns();
  }

  private reshape(): void {
    const screen = this.screen;
    if (!screen) {
      return;
    }

    const { width, height } = screen.stage.element.getBoundingClientRect();
    const shape: Shape = height > 0 && width / height >= WIDE_ASPECT ? 'wide' : 'tall';

    if (shape !== screen.shape) {
      screen.shape = shape;

      if (this.view) {
        this.drawStage(screen, this.view);
      }
    }
  }

  private tickCountdowns(): void {
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-countdown]')) {
      element.textContent = String(secondsUntil(Number(element.dataset.countdown), this.clockOffset));
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;

    if (this.screen && this.view) {
      this.drawControls(this.screen, this.view);
    }
  }

  private setOffline(offline: boolean): void {
    if (offline !== this.offline) {
      this.offline = offline;

      if (this.screen && this.view) {
        this.drawBanners(this.screen, this.view);
      }
    }
  }

  // ---- Dialogs ----

  private openDialog(dialog: Dialog): void {
    this.dialog = dialog;
    this.drawDialog();
  }

  private closeDialog(): void {
    this.dialog = null;
    this.drawDialog();
  }

  private drawDialog(): void {
    const screen = this.screen;
    if (!screen) {
      return;
    }

    if (!this.dialog || !this.view) {
      screen.overlay.hidden = true;
      screen.overlay.replaceChildren();
      return;
    }

    screen.overlay.hidden = false;
    screen.overlay.replaceChildren(dialogEl(this.dialog, this.view, this.dialogHandlers()));
  }

  private dialogHandlers(): DialogHandlers {
    const session = this.session!;

    return {
      send: (command) => void this.send(command),
      open: (dialog) => this.openDialog(dialog),
      close: () => this.closeDialog(),
      copy: (text) => this.copy(text),
      loadHistory: () => this.loadHistory(),
      tableLink: () => this.platform.links.tableLink(session.tableId),
      memberLink: () => this.platform.links.memberLink(session.tableId, session.auth),
      theme: () => this.theme(),
      setTheme: (id) => this.setTheme(id),
      soundOn: () => this.soundOn(),
      setSound: (on) => this.setSound(on),
      toLobby: () => this.showLobby(),
    };
  }

  private async loadHistory(): Promise<HandRecord[]> {
    const session = this.session;
    const response = session ? await this.request({ op: 'history', tableId: session.tableId, auth: session.auth }) : null;

    if (response?.ok && response.kind === 'history') {
      return response.hands;
    }

    throw new Error('The hand history could not be loaded');
  }

  // ---- Small things ----

  private async copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  private toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;

    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), TOAST_MS) as unknown as number;
  }

  private remember(tableId: string, auth: Auth): void {
    this.platform.memory.set(seatKey(tableId), `${auth.id}.${auth.token}`);
  }

  private rememberedSeat(tableId: string): Auth | null {
    return parseMember(this.platform.memory.get(seatKey(tableId)));
  }

  private rememberedName(): string {
    return this.platform.memory.get(NAME_KEY) ?? '';
  }

  private theme(): string {
    return themeById(this.platform.memory.get(THEME_KEY) ?? DEFAULT_THEME).id;
  }

  private soundOn(): boolean {
    return this.platform.memory.get(SOUND_KEY) !== 'off';
  }

  private applyTheme(id: string): void {
    const theme = themeById(id);
    this.themeHost.dataset.theme = theme.id;

    let link = document.getElementById(FONTS_LINK_ID) as HTMLLinkElement | null;
    if (!link) {
      link = h('link', { id: FONTS_LINK_ID, rel: 'stylesheet' });
      document.head.appendChild(link);
    }

    link.href = fontsUrl([theme]);
  }
}
