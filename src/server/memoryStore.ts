import type { HandRecord, LedgerEntry, TableState } from '../engine/index.ts';
import { peekOf, restoreState } from './store.ts';
import type { TablePeek, TableStore, Txn } from './store.ts';

/**
 * Keeps tables in memory, for local play and tests. Tables are held as JSON so nothing a caller does to
 * a state object can reach the saved copy, and so anything that doesn't survive JSON shows up here first.
 */
export class MemoryStore implements TableStore {
  readonly ledger: LedgerEntry[] = [];
  readonly hands: HandRecord[] = [];
  private readonly tables = new Map<string, string>();

  transact<T>(tableId: string, fn: (state: TableState | null) => Txn<T>): T {
    const txn = fn(this.read(tableId));

    if (txn.save) {
      this.tables.set(txn.save.id, JSON.stringify(txn.save));

      for (const effect of txn.effects) {
        if (effect.type === 'ledger') {
          this.ledger.push(effect.entry);
        } else {
          this.hands.push(effect.record);
        }
      }
    }

    return txn.result;
  }

  read(tableId: string): TableState | null {
    const json = this.tables.get(tableId);

    return json === undefined ? null : restoreState(json);
  }

  peek(tableId: string): TablePeek | null {
    const state = this.read(tableId);

    return state ? peekOf(state) : null;
  }

  recentHands(tableId: string, limit: number): HandRecord[] {
    return this.hands.filter((hand) => hand.tableId === tableId).slice(-limit);
  }
}
