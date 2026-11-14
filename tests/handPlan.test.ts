/*
 * The one place that decides a hand's button, its players and what they post, driven hand after hand
 * with no cards dealt: each case is a table, what happens at it between hands, and what the plan for
 * every hand says.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { comingIn, eligibleSeats, planHand, takeUp } from '../src/engine/index.ts';
import type { HandPlan, TableConfig, TableState } from '../src/engine/index.ts';
import { TestTable } from './helpers.ts';

/** What happens at the table between two hands. A player is named by the seat they first sat in. */
type Step =
  | ['out', number]
  /** Sits back in to wait for the big blind. */
  | ['in', number]
  /** Sits back in to post what they owe. */
  | ['post', number]
  | ['bust', number]
  | ['rebuy', number]
  /** A new player takes a seat, and from then on is named by it. */
  | ['arrive', number]
  | ['leave', number]
  | ['move', number, number]
  | ['shuffle']
  | ['set', Partial<TableConfig>]
  | ['forgive', number]
  /** The next hand is a bomb pot. */
  | ['bomb'];

interface Case {
  name: string;
  /** The seats taken when the first hand is dealt, which starts with the button on `button`. */
  seats: number[];
  button: number;
  config?: Partial<TableConfig>;
  /**
   * Hands and what happens between them. A hand is what its plan should say:
   * `D1 S2 B3 | in 0 1 2 3 | posts 4:BB+SB | waits 5:big blind | owes 6:BB`, the last three only when
   * there is something to say. `x` after a seat means nobody is dealt in there: a dead button, or no small blind.
   */
  play: (string | Step)[];
}

const debt = (bigBlind: boolean, smallBlind: boolean) => [bigBlind ? 'BB' : '', smallBlind ? 'SB' : ''].filter(Boolean).join('+');

