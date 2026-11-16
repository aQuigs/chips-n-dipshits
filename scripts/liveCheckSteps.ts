/*
 * The short game the live check plays, as steps over the place it is played at: the deployed address
 * for `npm run check:live`, and a stand-in for Apps Script's host in `scripts/hostedRun.ts`, which is
 * what keeps these steps in step with the page between deploys.
 *
 * It leaves one small table behind, a Presets tab if there was none, with the presets in it as it
 * found them, and in the Players tab the one player it plays as, whom its first run adds and every
 * later run comes back as. Both of its browsers being that one player, its table is nobody's night,
 * and it leaves nothing in the standings.
 */
import assert from 'node:assert/strict';

import type { Locator, Page } from 'playwright';

import { LIMITS } from '../src/engine/index.ts';
import type { KnownPlayer, Preset } from '../src/engine/index.ts';
import { OUTDATED_MESSAGE } from '../src/server/build.ts';
import { CHECK_PLAYER, isCheckPlayer } from '../src/server/playerStore.ts';

/** The game where a page has it: two frames deep as Apps Script serves it, the page itself elsewhere. */
export interface Game {
  locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
}

export interface Visitor {
  page: Page;
  app: Game;
}

export interface CheckedPlace {
  address: string;
  /** Opens an address in a browser of its own, as a friend would, and finds the game in what comes up. */
  open(url: string, phone?: boolean): Promise<Visitor>;
  /** What only this place can be held to about its front page, before anything is done on it. */
  frontPage?(host: Visitor): Promise<void>;
  /** Where a picture of this name goes. */
  picture(name: string): string;
  say(line: string): void;
}

type ScriptAnswer = {
  ok: boolean;
  presets?: Preset[];
  players?: KnownPlayer[];
  units?: { players: { name: string }[] }[];
  view?: { members: { identity: string | null }[] };
  error?: string;
};

/** Asks the script directly from inside the game's frame, the way the page itself does, as the page's build. */
async function ask(visitor: Visitor, request: object): Promise<ScriptAnswer> {
  const body = JSON.stringify(request);

  return visitor.app.locator('body').evaluate(`new Promise((resolve, reject) => google.script.run
    .withSuccessHandler((json) => resolve(JSON.parse(json)))
    .withFailureHandler(reject)
    .api(JSON.stringify({ ...${body}, build: window.CND_BUILD })))`) as Promise<ScriptAnswer>;
}

const inAddress = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

/**
 * Both browsers are the one player the Players tab keeps for the check, which is that tab written by the
 * first to come in and read back for the second, and the list friends pick from never offers them.
 */
async function checkPlayers(visitor: Visitor): Promise<void> {
  const [id, token] = inAddress(visitor.page, 'me')!.split('.');
  const table = await ask(visitor, { op: 'poll', tableId: inAddress(visitor.page, 'table'), auth: { id, token }, since: -1 });
  assert.ok(table.ok && table.view, `the table could not be read: ${table.error}`);

  const [first, ...others] = table.view.members.map((member) => member.identity);
  assert.ok(first && others.length === 1 && others[0] === first, `the check's two browsers are not one known player: ${JSON.stringify([first, ...others])}`);

  const list = await ask(visitor, { op: 'players' });
  assert.ok(list.ok && list.players, `the players could not be listed: ${list.error}`);
  assert.ok(!list.players.some(isCheckPlayer), `${CHECK_PLAYER} is on the list friends pick from, which leaves the check's own player out`);
}

/** The standings answer, whatever is on record, and never have the check's own player in them. */
async function checkStandings(visitor: Visitor): Promise<void> {
  const answer = await ask(visitor, { op: 'standings' });
  assert.ok(answer.ok && answer.units, `the standings could not be read: ${answer.error}`);

  const players = answer.units.flatMap((unit) => unit.players);
  assert.ok(!players.some(isCheckPlayer), `${CHECK_PLAYER} is in the standings, where a table of one player should leave nobody`);
}

/**
 * Answers "who are you?" as the check's one player, by their name typed as someone new: the list a
 * page is offered leaves them out, and the server takes whoever comes in under that name for them.
 * `nameBox` is where a new player's name is typed.
 */
