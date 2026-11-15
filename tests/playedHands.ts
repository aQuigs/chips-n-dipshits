/*
 * Hands played at random to their end, each with what one of its players saw of it as it went: what a
 * test of anything that plays a hand back holds the playback against.
 */
import { SEAT_COUNT, viewFor } from '../src/engine/index.ts';
import type { Card, HandRecord, TableView } from '../src/engine/index.ts';
import { handRecords, seededRng, TestTable } from './helpers.ts';
import { fixedSettings, randomConfig } from './randomConfig.ts';
import { chance, randomStep } from './randomPlay.ts';

export interface PlayedHand {
  record: HandRecord;
  /** The two cards each seat was dealt. */
  holes: Map<number, Card[]>;
  /** The player whose views were kept, who was dealt in. */
  watcher: string;
  /** The table as the watcher saw it, by how many of the hand's events had happened. */
  seen: Map<number, TableView>;
  /** The table as the watcher sees it once the hand is cleared away. */
  after: TableView;
  /** A member who was not dealt in, and the table as they see it then. Null when everyone was. */
  bystander: TableView | null;
}

/** Every hand of `tables` random tables played for `steps` steps each, in the order they ended. */
export function playedHands(tables: number, steps: number): PlayedHand[] {
  const played: PlayedHand[] = [];

  for (let seed = 1; seed <= tables; seed++) {
    const rng = seededRng(seed * 6247);
    const players = 2 + rng.int(SEAT_COUNT - 1);
    const stacks = Array.from({ length: players }, () => (chance(rng, 15) ? 1 + rng.int(30) : 100 + rng.int(1900)));
    const config = randomConfig(rng);
    const t = new TestTable({ stacks, seed, config: fixedSettings(config) });
    const live = new Map<number, Pick<PlayedHand, 'holes' | 'watcher' | 'seen'>>();
    let recorded = 0;

    t.cmd(0, { type: 'updateConfig', config });
    t.cmd(0, { type: 'start' });

    for (let step = 0; step < steps; step++) {
      randomStep(t, rng);

      const hand = t.state.hand;
      if (hand && hand.events.length > 0) {
        const mine = live.get(hand.number) ?? { holes: new Map(hand.players.map((player) => [player.seat, [...player.cards]])), watcher: hand.players[0]!.playerId, seen: new Map<number, TableView>() };

        live.set(hand.number, mine);
        mine.seen.set(hand.events.length, structuredClone(viewFor(t.state, mine.watcher, t.now)));
      }

      for (const record of handRecords(t.effects).slice(recorded)) {
        const mine = live.get(record.number);
        const out = t.state.members.find((member) => !record.players.some((player) => player.playerId === member.id));

        recorded += 1;
        if (mine) {
          played.push({ record: structuredClone(record), ...mine, after: structuredClone(viewFor(t.state, mine.watcher, t.now)), bystander: out ? structuredClone(viewFor(t.state, out.id, t.now)) : null });
        }
      }
    }
  }

  return played;
}
