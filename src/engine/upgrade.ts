import { DEFAULT_CONFIG } from './config.ts';
import { STATE_SCHEMA } from './types.ts';
import type { Hand, HandPlayer, HandRecord, Member, Seat, TableState } from './types.ts';

/**
 * One step per schema number, taking a table saved with that schema to the next one. A step is for a
 * change of shape: a field renamed, retyped or removed. It can treat what it is given as a table.
 */
const STEPS: Record<number, (state: TableState) => void> = {
  2: (state) => {
    if (state.hand) {
      state.hand.bounty = state.config.sevenDeuceBounty;
    }
  },
};

interface SavedDefaults {
  table(): Partial<TableState>;
  member(): Partial<Member>;
  seat(): Partial<Seat>;
  hand(): Partial<Hand>;
  handPlayer(): Partial<HandPlayer>;
  record(): Partial<HandRecord>;
}

/**
 * The default of every field added to what is saved since schema 3, by where it lives. A table or a
 * hand record saved before the field existed is given it when read, so a change that only adds a field
 * puts its default here and leaves the schema number alone. A setting is not listed: its default is in
 * the config registry. Each entry is a function so that no two tables are handed the same list.
 */
export const SAVED_DEFAULTS: SavedDefaults = {
  table: () => ({ cohostIds: [], shuffleAfterHand: false }),
  member: () => ({}),
  seat: () => ({ moveTo: null }),
  hand: () => ({ events: [] }),
  handPlayer: () => ({ dead: 0 }),
  record: () => ({ events: [] }),
};

function fillMissing<T extends object>(saved: T, defaults: Partial<T>): void {
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    if (saved[key] === undefined) {
      saved[key] = defaults[key]!;
    }
  }
}

function fillDefaults(table: TableState): void {
  fillMissing(table, SAVED_DEFAULTS.table());
  fillMissing(table.config, DEFAULT_CONFIG);

  for (const member of table.members) {
    fillMissing(member, SAVED_DEFAULTS.member());
  }

  for (const seat of table.seats) {
    if (seat) {
      fillMissing(seat, SAVED_DEFAULTS.seat());
    }
  }

  if (table.hand) {
    fillMissing(table.hand, SAVED_DEFAULTS.hand());

    for (const player of table.hand.players) {
      fillMissing(player, SAVED_DEFAULTS.handPlayer());
    }
  }
}

/**
 * Brings a saved table up to the shape this code reads, so a game in progress survives a new version:
 * first the steps, for what changed shape, then the defaults, for what was added.
 */
export function upgradeState(saved: TableState): TableState {
  while (saved.schema !== STATE_SCHEMA) {
    const step = STEPS[saved.schema];
    if (!step) {
      throw new Error(`Table ${saved.id} was saved with schema ${saved.schema}, and this code only knows the way to schema ${STATE_SCHEMA} from ${Object.keys(STEPS).join(', ')}`);
    }

    step(saved);
    saved.schema += 1;
  }

  fillDefaults(saved);

  return saved;
}

/** Gives a hand record saved by older code the fields added since. */
export function upgradeRecord(saved: HandRecord): HandRecord {
  fillMissing(saved, SAVED_DEFAULTS.record());

  return saved;
}
