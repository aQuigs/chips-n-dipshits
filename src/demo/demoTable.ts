import { freshDeck, TIMING } from '../engine/index.ts';
import type { BettingOptions, Card, Command, HandView, TableView } from '../engine/index.ts';
import type { ApiRequest, ApiResponse, Auth } from '../server/api.ts';
import { ByteRng } from '../server/byteRng.ts';
import { MemoryPresetStore } from '../server/memoryPresetStore.ts';
import { MemoryStore } from '../server/memoryStore.ts';
import { PokerService } from '../server/service.ts';

const RANDOM_BATCH_BYTES = 256;
const MAX_HOLD_MS = 20_000;
const HOLD_CHECK_MS = 120;

// Slow enough to follow, quick enough that a hand against bots doesn't drag
const BOT_THINK_MS = 1100;

// The poker word for the player whose eyes a hand is seen through
const YOU = { name: 'Hero', seat: 0, buyIn: 2000 };

const BOTS = [
  { name: 'Marge', seat: 1, buyIn: 1460 },
  { name: 'Danny', seat: 3, buyIn: 2000 },
  { name: 'Stu', seat: 5, buyIn: 1880 },
  { name: 'Big Al', seat: 6, buyIn: 1240 },
  { name: 'Pocket Pam', seat: 8, buyIn: 920 },
];

// The opening hand is fixed so the table opens on a real decision: top pair and the nut flush draw, facing a bet
const OPENING_HOLES: Record<string, [Card, Card]> = {
  Hero: ['As', 'Ks'],
  Marge: ['7c', '2d'],
  Danny: ['9h', '9d'],
  Stu: ['Kd', 'Qd'],
  'Big Al': ['Js', 'Ts'],
  'Pocket Pam': ['8c', '3h'],
};
const OPENING_BOARD: Card[] = ['Kh', '9s', '4s', '2s', '7d'];

// Played out before anyone is looking, in turn order with Hero on the button
const OPENING_ACTIONS: [name: string, command: Command][] = [
  ['Stu', { type: 'raise', to: 60 }],
  ['Big Al', { type: 'call' }],
  ['Pocket Pam', { type: 'fold' }],
  ['Hero', { type: 'call' }],
  ['Marge', { type: 'fold' }],
  ['Danny', { type: 'call' }],
  ['Danny', { type: 'check' }],
  ['Stu', { type: 'raise', to: 160 }],
  ['Big Al', { type: 'call' }],
];

/** A table that lives in the page: the real game service, five bots, and no network. */
export interface DemoTable {
  tableId: string;
  /** The seat the person at the page plays. They are the host. */
  you: Auth;
  /** Answers requests the way the deployed backend would. */
  send(request: ApiRequest): Promise<ApiResponse>;
  /** Lets one bot do the one thing it is being waited on for. Returns whether a bot acted. */
  step(): boolean;
  /** Starts the bots playing by themselves. */
  start(): void;
  stop(): void;
}

