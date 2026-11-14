import { playerName } from '../engine/index.ts';
import type { KnownPlayer, Rng } from '../engine/index.ts';
import { dueToBeSeen, inListOrder, listed, newcomer } from './playerStore.ts';
import type { KeptPlayer, PlayerStore } from './playerStore.ts';

/** Keeps the known players in memory, for local play and tests. `rng` is where their ids come from: one of its own wherever the game's is seeded, so that a new player changes no card dealt after. */
export class MemoryPlayerStore implements PlayerStore {
  private readonly kept: KeptPlayer[] = [];
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  list(): KnownPlayer[] {
    return inListOrder(this.kept);
  }

  seen(id: string, at: number): KnownPlayer | null {
    const found = this.kept.find((player) => player.id === id);
    if (!found) {
      return null;
    }

    if (dueToBeSeen(found, at)) {
      found.seenAt = at;
    }

    return listed(found);
  }

  add(name: string, at: number): KnownPlayer {
    const added = newcomer(this.kept, this.kept.length, playerName(name), at, this.rng);
    this.kept.push(added);

    return listed(added);
  }
}
