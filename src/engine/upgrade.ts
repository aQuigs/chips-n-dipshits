import { STATE_SCHEMA } from './types.ts';
import type { TableState } from './types.ts';

/**
 * One step per schema number, taking a table saved with that schema to the next one. A step only fills
 * in what the newer shape added, so it can treat what it is given as a table.
 */
const STEPS: Record<number, (state: TableState) => void> = {
  2: (state) => {
    if (state.hand) {
      state.hand.bounty = state.config.sevenDeuceBounty;
    }
  },
};

/** Brings a saved table up to the shape this code reads, so a game in progress survives a new version. */
export function upgradeState(saved: TableState): TableState {
  while (saved.schema !== STATE_SCHEMA) {
    const step = STEPS[saved.schema];
    if (!step) {
      throw new Error(`Table ${saved.id} was saved with schema ${saved.schema}, and this code only knows the way to schema ${STATE_SCHEMA} from ${Object.keys(STEPS).join(', ')}`);
    }

    step(saved);
    saved.schema += 1;
  }

  return saved;
}