export interface DemoOptions {
  now?: () => number;
  /** A number from 0 up to 1, for the bots' choices. */
  random?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Loose and passive: checks, calls most bets, folds more often the more a call costs, and now and then bets or raises. */
function botMove(options: BettingOptions, hand: HandView, roll: number): Command {
  if (options.canCheck) {
    if (options.canRaise && roll < 0.3) {
      const halfPot = hand.currentBet + Math.round(hand.pot / 2);

      return { type: 'raise', to: Math.min(options.maxRaiseTo, Math.max(options.minRaiseTo, halfPot)) };
    }

    return { type: 'check' };
  }

  const price = options.callCost / (hand.pot + options.callCost);
  if (roll < price) {
    return { type: 'fold' };
  }

  return options.canRaise && roll > 0.93 ? { type: 'raise', to: options.minRaiseTo } : { type: 'call' };
}

export function createDemoTable(options: DemoOptions = {}): DemoTable {
  const realNow = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;

  // The table's clock can be pushed ahead of the real one, to skip the wait before the first hand
  let ahead = 0;
  const store = new MemoryStore();
  const service = new PokerService({
    store,
    presets: new MemoryPresetStore(),
    clock: { now: () => realNow() + ahead },
    rng: new ByteRng(() => [...crypto.getRandomValues(new Uint8Array(RANDOM_BATCH_BYTES))]),
  });

  const ask = (request: ApiRequest): ApiResponse => service.handle(request);

  const expectView = (response: ApiResponse): TableView => {
    if (!response.ok) {
      throw new Error(`The demo table could not be set up: ${response.error}`);
    }

    if (response.kind !== 'view' && response.kind !== 'joined') {
      throw new Error(`The demo table got an unexpected ${response.kind} answer`);
    }

    return response.view;
  };

  // ---- Seat everyone ----
  const created = ask({ op: 'create', name: YOU.name, config: { actionSeconds: 0 } });
  if (!created.ok || created.kind !== 'joined') {
    throw new Error('The demo table could not be created');
  }

  const tableId = created.view.id;
  const you = created.auth;
  const authByName = new Map<string, Auth>([[YOU.name, you]]);
  const act = (name: string, command: Command) => expectView(ask({ op: 'act', tableId, auth: authByName.get(name)!, command }));

  act(YOU.name, { type: 'requestSeat', seat: YOU.seat, buyIn: YOU.buyIn });

  for (const bot of BOTS) {
    const joined = ask({ op: 'join', tableId, name: bot.name });
    if (!joined.ok || joined.kind !== 'joined') {
      throw new Error(`${bot.name} could not join the demo table`);
    }

    authByName.set(bot.name, joined.auth);
    act(bot.name, { type: 'requestSeat', seat: bot.seat, buyIn: bot.buyIn });
    act(YOU.name, { type: 'approve', playerId: joined.auth.id });
  }

  const botAuthBySeat = new Map(BOTS.map((bot) => [bot.seat, authByName.get(bot.name)!]));

  // ---- Deal the opening hand and play it up to the first decision ----
  store.transact(tableId, (state) => {
    // The button moves one seat on when the hand starts, which puts it on Hero
    state!.buttonSeat = BOTS[BOTS.length - 1]!.seat;

    return { save: state, effects: [], result: null };
  });

  act(YOU.name, { type: 'start' });
  ahead += TIMING.startDelayMs;
  expectView(ask({ op: 'poll', tableId, auth: you, since: -1 }));

  store.transact(tableId, (state) => {
    const hand = state!.hand!;
    const fixed = new Set<Card>([...Object.values(OPENING_HOLES).flat(), ...OPENING_BOARD]);

    for (const player of hand.players) {
      player.cards = [...OPENING_HOLES[player.name]!];
    }

    // The next card is taken from the end of the deck
    hand.deck = [...freshDeck().filter((card) => !fixed.has(card)), ...[...OPENING_BOARD].reverse()];

    return { save: state, effects: [], result: null };
  });

  for (const [name, command] of OPENING_ACTIONS) {
    act(name, command);
  }

  // ---- The bots from here on ----
  const viewAs = (auth: Auth): TableView | null => {
    const response = ask({ op: 'poll', tableId, auth, since: -1 });

    return response.ok && response.kind === 'view' ? response.view : null;
  };

  const botCommand = (view: TableView): Command | null => {
    const hand = view.hand;
    const seat = view.you.seat === null ? null : view.seats[view.you.seat];

    if (hand?.options) {
      return botMove(hand.options, hand, random());
    }

    if (hand?.canVote) {
      return { type: 'ritVote', agree: true };
    }

    if (seat?.away || seat?.sittingOut) {
      return { type: 'sitIn' };
    }

    // Out of chips between hands: ask the host, who is the person at the page, for more
    const waiting = view.requests.some((request) => request.playerId === view.you.id);
    if (seat && seat.stack === 0 && seat.pendingAdd === 0 && !seat.inHand && !waiting) {
      return { type: 'requestRebuy', amount: Math.ceil(view.config.maxBuyIn / 2) };
    }

    return null;
  };

  const step = (): boolean => {
    for (const auth of botAuthBySeat.values()) {
      const view = viewAs(auth);
      const command = view ? botCommand(view) : null;

      if (command) {
        return ask({ op: 'act', tableId, auth, command }).ok;
      }
    }

    return false;
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  return {
    tableId,
    you,
    step,

    async send(request) {
      if (request.op === 'poll' && request.holdMs) {
        const until = realNow() + Math.min(request.holdMs, MAX_HOLD_MS);

        while (!stopped && realNow() < until && !service.hasNews(request.tableId, request.since)) {
          await sleep(HOLD_CHECK_MS);
        }
      }

      // Through JSON, as over the wire, so the page never shares an object with the table
      return JSON.parse(JSON.stringify(ask(request))) as ApiResponse;
    },

    start() {
      timer ??= setInterval(step, BOT_THINK_MS);
    },

    stop() {
      stopped = true;

      if (timer !== null) {
        clearInterval(timer);
      }
    },
  };
}
