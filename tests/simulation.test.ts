import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HANDLERS } from '../src/engine/commands/index.ts';
import { eligibleSeats, fullyShown, handFacts, isStraddle, playerHand, nightIsOver, REACTIONS_LIVE, SEAT_COUNT } from '../src/engine/index.ts';
import type { CommandType } from '../src/engine/commands/handler.ts';
import type { AutoShow, Command, Rng, Straddle, TableConfig, TableState } from '../src/engine/index.ts';
import { handRecords, ledgerEntries, seededRng, TestTable } from './helpers.ts';
import { assertChipsConserved, assertHandRecordsHold, chopAnswers, assertInvariants, assertLedgerAgrees } from './invariants.ts';
import { fixedSettings, randomConfig } from './randomConfig.ts';
import { chance, randomStep } from './randomPlay.ts';

// SIM_TABLES=2000 npm test runs a much longer soak than the default
const TABLES = Number(process.env.SIM_TABLES ?? 60);
const STEPS_PER_TABLE = 600;

// Building every player's view and saving the table are the slow parts, so they are checked on a sample of steps
const SLOW_CHECK_PERCENT = 10;

// Commands random play does not send yet, each a gap to close in FUZZ_COMMANDS one day rather than a rule
const NOT_SENT_AT_RANDOM = new Set<CommandType>(['cancelRequest', 'pause']);

/** A test table that writes down the kind of every command sent to it, those it sends itself as it is set up included. */
class Recording extends TestTable {
  // Kept outside the table, since TestTable's constructor sends commands before a field of this class would exist
  private static readonly kinds = new WeakMap<Recording, Set<CommandType>>();

  get sent(): Set<CommandType> {
    const sent = Recording.kinds.get(this) ?? new Set<CommandType>();
    Recording.kinds.set(this, sent);

    return sent;
  }

  override cmd(seat: number, command: Command): void {
    this.sent.add(command.type);
    super.cmd(seat, command);
  }
}

/** Random table number `seed`, started, with the generator that plays it and the settings it was given. */
function randomTable(seed: number): { t: Recording; rng: Rng; config: TableConfig } {
  const rng = seededRng(seed * 8011);
  const players = 2 + rng.int(SEAT_COUNT - 1);
  const stacks = Array.from({ length: players }, () => (chance(rng, 15) ? 1 + rng.int(30) : 100 + rng.int(1900)));

  const config = randomConfig(rng);

  // Seated first and given its settings after, so the stacks are whatever they are, not what the buy-in limits allow.
  // Only what can't be changed after has to be there from the start
  const t = new Recording({ stacks, seed, config: fixedSettings(config) });
  t.cmd(0, { type: 'updateConfig', config });
  t.cmd(0, { type: 'start' });

  return { t, rng, config };
}

/**
 * Holds the hand just ended to the choices to show as the engine read them, and says which it carried
 * out. A player everyone folded to who chose to show has both cards up. At a showdown that was not run
 * out the hands are taken in the order they were turned up or mucked: one that could still win a pot it
 * is in for, on some board, against those before it that could too, is shown whatever was chosen, and
 * one that could not is shown exactly when its player chose to show losers.
 */
function autoShowsApplied(state: TableState): Record<AutoShow, boolean> {
  const hand = state.hand!;
  const result = hand.result!;
  const chose = (seat: number, when: AutoShow) => state.seats[seat]!.autoShow.includes(when);
  const applied = { lost: false, foldedTo: false };

  if (result.uncontested) {
    const winner = result.chopped ? undefined : hand.players.find((player) => !player.folded)!;
    applied.foldedTo = winner !== undefined && chose(winner.seat, 'foldedTo');
    assert.ok(!applied.foldedTo || fullyShown(winner!.shown), `hand ${hand.number}: a player who shows when folded to did not`);

    return applied;
  }

  if (hand.events.some((event) => event[0] === 'runs')) {
    return applied;
  }

  const score = (seat: number, board: number) => playerHand(hand.players.find((player) => player.seat === seat)!.cards, hand.boards[board]!).score;
  const contenders: number[] = [];

  for (const event of hand.events.slice(0, hand.events.findIndex((event) => event[0] === 'win'))) {
    if (event[0] !== 'show' && event[0] !== 'muck') {
      continue;
    }

    const seat = event[1];
    const canWin = result.pots.some((pot) => pot.eligible.includes(seat) && hand.boards.some((_board, board) => contenders.filter((other) => pot.eligible.includes(other)).every((other) => score(seat, board) >= score(other, board))));

    if (canWin) {
      assert.equal(event[0], 'show', `hand ${hand.number}: a hand that could still win was mucked`);
      contenders.push(seat);
    } else {
      assert.equal(event[0] === 'show', chose(seat, 'lost'), `hand ${hand.number}: seat ${seat} ${event[0]}s a hand that could win nothing, having chosen otherwise`);
      applied.lost ||= event[0] === 'show';
    }
  }

  return applied;
}

