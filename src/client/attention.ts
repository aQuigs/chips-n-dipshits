import type { Abilities, Ability, AppPreferences } from './prefs.ts';

/** Why the page wants a player: it is their turn. Another reason, such as being named in the chat, is another value here. */
export type Why = 'turn';

/**
 * What the page asks for a player's attention for: which table, and why. It never carries cards or
 * amounts, since a notification shows on a phone's lock screen.
 */
export interface Call {
  why: Why;
  table: { id: string; name: string };
}

/** One way of getting a player's attention: a chime, a buzz, a flash, a notification, the tab's title. */
export interface AttentionWay {
  /** Whether this device, on this page, can do it, as the Preferences dialog shows it. */
  ability(): Ability;
  /** Only called while the ability is 'yes' and the player has the way switched on. */
  call(call: Call): void;
  /** `call` no longer stands, as when the player acted or the turn passed: takes back whatever still shows for it. */
  end(call: Call): void;
  /** For an ability of 'ask': asks the browser's leave. Only ever called from the player's own tap. */
  ask?(): Promise<Ability>;
}

/** Each way, under the on/off preference that switches it. */
export type AttentionWays = Record<'sound' | 'buzz' | 'flash' | 'notify' | 'tabTitle', AttentionWay>;

/**
 * The ways one viewer's attention is got. Whatever wants the player calls here with a reason, and
 * every way that this device can do and the player has switched on answers it.
 */
export class Attention implements Abilities {
  private readonly prefs: AppPreferences;
  private readonly ways: AttentionWays;

  constructor(prefs: AppPreferences, ways: AttentionWays) {
    this.prefs = prefs;
    this.ways = ways;
  }

  call(call: Call): void {
    for (const [key, way] of this.entries()) {
      if (this.prefs.get(key) && way.ability() === 'yes') {
        this.each(() => way.call(call));
      }
    }
  }

  /** Every way hears it, so what was showing goes away even if the player switched the way off since. */
  end(call: Call): void {
    for (const [, way] of this.entries()) {
      this.each(() => way.end(call));
    }
  }

  of(key: string): Ability {
    return this.way(key)?.ability() ?? 'yes';
  }

  async ask(key: string): Promise<Ability> {
    const way = this.way(key);

    return way?.ask ? way.ask() : this.of(key);
  }

  private way(key: string): AttentionWay | undefined {
    return Object.hasOwn(this.ways, key) ? this.ways[key as keyof AttentionWays] : undefined;
  }

  private entries(): [keyof AttentionWays, AttentionWay][] {
    return Object.entries(this.ways) as [keyof AttentionWays, AttentionWay][];
  }

  // One way the browser refuses must not keep the others from getting the player's attention
  private each(act: () => void): void {
    try {
      act();
    } catch (error) {
      console.error(error);
    }
  }
}