async function sayWho(visitor: Visitor, nameBox: string): Promise<void> {
  await visitor.app.locator(nameBox).fill(CHECK_PLAYER);
}

async function presetNames(visitor: Visitor): Promise<string[]> {
  const answer = await ask(visitor, { op: 'presets' });
  assert.ok(answer.ok && answer.presets, `the presets could not be listed: ${answer.error}`);

  return answer.presets.map((preset) => preset.name);
}

const BOTH_MAY_ANSWER =
  'For about a minute after a web app is given a version, Google answers from the version it had as well, so both may still be answering: wait a minute and run the check again. ' +
  'The deploy waits that minute out before it says "Live at" or "Staging at". If this comes after it said so, the address was given another version since.';

// The two ways a check meets an answer from another build than its page's: the page hears it and stops, or a request of the check's own is turned away
const ANOTHER_BUILD_ANSWERED = `A page of the check's is showing "The game was updated": an answer came to it from another build than its own, and it stopped there. ${BOTH_MAY_ANSWER}`;
const ANOTHER_BUILD_REFUSED = `A request of the check's own was turned away as one from a page of another build. ${BOTH_MAY_ANSWER}`;

/** Whether a page is showing that the game was updated, which it does once an answer has come to it from another build than its own. */
async function toldOfAnUpdate(visitors: readonly Visitor[]): Promise<boolean> {
  for (const visitor of visitors) {
    try {
      if (!visitor.page.isClosed() && (await visitor.app.locator('.outdated').count()) > 0) {
        return true;
      }
    } catch {
      // A page that can no longer be looked at shows nothing to go by
    }
  }

  return false;
}

/**
 * Plays the check's short game at `place`, and throws at the first thing that is not as it should be.
 * A step that failed because another build answered says so: a page told of an update shows nothing
 * more, and the step would otherwise read as one that only took too long.
 */
export async function playCheck(place: CheckedPlace): Promise<void> {
  const opened: Visitor[] = [];
  const open: CheckedPlace['open'] = async (url, phone) => {
    const visitor = await place.open(url, phone);
    opened.push(visitor);

    return visitor;
  };

  try {
    await play({ ...place, open });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const why = (await toldOfAnUpdate(opened)) ? ANOTHER_BUILD_ANSWERED : message.includes(OUTDATED_MESSAGE) ? ANOTHER_BUILD_REFUSED : null;

    throw why ? new Error(`${message}\n\n${why}`, { cause: error }) : error;
  }
}

