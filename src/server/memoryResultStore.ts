import type { TableResults, Unit } from '../engine/index.ts';
import { nightsIn, nightsOf, recordsOf } from './resultStore.ts';
import type { NightResult, PlayedNight, ResultStore, ResultWriter, Standings } from './resultStore.ts';

/** Keeps what tables came to in memory, for local play and tests. Held as JSON, like the tables of `MemoryStore`. `now` says when the standings are read. */
export class MemoryResultStore implements ResultStore, ResultWriter {
  private readonly kept = new Map<string, string>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  standings(): Standings {
    return { asOf: this.now(), records: recordsOf(this.rows()) };
  }

  nights(playerId: string, unit: Unit): PlayedNight[] {
    return nightsOf(this.rows(), playerId, unit);
  }

  written(): Map<string, number> {
    return new Map(this.tables().map((table) => [table.tableId, table.version]));
  }

  write(results: readonly TableResults[]): void {
    for (const table of results) {
      if (table.players.length > 0) {
        this.kept.set(table.tableId, JSON.stringify(table));
      } else {
        this.kept.delete(table.tableId);
      }
    }
  }

  /** Every row kept, in the order their tables were first written. */
  rows(): NightResult[] {
    return this.tables().flatMap(nightsIn);
  }

  private tables(): TableResults[] {
    return [...this.kept.values()].map((json) => JSON.parse(json) as TableResults);
  }
}
