import { liveReactions, REACTION_TOO_SOON, reactionRefusal } from '../engine/reactions.ts';
import { replaySteps } from '../engine/replay.ts';
import { anteText, blindsText } from '../engine/stakes.ts';
import type { Preset } from '../engine/presets.ts';
import type { Command, HandRecord, TableConfig } from '../engine/types.ts';
import type { TableView } from '../engine/view.ts';
import type { ApiError, ApiRequest, ApiResponse, Auth } from '../server/api.ts';
import { PageAnnouncer } from './announcer.ts';
import { isRefusal, nextRetry, ServerClock, ServerLine, sleep, TableConnection } from './connection.ts';
import type { SendOutcome, Session } from './connection.ts';
import { TableEffects } from './effects.ts';
import { lastOnRecord } from './handRecords.ts';
import { HotkeyPresser } from './hotkeyPresser.ts';
import { playerFor, RememberedPlayer } from './knownPlayers.ts';
import type { Answer } from './knownPlayers.ts';
import { Modal } from './modal.ts';
import { browserOf } from './pageErrors.ts';
import type { PageFailure } from './pageErrors.ts';
import { DealtCards, forgetDealt } from './dealtCards.ts';
import { forgetMutes, Mutes } from './mutes.ts';
import { pageWishes } from './pageWishes.ts';
import { sendersShown } from './senders.ts';
import { Motion, motionAbility } from './motion.ts';
import { pageMotion, pageWatching } from './pageMotion.ts';
import { pagePace } from './pagePace.ts';
import { TapGuard } from './pageTapGuard.ts';
import { noReplayLine, pageTicker } from './replayPlayer.ts';
import { ReplayScreen } from './replayScreen.ts';
import { neededBy } from './replayTurn.ts';
import { ReactionMarks } from './reactionMarks.ts';
import { ReactionPicker } from './render/reactionPicker.ts';
import type { Platform } from './platform.ts';
import { PREFERENCES, Preferences } from './prefs.ts';
import { movePromptEl, SeatMoves } from './seatMoves.ts';
import type { Abilities, Ability, AppPreferences } from './prefs.ts';
import { controlsEl, controlsSignature, lockTurn, sizingMemory } from './render/controls.ts';
import type { Sizing } from './render/controls.ts';
import { frame } from './render/dialogs/dialog.ts';
import { dialogAllowed, dialogEl, dialogShows } from './render/dialogs/index.ts';
import type { Dialog, DialogHandlers } from './render/dialogs/index.ts';
import { createFeed } from './render/feed.ts';
import type { Feed } from './render/feed.ts';
import { joinScreen, lobbyEl, noticeEl, putAwayEl, welcomeBackEl } from './render/lobby.ts';
import type { AsksWho, LobbyScreen, Visitor } from './render/lobby.ts';
import { nightOver } from './render/night.ts';
import { outdatedEl } from './render/outdated.ts';
import { hostOrCohost } from './render/roles.ts';
import { standingsEl } from './render/standings.ts';
import type { StandingsHandlers } from './render/standings.ts';
import { handDrawn, shapeFor, tableEl } from './render/table.ts';
import { createThemePicker } from './render/themePicker.ts';
import { voiceLinkEl } from './render/voiceLink.ts';
import type { Listed } from './render/whoField.ts';
import type { Shape } from './render/table.ts';
import { Arrivals } from './arrivals.ts';
import { Attention } from './attention.ts';
import { pageWays } from './pageAttention.ts';
import { showStillOffered } from './showing.ts';
import { ShownTable } from './shownTable.ts';
import { Sounds } from './sound.ts';
import { LABELS, menuLabel, replayOpenedSaid, requestText, timeSaid } from './spoken.ts';
import { fontsUrl, themeById } from './themes.ts';
import { TimeWarning } from './timeWarning.ts';
import { pageTouch } from './pageTouch.ts';
import { h, holdWhile, secondsUntil, Slot } from './ui.ts';
import { pageSounds } from './webAudioSounds.ts';

const COUNTDOWN_TICK_MS = 250;
const TOAST_MS = 4500;

const NAME_KEY = 'cnd.name';
const seatKey = (tableId: string) => `cnd.seat.${tableId}`;

const FONTS_LINK_ID = 'theme-fonts';

/** The parts of the table screen that are built once and then filled in as views arrive. */
interface TableScreen {
  topbar: Slot;
  banners: Slot;
  stage: Slot;
  controls: Slot;
  /** Holds back a tap on a control of the bar that came up where another lay a moment before. */
  taps: TapGuard;
  overlay: Slot;
  modal: Modal;
  feed: Feed;
  /** Who the viewer has muted at this table, and the way to stop following it. */
  mutes: Mutes;
  stopMutes: () => void;
  /** A finished hand played back, lying over everything else of the table. */
  replay: ReplayScreen;
  dealt: DealtCards;
  motion: Motion;
  /** Reactions over the seats, and the picker for them, on a layer over the table that drawing the table leaves alone. */
  marks: ReactionMarks;
  picker: ReactionPicker;
  effects: TableEffects;
  /** What the screen shows of the table, which every view passes through on its way here. */
  shown: ShownTable;
  sizing: Sizing;
  seatMoves: SeatMoves;
  shape: Shape;
  resizeObserver: ResizeObserver;
  /** The trouble with the connection that a screen reader was last told of, which is told once and not with every redraw. */
  troubleSaid: 'unreachable' | 'struggling' | null;
}

function parseMember(value: string | null | undefined): Auth | null {
  const [id, token] = (value ?? '').split('.');

  return id && token ? { id, token } : null;
}

/** Runs the whole page: which screen is up, and keeping the table drawn from what its connection brings. */
export class App {
  /** What this viewer has chosen for themselves. */
  readonly prefs: AppPreferences;
  private readonly sounds: Sounds;
  private readonly attention: Attention;
  private readonly watching = pageWatching();
  /** What this device can do of what Preferences switches on, each switch asked of the part of the page that knows. */
  private readonly abilities: Abilities;