test('random play never breaks the rules of chip accounting, secrecy or turn order', () => {
  let handsPlayed = 0;
  let showdowns = 0;
  // Hands by how many times they were run
  const runs = [0, 0, 0, 0];
  let bounties = 0;
  // Paid for a hand that is not seven-deuce
  let otherBounties = 0;
  const tablesPlaying = { chips: 0, cents: 0 };
  const handsWithAnte = { everyone: 0, bigBlind: 0 };
  const handsWithAnteIn = { chips: 0, cents: 0 };
  let shortAntes = 0;
  const transfersIn = { chips: 0, cents: 0 };
  // Tables where a high-hand bonus was paid, and by which of the two ways
  const bonuses = { chips: 0, cents: 0, early: 0, atNightsEnd: 0 };
  const bombPots = { chips: 0, cents: 0, called: 0, byCount: 0, overAnAnte: 0, short: 0, allInWhenDealt: 0 };
  const doubleBoards = { chips: 0, cents: 0, shownDown: 0, ranOut: 0, withSidePots: 0, wonUncontested: 0 };
  const nights = { afterLastHand: 0, endedOutright: 0, startedAgain: 0, signals: 0 };
  const blinds = { missedBigBlinds: 0, deadSmallBlinds: 0, shortOfOwed: 0, noSmallBlind: 0, deadButtons: 0, keptWaiting: 0, forgivenTables: 0 };
  const chops = { offered: 0, agreed: 0, turnedDown: 0 };
  const reactions = { shown: 0, thrown: 0, full: 0 };
  // Hands whose rabbit was hunted, and of those how many on two boards
  const hunts = { hunted: 0, onTwoBoards: 0 };
  // Hands in which a player showed by choice one card, the other one after it, or both at once
  const shownByChoice = { oneCard: 0, otherAfter: 0, both: 0 };
  // Hands where a standing choice to show turned cards up: a loser at a showdown who could win nothing, and a player everyone folded to
  const autoShown = { lost: 0, foldedTo: 0 };
  const straddles: Record<Straddle | 'passedOver' | 'overAnAnte' | 'shownDown', number> = { straddle: 0, 'double straddle': 0, 'button straddle': 0, 'Mississippi straddle': 0, passedOver: 0, overAnAnte: 0, shownDown: 0 };

  // Tables that ended with a member the list of players knows, one it does not, and two who said they were the same player
  const identities = { known: 0, nobody: 0, shared: 0 };

  const sent = new Set<CommandType>();

  for (let seed = 1; seed <= TABLES; seed++) {
    const { t, rng, config } = randomTable(seed);
    tablesPlaying[config.unit] += 1;

    for (let step = 0; step < STEPS_PER_TABLE; step++) {
      assertChipsConserved(t.state);
      if (chance(rng, SLOW_CHECK_PERCENT)) {
        assertInvariants(t.state, t.now);
      }

      const before = { hands: t.state.handCount, called: t.state.bombPotCalled, inHand: t.state.hand !== null, over: nightIsOver(t.state), effects: t.effects.length, ended: t.state.hand?.stage === 'done' };
      const lastReaction = t.state.reactions.at(-1);
      randomStep(t, rng);

      const made = t.state.reactions.at(-1);
      if (made && made !== lastReaction) {
        reactions[made.to === undefined ? 'shown' : 'thrown'] += 1;
        reactions.full += t.state.reactions.length === REACTIONS_LIVE ? 1 : 0;
      }

      if (t.effects.slice(before.effects).some((effect) => effect.type === 'ledger' && effect.entry.kind === 'high hand')) {
        bonuses[before.over === nightIsOver(t.state) ? 'early' : 'atNightsEnd'] += 1;
      }

      if (before.over !== nightIsOver(t.state)) {
        nights[before.over ? 'startedAgain' : before.inHand ? 'afterLastHand' : 'endedOutright'] += 1;
      }

      // Looked at in the step that ends the hand, while the choices are still the ones the engine read
      if (t.state.hand?.stage === 'done' && !before.ended) {
        const applied = autoShowsApplied(t.state);
        autoShown.lost += applied.lost ? 1 : 0;
        autoShown.foldedTo += applied.foldedTo ? 1 : 0;
      }

      // A hand is dealt by time passing, never by the step that called a bomb pot or changed a setting
      const dealt = t.state.handCount > before.hands ? t.state.hand?.bombPot : null;
      if (dealt) {
        bombPots[t.state.config.unit] += 1;
        bombPots[before.called ? 'called' : 'byCount'] += 1;
        bombPots.overAnAnte += t.state.config.ante > 0 ? 1 : 0;
        bombPots.short += t.state.hand!.players.some((p) => p.committed < dealt.amount) ? 1 : 0;
        bombPots.allInWhenDealt += t.state.hand!.stage !== 'betting' ? 1 : 0;
        doubleBoards[t.state.config.unit] += dealt.boards === 2 ? 1 : 0;
      }

      // A hand with blinds that left someone out who was there to play: they owe, and are waiting
      if (t.state.handCount > before.hands && t.state.hand && !t.state.hand.bombPot) {
        straddles.passedOver += t.state.hand.passedOver.length > 0 ? 1 : 0;
        blinds.keptWaiting += eligibleSeats(t.state).some((seat) => !t.state.hand!.players.some((player) => player.seat === seat)) ? 1 : 0;
      }
    }

    blinds.forgivenTables += t.state.config.missedBlinds === 'forgiven' ? 1 : 0;

    const saidWho = t.state.members.flatMap((member) => (member.identity === null ? [] : [member.identity]));
    identities.known += saidWho.length > 0 ? 1 : 0;
    identities.nobody += saidWho.length < t.state.members.length ? 1 : 0;
    identities.shared += new Set(saidWho).size < saidWho.length ? 1 : 0;

    assertChipsConserved(t.state);
    assertLedgerAgrees(t.state, t.effects);
    assert.deepEqual(fixedSettings(t.state.config), fixedSettings(config), 'a setting chosen for good was changed along the way');
    handsPlayed += assertHandRecordsHold(t.effects);
    nights.signals += t.effects.filter((effect) => effect.type === 'nightEnded').length;
    transfersIn[config.unit] += ledgerEntries(t.effects).filter((entry) => entry.kind === 'transfer' && entry.amount > 0).length;
    bonuses[config.unit] += ledgerEntries(t.effects).some((entry) => entry.kind === 'high hand') ? 1 : 0;

    for (const record of handRecords(t.effects)) {
      showdowns += record.result.uncontested ? 0 : 1;
      runs[handFacts(record).timesRun]! += 1;
      bounties += record.result.bounty ? 1 : 0;
      otherBounties += record.result.bounty && !record.result.bounty.hand.startsWith('72') ? 1 : 0;

      if (record.bombPot?.boards === 2) {
        doubleBoards.shownDown += record.result.uncontested ? 0 : 1;
        doubleBoards.wonUncontested += record.result.uncontested ? 1 : 0;
        doubleBoards.ranOut += record.events.some((event) => event[0] === 'runs') ? 1 : 0;
        doubleBoards.withSidePots += record.result.pots.length > 1 ? 1 : 0;
      }

      const hunt = record.events.find((event) => event[0] === 'hunt');
      hunts.hunted += hunt ? 1 : 0;
      hunts.onTwoBoards += hunt && record.boards.length === 2 ? 1 : 0;

      // What is turned up once the pots and any bounty are paid is shown by choice
      const ended = record.events.reduce((last, event, nth) => (event[0] === 'win' || event[0] === 'chop' || event[0] === 'bounty' ? nth : last), -1);
      const chosen = record.events.slice(ended + 1).flatMap((event) => (event[0] === 'show' ? [event] : []));
      shownByChoice.oneCard += chosen.some((event) => event[2].includes(null)) ? 1 : 0;
      shownByChoice.otherAfter += chosen.some((event, nth) => chosen.slice(nth + 1).some((later) => later[1] === event[1])) ? 1 : 0;
      shownByChoice.both += chosen.some((event) => !event[2].includes(null)) ? 1 : 0;

      const answers = chopAnswers(record);
      chops.offered += record.events.some((event) => event[0] === 'chopOffer') ? 1 : 0;
      chops.agreed += answers.some((answer) => answer.agree) ? 1 : 0;
      chops.turnedDown += answers.some((answer) => !answer.agree) ? 1 : 0;

      const posts = record.events.flatMap((event) => (event[0] === 'post' ? [event] : []));
      const owed = posts.filter((post) => post[2] === 'missed big blind' || post[2] === 'dead small blind');
      blinds.missedBigBlinds += posts.some((post) => post[2] === 'missed big blind') ? 1 : 0;
      blinds.deadSmallBlinds += posts.some((post) => post[2] === 'dead small blind') ? 1 : 0;
      blinds.shortOfOwed += owed.some((post) => post[4] === 0) ? 1 : 0;
      blinds.noSmallBlind += posts.length > 0 && !record.bombPot && !posts.some((post) => post[2] === 'small blind') ? 1 : 0;

      const straddled = posts.flatMap((post) => (isStraddle(post[2]) ? [post[2]] : []));
      for (const what of straddled) {
        straddles[what] += 1;
      }

      straddles.overAnAnte += straddled.length > 0 && posts.some((post) => post[2] === 'ante' || post[2] === 'big blind ante') ? 1 : 0;
      straddles.shownDown += straddled.length > 0 && !record.result.uncontested ? 1 : 0;

      // A hand's first event says where the button was, and what ante it was dealt under when there was one
      const [dealt] = record.events;
      blinds.deadButtons += dealt?.[0] === 'start' && !record.players.some((player) => player.seat === dealt[2]) ? 1 : 0;

      if (dealt?.[0] === 'start' && dealt[6]) {
        handsWithAnte[dealt[7]!] += 1;
        handsWithAnteIn[config.unit] += 1;
        shortAntes += record.events.some((event) => event[0] === 'post' && event[5] !== undefined && event[3] < dealt[6]!) ? 1 : 0;
      }
    }

    t.sent.forEach((type) => sent.add(type));
  }

  // The run only proves something if it actually reached the interesting parts of the game
  const reached = `${handsPlayed} hands, ${showdowns} showdowns, ${runs[2]} run twice, ${runs[3]} run three times, ${bounties} bounties, ${otherBounties} of them for a hand other than seven-deuce`;
  assert.ok(handsPlayed >= TABLES * 30, reached);
  assert.ok(showdowns >= TABLES * 10, reached);
  assert.ok(runs[2]! >= TABLES / 2 && runs[3]! >= TABLES / 2, reached);
  assert.ok(bounties >= TABLES / 4 && otherBounties >= TABLES / 4, reached);
  assert.ok(tablesPlaying.chips >= TABLES / 4 && tablesPlaying.cents >= TABLES / 4, `${tablesPlaying.chips} tables played whole chips and ${tablesPlaying.cents} dollars and cents`);

  const antes = `${handsWithAnte.everyone} hands where everyone anted and ${handsWithAnte.bigBlind} with a big-blind ante, ${handsWithAnteIn.chips} of them in whole chips and ${handsWithAnteIn.cents} in dollars and cents, ${shortAntes} with a player short of the ante`;
  assert.ok(handsWithAnte.everyone >= TABLES * 5 && handsWithAnte.bigBlind >= TABLES * 5, antes);
  assert.ok(handsWithAnteIn.chips >= TABLES * 5 && handsWithAnteIn.cents >= TABLES * 5, antes);
  assert.ok(shortAntes >= TABLES / 4, antes);

  assert.ok(transfersIn.chips >= TABLES && transfersIn.cents >= TABLES, `${transfersIn.chips} transfers at whole-chip tables and ${transfersIn.cents} at tables of dollars and cents`);

  const paid = `high-hand bonuses: ${JSON.stringify(bonuses)}`;
  assert.ok(bonuses.chips >= TABLES / 4 && bonuses.cents >= TABLES / 4 && bonuses.early >= TABLES / 4 && bonuses.atNightsEnd >= TABLES / 4, paid);

  const ended = `nights: ${JSON.stringify(nights)}`;
  assert.ok(nights.afterLastHand >= TABLES / 2 && nights.endedOutright >= TABLES / 4 && nights.startedAgain >= TABLES, ended);
  assert.equal(nights.signals, nights.afterLastHand + nights.endedOutright, `every night that ended said so once: ${ended}`);

  const bombs = `bomb pots: ${JSON.stringify(bombPots)}`;
  assert.ok(bombPots.chips >= TABLES && bombPots.cents >= TABLES, bombs);
  assert.ok(bombPots.called >= TABLES / 2 && bombPots.byCount >= TABLES, bombs);
  assert.ok(bombPots.overAnAnte >= TABLES && bombPots.short >= TABLES / 2 && bombPots.allInWhenDealt >= TABLES / 4, bombs);

  const missed = `missed blinds: ${JSON.stringify(blinds)}`;
  assert.ok(blinds.missedBigBlinds >= TABLES / 6 && blinds.deadSmallBlinds >= TABLES / 6 && blinds.keptWaiting >= TABLES / 6, missed);
  assert.ok(blinds.noSmallBlind >= TABLES && blinds.deadButtons >= TABLES / 2 && blinds.forgivenTables >= TABLES / 4, missed);

  // Random play is two-handed most of the time, where nobody straddles, and a double needs four players and nobody with the
  // right before under the gun: tests/straddles.test.ts is where every kind is dealt by the hundred
  const straddling = `straddles: ${JSON.stringify(straddles)}`;
  assert.ok(straddles.straddle >= TABLES / 10 && straddles['button straddle'] >= TABLES / 10 && straddles['Mississippi straddle'] >= TABLES / 10, straddling);
  assert.ok(straddles.passedOver >= TABLES && straddles.overAnAnte >= TABLES / 6 && straddles.shownDown >= TABLES / 6, straddling);

  // Random play is mostly two-handed or has an ante or a straddle in the pot, where nobody chops: tests/chop.test.ts chops by the hundred
  const chopping = `chops: ${JSON.stringify(chops)}`;
  assert.ok(chops.offered >= TABLES / 20 && chops.agreed >= TABLES / 30 && chops.turnedDown >= 1, chopping);

  // Sent beside the game on a generator of their own (`ASIDE_COMMANDS`), so every count above is what it was before there were any
  const reacting = `reactions: ${JSON.stringify(reactions)}`;
  assert.ok(reactions.shown >= TABLES && reactions.thrown >= TABLES && reactions.full >= TABLES, reacting);

  const hunting = `rabbits hunted: ${JSON.stringify(hunts)}`;
  assert.ok(hunts.hunted >= TABLES && hunts.onTwoBoards >= TABLES / 20, hunting);

  const showing = `hands with cards shown by choice: ${JSON.stringify(shownByChoice)}`;
  assert.ok(shownByChoice.oneCard >= TABLES * 2 && shownByChoice.otherAfter >= TABLES / 4 && shownByChoice.both >= TABLES * 2, showing);

  const choosing = `hands where a choice to show applied: ${JSON.stringify(autoShown)}`;
  assert.ok(autoShown.lost >= TABLES / 2 && autoShown.foldedTo >= TABLES, choosing);

  const doubles = `double-board bomb pots: ${JSON.stringify(doubleBoards)}`;
  assert.ok(doubleBoards.chips >= TABLES / 2 && doubleBoards.cents >= TABLES / 2, doubles);
  assert.ok(doubleBoards.shownDown >= TABLES && doubleBoards.wonUncontested >= TABLES / 4, doubles);
  // A side pot in a double-board bomb pot comes about once in a dozen random tables, which is tested by the hundred in tests/doubleBoard.test.ts
  assert.ok(doubleBoards.ranOut >= TABLES / 4 && doubleBoards.withSidePots >= TABLES / 20, doubles);

  // Who a member says they are changes nothing of the game, which every count above being what it was shows
  const known = `members by who they said they are: ${JSON.stringify(identities)}`;
  assert.ok(identities.known >= TABLES / 4 && identities.nobody === TABLES && identities.shared >= TABLES / 20, known);

  // Every command the table takes is sent, as part of the game or beside it, but those named as not yet
  const unsent = Object.keys(HANDLERS).filter((type) => !sent.has(type as CommandType) && !NOT_SENT_AT_RANDOM.has(type as CommandType));
  assert.deepEqual(unsent, [], 'commands random play never sends: add each to FUZZ_COMMANDS, or ASIDE_COMMANDS if it touches nothing of the game');
  assert.deepEqual([...NOT_SENT_AT_RANDOM].filter((type) => sent.has(type)), [], 'a command named as not sent at random now is: take it off the list');
});

test('the commands sent beside the game leave it as it was: the same tables played with them and without make the same game, step for step', () => {
  const without = ({ reactions, ...game }: Recording['state']) => game;

  for (let seed = 1; seed <= TABLES / 3; seed++) {
    const asides = randomTable(seed);
    const none = randomTable(seed);

    for (let step = 0; step < STEPS_PER_TABLE; step++) {
      randomStep(asides.t, asides.rng);
      randomStep(none.t, none.rng, false);

      assert.equal(asides.t.now, none.t.now);
      assert.deepEqual(without(asides.t.state), without(none.t.state), `table ${seed} went another way at step ${step}`);
    }

    assert.ok(asides.t.sent.has('react') && !none.t.sent.has('react'), `table ${seed} sent no reaction`);
  }
});
