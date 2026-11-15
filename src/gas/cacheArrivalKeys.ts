import { ARRIVAL_KEY_SECONDS, isKeptArrival } from '../server/arrivalKeys.ts';
import type { ArrivalKeys, KeptArrival } from '../server/arrivalKeys.ts';
import type { CacheLike } from './sheets.ts';

export interface CacheArrivalKeysDeps {
  cache: CacheLike;
}

// A name nothing else in the cache has, and no version before this one reads
const entryOf = (key: string) => `arrival:${key}`;

/**
 * Keeps the keys in the script cache, which every run of the script shares and which lets an entry
 * go by itself. The table's own transaction is what orders two askings: both are made under the
 * script lock, so the second finds what the first kept.
 */
export class CacheArrivalKeys implements ArrivalKeys {
  private readonly deps: CacheArrivalKeysDeps;

  constructor(deps: CacheArrivalKeysDeps) {
    this.deps = deps;
  }

  find(key: string): KeptArrival | null {
    const kept = this.deps.cache.get(entryOf(key));
    if (kept === null) {
      return null;
    }

    try {
      const arrival: unknown = JSON.parse(kept);

      return isKeptArrival(arrival) ? arrival : null;
    } catch {
      // Not something this code kept, so not an arrival
      return null;
    }
  }

  keep(key: string, arrival: KeptArrival): void {
    this.deps.cache.put(entryOf(key), JSON.stringify(arrival), ARRIVAL_KEY_SECONDS);
  }
}
