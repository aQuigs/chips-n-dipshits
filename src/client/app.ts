import type { Command, HandRecord, TableConfig } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';
import type { ApiError, ApiRequest, ApiResponse, Auth } from '../server/api.ts';
import { ask, isRefusal, nextRetry, ServerClock, sleep, TableConnection } from './connection.ts';
import type { SendOutcome, Session } from './connection.ts';
import { TableEffects } from './effects.ts';
import { tableChange } from './tableChange.ts';
import { Modal } from './modal.ts';
import type { Platform } from './platform.ts';
import { PREFERENCES, Preferences } from './prefs.ts';
import type { AppPreferences } from './prefs.ts';
import { controlsEl, controlsSignature, lockTurn } from './render/controls.ts';
import { dialogEl, dialogShows } from './render/dialogs/index.ts';
import type { Dialog, DialogHandlers } from './render/dialogs/index.ts';
import { createFeed } from './render/feed.ts';
import type { Feed } from './render/feed.ts';
import { joinScreen, lobbyEl, noticeEl, welcomeBackEl } from './render/lobby.ts';
import { tableEl } from './render/table.ts';
import { createThemePicker } from './render/themePicker.ts';
import type { Shape } from './render/table.ts';
import { allowSound } from './sound.ts';
import { fontsUrl, themeById } from './themes.ts';
import { chips, h, holdWhile, secondsUntil, Slot } from './ui.ts';

const COUNTDOWN_TICK_MS = 250;
const TOAST_MS = 4500;

// Wider than this and the table lies down; narrower and it stands up, as on a phone
const WIDE_ASPECT = 1.15;

const NAME_KEY = 'cnd.name';
const seatKey = (tableId: string) => `cnd.seat.${tableId}`;

const FONTS_LINK_ID = 'theme-fonts';

/** The parts of the table screen that are built once and then filled in as views arrive. */
interface TableScreen {
  topbar: Slot;
  banners: Slot;
  stage: Slot;
  controls: Slot;
  overlay: Slot;
  modal: Modal;
  feed: Feed;
  effects: TableEffects;
  shape: Shape;
  seenCards: Set<string>;
  resizeObserver: ResizeObserver;
}

function parseMember(value: string | null | undefined): Auth | null {
  const [id, token] = (value ?? '').split('.');

  return id && token ? { id, token } : null;
}

/** Runs the whole page: which screen is up, and keeping the table drawn from what its connection brings. */
export class App {
  /** What this viewer has chosen for themselves. */
  readonly prefs: AppPreferences;

  private readonly root: HTMLElement;
  private readonly platform: Platform;
  private readonly themeHost: HTMLElement;
  private readonly toastEl = h('div.toast', { role: 'status', hidden: true });

  private readonly clock = new ServerClock();

  /** The table this page is at, from sitting down at its screen until that screen is left. */
  private table: TableConnection | null = null;
  private view: TableView | null = null;
  private screen: TableScreen | null = null;
  private dialog: Dialog | null = null;
  private dialogOpens = 0;

  /**
   * A member the address names whom this browser hasn't taken up as its own. The address may be the
   * only place that seat is kept, so until it is confirmed, declined or refused, nothing else is put there.
   */
  private linked: Session | null = null;

  /** Bumped whenever the screen is changed, to retire a wait for a linked member that began before. */
  private leaves = 0;
  private toastTimer = 0;