  private readonly root: HTMLElement;
  private readonly platform: Platform;
  private readonly themeHost: HTMLElement;
  // For the eye: its words are said through the announcer, which a screen reader hears whether or not the line is still up
  private readonly toastEl = h('div.toast', { hidden: true, 'aria-hidden': 'true' });
  /** What a screen reader is told, kept on the page through every screen and every redraw so that each line is heard once. */
  private readonly announcer = new PageAnnouncer(LABELS.spoken);
  private readonly timeWarning = new TimeWarning();

  private readonly clock = new ServerClock();
  private readonly server: ServerLine;

  /** Where a join or a new table is asked for, so that one whose answer is lost can be tried again without arriving twice. */
  private readonly arrivals = new Arrivals(
    (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
    (request) => this.request(request),
  );

  /** Which of the players the game knows this browser was last used as. */
  private readonly me: RememberedPlayer;

  /** Counts the times the list of players was asked for a screen, so that only the latest goes on trying. */
  private playersAsked = 0;
  private readonly hotkeys: HotkeyPresser;

  /** The table this page is at, from sitting down at its screen until that screen is left. */
  private table: TableConnection | null = null;
  private screen: TableScreen | null = null;
  /** Takes the standings off a screen that has no table, while they are up over one. */
  private closeStandings: (() => void) | null = null;
  private dialog: Dialog | null = null;

  /** Whether the page put the dialog on screen in front of the viewer by itself, which is what lets it take that dialog away again. */
  private dialogOpenedItself = false;
  private dialogOpens = 0;

  /** The opening that the dialog on screen was drawn for. */
  private dialogDrawn = 0;

  /** A dialog the page means to open by itself, waiting for the viewer to be free for it. */
  private offered: { dialog: Dialog; still(view: TableView): boolean } | null = null;

  /** How many commands are on their way to the table with no answer yet. */
  private sending = 0;

  /** Whether the hand the bar's button asked to see again is still being fetched. */
  private fetchingReplay = false;

  /** The hand the bar's button asked to see again before it was on record, played back as soon as it is. */
  private replayWanted: number | null = null;

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

    const device = pageWishes();

    this.prefs = new Preferences(PREFERENCES, platform.memory, root, device.wished);
    device.onChange(() => this.applyTheme(this.prefs.get('theme')));

    this.me = new RememberedPlayer(platform.memory);
    this.prefs.watch('theme', (id) => this.applyTheme(id));
    for (const key of ['deck', 'gifs'] as const) {
      this.prefs.watch(key, () => this.screen?.feed.redraw());
    }
    this.sounds = new Sounds(pageSounds(), this.prefs, { inView: this.watching.inView });
    this.attention = new Attention(this.prefs, pageWays({ sounds: this.sounds, touch: pageTouch(), root, ownsTab: platform.ownsTab }));
    // What the device says to a preference that is no way of getting attention
    const own: Record<string, () => Ability> = { motion: () => motionAbility(this.watching), hotkeys: () => this.hotkeys.ability() };

    this.abilities = { of: (key) => (Object.hasOwn(own, key) ? own[key]!() : this.attention.of(key)), ask: (key) => this.attention.ask(key) };
    this.server = new ServerLine(platform.transport, platform.build, () => this.showOutdated());
    this.hotkeys = new HotkeyPresser(this.prefs, { root, controls: () => this.screen?.controls.element ?? null, dialogOpen: () => this.tableCovered() });

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

  /**
   * What tells the server's error log of a failure the page saw, as the member of the table it is at, or
   * null before the page is at a table, when there is nobody to send it as. Like a reaction a report is
   * sent once and whatever comes back, or doesn't, is left alone: nothing of the seat or the screen hangs on it.
   */
  failureReporter(): ((failure: PageFailure) => void) | null {
    const session = this.table?.session;

    return session ? (failure) => void this.server.ask({ op: 'report', tableId: session.tableId, auth: session.auth, ...failure, browser: browserOf(navigator.userAgent) }) : null;
  }

  /** Starts seated at a table as a member who is already known, skipping the lobby. */
  startAt(tableId: string, auth: Auth): void {
    this.begin();
    this.remember(tableId, auth);
    this.enterTable({ tableId, auth }, null);
  }

  private begin(): void {
    // Whoever serves the page may write its outer markup themselves, as Apps Script does, and a page that
    // names no language is read out in the screen reader's own, whatever that is
    document.documentElement.lang ||= 'en';
    this.applyTheme(this.prefs.get('theme'));
    setInterval(() => {
      this.tickCountdowns();
      this.showOffered();
    }, COUNTDOWN_TICK_MS);

    // Ahead of the listeners below: while a hand is played back the keys are its own, and neither the dialog under it nor the turn hears them
    document.addEventListener('keydown', (event) => {
      const replay = this.screen?.replay;
      if (!replay?.isOpen) {
        return;
      }

      replay.key(event);
      event.stopImmediatePropagation();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.server.outdated) {
        return;
      }

      if (this.closeStandings) {
        this.closeStandings();
      } else if (this.dialog) {
        this.closeDialog();
      } else if (this.screen?.picker.isOpen) {
        this.screen.picker.close();
      } else if (this.screen?.seatMoves.active) {
        this.screen.seatMoves.cancel();

        // Spent on backing out of the move, so the keys of the turn don't also act on it
        event.stopImmediatePropagation();
      }
    });
    document.addEventListener('keydown', (event) => this.hotkeys.handle(event));

    // A phone that was asleep comes back with a request that may never be answered
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.table?.refresh();
        this.hotkeys.shown();
      }
    });
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

    const lobby = lobbyEl(this.visitor(), this.themePicker(), {
      create: async (as, config) => {
        if (!(await this.createTable(as, config))) {
          void this.offerPlayers(lobby);
        }
      },
      openTable: (code) => this.openTable(code.trim().toUpperCase()),
      standings: () => this.showStandings(),
    });

    this.mount(lobby.element);
    void this.offerPresets(lobby);
    void this.offerPlayers(lobby);
  }

  /**
   * Brings a screen something it works without, as soon as it is up: a failure is tried again quietly
   * for as long as the screen shows and the help is still `wanted`.
   */
  private async offerWhileShown<T>(screen: HTMLElement, load: () => Promise<T>, offer: (loaded: T) => void, wanted: () => boolean = () => true): Promise<void> {
    for (let retryIn = 0; this.root.contains(screen) && wanted(); ) {
      try {
        const loaded = await load();

        if (this.root.contains(screen)) {
          offer(loaded);
        }

        return;
      } catch {
        retryIn = nextRetry(retryIn);
        await sleep(retryIn);
      }
    }
  }

  /**
   * The players the game knows, for a screen that asks "who are you?". Asked for again when an attempt
   * from the screen came to nothing, since the usual reason is a name the list turned out to have; only
   * the latest asking goes on trying.
   */
  private offerPlayers(screen: AsksWho): Promise<void> {
    const asked = ++this.playersAsked;

    return this.offerWhileShown(screen.element, () => this.listPlayers(), (listed) => screen.offerPlayers(listed), () => asked === this.playersAsked);
  }

  /** The group's presets, so that they are there by the time the host has typed their name. */
  private offerPresets(lobby: LobbyScreen): Promise<void> {
    return this.offerWhileShown(lobby.element, () => this.listPresets(), (presets) => lobby.offerPresets(presets));
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
        if (response.putAway) {
          this.showPutAway(tableId, response);
          return;
        }

        // A personal link that no longer works is still a link to the table
        void this.showJoin(tableId);

        if (response.code === 'unauthorized') {
          this.fail('That personal link no longer works here. Join again to play.');
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

    const screen = joinScreen(tableId, this.visitor(), this.themePicker(), {
      join: async (as) => {
        if (!(await this.joinTable(tableId, as))) {
          void this.offerPlayers(screen);
        }
      },
      toLobby: () => this.showLobby(),
    });

    this.mount(screen.element);
    void this.offerPlayers(screen);

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
        if (response.putAway) {
          this.showPutAway(tableId, response);
        } else {
          this.showLobby();
          this.fail(`There is no table with the code ${tableId}.`);
        }

        return;
      }

      // The link stays in the address, so a reload is another try
      retryIn = nextRetry(retryIn);
      this.fail('Could not reach the table. Trying again…');
      await sleep(retryIn);
    }
  }

  /** Resolves to whether the table was made. */
  private async createTable(as: Answer, config: Partial<TableConfig>): Promise<boolean> {
    const response = await this.arrivals.ask({ op: 'create', ...as, config });
    if (response?.ok && response.kind === 'joined') {
      this.remember(response.view.id, response.auth);
      this.enterTable({ tableId: response.view.id, auth: response.auth }, response.view);
      this.openDialog({ kind: 'invite' });
      this.noteWho(as, response.view);
      return true;
    }

    this.fail(response && !response.ok ? response.error : 'Could not create the table. Check your connection and try again.');
    return false;
  }

  /** Resolves to whether the visitor is now somewhere other than the form they joined from. */
  private async joinTable(tableId: string, as: Answer): Promise<boolean> {
    const response = await this.arrivals.ask({ op: 'join', tableId, ...as });
    if (response?.ok && response.kind === 'joined') {
      this.remember(tableId, response.auth);
      this.enterTable({ tableId, auth: response.auth }, response.view);
      this.noteWho(as, response.view);
      return true;
    }

    if (response && !response.ok && response.putAway) {
      this.showPutAway(tableId, response);
      return true;
    }

    this.fail(response && !response.ok ? response.error : 'Could not join the table. Check your connection and try again.');
    return false;
  }

  /**
   * One the table has down as nobody got in while the list of players could not be asked or had no
   * room. Whoever the browser remembered before is kept then, since only a list that loaded says a
   * player is gone.
   */
  private noteWho(as: Answer, view: TableView): void {
    if (as.who.as === 'new') {
      this.platform.memory.set(NAME_KEY, view.you.name);
    }

    if (view.you.identity !== null) {
      this.me.set(playerFor(view.you.identity, as));
    } else {
      this.toast('You’re in, though not on the list of players. You can say who you are from the menu.');
    }
  }

  /**
   * The server has said the table was put away. Nothing of it is kept here, neither in the address nor
   * in the browser's memory, mutes included, and the visitor is told why and offered a new one.
   */
  private showPutAway(tableId: string, error: ApiError): void {
    this.leaveTableScreen();
    this.platform.memory.remove(seatKey(tableId));
    forgetMutes(this.platform.memory, tableId);
    forgetDealt(this.platform.memory, tableId);
    this.pointAddress(null);
    this.mount(putAwayEl(tableId, error.error, () => this.showLobby()));
  }

  private enterTable(session: Session, view: TableView | null): void {
    this.leaveTableScreen();
    this.pointAddress(session.tableId, session.auth);

    const table = new TableConnection(this.server, session, this.clock, {
      view: (shown, wentBack) => this.showView(shown, wentBack),
      move: (lock, sent) => this.screen?.shown.moveIs(lock, sent),
      chose: (sent) => this.screen?.shown.choiceIs(sent),
      status: () => this.showStatus(),
      refused: (error) => this.dropSession(error),
      notice: (message) => this.fail(message),
    });
    this.table = table;

    const picker = new ReactionPicker({ react: (kind, to) => this.react(kind, to), refusal: (view) => this.reactionRefusal(view) });
    const mutes = new Mutes(this.platform.memory, session.tableId);
    const dealt = new DealtCards(this.platform.memory, session.tableId);
    const page = h('div.app');
    const replay = new ReplayScreen({
      under: page,
      ticker: pageTicker,
      pace: pagePace(),
      deck: () => this.prefs.get('deck'),
      // The buttons the replay covered are new to the player again
      closed: () => this.hotkeys.shown(),
      toTable: () => void this.setReplayAside(),
    });
    const feed = createFeed(
      (text) => void this.send({ type: 'chat', text }),
      () => ({ deck: this.prefs.get('deck'), pictures: this.prefs.get('gifs'), shown: sendersShown(this.prefs, mutes, table.session.auth.id, 'chat') }),
      picker.toggleElement,
    );
    const stage = new Slot(h('main.stage', { 'aria-label': LABELS.table, tabindex: -1 }));
    const bar = h('section.controls-slot', { 'aria-label': LABELS.bar, tabindex: -1 });
    // The parts whose controls come up by themselves have the guard. Not the table, drawn anew with every move and with none of its controls moving
    const taps = new TapGuard();
    taps.watchShape(bar);
    const overlay = new Slot(h('div.overlay', { hidden: true }), taps);
    const motion = new Motion(pageMotion(stage.element), this.prefs, this.watching);
    const above = h('div.above');
    const marks = new ReactionMarks(above, stage.element);
    above.append(picker.panelElement);
    const effects = new TableEffects({
      prefs: this.prefs,
      mutes,
      stage: stage.element,
      sounds: this.sounds,
      attention: this.attention,
      motion,
      marks,
      dialogs: { offer: (dialog, still) => this.offerDialog(dialog, still), withdraw: (kind) => this.withdrawDialog(kind) },
      dealt,
      replay: { setAside: () => this.setReplayAside(), turn: (mine) => replay.turn(mine) },
      toast: (message) => this.toast(message),
      say: this.announcer,
    });
    const controls = new Slot(bar, taps);
    // The first thing a keyboard reaches: the table is a long way to tab through to a turn that is on the clock
    const skip = h('button.skip', { type: 'button', onclick: () => controls.element.focus() }, LABELS.skip);
    const screen: TableScreen = {
      topbar: new Slot(h('header.topbar', { tabindex: -1 })),
      // A landmark only while it has something in it (`drawBanners`)
      // Takes the keyboard itself when the button that had it is gone with its notice, as the table and the bar do
      banners: new Slot(h('section.banners', { 'aria-label': LABELS.notices, tabindex: -1, hidden: true }), taps),
      stage,
      controls,
      taps,
      overlay,
      modal: new Modal(overlay.element),
      feed,
      mutes,
      stopMutes: mutes.watch(() => {
        feed.redraw();
        this.drawTable();
      }),
      replay,
      dealt,
      motion,
      marks,
      picker,
      effects,
      shown: new ShownTable(motion, () => this.clock.now(), () => Date.now(), pagePace(), {
        draw: () => this.drawShown(),
        tell: (change) => {
          effects.run(change);
          this.replayOnceRecorded(change.view);
        },
        say: (message) => this.fail(message),
      }),
      sizing: sizingMemory(),
      seatMoves: new SeatMoves(stage.element, {
        view: () => this.screen?.shown.heard ?? null,
        send: (command) => void this.send(command),
        changed: () => this.drawTable(),
      }),
      shape: 'wide',
      resizeObserver: new ResizeObserver(() => this.reshape()),
      troubleSaid: null,
    };

    screen.overlay.element.addEventListener('click', (event) => {
      if (event.target === screen.overlay.element) {
        this.closeDialog();
      }
    });

    this.screen = screen;
    page.append(skip, screen.topbar.element, screen.banners.element, stage.element, above, screen.controls.element, feed.element, screen.overlay.element);
    this.mount(page);
    // Beside the page, not in it: a dialog shuts everything else in the page off from the keyboard, and a replay opens over one
    page.after(replay.element);
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
    this.replayWanted = null;
    this.table?.close();
    this.table = null;
    this.screen?.resizeObserver.disconnect();
    this.screen?.effects.dispose();
    this.screen?.shown.end();
    this.screen?.motion.dispose();
    this.screen?.marks.dispose();
    this.screen?.picker.dispose();
    this.screen?.seatMoves.dispose();
    this.screen?.taps.dispose();
    this.screen?.stopMutes();
    this.screen?.replay.close();
    this.screen = null;
    this.dialog = null;
    this.offered = null;
    this.announcer.forget();
  }

  private mount(content: HTMLElement): void {
    // Whatever was up over the screen before goes with it, and lets go of what it held back
    this.closeStandings?.();

    const kept = [this.toastEl, ...this.announcer.elements];

    // What speaks stays where it is: a region taken off the page and put back may be read out again
    for (const child of [...this.root.children]) {
      if (!kept.includes(child as HTMLElement)) {
        child.remove();
      }
    }

    this.root.prepend(content);
    this.root.append(...kept.filter((element) => !element.isConnected));
  }

  /**
   * The standings over a screen that has no table, which stays as it is underneath: a name half typed
   * on the first screen is still there when they are closed. At a table they are a dialog like any other.
   */
  private showStandings(): void {
    const close = (): void => {
      modal.update(false);
      overlay.remove();
      this.closeStandings = null;
    };

    const overlay = h(
      'div.overlay',
      { 'data-screen': 'standings', onclick: (event: Event) => event.target === overlay && close() },
      frame('Standings', { close }, standingsEl(this.standingsHandlers(this.me.get()?.id ?? null))),
    );
    const modal = new Modal(overlay);

    this.closeStandings?.();
    this.closeStandings = close;
    this.root.appendChild(overlay);
    modal.update(true);
  }

  private standingsHandlers(you: string | null): StandingsHandlers {
    return {
      load: async () => {
        const response = await this.request({ op: 'standings' });

        if (response?.ok && response.kind === 'standings') {
          return response;
        }

        throw new Error('The standings could not be loaded');
      },
      nights: async (playerId, unit) => {
        const response = await this.request({ op: 'nights', playerId, unit });

        if (response?.ok && response.kind === 'nights') {
          return response.nights;
        }

        throw new Error('The nights could not be loaded');
      },
      you,
      deck: this.prefs.get('deck'),
    };
  }

  // ---- Talking to the server ----

  private request(request: ApiRequest): Promise<ApiResponse | null> {
    return this.server.ask(request);
  }

  /**
   * The server is another build of the game than this page. Whatever was on screen stays there, out of
   * reach behind the notice: it is the last thing this page was sure to understand, and it shows the
   * player what a reload brings them back to.
   */
  private showOutdated(): void {
    this.screen?.replay.close();
    this.closeDialog(true);

    // A move this page was showing as made may never be played, or was and its answer is now left unread:
    // the page cannot tell, so what stays behind the notice is the server's last word, and the reload shows the truth
    this.screen?.shown.forget();

    // Like the countdowns: a clock still running down would say the table behind the notice is the table as it is now
    for (const animation of this.root.getAnimations({ subtree: true })) {
      animation.pause();
    }

    const notice = outdatedEl(this.platform.links.reloadLink(), this.table !== null);

    this.root.appendChild(notice);
    new Modal(notice).update(true);
  }

  private async send(command: Command): Promise<SendOutcome> {
    this.sending += 1;

    try {
      return (await this.table?.send(command)) ?? 'refused';
    } finally {
      this.sending -= 1;
    }
  }

  /**
   * Sends a request that does the same however often it arrives, such as a rabbit hunt or a show of
   * cards. Unlike a move, one that got no answer is sent once more, since the hand is off the table within
   * seconds; but only while the page still offers it, as one that went through shows with the next poll.
   */
  private async sendAgainWhileOffered(command: Command, offered: () => boolean): Promise<void> {
    if ((await this.send(command)) === 'unanswered' && offered()) {
      await this.send(command);
    }
  }

  private hunt(hand: number): Promise<void> {
    return this.sendAgainWhileOffered({ type: 'huntRabbit', hand }, () => this.offersHunt(hand));
  }

  private showCards(hand: number, places: number[]): Promise<void> {
    return this.sendAgainWhileOffered({ type: 'showCards', hand, cards: places }, () => showStillOffered(this.shownView(), hand, places));
  }

  private offersHunt(hand: number): boolean {
    const shown = this.shownView()?.hand;

    return shown?.number === hand && shown.canHunt;
  }

  /** The server no longer knows this browser at the table, so start over from the join screen or the lobby. */
  private dropSession(error: ApiError): void {
    const tableId = this.table?.session.tableId;

    if (tableId && error.putAway) {
      this.showPutAway(tableId, error);
      return;
    }

    if (tableId) {
      this.platform.memory.remove(seatKey(tableId));
    }

    if (tableId && error.code === 'unauthorized') {
      void this.showJoin(tableId);
    } else {
      this.showLobby();
    }

    this.fail(error.code === 'not_found' ? 'That table no longer exists.' : 'This browser is not at the table anymore. Join again to keep playing.');
  }

  /** Puts on screen a view the connection has taken up: only such a one, so nothing happens twice for a view that was dropped. */
  private showView(view: TableView, wentBack: boolean): void {
    this.screen?.seatMoves.follow(view);
    this.screen?.shown.take(view, wentBack);
  }

  private drawShown(): void {
    // A table that can't be drawn must not be what stops it from updating
    try {
      this.drawTable();
    } catch (error) {
      console.error(error);
    }
  }

  /** Whether a move can be made, or whether the table is being heard from, has changed. */
  private showStatus(): void {
    if (!this.screen) {
      return;
    }

    lockTurn(this.screen.controls.element, this.turnLocked());

    const view = this.shownView();
    if (view) {
      this.drawBanners(this.screen, view);
      this.screen.picker.draw(view);
    }
  }

  private turnLocked(): boolean {
    return this.table?.turnLocked ?? false;
  }

  // ---- Drawing the table screen ----

  /**
   * The table as the screen shows it: with the viewer's own move on it before the server has answered,
   * and while the last cards of a runout are turned, as it stood before its hand was settled.
   */
  private shownView(): TableView | null {
    return this.screen?.shown.view() ?? null;
  }

  private drawTable(): void {
    const screen = this.screen;
    const view = this.shownView();
    if (!screen || !view) {
      return;
    }

    this.drawTopbar(screen, view);
    this.drawBanners(screen, view);
    this.drawStage(screen, view);
    screen.picker.draw(view);
    this.drawControls(screen, view);

    screen.feed.update(view);

    this.drawDialog();
  }

  private drawControls(screen: TableScreen, view: TableView): void {
    const waiting = screen.shown.waiting;
    // A choice of a move ahead draws the bar again the moment it is pressed, and whoever pressed it with a key is still on it:
    // the slot finds that button again. It finds no other, so no key press lands on a button of the turn that came up in its place
    const redrawn = screen.controls.draw([controlsSignature(view), waiting], () =>
      controlsEl(
        view,
        {
          send: (command) => this.send(command),
          showCards: (hand, places) => this.showCards(hand, places),
          openRebuy: () => this.openDialog({ kind: 'rebuy' }),
          openStraddles: () => this.openDialog({ kind: 'straddles' }),
          replay: (hand) => this.replayHand(hand),
          sizing: screen.sizing,
          say: (message) => this.announcer.status(message),
        },
        waiting,
      ),
    );

    if (redrawn) {
      this.hotkeys.shown();
      this.keyboardOffTheChat(screen);
    }

    // Freshly built buttons are free; a move still on its way keeps them locked
    lockTurn(screen.controls.element, this.turnLocked());
  }

  /**
   * A lying phone's open chat goes down to its bar for the viewer's turn, by the stylesheet alone
   * (sideways.css), and the box in it with it. The keyboard that was in the box goes to the bar under the
   * table, where the turn is, and not to nothing, which is the top of the page.
   */
  private keyboardOffTheChat(screen: TableScreen): void {
    const held = document.activeElement;

    if (held instanceof HTMLElement && screen.feed.element.contains(held) && held.getClientRects().length === 0) {
      screen.controls.element.focus({ preventScroll: true });
    }
  }

  /** Why a reaction now would be refused, as the table would say it, or null when one would go: the same rule, by the page's reckoning of the table's clock. */
  private reactionRefusal(view: TableView): string | null {
    const now = this.clock.now();

    return this.table?.reacting ? REACTION_TOO_SOON : reactionRefusal(liveReactions(view.reactions, now), view.you.id, now);
  }

  /** The player's own reaction shows at once, and is sent; one that gets no answer is simply gone. */
  private react(kind: string, to?: string): void {
    const view = this.shownView();
    if (!this.screen || !view || this.reactionRefusal(view) !== null) {
      return;
    }

    this.screen.shown.react({ from: view.you.id, kind, at: this.clock.now(), to });
    void this.send({ type: 'react', kind, to });
  }

  private drawTopbar(screen: TableScreen, view: TableView): void {
    const waiting = hostOrCohost(view) ? view.requests.length : 0;
    let state = '';

    if (view.hand) {
      state = `Hand #${view.hand.number}`;
    } else if (nightOver(view)) {
      state = 'Night over';
    } else if (!view.running) {
      state = view.handCount === 0 ? 'Not started' : 'Paused';
    }

    const blinds = blindsText(view.config);
    const ante = anteText(view.config);

    screen.topbar.draw([waiting, state, view.config.name, blinds, ante, view.config.voiceLink], () => [
      h('button.icon.menu-button', { type: 'button', 'aria-label': menuLabel(waiting), 'data-action': 'menu', onclick: () => this.openDialog({ kind: 'menu' }) }, '☰', waiting > 0 ? h('span.dot', null, String(waiting)) : null),
      // The ante takes the place of the word: a small phone has no room for both beside the hand's number.
      // It is a piece of its own, so where there is no room for it either it moves to the next line whole
      h('div.title', null, h('b', { role: 'heading', 'aria-level': '1', title: view.config.name }, view.config.name), ante ? h('span', null, `${blinds} `, h('span.ante', null, `· ${ante}`)) : h('span', null, `${blinds} hold’em`)),
      state ? h('span.pill', null, state) : null,
      voiceLinkEl(view.config.voiceLink),
      h('button.btn.small', { type: 'button', 'data-action': 'invite', onclick: () => this.openDialog({ kind: 'invite' }) }, 'Invite'),
    ]);
  }

  private drawBanners(screen: TableScreen, view: TableView): void {
    const requests = hostOrCohost(view) ? view.requests : [];

    const trouble = this.table?.trouble ?? null;
    const picking = screen.seatMoves.picking;

    const troubleText = { unreachable: 'Lost the connection to the table. Trying again…', struggling: 'The table is slow to answer. Trying again…' };

    const pickingFor = picking === null ? null : view.seats.find((seat) => seat?.playerId === picking);

    screen.banners.draw([trouble, requests, picking, pickingFor?.name, pickingFor?.inHand], () => [
      trouble ? h('div.banner.warn', null, troubleText[trouble]) : null,
      picking === null ? null : movePromptEl(view, picking, () => screen.seatMoves.cancel()),
      requests.map((request) => {
        const what = requestText(request, view.config);
        // Each says whose request it answers: several can be up at once, and a screen reader lands on a button without its line.
        // And each carries whose it is: the next row's buttons moving up into this one's place are other buttons, to the tap
        // guard and to the keyboard alike
        const approve = h('button.btn.small.primary', { type: 'button', 'data-action': 'approve', 'data-player': request.playerId, 'aria-label': `Approve ${request.name}` }, 'Approve');
        const deny = h('button.btn.small', { type: 'button', 'data-action': 'deny', 'data-player': request.playerId, 'aria-label': `Deny ${request.name}` }, 'Deny');

        approve.addEventListener('click', () => holdWhile(approve, () => this.send({ type: 'approve', playerId: request.playerId })));
        deny.addEventListener('click', () => holdWhile(deny, () => this.send({ type: 'deny', playerId: request.playerId })));

        return h('div.banner', null, h('span', null, h('b', null, request.name), ` ${what}`), approve, deny);
      }),
    ]);

    screen.banners.element.hidden = screen.banners.element.childElementCount === 0;

    if (trouble !== screen.troubleSaid) {
      screen.troubleSaid = trouble;

      if (trouble) {
        this.announcer.alert(troubleText[trouble]);
      }
    }
  }

  private drawStage(screen: TableScreen, view: TableView): void {
    const myRequest = view.requests.find((request) => request.playerId === view.you.id);
    const picking = screen.seatMoves.picking;
    const turning = screen.shown.turning;
    const chances = screen.shown.chances;
    const muted = screen.mutes.ids();
    const shows = [screen.shape, view.you, view.hostId, view.cohostIds, view.running, view.nextHandAt, view.nightEndedAt, view.config.actionSeconds, view.seats, handDrawn(view.hand), view.tonight.highHand.next, myRequest, picking, turning, chances, muted];

    screen.stage.draw(shows, () => {
      return tableEl(
        view,
        screen.shape,
        this.clock.offset,
        {
          onSit: (seat) => this.openDialog({ kind: 'sit', seat }),
          onStart: () => void this.send({ type: 'start' }),
          onPlayOn: () => void this.send({ type: 'playOn' }),
          onHunt: (hand) => void this.hunt(hand),
          moving: screen.seatMoves.tableHandlers(),
          muted: new Set(muted),
        },
        turning,
        chances,
      );
    });

    screen.seatMoves.redrawn();

    // On the part of the screen itself, not on what is drawn in it: marking a move must not draw the table again
    screen.stage.element.toggleAttribute('data-unconfirmed', screen.shown.waiting === 'unconfirmed');

    // For as long as the hands' chances are not those of the cards now on the table, which is what a browser check waits out
    screen.stage.element.toggleAttribute('data-chances-pending', screen.shown.chancesPending);

    this.tickCountdowns();
  }

  private reshape(): void {
    const screen = this.screen;
    if (!screen) {
      return;
    }

    const shape = shapeFor(screen.stage.element.getBoundingClientRect());

    if (shape !== screen.shape) {
      screen.shape = shape;

      const view = this.shownView();
      if (view) {
        this.drawStage(screen, view);
      }
    }

    // Once the table is drawn for the room it now has, never before: a new shape puts every seat a mark stands over somewhere else
    screen.marks.follow();
  }

  private tickCountdowns(): void {
    if (this.server.outdated) {
      return;
    }

    for (const element of this.root.querySelectorAll<HTMLElement>('[data-countdown]')) {
      element.textContent = String(secondsUntil(Number(element.dataset.countdown), this.clock.offset));
    }

    const screen = this.screen;
    const view = this.shownView();

    // The wait before the next reaction ends by the clock, with no view to draw it
    if (screen?.picker.isOpen && view) {
      screen.picker.draw(view);
    }

    // A move that has waited too long for its answer says so by the clock, with no view to draw it
    if (screen && (screen.shown.waiting === 'unconfirmed') !== screen.stage.element.hasAttribute('data-unconfirmed')) {
      this.drawShown();
    }

    const left = view && this.timeWarning.due(view, this.clock.now());
    if (left) {
      this.announcer.alert(timeSaid(left));
    }
  }

  // ---- Dialogs ----

  /** `byItself` is for a dialog the game opens or closes, not the player: what that brings up under a finger takes no tap for a moment (`TapGuard`). */
  private openDialog(dialog: Dialog, byItself = false): void {
    this.dialog = dialog;
    this.dialogOpenedItself = byItself;
    this.dialogOpens += 1;
    this.drawDialogAs(byItself);
  }

  private closeDialog(byItself = false): void {
    this.dialog = null;
    this.drawDialogAs(byItself);
  }

  private drawDialogAs(byItself: boolean): void {
    const taps = this.screen?.taps;

    if (byItself || !taps) {
      this.drawDialog();
    } else {
      taps.byThePlayer(() => this.drawDialog());
    }
  }

  private offerDialog(dialog: Dialog, still: (view: TableView) => boolean): void {
    // Open already, it is in front of them, and offering it would bring it back when they close it
    if (this.dialog?.kind === dialog.kind) {
      return;
    }

    this.offered = { dialog, still };
    this.showOffered();
  }

  /**
   * Takes away a dialog the page opened by itself (`DialogOffers.withdraw`). A dialog that closes hands
   * the keyboard back to where it was, or to the menu: here it goes to the bar, since the table is
   * what the viewer is being given back.
   */
  private withdrawDialog(kind: Dialog['kind']): boolean {
    if (this.dialog?.kind !== kind || !this.dialogOpenedItself) {
      return false;
    }

    this.closeDialog(true);
    this.screen?.controls.element.focus({ preventScroll: true });

    return true;
  }

  /** Whether something is in front of the table: a dialog, a seat being picked, or word that the page is out of date. */
  private tableCovered(): boolean {
    return this.server.outdated || this.dialog !== null || (this.screen?.seatMoves.active ?? false) || (this.screen?.replay.isOpen ?? false);
  }

  /** Whether the viewer is part way through typing a line, which anything that opens by itself would take the keyboard from. */
  private midLine(): boolean {
    const field = document.activeElement;

    return field instanceof HTMLInputElement && field.type === 'text' && field.value !== '';
  }

  /**
   * Opens the dialog that is waiting, once the viewer is free for it (`DialogOffers`). An answer the
   * table still owes them counts as busy: it may be what makes the dialog moot. Tried on every tick.
   */
  private showOffered(): void {
    const offered = this.offered;
    const view = this.shownView();
    if (!offered || !view || this.tableCovered() || this.sending > 0 || this.midLine()) {
      return;
    }

    this.offered = null;

    if (offered.still(view)) {
      this.openDialog(offered.dialog, true);
    }
  }

  private drawDialog(): void {
    const screen = this.screen;
    if (!screen) {
      return;
    }

    const view = this.shownView();
    if (this.dialog && view && !dialogAllowed(this.dialog, view)) {
      this.dialog = null;
    }

    const dialog = this.dialog;
    const covered = dialog !== null && view !== null;

    // The buttons the dialog covered are new to the player again
    if (!covered && !screen.overlay.element.hidden) {
      this.hotkeys.shown();
    }

    // The page under a dialog is covered and uncovered as the dialog is drawn or emptied, not before: whoever is told of the redraw sees the page as it was, and then as it is
    const cover = (covers: boolean) => {
      screen.overlay.element.hidden = !covers;
      screen.modal.update(covers);
    };

    if (!dialog || !view) {
      screen.overlay.draw(null, () => {
        cover(false);

        return null;
      });

      return;
    }

    // Opening a dialog always draws it; after that only a change in what it shows does
    const handlers = this.dialogHandlers();
    const body = () => screen.overlay.element.querySelector('.dialog-body');
    const scrolled = this.dialogDrawn === this.dialogOpens ? (body()?.scrollTop ?? 0) : 0;

    // Drawn again for what changed at the table, a dialog stays where its reader had scrolled to. Put back before the
    // tap guard looks at the dialog: it is the rows the reader has in sight that a finger may be on its way to
    screen.overlay.draw(
      [this.dialogOpens, dialogShows(dialog, view, handlers)],
      () => {
        screen.overlay.element.hidden = false;

        return dialogEl(dialog, view, handlers);
      },
      () => {
        if (scrolled > 0) {
          body()!.scrollTop = scrolled;
        }
      },
    );

    this.dialogDrawn = this.dialogOpens;
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
      replay: (record) => this.openReplay(record),
      presets: {
        list: () => this.listPresets(),
        save: (name, settings, replace) => this.changePresets({ op: 'savePreset', tableId: session.tableId, auth: session.auth, name, settings, replace }),
        remove: (name) => this.changePresets({ op: 'deletePreset', tableId: session.tableId, auth: session.auth, name }),
      },
      players: {
        list: () => this.listPlayers(),
        remembered: () => this.me.get(),
        identify: (as) => this.identify(session, as),
      },
      standings: (you) => this.standingsHandlers(you),
      tableLink: () => this.platform.links.tableLink(session.tableId),
      memberLink: () => this.platform.links.memberLink(session.tableId, session.auth),
      prefs: this.prefs,
      mutes: this.screen!.mutes,
      abilities: this.abilities,
      resizing: (change) => this.screen!.taps.byItself(change),
      toLobby: () => this.showLobby(true),
      pickSeat: (playerId) => {
        this.closeDialog();
        this.screen?.seatMoves.pick(playerId);
      },
    };
  }

  // ---- A hand played back ----

  /** Plays a finished hand back over the table. `byItself` when it comes seconds after it was asked for, under a finger that may be on its way to the bar by then. */
  private openReplay(record: HandRecord, byItself = false): void {
    const screen = this.screen;
    const view = this.shownView();
    const steps = view && replaySteps(record, view.config);
    if (!screen || !view || !steps) {
      return;
    }

    const show = () => screen.replay.show({ record, steps, table: view, kept: screen.dealt.of(view.you.id, record.number) });

    if (byItself) {
      screen.taps.byItself(show);
    } else {
      show();
    }
  }

  /**
   * Plays hand number `number` back from the history, as the bar under the table asks for the hand just
   * played, or says why it can't. A hand whose result is still up is not on record yet: it is played
   * back as soon as a view says it is, some seconds on, and the viewer is told so meanwhile. The hand
   * before it is on record, and is not the one they asked for. `unasked` is that later playing back,
   * which no tap of this moment asks for.
   */
  private async replayHand(number: number, unasked = false): Promise<void> {
    const asked = this.shownView();

    if (asked && number > lastOnRecord(asked)) {
      this.replayWanted = number;
      this.toast(`Hand #${number} plays back as soon as it is cleared from the table.`);

      return;
    }

    // The bar can be drawn again while the hand is fetched, with its button live: a second tap adds nothing to the first
    if (this.fetchingReplay) {
      return;
    }

    const leaves = this.leaves;

    this.fetchingReplay = true;
    const hands = await this.loadHistory().catch(() => null);
    this.fetchingReplay = false;

    const view = this.shownView();

    // They left the table meanwhile, perhaps for another, whose hands have the same numbers
    if (!view || leaves !== this.leaves) {
      return;
    }

    // The game came to wait on them meanwhile: a replay they asked for while free is not put over their move
    if (neededBy(view)) {
      this.toast(`Your turn. Hand #${number} is in the hand history.`);

      return;
    }

    // Seconds after the tap that asked for it, it takes the place of nothing they have opened since, nor the keyboard from a line half typed
    if (unasked && (this.tableCovered() || this.midLine())) {
      this.toast(`Hand #${number} is in the hand history.`);

      return;
    }

    const record = hands?.find((hand) => hand.number === number);

    if (!record) {
      this.toast(hands ? `Hand #${number} is not in the history yet. Try again in a moment.` : 'Could not load the hand. Try again, or open the hand history from the menu.');

      return;
    }

    // The same line the history has in place of its button, for a hand whose record does not tell it
    const refusal = noReplayLine(record, view.config);

    if (refusal === null) {
      this.openReplay(record, unasked);

      if (unasked) {
        this.announcer.status(replayOpenedSaid(number));
      }
    } else {
      this.toast(refusal);
    }
  }

  /** Plays back the hand that was asked for before it was on record, once a view put on screen says it is there. */
  private replayOnceRecorded(view: TableView): void {
    const wanted = this.replayWanted;

    if (wanted !== null && lastOnRecord(view) >= wanted) {
      this.replayWanted = null;
      void this.replayHand(wanted, true);
    }
  }

  /** Takes a hand being played back off the table, and the history it was opened from, for the game to have the viewer (`ReplaySetAside`). */
  private setReplayAside(): boolean {
    const screen = this.screen;

    if (!screen?.replay.isOpen) {
      return false;
    }

    // The replay is no slot's to draw, so the guard is told here: the turn's buttons come up where the replay's lay
    screen.taps.byItself(() => {
      screen.replay.setAside();
      this.closeDialog(true);
    });

    return true;
  }

  private async loadHistory(): Promise<HandRecord[]> {
    const session = this.table?.session;
    const response = session ? await this.request({ op: 'history', tableId: session.tableId, auth: session.auth }) : null;

    if (response?.ok && response.kind === 'history') {
      return response.hands;
    }

    throw new Error('The hand history could not be loaded');
  }

  private async listPresets(): Promise<Preset[]> {
    const response = await this.request({ op: 'presets' });

    if (response?.ok && response.kind === 'presets') {
      return response.presets;
    }

    throw new Error('The presets could not be loaded');
  }

  /** The players the game knows. What the browser remembers of who it is, is held to them on the way. */
  private async listPlayers(): Promise<Listed> {
    const response = await this.request({ op: 'players' });

    if (response?.ok && response.kind === 'players') {
      return { players: response.players, remembered: this.me.heldTo(response.players) };
    }

    throw new Error('The list of players could not be loaded');
  }

  /** Tells the table which known player this member is. Resolves to whether it took that; if not, the player is told why. */
  private async identify(session: Session, as: Answer): Promise<boolean> {
    const response = await this.request({ op: 'identify', tableId: session.tableId, auth: session.auth, ...as });

    if (response?.ok && response.kind === 'view' && response.view.you.identity !== null) {
      const now = playerFor(response.view.you.identity, as);

      this.me.set(now);
      this.toast(`Noted: on the list of players you are ${now.name}.`);
      return true;
    }

    // A refusal here says nothing about the player's seat, so it never takes them from the table
    this.fail(response && !response.ok ? response.error : 'No answer from the server. Try again in a moment.');

    return false;
  }

  /** The presets after a change, or null when it was refused or got no answer, which the player is told. */
  private async changePresets(request: ApiRequest): Promise<Preset[] | null> {
    const response = await this.request(request);

    if (response?.ok && response.kind === 'presets') {
      return response.presets;
    }

    // A refusal here says nothing about the player's seat, so it never takes them from the table
    this.fail(response && !response.ok ? response.error : 'No answer from the server. Checking the presets…');

    return null;
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

  /** A passing word at the top of the screen, said to a screen reader when it is free. */
  private toast(message: string): void {
    this.showToast(message);
    this.announcer.toast(message);
  }

  /** Word that something did not go as asked: shown like any other, and said to a screen reader at once. */
  private fail(message: string): void {
    this.showToast(message);
    this.announcer.alert(message);
  }

  private showToast(message: string): void {
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

  private visitor(): Visitor {
    return { name: this.platform.memory.get(NAME_KEY) ?? '', player: this.me.get() };
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
