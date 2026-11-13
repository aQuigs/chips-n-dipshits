import type { Command, HandRecord, TableConfig } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';
import type { ApiError, ApiRequest, ApiResponse, Auth } from '../server/api.ts';
import type { Platform } from './platform.ts';
import { controlsEl, controlsSignature, lockTurn } from './render/controls.ts';
import { dialogEl, dialogShows } from './render/dialogs.ts';
import type { Dialog, DialogHandlers } from './render/dialogs.ts';
import { createFeed } from './render/feed.ts';
import type { Feed } from './render/feed.ts';
import { joinScreen, lobbyEl, noticeEl, welcomeBackEl } from './render/lobby.ts';
import { tableEl } from './render/table.ts';
import { createThemePicker } from './render/themePicker.ts';
import type { Shape } from './render/table.ts';
import { allowSound, playTurnChime } from './sound.ts';
import { DEFAULT_THEME, fontsUrl, themeById } from './themes.ts';
import { chips, h, holdWhile, secondsUntil, Slot } from './ui.ts';

// How long the server may sit on a poll before answering "nothing new"
const HOLD_MS = 20_000;

// A server that can't hold a poll answers at once, so those are spaced out instead
const QUICK_POLL_GAP_MS = 1200;

// Longer than any answer takes. Past this a request is taken for lost, as happens when a phone sleeps mid-request
const REQUEST_TIMEOUT_MS = 30_000;

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 10_000;

// How many of the latest answers the server's clock is judged from
const CLOCK_SAMPLES = 8;

// A move in the hand. Only one may be on its way at a time, and it must not be repeated on a guess
const MOVES = new Set<Command['type']>(['fold', 'check', 'call', 'raise', 'ritVote']);

/** Why the table isn't being heard from: no answer at all, or an answer saying the server couldn't cope. */
type Trouble = 'unreachable' | 'struggling';

/**
 * Whether the buttons that play a move can be pressed. `sent` is a move on its way. `unanswered` is a
 * move that got no answer, so nobody knows yet whether it was played; the table has to be heard from first.
 */
type TurnLock = 'open' | 'sent' | 'unanswered';
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
  overlay: Slot;
  feed: Feed;
  shape: Shape;
  seenCards: Set<string>;
  resizeObserver: ResizeObserver;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextRetry(last: number): number {
  return Math.min(MAX_RETRY_MS, last ? last * 2 : FIRST_RETRY_MS);
}