  /**
   * `themeHost` is the element the app sets its theme on: the whole page by default, or one frame
   * of it when several apps share a page.
   */
  constructor(root: HTMLElement, platform: Platform, themeHost: HTMLElement = document.documentElement) {
    this.root = root;
    this.platform = platform;
    this.themeHost = themeHost;
    this.prefs = new Preferences(PREFERENCES, platform.memory, root);
    this.prefs.watch('theme', (id) => this.applyTheme(id));

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
    this.applyTheme(this.prefs.get('theme'));
    setInterval(() => this.tickCountdowns(), COUNTDOWN_TICK_MS);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.dialog) {
        this.closeDialog();
      }
    });

    // A phone that was asleep comes back with a request that may never be answered
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.table?.refresh();
      }
    });

    // A touch only counts as the visitor's own gesture once the finger lifts, which is the click
    for (const gesture of ['pointerdown', 'click', 'keydown']) {
      document.addEventListener(gesture, allowSound);
    }
  }

  /** Switches the theme and remembers it for this browser. */
  setTheme(id: string): void {
    this.prefs.set('theme', themeById(id).id);
  }

  // ---- Screens ----

  /**
   * `keepAddress` leaves the address pointing at the table just left. Where the address is what
   * remembers a player's seat, clearing it would be throwing the seat away.
   */
  private showLobby(keepAddress = false): void {
    this.leaveTableScreen();

    if (!keepAddress) {
      this.pointAddress(null);
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
    return createThemePicker(this.prefs.get('theme'), (id) => this.setTheme(id), true).element;
  }

  private openTable(tableId: string): void {
    const auth = this.rememberedSeat(tableId);

    if (this.linked?.tableId === tableId) {
      // Reached from the lobby, this is the same question a reload of the address would ask
      void this.confirmMember(tableId, this.linked.auth);
    } else if (auth) {
      this.enterTable({ tableId, auth }, null);
    } else {
      void this.showJoin(tableId);
    }
  }

  /** Every change to the address goes through here, so that what it is known to name stays true. */
  private pointAddress(tableId: string | null, auth?: Auth): void {
    this.linked = null;
    this.platform.links.showTable(tableId, auth);
  }

  /**
   * Someone arrived by a link that says who they are: shows whose seat it is and lets them say it
   * isn't theirs. The link may be the only place their seat is remembered, so the address is left
   * alone until the server itself has said the link is no good; a request that merely fails is tried again.
   */
  private async confirmMember(tableId: string, auth: Auth): Promise<void> {
    // Leaving for the lobby keeps the address, so the link is still there to come back to
    const wayOut = { label: 'Go to the lobby', action: () => this.showLobby(true) };

    this.leaveTableScreen();
    this.linked = { tableId, auth };
    this.mount(noticeEl('Looking for your seat…', wayOut));

    const run = this.leaves;
    let view: TableView | null = null;

    for (let retryIn = 0; !view; ) {
      const response = await this.request({ op: 'poll', tableId, auth, since: -1 });

      if (run !== this.leaves) {
        return;
      }

      if (isRefusal(response)) {
        // A personal link that no longer works is still a link to the table
        void this.showJoin(tableId);

        if (response.code === 'unauthorized') {
          this.toast('That personal link no longer works here. Join again to play.');
        }

        return;
      }

      if (response?.ok && response.kind === 'view') {
        view = response.view;
      } else {
        retryIn = nextRetry(retryIn);
        this.mount(noticeEl('Could not reach the table. Trying again…', wayOut));
        await sleep(retryIn);

        if (run !== this.leaves) {
          return;
        }
      }
    }

    const found = view;

    this.mount(
      welcomeBackEl(found.you.name, found.config.name, this.rememberedSeat(tableId) !== null, {
        yes: () => {
          this.remember(tableId, auth);
          this.enterTable({ tableId, auth }, found);
        },
        no: () => {
          this.linked = null;
          this.openTable(tableId);
        },
      }),
    );
  }

  private async showJoin(tableId: string): Promise<void> {
    this.leaveTableScreen();
    this.pointAddress(tableId);

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
    this.pointAddress(session.tableId, session.auth);

    const table = new TableConnection(this.platform.transport, session, this.clock, {
      view: (shown, wentBack) => this.showView(shown, wentBack),
      status: () => this.showStatus(),
      refused: (error) => this.dropSession(error),
      notice: (message) => this.toast(message),
    });
    this.table = table;

    const feed = createFeed((text) => void this.send({ type: 'chat', text }));
    const stage = new Slot(h('div.stage'));
    const overlay = new Slot(h('div.overlay', { hidden: true }));
    const screen: TableScreen = {
      topbar: new Slot(h('header.topbar')),
      banners: new Slot(h('div.banners')),
      stage,
      controls: new Slot(h('div.controls-slot')),
      overlay,
      modal: new Modal(overlay.element),
      feed,
      effects: new TableEffects(this.prefs, stage.element),
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
      table.take(view);
    } else {
      stage.element.appendChild(h('div.loading', null, 'Finding your seat…'));
    }

    table.refresh();
  }

  private leaveTableScreen(): void {
    this.leaves += 1;
    this.table?.close();
    this.table = null;
    this.screen?.resizeObserver.disconnect();
    this.screen?.effects.dispose();
    this.screen = null;
    this.view = null;
    this.dialog = null;
  }

  private mount(content: HTMLElement): void {
    this.root.replaceChildren(content, this.toastEl);
  }

  // ---- Talking to the server ----

  private request(request: ApiRequest): Promise<ApiResponse | null> {
    return ask(this.platform.transport, request);
  }

  private async send(command: Command): Promise<SendOutcome> {
    return (await this.table?.send(command)) ?? 'refused';
  }

  /** The server no longer knows this browser at the table, so start over from the join screen or the lobby. */
  private dropSession(error: ApiError): void {
    const tableId = this.table?.session.tableId;

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

  /** Puts on screen a view the connection has taken up. */
  private showView(view: TableView, wentBack: boolean): void {
    const before = this.view;

    this.view = view;

    // A table that can't be drawn must not be what stops it from updating
    try {
      this.drawTable();
    } catch (error) {
      console.error(error);
    }

    // Only for a view that was taken up, so nothing happens twice for one that was dropped or is drawn again
    this.screen?.effects.run(tableChange(before, view, this.clock.now(), wentBack));
  }

  /** Whether a move can be made, or whether the table is being heard from, has changed. */
  private showStatus(): void {
    if (!this.screen) {
      return;
    }

    lockTurn(this.screen.controls.element, this.turnLocked());

    if (this.view) {
      this.drawBanners(this.screen, this.view);
    }
  }

  private turnLocked(): boolean {
    return this.table?.turnLocked ?? false;
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
    lockTurn(screen.controls.element, this.turnLocked());
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

    const trouble = this.table?.trouble ?? null;

    const troubleText = { unreachable: 'Lost the connection to the table. Trying again…', struggling: 'The table is slow to answer. Trying again…' };

    screen.banners.draw([trouble, requests], () => [
      trouble ? h('div.banner.warn', null, troubleText[trouble]) : null,
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
      const table = tableEl(view, screen.shape, this.clock.offset, {
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
      element.textContent = String(secondsUntil(Number(element.dataset.countdown), this.clock.offset));
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
      screen.modal.update(false);
      return;
    }

    // Opening a dialog always draws it; after that only a change in what it shows does
    const handlers = this.dialogHandlers();
    screen.overlay.draw([this.dialogOpens, dialogShows(dialog, view, handlers)], () => dialogEl(dialog, view, handlers));
    screen.modal.update(true);
  }

  private dialogHandlers(): DialogHandlers {
    const { session } = this.table!;

    return {
      send: (command) => this.send(command),
      open: (dialog) => this.openDialog(dialog),
      close: () => this.closeDialog(),
      copy: (text) => this.copy(text),
      loadHistory: () => this.loadHistory(),
      tableLink: () => this.platform.links.tableLink(session.tableId),
      memberLink: () => this.platform.links.memberLink(session.tableId, session.auth),
      prefs: this.prefs,
      toLobby: () => this.showLobby(true),
    };
  }

  private async loadHistory(): Promise<HandRecord[]> {
    const session = this.table?.session;
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