async function play(place: CheckedPlace): Promise<void> {
  /** Does one thing a player does and says how long the table took to show it. */
  const timed = async (what: string, step: () => Promise<unknown>): Promise<void> => {
    const started = Date.now();
    await step();
    place.say(`  ${what}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  };

  /**
   * Saves a preset from the host's table settings, finds it in the form for a new table, and deletes it
   * again: the one place the Presets tab, its timestamp cell and a deleted row meet the real Sheet. The
   * preset is deleted whatever happens in between, so the tab is left with the presets it had.
   */
  const checkPresets = async (host: Visitor, tableId: string, me: string): Promise<void> => {
    const before = await presetNames(host);
    if (before.length >= LIMITS.presets) {
      place.say(`  (the group has ${before.length} presets, so there is no room to save one and the presets are not checked)`);
      return;
    }

    const name = `Live check ${Date.now()}`;
    const [id, token] = me.split('.');
    const openPresets = async () => {
      await host.app.locator('[data-action="menu"]').click();
      await host.app.locator('.menu [data-action="settings"]').click();
      await host.app.locator('summary[data-section="presets"]').click();
    };

    try {
      await timed('save a preset', async () => {
        await openPresets();
        await host.app.locator('#preset-name').fill(name);
        await host.app.locator('[data-action="save-preset"]').click();
        await host.app.locator(`.preset-list .preset-name:text-is("${name}")`).waitFor();
      });
      await host.app.locator('[data-action="close"]').click();

      const lobby = await place.open(place.address);
      await timed('the form for a new table offers it', () => lobby.app.locator(`#new-table-preset option:text-is("${name}")`).waitFor({ state: 'attached' }));
      await lobby.page.context().close();

      await timed('delete the preset', async () => {
        await openPresets();
        await host.app.locator(`[aria-label="Delete ${name}"]`).click();
        await host.app.locator('[data-action="confirm-delete-preset"]').click();
        await host.app.locator('.preset-panel p.note[aria-live]', { hasText: `Deleted ${name}.` }).waitFor();
      });
      await host.app.locator('[data-action="close"]').click();
    } finally {
      // Gone already if the page deleted it; otherwise this is the cleanup after a step that failed
      const left = await ask(host, { op: 'deletePreset', tableId, auth: { id, token }, name });
      assert.ok(left.ok, `the check's preset ${name} could not be deleted: ${left.error}`);
    }

    assert.deepEqual(await presetNames(host), before, 'the presets are not as the check found them');
  };

  const host = await place.open(place.address);

  await timed('front page', () => host.app.locator('#host-name').waitFor());
  await place.frontPage?.(host);

  await timed('say who the host is', () => sayWho(host, '#host-name'));
  await timed('create a table', async () => {
    await host.app.locator('[data-action="create-table"]').click();
    await host.app.locator('#table-link').waitFor();
  });

  const invite = await host.app.locator('#table-link').inputValue();
  await host.app.locator('[data-action="close"]').click();
  await host.page.waitForURL(/[?&]me=/);
  assert.ok(inAddress(host.page, 'table'), "the address names the table and the host's seat");

  // The guest is the same player from another browser: a second member under a number, with a seat of their own
  const guest = await place.open(invite, true);
  await guest.app.locator('#join-name').waitFor();
  await timed('say who the guest is', () => sayWho(guest, '#join-name'));
  await timed('join by the invite link', async () => {
    await guest.app.locator('[data-action="join-table"]').click();
    await guest.app.locator('.stage .table').waitFor();
  });

  await checkPlayers(host);

  await timed('host sits down', async () => {
    await host.app.locator('[data-sit="0"]').click();
    await host.app.locator('[data-action="confirm-sit"]').click();
    await host.app.locator('.seat.me').waitFor();
  });

  await guest.app.locator('[data-sit="1"]').click();
  await guest.app.locator('[data-action="confirm-sit"]').click();
  await timed("guest's request reaches the host", () => host.app.locator('.banner [data-action="approve"]').waitFor());
  await host.app.locator('.banner [data-action="approve"]').click();
  await timed('approval reaches the guest', () => guest.app.locator('.seat.me').waitFor());

  await host.app.locator('.message [data-action="start"]').click();

  const fold = (visitor: Visitor) => visitor.app.locator('.turn [data-action="fold"]:enabled');
  let first: Visitor | null = null;

  await timed('first hand dealt', async () => {
    first = await Promise.race([host, guest].map((visitor) => fold(visitor).waitFor().then(() => visitor)));
  });

  const actor = first!;
  const other = actor === host ? guest : host;
  await host.page.screenshot({ path: place.picture('host') });
  await guest.page.screenshot({ path: place.picture('guest') });

  await timed('a fold shows on the other screen', async () => {
    await fold(actor).click();
    await other.app.locator('.message.result').waitFor();
  });

  // A hand is filed once it is cleared away for the next one, so that cards shown late are in it
  await timed('second hand dealt', () => Promise.race([host, guest].map((visitor) => fold(visitor).waitFor())));

  // The hand history is read back from where hands are kept, not from the table in memory
  await timed('hand history', async () => {
    await host.app.locator('[data-action="menu"]').click();
    await host.app.locator('.menu [data-action="history"]').click();
    await host.app.locator('.history summary:has-text("Hand #1")').waitFor();
  });
  await host.app.locator('[data-action="close"]').click();

  await timed('reload at the personal address', async () => {
    await host.page.reload();
    await host.app.locator('.stage .table, [data-action="confirm-member"]').first().waitFor();
  });

  if (await host.app.locator('[data-action="confirm-member"]').count()) {
    place.say('  (this browser had forgotten the seat, so the address was what found it)');
    await host.app.locator('[data-action="confirm-member"]').click();
  }

  await host.app.locator('.seat.me').waitFor();
  await host.page.screenshot({ path: place.picture('host-after') });

  await checkPresets(host, inAddress(host.page, 'table')!, inAddress(host.page, 'me')!);
  await timed('standings', () => checkStandings(host));

  for (const visitor of [host, guest]) {
    await visitor.page.context().close();
  }
}