/** The server has said this member or table isn't there, as opposed to not having managed to answer. */
function isRefusal(response: ApiResponse | null): response is ApiError {
  return response !== null && !response.ok && (response.code === 'unauthorized' || response.code === 'not_found');
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
  private dialogOpens = 0;

  /** Server time minus this device's time, so countdowns agree with the server's clock. */
  private clockOffset = 0;
  private clockSamples: number[] = [];
  private turnLock: TurnLock = 'open';
  private trouble: Trouble | null = null;

  /** Bumped to retire the running poll loop when the table changes or is left. */
  private pollRun = 0;
  private toastTimer = 0;

  /**
   * `themeHost` is the element the app sets its theme on: the whole page by default, or one frame
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

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.dialog) {
        this.closeDialog();
      }
    });

    // A phone that was asleep comes back with a request that may never be answered
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.session) {
        this.restartPolling();
      }
    });

    document.addEventListener('pointerdown', allowSound);
    document.addEventListener('keydown', allowSound);
  }

  /** Switches the theme and remembers it for this browser. */
  setTheme(id: string): void {
    this.platform.memory.set(THEME_KEY, themeById(id).id);
    this.applyTheme(id);
  }

  setSound(on: boolean): void {
    this.platform.memory.set(SOUND_KEY, on ? 'on' : 'off');
  }

  // ---- Screens ----

  /**
   * `keepAddress` leaves the address pointing at the table just left. Where the address is what
   * remembers a player's seat, clearing it would be throwing the seat away.
   */
  private showLobby(keepAddress = false): void {
    this.leaveTableScreen();

    if (!keepAddress) {
      this.platform.links.showTable(null);
    }

    this.mount(
      lobbyEl(this.rememberedName(), this.themePicker(), {
        create: (name, config) => this.createTable(name, config),
        openTable: (code) => this.openTable(code.trim().toUpperCase()),
      }),
    );
  }

  /** The compact theme picker for the screens before the table. */
  private themePicker(): HTMLElement {
    return createThemePicker(this.theme(), (id) => this.setTheme(id), true).element;
  }

  private openTable(tableId: string): void {
    const auth = this.rememberedSeat(tableId);

    if (auth) {
      this.enterTable({ tableId, auth }, null);
    } else {
      void this.showJoin(tableId);
    }
  }

  /**
   * Someone arrived by a link that says who they are: shows whose seat it is and lets them say it
   * isn't theirs. The link may be the only place their seat is remembered, so the address is left
   * alone until the server itself has said the link is no good; a request that merely fails is tried again.
   */
  private async confirmMember(tableId: string, auth: Auth): Promise<void> {
    this.leaveTableScreen();
    this.mount(noticeEl('Looking for your seat…'));

    const run = this.pollRun;
    let view: TableView | null = null;

    for (let retryIn = 0; !view; ) {
      const response = await this.request({ op: 'poll', tableId, auth, since: -1 });

      if (run !== this.pollRun) {
        return;
      }

      if (isRefusal(response)) {
        // A personal link that no longer works is still a link to the table
        void this.showJoin(tableId);
        return;
      }

      if (response?.ok && response.kind === 'view') {
        view = response.view;
      } else {
        retryIn = nextRetry(retryIn);
        this.mount(noticeEl('Could not reach the table. Trying again…'));
        await sleep(retryIn);
      }
    }

    const found = view;

    this.mount(
      welcomeBackEl(found.you.name, found.config.name, this.rememberedSeat(tableId) !== null, {
        yes: () => {
          this.remember(tableId, auth);
          this.enterTable({ tableId, auth }, found);
        },
        no: () => this.openTable(tableId),
      }),
    );
  }

  private async showJoin(tableId: string): Promise<void> {
    this.leaveTableScreen();
    this.platform.links.showTable(tableId);

    const screen = joinScreen(tableId, this.rememberedName(), this.themePicker(), {
      join: (name) => this.joinTable(tableId, name),
      toLobby: () => this.showLobby(),
    });

    this.mount(screen.element);

    for (let retryIn = 0; ; ) {
      const response = await this.request({ op: 'info', tableId });

      // The visitor may have gone elsewhere while the answer was on its way
      if (!this.root.contains(screen.element)) {
        return;
      }

      if (response?.ok && response.kind === 'info') {
        screen.showTable(response.table);
        return;
      }

      if (isRefusal(response)) {
        this.showLobby();
        this.toast(`There is no table with the code ${tableId}.`);
        return;
      }

      // The link stays in the address, so a reload is another try
      retryIn = nextRetry(retryIn);
      this.toast('Could not reach the table. Trying again…');
      await sleep(retryIn);
    }
  }

  private async createTable(name: string, config: Partial<TableConfig>): Promise<void> {
    const response = await this.request({ op: 'create', name, config });
    if (response?.ok && response.kind === 'joined') {
      this.platform.memory.set(NAME_KEY, response.view.you.name);
      this.remember(response.view.id, response.auth);
      this.enterTable({ tableId: response.view.id, auth: response.auth }, response.view);
      this.openDialog({ kind: 'invite' });
      return;
    }

    this.toast(response && !response.ok ? response.error : 'Could not create the table. Check your connection and try again.');
  }

  private async joinTable(tableId: string, name: string): Promise<void> {
    const response = await this.request({ op: 'join', tableId, name });
    if (response?.ok && response.kind === 'joined') {
      this.platform.memory.set(NAME_KEY, response.view.you.name);
      this.remember(tableId, response.auth);
      this.enterTable({ tableId, auth: response.auth }, response.view);
      return;
    }

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
      overlay: new Slot(h('div.overlay', { hidden: true })),
      feed,
      shape: 'wide',
      seenCards: new Set(),
      resizeObserver: new ResizeObserver(() => this.reshape()),
    };

    screen.overlay.element.addEventListener('click', (event) => {
      if (event.target === screen.overlay.element) {
        this.closeDialog();
      }
    });

    this.screen = screen;
    this.mount(h('div.app', null, screen.topbar.element, screen.banners.element, stage.element, screen.controls.element, feed.element, screen.overlay.element));
    screen.resizeObserver.observe(stage.element);

    if (view) {
      this.applyView(view);
    } else {
      stage.element.appendChild(h('div.loading', null, 'Finding your seat…'));
    }

    this.restartPolling();
  }

  /**
   * Retires the request that is waiting on the server and asks afresh, so the table is current right
   * away. `whole` asks for the table whether or not it has changed, for when what is on screen is in doubt.
   */
  private restartPolling(whole = false): void {
    this.pollRun += 1;
    void this.poll(this.pollRun, whole);
  }

  private leaveTableScreen(): void {
    this.pollRun += 1;
    this.screen?.resizeObserver.disconnect();
    this.screen = null;
    this.session = null;
    this.view = null;
    this.dialog = null;
    this.trouble = null;
    this.turnLock = 'open';
  }

  private mount(content: HTMLElement): void {
    this.root.replaceChildren(content, this.toastEl);
  }

  // ---- Talking to the server ----

  /** One request; null when the server could not be reached, or took so long that the request must be lost. */
  private async request(request: ApiRequest): Promise<ApiResponse | null> {
    const patience = REQUEST_TIMEOUT_MS + (request.op === 'poll' ? (request.holdMs ?? 0) : 0);
    let timer = 0;
    const lost = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), patience);
    });

    try {
      return await Promise.race([this.platform.transport.send(request), lost]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(command: Command): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }

    const move = MOVES.has(command.type);

    if (move) {
      // A second tap while the first move is on its way would be a second move
      if (this.turnLock !== 'open') {
        return;
      }

      this.setTurnLock('sent');
    }

    const response = await this.request({ op: 'act', tableId: session.tableId, auth: session.auth, command });

    if (session !== this.session) {
      return;
    }

    if (!response) {
      // It may have been played all the same. Rather than invite a second try on a guess, ask the table what happened
      if (move) {
        this.setTurnLock('unanswered');
      }

      this.toast(move ? 'No answer from the table. Checking whether that was played…' : 'No answer from the table. Check your connection.');
      this.restartPolling(true);
      return;
    }

    if (move) {
      this.setTurnLock('open');
    }

    if (!response.ok) {
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

  private async poll(run: number, whole: boolean): Promise<void> {
    let retryIn = 0;
    let passedOver = 0;

    while (run === this.pollRun && this.session) {
      const { tableId, auth } = this.session;
      const asked = Date.now();
      const since = whole ? -1 : (this.view?.version ?? -1);
      const response = await this.request({ op: 'poll', tableId, auth, since, holdMs: HOLD_MS });

      if (run !== this.pollRun) {
        return;
      }

      if (isRefusal(response)) {
        this.dropSession(response);
        return;
      }

      if (!response || !response.ok) {
        retryIn = nextRetry(retryIn);
        this.setTrouble(response ? 'struggling' : 'unreachable');
        await sleep(retryIn);
        continue;
      }

      retryIn = 0;
      whole = false;
      this.setTrouble(null);

      // The table has been heard from since the move that got no answer, so the screen can be trusted again
      if (this.turnLock === 'unanswered') {
        this.setTurnLock('open');
      }

      try {
        if (response.kind === 'view') {
          // A view older than the one on screen was overtaken on its way here. A second in a row means
          // the table itself has gone back, as after a restore of the Sheet, and then the server is right
          const drawn = this.applyView(response.view, passedOver > 0);
          passedOver = drawn ? 0 : passedOver + 1;
        } else if (response.kind === 'unchanged') {
          passedOver = 0;
          this.noteServerTime(response.now);

          if (Date.now() - asked < QUICK_POLL_GAP_MS) {
            await sleep(QUICK_POLL_GAP_MS);
          }
        }
      } catch (error) {
        // A table that can't be drawn must not be what stops it from updating
        console.error(error);
        await sleep(FIRST_RETRY_MS);
      }
    }
  }

  /**
   * An answer's time is already old by however long it took to arrive, so every sample puts the
   * server's clock a little behind. The largest of the recent ones traveled fastest and is closest,
   * which also errs toward showing a player less time than they have, never more.
   */
  private noteServerTime(serverNow: number): void {
    this.clockSamples.push(serverNow - Date.now());

    if (this.clockSamples.length > CLOCK_SAMPLES) {
      this.clockSamples.shift();
    }

    this.clockOffset = Math.max(...this.clockSamples);
  }

  /** Puts a view on screen. Returns false for one older than what is showing, unless `evenIfOlder`. */
  private applyView(view: TableView, evenIfOlder = false): boolean {
    const previous = this.view;

    // An action's answer and a poll can cross; the older picture doesn't replace the newer one
    if (previous && view.version <= previous.version && !evenIfOlder) {
      return false;
    }

    this.noteServerTime(view.now);
    this.view = view;

    const mySeat = view.you.seat;
    const myTurn = mySeat !== null && view.hand?.stage === 'betting' && view.hand.toAct === mySeat;
    const wasMyTurn = previous?.hand?.stage === 'betting' && previous.hand.toAct === previous.you.seat && previous.hand.number === view.hand?.number && previous.hand.street === view.hand?.street;

    if (myTurn && !wasMyTurn && this.soundOn()) {
      playTurnChime();
    }

    this.drawTable();

    return true;
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

    this.drawDialog();
  }

  private drawControls(screen: TableScreen, view: TableView): void {
    screen.controls.draw(controlsSignature(view), () =>
      controlsEl(view, {
        send: (command) => this.send(command),
        openRebuy: () => this.openDialog({ kind: 'rebuy' }),
      }),
    );

    // Freshly built buttons are free; a move still on its way keeps them locked
    lockTurn(screen.controls.element, this.turnLock !== 'open');
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

    const troubleText = { unreachable: 'Lost the connection to the table. Trying again…', struggling: 'The table is slow to answer. Trying again…' };

    screen.banners.draw([this.trouble, requests], () => [
      this.trouble ? h('div.banner.warn', null, troubleText[this.trouble]) : null,
      requests.map((request) => {
        const what = request.kind === 'seat' ? `wants seat ${request.seat + 1} with ${chips(request.amount)}` : `wants to add ${chips(request.amount)}`;
        const approve = h('button.btn.small.primary', { type: 'button', 'data-action': 'approve' }, 'Approve');
        const deny = h('button.btn.small', { type: 'button', 'data-action': 'deny' }, 'Deny');

        approve.addEventListener('click', () => holdWhile(approve, () => this.send({ type: 'approve', playerId: request.playerId })));
        deny.addEventListener('click', () => holdWhile(deny, () => this.send({ type: 'deny', playerId: request.playerId })));

        return h('div.banner', null, h('span', null, h('b', null, request.name), ` ${what}`), approve, deny);
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

  private setTurnLock(lock: TurnLock): void {
    this.turnLock = lock;

    if (this.screen) {
      lockTurn(this.screen.controls.element, lock !== 'open');
    }
  }

  private setTrouble(trouble: Trouble | null): void {
    if (trouble !== this.trouble) {
      this.trouble = trouble;

      if (this.screen && this.view) {
        this.drawBanners(this.screen, this.view);
      }
    }
  }

  // ---- Dialogs ----

  private openDialog(dialog: Dialog): void {
    this.dialog = dialog;
    this.dialogOpens += 1;
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

    const dialog = this.dialog;
    const view = this.view;

    screen.overlay.element.hidden = !dialog || !view;

    if (!dialog || !view) {
      screen.overlay.draw(null, () => null);
      return;
    }

    // Opening a dialog always draws it; after that only a change in what it shows does
    const handlers = this.dialogHandlers();
    screen.overlay.draw([this.dialogOpens, dialogShows(dialog, view, handlers)], () => dialogEl(dialog, view, handlers));
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
      toLobby: () => this.showLobby(true),
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
    this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), TOAST_MS);
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
