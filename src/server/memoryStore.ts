import type { Effect, HandRecord, LedgerEntry, NightEnd, TableState } from '../engine/index.ts';
import { dueToLookAt, lastWordsOf, PUT_AWAY_AT_ONCE } from './putAway.ts';
import type { LastWords } from './putAway.ts';
import { peekOf, restoreState } from './store.ts';
import type { TablePeek, TableStore, Txn } from './store.ts';

interface Kept {
  json: string;
  changedAt: number;
}

/**
 * Keeps tables in memory, for local play and tests. Tables are held as JSON so nothing a caller does to
 * a state object can reach the saved copy, and so anything that doesn't survive JSON shows up here first.
 */
export class MemoryStore implements TableStore {
  readonly ledger: LedgerEntry[] = [];
  readonly hands: HandRecord[] = [];
  readonly nightsEnded: NightEnd[] = [];
  private readonly tables = new Map<string, Kept>();
  private readonly putAway = new Set<string>();

  transact<T>(tableId: string, fn: (state: TableState | null) => Txn<T>): T {
    const txn = fn(this.read(tableId));

    if (txn.save !== null) {
      this.tables.set(txn.save.id, { json: JSON.stringify(txn.save), changedAt: txn.at });
      this.keep(txn.effects);
    }

    return txn.result;
  }

  read(tableId: string): TableState | null {
    const kept = this.tables.get(tableId);

    return kept === undefined ? null : restoreState(kept.json);
  }

  peek(tableId: string): TablePeek | null {
    const state = this.read(tableId);

    return state ? peekOf(state) : null;
  }

  recentHands(tableId: string, limit: number): HandRecord[] {
    return this.hands.filter((hand) => hand.tableId === tableId).slice(-limit);
  }

  putAwayOld(now: number, lastWords: LastWords): void {
    const tables = [...this.tables].map(([id, kept]) => ({ id, ...kept }));

    for (const { id, json } of dueToLookAt(tables, now).slice(0, PUT_AWAY_AT_ONCE)) {
      this.keep(lastWordsOf(restoreState(json), now, lastWords));
      this.putAway.add(id);
      this.tables.delete(id);
    }
  }

  wasPutAway(tableId: string): boolean {
    return this.putAway.has(tableId);
  }

  private keep(effects: Effect[]): void {
    for (const effect of effects) {
      if (effect.type === 'ledger') {
        this.ledger.push(effect.entry);
      } else if (effect.type === 'hand') {
        this.hands.push(effect.record);
      } else {
        this.nightsEnded.push(effect.night);
      }
    }
  }
}