function told(plan: HandPlan): string {
  const dealtIn = [...plan.order].sort((a, b) => a - b);
  const mark = (seat: number) => `${seat}${dealtIn.includes(seat) ? '' : 'x'}`;
  const posted = (seat: number, what: string) => plan.bets.some((bet) => bet.seat === seat && bet.what === what);
  const posts = (plan.posting ?? []).map((seat) => `${seat}:${debt(posted(seat, 'missed big blind'), posted(seat, 'dead small blind'))}`);

  return [
    `D${mark(plan.button)} S${mark(plan.sbSeat)} B${plan.bbSeat}`,
    `in ${dealtIn.join(' ')}`,
    posts.length > 0 ? `posts ${posts.join(' ')}` : '',
    plan.held.length > 0 ? `waits ${plan.held.map((held) => `${held.seat}:${held.for}`).join(' ')}` : '',
    plan.owing.length > 0 ? `owes ${plan.owing.map((owed) => `${owed.seat}:${debt(owed.bigBlind, owed.smallBlind)}`).join(' ')}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

/** A table with a player in each of `seats`, each known from then on by that seat, before its first hand. */
class Planned {
  t: TestTable;
  /** The seat each player is named by: the one they had for the first hand, or took when they arrived. */
  private first: number[];
  private bombPot = false;

  constructor(seats: number[], button: number, config: Partial<TableConfig> = {}) {
    this.t = new TestTable({ stacks: seats.map(() => 1000), seats, config });

    this.first = [...seats];
    this.state.buttonSeat = (button + 9) % 10;
  }

  get state(): TableState {
    return this.t.state;
  }

  private player(firstSeat: number): number {
    const player = this.first.indexOf(firstSeat);
    assert.ok(player >= 0, `nobody first sat in seat ${firstSeat}`);

    return player;
  }

  private seatOf(firstSeat: number) {
    return this.state.seats.find((seat) => seat?.playerId === this.t.ids[this.player(firstSeat)])!;
  }

  apply(step: Step): void {
    const { t } = this;

    switch (step[0]) {
      case 'out':
        return t.cmd(this.player(step[1]), { type: 'sitOut' });

      case 'in':
        return t.cmd(this.player(step[1]), { type: 'comeIn', post: false });

      case 'post':
        return t.cmd(this.player(step[1]), { type: 'comeIn', post: true });

      case 'bust':
        return t.cmd(0, { type: 'setStack', playerId: t.ids[this.player(step[1])]!, stack: 0 });

      case 'rebuy':
        return t.cmd(0, { type: 'setStack', playerId: t.ids[this.player(step[1])]!, stack: 1000 });

      case 'arrive':
        this.first.push(step[1]);
        t.sitDown(`N${step[1]}`, step[1]);
        return;

      case 'leave': {
        const player = this.player(step[1]);

        // Whoever takes the seat next is the one it names from then on
        this.first[player] = -1;

        return t.cmd(player, { type: 'standUp' });
      }

      case 'move':
        return t.cmd(0, { type: 'moveSeat', playerId: t.ids[this.player(step[1])]!, seat: step[2] });

      case 'shuffle':
        return t.cmd(0, { type: 'shuffleSeats' });

      case 'set':
        return t.cmd(0, { type: 'updateConfig', config: step[1] });

      case 'forgive':
        return t.cmd(0, { type: 'forgiveBlinds', playerId: t.ids[this.player(step[1])]! });

      case 'bomb':
        this.bombPot = true;
    }
  }

  /** Plans the next hand and has the table take it up, as dealing it would. */
  deal(): HandPlan {
    const plan = planHand(this.state, this.bombPot ? { amount: 100 } : null, this.t.rng);

    takeUp(this.state, plan);
    this.bombPot = false;

    return plan;
  }

  owes(firstSeat: number): string {
    const seat = this.seatOf(firstSeat);

    return debt(seat.owesBigBlind, seat.owesSmallBlind);
  }
}

const SIX = [0, 1, 2, 3, 4, 5];
const ALL_TEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const CASES: Case[] = [
  {
    name: 'six players and nobody moves: the button, the small blind and the big blind each go round one seat a hand',
    seats: SIX,
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3 4 5', 'D1 S2 B3 | in 0 1 2 3 4 5', 'D2 S3 B4 | in 0 1 2 3 4 5', 'D3 S4 B5 | in 0 1 2 3 4 5', 'D4 S5 B0 | in 0 1 2 3 4 5', 'D5 S0 B1 | in 0 1 2 3 4 5', 'D0 S1 B2 | in 0 1 2 3 4 5'],
  },
  {
    name: 'heads-up the small blind has the button, and the two swap every hand',
    seats: [3, 8],
    button: 3,
    play: ['D3 S3 B8 | in 3 8', 'D8 S8 B3 | in 3 8', 'D3 S3 B8 | in 3 8'],
  },
  {
    name: 'three players: the button is first to act before the flop, and each has every position in three hands',
    seats: [1, 4, 7],
    button: 4,
    play: ['D4 S7 B1 | in 1 4 7', 'D7 S1 B4 | in 1 4 7', 'D1 S4 B7 | in 1 4 7', 'D4 S7 B1 | in 1 4 7'],
  },
  {
    name: 'ten players: a full table goes round the same way',
    seats: ALL_TEN,
    button: 8,
    play: ['D8 S9 B0 | in 0 1 2 3 4 5 6 7 8 9', 'D9 S0 B1 | in 0 1 2 3 4 5 6 7 8 9', 'D0 S1 B2 | in 0 1 2 3 4 5 6 7 8 9'],
  },

  {
    name: 'a player who sits out through the blinds owes both, cannot post between the button and the big blind, and posts once the button has passed',
    seats: SIX,
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 3 4 5',
      ['out', 3],
      // The big blind would have been theirs, and the small blind after it
      'D1 S2 B4 | in 0 1 2 4 5 | owes 3:BB+SB',
      ['post', 3],
      'D2 S4 B5 | in 0 1 2 4 5 | waits 3:button | owes 3:BB+SB',
      // In front of the button now: a big blind that plays and a small blind that is dead
      'D4 S5 B0 | in 0 1 2 3 4 5 | posts 3:BB+SB',
      'D5 S0 B1 | in 0 1 2 3 4 5',
    ],
  },
  {
    name: 'a player who owes and waits is dealt in when the big blind reaches them, and owes nothing more',
    seats: SIX,
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 3 4 5',
      ['out', 3],
      'D1 S2 B4 | in 0 1 2 4 5 | owes 3:BB+SB',
      ['in', 3],
      'D2 S4 B5 | in 0 1 2 4 5 | waits 3:big blind | owes 3:BB+SB',
      'D4 S5 B0 | in 0 1 2 4 5 | waits 3:big blind | owes 3:BB+SB',
      'D5 S0 B1 | in 0 1 2 4 5 | waits 3:big blind | owes 3:BB+SB',
      'D0 S1 B2 | in 0 1 2 4 5 | waits 3:big blind | owes 3:BB+SB',
      'D1 S2 B3 | in 0 1 2 3 4 5',
      'D2 S3 B4 | in 0 1 2 3 4 5',
    ],
  },
  {
    name: 'a player who posts the big blind and then sits out owes the small blind alone, with no small blind in that hand, and may post it from the button',
    seats: SIX,
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 3 4 5',
      ['out', 2],
      'D1 S2x B3 | in 0 1 3 4 5 | owes 2:SB',
      ['post', 2],
      'D2 S3 B4 | in 0 1 2 3 4 5 | posts 2:SB',
      'D3 S4 B5 | in 0 1 2 3 4 5',
    ],
  },
  {
    name: 'sitting out for the hand on the button costs nothing: the button is dead for it, and the player comes straight back',
    seats: SIX,
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3 4 5', ['out', 1], 'D1x S2 B3 | in 0 2 3 4 5', ['in', 1], 'D2 S3 B4 | in 0 1 2 3 4 5'],
  },
  {
    name: 'however long a player is away, they owe one big blind and one small blind at most',
    seats: SIX,
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 3 4 5',
      ['out', 4],
      'D1 S2 B3 | in 0 1 2 3 5',
      'D2 S3 B5 | in 0 1 2 3 5 | owes 4:BB+SB',
      'D3 S5 B0 | in 0 1 2 3 5 | owes 4:BB+SB',
      'D5 S0 B1 | in 0 1 2 3 5 | owes 4:BB+SB',
      'D0 S1 B2 | in 0 1 2 3 5 | owes 4:BB+SB',
      'D1 S2 B3 | in 0 1 2 3 5 | owes 4:BB+SB',
      'D2 S3 B5 | in 0 1 2 3 5 | owes 4:BB+SB',
      ['post', 4],
      'D3 S5 B0 | in 0 1 2 3 5 | waits 4:button | owes 4:BB+SB',
      'D5 S0 B1 | in 0 1 2 3 4 5 | posts 4:BB+SB',
    ],
  },
  {
    name: 'a choice to post is dropped by sitting out again, so nobody is charged for a choice made about an earlier return',
    seats: SIX,
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 3 4 5',
      ['out', 3],
      'D1 S2 B4 | in 0 1 2 4 5 | owes 3:BB+SB',
      ['post', 3],
      ['out', 3],
      'D2 S4 B5 | in 0 1 2 4 5 | owes 3:BB+SB',
      ['in', 3],
      'D4 S5 B0 | in 0 1 2 4 5 | waits 3:big blind | owes 3:BB+SB',
    ],
  },

  {
    name: 'a player who busts and buys back in before a blind reaches them owes nothing',
    seats: SIX,
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3 4 5', ['bust', 5], 'D1 S2 B3 | in 0 1 2 3 4', ['rebuy', 5], 'D2 S3 B4 | in 0 1 2 3 4 5'],
  },
  {
    name: 'a player who is out of chips when the big blind passes owes it like anyone',
    seats: SIX,
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3 4 5', ['bust', 3], 'D1 S2 B4 | in 0 1 2 4 5 | owes 3:BB+SB', ['rebuy', 3], 'D2 S4 B5 | in 0 1 2 4 5 | waits 3:big blind | owes 3:BB+SB'],
  },
  {
    name: 'the player due the button busts: the button is dead on their seat, and nobody posts a blind twice',
    seats: [0, 1, 2, 3],
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3', ['bust', 1], 'D1x S2 B3 | in 0 2 3', 'D2 S3 B0 | in 0 2 3', 'D3 S0 B2 | in 0 2 3 | owes 1:BB+SB'],
  },
  {
    name: 'the big blind leaves their seat: the next hand has no small blind, and the button is dead on that seat the hand after',
    seats: [0, 1, 2, 3],
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3', ['leave', 2], 'D1 S2x B3 | in 0 1 3', 'D2x S3 B0 | in 0 1 3', 'D3 S0 B1 | in 0 1 3'],
  },

  {
    name: 'gap: a newcomer between the button and the small blind leaves the blinds moving on, and waits for the big blind',
    seats: [0, 2, 4, 6],
    button: 0,
    play: [
      'D0 S2 B4 | in 0 2 4 6',
      ['arrive', 1],
      'D2 S4 B6 | in 0 2 4 6 | waits 1:big blind | owes 1:BB',
      'D4 S6 B0 | in 0 2 4 6 | waits 1:big blind | owes 1:BB',
      'D6 S0 B1 | in 0 1 2 4 6',
      'D0 S1 B2 | in 0 1 2 4 6',
    ],
  },
  {
    name: 'gap: a newcomer between the small blind and the big blind cannot post there, and posts a big blind once the button has passed',
    seats: [0, 2, 4, 6],
    button: 0,
    play: [
      'D0 S2 B4 | in 0 2 4 6',
      ['arrive', 3],
      ['post', 3],
      'D2 S4 B6 | in 0 2 4 6 | waits 3:button | owes 3:BB',
      'D4 S6 B0 | in 0 2 3 4 6 | posts 3:BB',
      'D6 S0 B2 | in 0 2 3 4 6',
      'D0 S2 B3 | in 0 2 3 4 6',
    ],
  },
  {
    name: 'a newcomer who sits where the big blind comes next simply has it, and one who sits anywhere else may post at once',
    seats: [0, 2, 4, 6],
    button: 0,
    play: ['D0 S2 B4 | in 0 2 4 6', ['arrive', 5], ['arrive', 8], ['post', 8], 'D2 S4 B5 | in 0 2 4 5 6 8 | posts 8:BB', 'D4 S5 B6 | in 0 2 4 5 6 8'],
  },
  {
    name: 'a newcomer on the seat the big blind just left owes that big blind and no small blind, and the hand has no small blind',
    seats: [0, 1, 2, 3],
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3', ['leave', 2], ['arrive', 2], 'D1 S2x B3 | in 0 1 3 | waits 2:big blind | owes 2:BB', 'D2x S3 B0 | in 0 1 3 | waits 2:big blind | owes 2:BB'],
  },

  {
    name: 'three players down to two when the button steps out: the big blind passes them to the player who had the small blind, and nobody posts it twice running',
    seats: [0, 1, 2],
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2', ['out', 0], 'D2 S2 B1 | in 1 2 | owes 0:BB+SB', 'D1 S1 B2 | in 1 2 | owes 0:BB+SB'],
  },
  {
    name: 'three players down to two when the small blind steps out: the button is with the player who had the big blind',
    seats: [0, 1, 2],
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2', ['out', 1], 'D2 S2 B0 | in 0 2', 'D0 S0 B2 | in 0 2 | owes 1:BB+SB'],
  },
  {
    name: 'three players down to two when the big blind steps out: a hand with no small blind, rather than the same one posted twice',
    seats: [0, 1, 2],
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2', ['out', 2], 'D1 S2x B0 | in 0 1 | owes 2:SB', 'D0 S0 B1 | in 0 1 | owes 2:SB', 'D1 S1 B0 | in 0 1 | owes 2:BB+SB'],
  },
  {
    name: 'two players up to three, the third left of the big blind: they have the big blind, and the button stays a hand with the player who had it as the small blind',
    seats: [0, 3],
    button: 0,
    play: ['D0 S0 B3 | in 0 3', ['arrive', 6], 'D0 S3 B6 | in 0 3 6', 'D3 S6 B0 | in 0 3 6'],
  },
  {
    name: 'two players up to three, the third right of the big blind and waiting: the two swap blinds once more, and then the big blind reaches the third',
    seats: [0, 3],
    button: 0,
    play: ['D0 S0 B3 | in 0 3', ['arrive', 1], 'D3 S3 B0 | in 0 3 | waits 1:big blind | owes 1:BB', 'D3 S0 B1 | in 0 1 3', 'D0 S1 B3 | in 0 1 3'],
  },
  {
    name: 'two players, and the third posts from between them: they come in on the button',
    seats: [0, 3],
    button: 0,
    play: ['D0 S0 B3 | in 0 3', ['arrive', 1], ['post', 1], 'D1 S3 B0 | in 0 1 3 | posts 1:BB', 'D3 S0 B1 | in 0 1 3'],
  },

  {
    name: 'a bomb pot is dealt to everyone there to play, moves its own button, and leaves the blinds and what is owed where they were',
    seats: SIX,
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 3 4 5',
      ['out', 3],
      'D1 S2 B4 | in 0 1 2 4 5 | owes 3:BB+SB',
      ['in', 3],
      ['bomb'],
      'D2 S3 B4 | in 0 1 2 3 4 5 | owes 3:BB+SB',
      ['bomb'],
      'D3 S4 B5 | in 0 1 2 3 4 5 | owes 3:BB+SB',
      'D2 S4 B5 | in 0 1 2 4 5 | waits 3:big blind | owes 3:BB+SB',
    ],
  },
  {
    name: 'a bomb pot does not count as the big blind passing a player who sits it out',
    seats: SIX,
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3 4 5', ['out', 3], ['bomb'], 'D1 S2 B4 | in 0 1 2 4 5', ['in', 3], 'D1 S2 B3 | in 0 1 2 3 4 5'],
  },

  {
    name: 'at a table that forgives missed blinds nobody ever owes, and the blinds move by the same rule',
    seats: SIX,
    button: 0,
    config: { missedBlinds: 'forgiven' },
    play: [
      'D0 S1 B2 | in 0 1 2 3 4 5',
      ['out', 3],
      'D1 S2 B4 | in 0 1 2 4 5',
      ['in', 3],
      // Back in between the button's seat and the small blind's, so the button is theirs: nobody is dealt in behind it
      'D3 S4 B5 | in 0 1 2 3 4 5',
      ['arrive', 8],
      'D4 S5 B8 | in 0 1 2 3 4 5 8',
      'D5 S8 B0 | in 0 1 2 3 4 5 8',
    ],
  },
  {
    name: 'gap, at a table that forgives missed blinds: a newcomer between the button and the blinds makes nobody post a blind twice',
    seats: [0, 2, 4, 6],
    button: 0,
    config: { missedBlinds: 'forgiven' },
    play: ['D0 S2 B4 | in 0 2 4 6', ['arrive', 1], 'D2 S4 B6 | in 0 1 2 4 6', ['arrive', 5], 'D5 S6 B0 | in 0 1 2 4 5 6', 'D6 S0 B1 | in 0 1 2 4 5 6'],
  },
  {
    name: 'switching to forgiven clears what everyone owes, and switching back starts counting from the next hand',
    seats: SIX,
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 3 4 5',
      ['out', 3],
      'D1 S2 B4 | in 0 1 2 4 5 | owes 3:BB+SB',
      ['set', { missedBlinds: 'forgiven' }],
      'D2 S4 B5 | in 0 1 2 4 5',
      ['set', { missedBlinds: 'owed' }],
      ['in', 3],
      'D4 S5 B0 | in 0 1 2 3 4 5',
      ['out', 3],
      'D5 S0 B1 | in 0 1 2 4 5',
      'D0 S1 B2 | in 0 1 2 4 5',
      'D1 S2 B4 | in 0 1 2 4 5 | owes 3:BB+SB',
    ],
  },
  {
    name: 'the host forgives one player what they owe, and they are dealt in like anyone',
    seats: SIX,
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3 4 5', ['out', 3], ['out', 5], 'D1 S2 B4 | in 0 1 2 4 | owes 3:BB+SB', 'D2 S4 B0 | in 0 1 2 4 | owes 3:BB+SB 5:BB+SB', ['forgive', 3], ['in', 3], ['in', 5], 'D4 S0 B1 | in 0 1 2 3 4 | waits 5:big blind | owes 5:BB+SB'],
  },

  {
    name: 'gap: the player with the button, moved one seat clockwise, does not have it again: the button and the blinds go with a player who passes nobody',
    seats: [0, 2, 4],
    button: 0,
    play: ['D0 S2 B4 | in 0 2 4', ['move', 0, 1], 'D2 S4 B1 | in 1 2 4', 'D4 S1 B2 | in 1 2 4'],
  },
  {
    name: 'the small blind and the big blind, each moved a seat without passing anyone, are still the next button and the next small blind',
    seats: [0, 2, 4, 6],
    button: 0,
    play: ['D0 S2 B4 | in 0 2 4 6', ['move', 2, 3], ['move', 4, 5], 'D3 S5 B6 | in 0 3 5 6', ['move', 6, 9], 'D5 S9 B0 | in 0 3 5 9'],
  },
  {
    name: 'a player moved past others takes their turn from the new seat: the button and the blinds stay on the seats, and nothing new is owed',
    seats: [0, 1, 2, 3],
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 3',
      // The small blind goes to the far side of the table, between seats 3 and 0, and the button due on their old seat is dead
      ['move', 1, 6],
      'D1x S2 B3 | in 0 2 3 6',
      'D2 S3 B6 | in 0 2 3 6',
      'D3 S6 B0 | in 0 2 3 6',
    ],
  },
  {
    name: 'a player moved onto the seat a blind was left on leaves their own behind: the two blinds are never on one seat, and the button is not held up',
    seats: [0, 1, 2, 3],
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 3',
      // The big blind leaves and the small blind is moved onto their seat, which is the one due the small blind next
      ['leave', 2],
      ['move', 1, 2],
      'D1x S2 B3 | in 0 2 3',
      'D2 S3 B0 | in 0 2 3',
    ],
  },
  {
    name: 'the big blind moved back onto the seat the small blind left has the button that seat is due, and the seat they left has no small blind to post',
    seats: [0, 1, 2, 3],
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3', ['leave', 1], ['move', 2, 1], 'D1 S2x B3 | in 0 1 3', 'D2x S3 B0 | in 0 1 3'],
  },
  {
    name: 'a player moved past a seat a blind was left on has passed a place at the table, though nobody is in it',
    seats: [0, 1, 2, 4],
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 4',
      // Past the seat the big blind left, the small blind is the next player after the big blind, and so the next big blind
      ['leave', 2],
      ['move', 1, 3],
      'D1x S2x B3 | in 0 3 4',
      'D2x S3 B4 | in 0 3 4',
    ],
  },
  {
    name: 'a player who owes keeps owing in a new seat',
    seats: SIX,
    button: 0,
    play: ['D0 S1 B2 | in 0 1 2 3 4 5', ['out', 3], 'D1 S2 B4 | in 0 1 2 4 5 | owes 3:BB+SB', ['move', 3, 8], ['in', 3], 'D2 S4 B5 | in 0 1 2 4 5 | waits 8:big blind | owes 8:BB+SB', 'D4 S5 B8 | in 0 1 2 4 5 8'],
  },
  {
    name: 'a shuffle starts a new game: the button is drawn afresh, everyone there to play is dealt in, and nobody owes',
    seats: [0, 2, 4, 6],
    button: 0,
    play: ['D0 S2 B4 | in 0 2 4 6', ['out', 6], 'D2 S4 B0 | in 0 2 4 | owes 6:BB+SB', ['in', 6], ['shuffle'], 'new game'],
  },

  {
    name: 'when everyone but the big blind is waiting for it, a hand is dealt to them all the same, and they owe nothing for it',
    seats: [0, 1, 2, 3],
    button: 0,
    play: [
      'D0 S1 B2 | in 0 1 2 3',
      ['out', 3],
      'D1 S2 B0 | in 0 1 2 | owes 3:BB+SB',
      // Two go, and of the two left the big blind is due on the one who was playing: the other owes and is waiting for it
      ['out', 0],
      ['out', 1],
      ['in', 3],
      'D3 S0x B2 | in 2 3 | owes 0:SB 1:BB+SB',
      'D2 S2 B3 | in 2 3 | owes 0:SB 1:BB+SB',
      'D3 S3 B2 | in 2 3 | owes 0:BB+SB 1:BB+SB',
    ],
  },
];

for (const { name, seats, button, config, play } of CASES) {
  test(name, () => {
    const table = new Planned(seats, button, config);
    let hands = 0;

    for (const step of play) {
      if (typeof step !== 'string') {
        table.apply(step);
        continue;
      }

      hands += 1;
      const ready = eligibleSeats(table.state);
      const plan = table.deal();

      if (step === 'new game') {
        assert.deepEqual([...plan.order].sort((a, b) => a - b), ready, `hand ${hands} is not dealt to everyone`);
        assert.deepEqual([plan.held, plan.owing, plan.posting ?? []], [[], [], []], `hand ${hands} holds someone to the game before`);
        assert.deepEqual(table.state.blinds, { small: plan.sbSeat, big: plan.bbSeat });
      } else {
        assert.equal(told(plan), step, `hand ${hands}`);
      }

      // The plan is whole: the players it deals in are the ones it gives cards to, in an order that ends on the button when someone has it
      assert.equal(new Set(plan.order).size, plan.order.length);
      assert.ok(plan.order.includes(plan.bbSeat), 'nobody posts the big blind');
      assert.ok(!plan.order.includes(plan.button) || plan.order.at(-1) === plan.button, 'the button is not last to be dealt');
    }
  });
}

test('the button for the first hand is drawn from the players there, and for the first hand after a shuffle', () => {
  const buttons = new Set<number>();

  for (let seed = 1; seed <= 20; seed++) {
    const table = new Planned([1, 4, 7], 0);
    table.state.buttonSeat = null;
    table.t.rng = { int: (max) => seed % max };

    buttons.add(table.deal().button);
  }

  assert.deepEqual([...buttons].sort(), [1, 4, 7]);
});

test('a plan changes nothing at the table until it is taken up', () => {
  const table = new Planned(SIX, 0);
  table.deal();
  table.apply(['out', 3]);
  table.deal();
  table.apply(['post', 3]);

  const before = JSON.stringify(table.state);
  planHand(table.state, null, table.t.rng);
  planHand(table.state, { amount: 100 }, table.t.rng);
  comingIn(table.state);

  assert.equal(JSON.stringify(table.state), before);
});

test('what a player who owes is told about coming in is what the next hand then does', () => {
  const table = new Planned(SIX, 0);
  table.deal();
  table.apply(['out', 3]);
  table.apply(['out', 5]);
  table.deal();
  table.deal();
  assert.deepEqual([table.owes(3), table.owes(5)], ['BB+SB', 'BB+SB']);
  assert.deepEqual([...comingIn(table.state)], [], 'someone not there to play is told when they come in');

  // The button is due on seat 4 and the big blind on seat 1, so seat 5 is between them and seat 3 is not
  table.apply(['post', 3]);
  table.apply(['post', 5]);
  assert.deepEqual([...comingIn(table.state)], [[3, 'posting'], [5, 'button']]);

  table.apply(['in', 5]);
  assert.deepEqual([...comingIn(table.state)], [[3, 'posting'], [5, 'big blind']]);
  assert.equal(told(table.deal()), 'D4 S0 B1 | in 0 1 2 3 4 | posts 3:BB+SB | waits 5:big blind | owes 5:BB+SB');

  // The big blind goes round to seat 4, and seat 5 is next
  table.deal();
  table.deal();
  table.deal();
  assert.deepEqual(table.state.blinds, { small: 3, big: 4 });
  assert.deepEqual([...comingIn(table.state)], [[5, 'next hand']]);
  assert.equal(told(table.deal()), 'D3 S4 B5 | in 0 1 2 3 4 5');
  assert.deepEqual([...comingIn(table.state)], []);
});
