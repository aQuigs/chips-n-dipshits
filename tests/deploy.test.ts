/*
 * The deploy, on a stand-in for the script with Google and for a checkout's files. What the stand-in
 * keeps is what matters about the real thing: a web app serves the version it was last given, a push
 * changes no web app, and a call can take effect with Google and still fail here. And what the first
 * real deploy showed of Google: for a while after a web app is given a version the one before answers
 * at its address too, and the list of web apps shows the script as it was some time ago.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { QUIET_MS, SETTLE_DEADLINE_MS } from '../scripts/answering.ts';
import type { Answer, Answers } from '../scripts/answering.ts';
import { addressToCheck, deploymentFrom, DeployRefused, DeployUnsettled, exitOnRefusal, linkFilesElsewhere, readDeployment, stagingAsked, webAppUrlFor } from '../scripts/deployment.ts';
import type { Deployment, LinkFilesElsewhere } from '../scripts/deployment.ts';
import { claspOver, deploy, LIST_DEADLINE_MS, modeOf, TITLE } from '../scripts/deploySteps.ts';
import type { Built, Checkout, Clasp, ListedWebApp, Mode } from '../scripts/deploySteps.ts';

const NEW_CODE = 'the code in the tree';
const UNNAMED_CODE = 'code from before builds had ids';

/** What a build of some code for one address is: the same code for the same address, the same build. */
const built = (url: string, code = NEW_CODE) => `${code}, built for ${url || 'no address'}`;
/** The mark of everything such a build pushes, which is what the record keeps of a staged build. */
const markOf = (url: string, code = NEW_CODE) => `mark of ${built(url, code)}`;
/** The id on every answer of a build, by what the build is; code from before builds had ids puts none on. */
const idOf = (build: string) => (build.startsWith(UNNAMED_CODE) ? null : `id of ${build}`);

/** A clock the test moves. A pause takes no time and moves it on. */
class FakeClock {
  ms = 3_600_000;

  now = (): Date => new Date(this.ms);

  pause = async (ms: number): Promise<void> => {
    this.ms += ms;
  };
}

class FakeCheckout implements Checkout {
  link = false;
  record: Deployment | null = null;
  /** What reading the record fails with, when the file is there and cannot be gone by. */
  unreadable: Error | null = null;
  found: LinkFilesElsewhere | null = null;
  /** The sources as they stand. */
  code = NEW_CODE;
  /** What is in `dist/`. */
  dist = 'a build left from before';

  linked(): boolean {
    return this.link;
  }

  async readDeployment(): Promise<Deployment | null> {
    if (this.unreadable) {
      throw this.unreadable;
    }

    return this.record;
  }

  async writeDeployment(deployment: Deployment): Promise<void> {
    this.record = deployment;
  }

  async build(webAppUrl: string): Promise<Built> {
    this.dist = built(webAppUrl, this.code);

    return { id: idOf(this.dist)!, mark: markOf(webAppUrl, this.code) };
  }

  elsewhere(): LinkFilesElsewhere | null {
    return this.found;
  }
}

/** A web app as the script has it: the version it serves, the one it served before that, and when it was given this one. */
interface FakeWebApp {
  version: number;
  description: string;
  before: number | null;
  since: number;
}

class FakeScript implements Clasp, Answers {
  readonly calls: string[] = [];
  /** Everything that was pushed, the last of it being what a new version is made of. */
  readonly pushed: string[] = [];
  /** Every call to an address that was answered: when, where, and by which build. */
  readonly answered: { at: number; url: string; build: string | null }[] = [];
  /** The next web app is made with Google, and the answer that says which never arrives. */
  loseNextAnswer = false;
  /** A web app Google will not update for now. */
  unavailable: string | null = null;
  /** clasp makes the Sheet and its script, then fails before it has linked the checkout to them. */
  failsAfterMakingTheSheet = false;
  /** How long after a web app is given a version the one it had goes on answering at its address too, every other call. */
  mixMs = 0;
  /** How far behind the list of web apps is: a read shows the script as it was this long ago, and every other read as it was twice as long ago. */
  listLagMs = 0;
  /** A web app whose address answers nothing for now. */
  silent: string | null = null;
  /** clasp updates a web app and does not say which version it gave it. */
  saysNoVersion = false;
  private readonly checkout: FakeCheckout;
  private readonly clock: FakeClock;
  private readonly versions: string[] = [];
  private readonly apps = new Map<string, FakeWebApp>();
  private readonly lists: { at: number; apps: ListedWebApp[] }[] = [];
  private listsRead = 0;
  private asked = 0;

  constructor(checkout: FakeCheckout, clock: FakeClock) {
    this.checkout = checkout;
    this.clock = clock;
  }

  /** A web app the script has from before, serving `build`: from long before the test, or from the last thing done to the script in it. */
  has(deploymentId: string, build: string, description = `${TITLE}, deployed some time ago`): void {
    this.versions.push(build);
    this.serve(deploymentId, this.versions.length, description, this.lists.at(-1)?.at ?? 0);
  }

  /** Someone gives a web app a version of this code now, outside the deploy: by hand in the editor, or from another checkout. */
  givenElsewhere(deploymentId: string, build: string): void {
    this.versions.push(build);
    this.serve(deploymentId, this.versions.length, this.apps.get(deploymentId)!.description, this.clock.ms);
  }

  /** The build a visitor to this web app gets, once only one answers there. */
  serves(deploymentId: string): string | null {
    const app = this.apps.get(deploymentId);

    return app ? this.versions[app.version - 1]! : null;
  }

  /** How many versions of the script there are, of the few Google keeps. */
  versionsMade(): number {
    return this.versions.length;
  }

  /** The web apps the script has now, whatever the list shows. */
  webAppsNow(): string[] {
    return [...this.apps.keys()];
  }

  /** Whether the version a web app had still answers at its address some of the time. */
  mixedAt(deploymentId: string): boolean {
    const app = this.apps.get(deploymentId);

    return app !== undefined && app.before !== null && this.clock.ms - app.since < this.mixMs;
  }

  async ask(url: string): Promise<Answer> {
    const deploymentId = [...this.apps.keys()].find((id) => webAppUrlFor(id) === url);
    const app = deploymentId === undefined ? undefined : this.apps.get(deploymentId);

    if (!app || deploymentId === this.silent) {
      return { failed: 'no answer' };
    }

    const version = this.mixedAt(deploymentId!) && this.asked++ % 2 === 0 ? app.before! : app.version;
    const build = idOf(this.versions[version - 1]!);

    this.answered.push({ at: this.clock.ms, url, build });

    return { build };
  }

  createScript(): void {
    this.calls.push('createScript');

    if (this.failsAfterMakingTheSheet) {
      throw new Error('Could not pull the new project');
    }

    this.checkout.link = true;
    this.checkout.dist = 'the starter files';
  }

  push(): void {
    this.calls.push('push');
    this.pushed.push(this.checkout.dist);
  }

  webApps(): ListedWebApp[] {
    if (this.listLagMs === 0) {
      return this.lists.at(-1)?.apps ?? [];
    }

    // Behind by the lag, and every other read by twice the lag: a later read can show an earlier state
    const asOf = this.clock.ms - this.listLagMs * (this.listsRead++ % 2 === 0 ? 1 : 2);

    return this.lists.filter((list) => list.at <= asOf).at(-1)?.apps ?? [];
  }

  createWebApp(description: string, version?: number): string {
    const deploymentId = `AKfycb-made-${this.apps.size + 1}`;

    this.calls.push(`createWebApp ${deploymentId}`);
    this.give(deploymentId, description, version);

    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      throw new Error('socket hang up');
    }

    return deploymentId;
  }

  updateWebApp(deploymentId: string, description: string, version?: number): number | null {
    this.calls.push(`updateWebApp ${deploymentId}${version === undefined ? '' : ` to version ${version}`}`);
    assert.ok(this.apps.has(deploymentId), `the script has no web app ${deploymentId}`);

    if (this.unavailable === deploymentId) {
      throw new Error('Service unavailable');
    }

    this.give(deploymentId, description, version);

    return this.saysNoVersion ? null : this.apps.get(deploymentId)!.version;
  }

  private give(deploymentId: string, description: string, version: number | undefined): void {
    if (version === undefined) {
      this.versions.push(this.pushed.at(-1) ?? 'nothing pushed');
    } else {
      assert.ok(version >= 1 && version <= this.versions.length, `the script has no version ${version}`);
    }

    this.serve(deploymentId, version ?? this.versions.length, description, this.clock.ms);
  }

  private serve(deploymentId: string, version: number, description: string, since: number): void {
    this.apps.set(deploymentId, { version, description, before: this.apps.get(deploymentId)?.version ?? null, since });
    this.lists.push({ at: since, apps: [...this.apps].map(([id, app]) => ({ deploymentId: id, version: app.version, description: app.description })) });
  }
}

const LIVE = 'AKfycb-live';
const LIVE_URL = webAppUrlFor(LIVE);
const OLD_CODE = 'the code friends are playing on';
const STAGING_MADE = `${TITLE}, staging`;

const refused = (pattern: RegExp) => (error: unknown) => error instanceof DeployRefused && pattern.test(error.message);
const entry = (deploymentId: string) => ({ deploymentId, url: webAppUrlFor(deploymentId) });

function setup() {
  const checkout = new FakeCheckout();
  const clock = new FakeClock();
  const script = new FakeScript(checkout, clock);
  const said: string[] = [];
  const saidAt: number[] = [];
  const say = (line: string) => {
    said.push(line);
    saidAt.push(clock.ms);
  };
  const run = (mode: Mode = 'live') => deploy(mode, { clasp: script, answers: script, checkout, say, now: clock.now, pause: clock.pause });
  /** When the first line with this in it was said. */
  const when = (pattern: RegExp) => saidAt[said.findIndex((line) => pattern.test(line))];

  return { checkout, clock, script, said, run, when, told: () => said.join('\n') };
}

/** A checkout linked to a script, with no record of where the game is. */
function linked() {
  const game = setup();
  game.checkout.link = true;

  return game;
}

/** A game that is deployed, in a checkout that holds both of its files. */
function deployed() {
  const game = linked();

  game.checkout.record = entry(LIVE);
  game.script.has(LIVE, OLD_CODE);

  return game;
}

test('a checkout that is not linked to a script deploys nothing and makes nothing, and says how a new game is asked for', async () => {
  const { script, checkout, run } = setup();

  await assert.rejects(run(), refused(/not linked to an Apps Script project.*nothing was made.*To set up a new game.*npm run deploy -- --new/));

  assert.deepEqual(script.calls, []);
  assert.equal(checkout.record, null);
});

test('a git worktree without the two files, whose main checkout holds them, makes no second game and says where they are', async () => {
  const { script, checkout, run } = setup();
  checkout.found = { path: '/somewhere/the-game', linked: true, recorded: true, above: false };

  await assert.rejects(
    run(),
    refused(/nothing was made\. This is a git worktree of \/somewhere\/the-game, which holds \.clasp\.json and \.deployment\.json.*run the deploy there, or copy \.clasp\.json and \.deployment\.json from there/),
  );

  assert.deepEqual(script.calls, []);
  assert.equal(checkout.record, null);
  assert.equal(checkout.link, false);
});

test('a worktree whose main checkout holds only one of the files is told of that one', async () => {
  const { checkout, run } = setup();
  checkout.found = { path: '/somewhere/the-game', linked: true, recorded: false, above: false };

  await assert.rejects(run(), refused(/which holds \.clasp\.json: git ignores that file, so a worktree starts without it\./));
});

test('a checkout under a folder that holds a link file is refused whatever was asked: clasp would go by that file and push that folder\'s build', async () => {
  for (const mode of ['live', 'staging', 'new'] as const) {
    const { script, checkout, run } = setup();
    checkout.found = { path: '/somewhere/the-game', linked: true, recorded: true, above: true };

    await assert.rejects(
      run(mode),
      refused(/no \.clasp\.json of its own, and \/somewhere\/the-game, a folder above it, has one.*push that folder's build, not this one's\. Copy \.clasp\.json and \.deployment\.json from there.*Nothing was deployed and nothing was made/),
      mode,
    );
    assert.deepEqual(script.calls, [], mode);
    assert.equal(checkout.record, null, mode);
  }
});

test('a link file above that has no record of a game beside it may be some other project\'s, and the refusal does not say to copy it', async () => {
  const { script, checkout, run } = setup();
  checkout.found = { path: '/somewhere', linked: true, recorded: false, above: true };

  await assert.rejects(run(), (error: unknown) => refused(/\/somewhere, a folder above it, has one.*may not be this game's: do not copy it.*Nothing was deployed and nothing was made/)(error) && !/Copy \.clasp\.json/.test((error as Error).message));
  assert.deepEqual(script.calls, []);
});

test('staging is refused the same way where nothing is linked', async () => {
  const { script, run } = setup();

  await assert.rejects(run('staging'), refused(/not linked/));
  assert.deepEqual(script.calls, []);
});

test('a record that is there and cannot be gone by stops everything, and is never taken for no record', async () => {
  for (const mode of ['live', 'staging', 'new'] as const) {
    for (const link of [true, false]) {
      const { script, checkout, run } = setup();
      checkout.link = link;
      checkout.unreadable = new DeployRefused('.deployment.json cannot be gone by as it is');
      script.has(LIVE, OLD_CODE);

      await assert.rejects(run(mode), refused(/cannot be gone by/), `${mode}, linked: ${link}`);
      assert.deepEqual(script.calls, [], `${mode}, linked: ${link}`);
      assert.equal(checkout.record, null, 'and nothing is written over the file');
    }
  }
});

test('--new sets up a game where there is none: a Sheet with its script, a web app, its address on record and in the build it serves', async () => {
  const { script, checkout, run, told } = setup();

  await run('new');

  const { deploymentId, url } = checkout.record!;
  assert.equal(url, webAppUrlFor(deploymentId));
  assert.equal(checkout.record!.staging, undefined);
  assert.equal(script.calls[0], 'createScript');
  assert.equal(script.pushed[0], built(''), 'what is pushed first is this build, not the starter files the new project came with');
  assert.equal(script.serves(deploymentId), built(url));
  assert.equal(script.webApps().length, 1);
  assert.match(told(), new RegExp(`Live at ${url}$`));
});

test('--new that fails while clasp is making the Sheet says one may be there, since running it again would make another', async () => {
  const { script, checkout, run, told } = setup();
  script.failsAfterMakingTheSheet = true;

  await assert.rejects(run('new'), /Could not pull the new project/);

  assert.match(told(), /a Sheet named "Chips n' Dipshits" may have been made all the same\. Look for it in Google Drive and remove it before running --new again/);
  assert.deepEqual(script.calls, ['createScript']);
  assert.equal(checkout.record, null);
});

test('--new in a worktree of a checkout that has a game says it is making another one beside it', async () => {
  const { checkout, run, told } = setup();
  checkout.found = { path: '/somewhere/the-game', linked: true, recorded: true, above: false };

  await run('new');

  assert.match(told(), /git worktree of \/somewhere\/the-game, which has a game of its own\. What --new makes here is another game, beside that one/);
});

test('--new is refused where a game is on record, and nothing of that game is touched', async () => {
  const { script, checkout, run } = deployed();

  await assert.rejects(run('new'), refused(/already has a game on record.*--new sets one up only where there is none/));

  assert.deepEqual(script.calls, []);
  assert.deepEqual(checkout.record, entry(LIVE));
  assert.equal(script.serves(LIVE), OLD_CODE);
});

test('--new is refused for a linked script that already has a web app', async () => {
  const { script, run } = linked();
  script.has(LIVE, OLD_CODE);

  await assert.rejects(run('new'), refused(/already has a web app, and --new makes an address only where there is none: AKfycb-live/));

  assert.deepEqual(script.calls, []);
  assert.equal(script.webApps().length, 1);
});

test('--new gives a linked script that has no web app its first one, without making another Sheet, from a build made now', async () => {
  const { script, checkout, run } = linked();

  await run('new');

  assert.ok(!script.calls.includes('createScript'));
  assert.equal(script.pushed[0], built(''), 'not whatever was in dist/ from before');
  assert.equal(script.serves(checkout.record!.deploymentId), built(checkout.record!.url));
});

test('an address on record in a checkout that is not linked to its script is refused, with --new too', async () => {
  for (const mode of ['live', 'staging', 'new'] as const) {
    const { script, checkout, run } = setup();
    checkout.record = entry(LIVE);

    await assert.rejects(run(mode), refused(/has the game's address on record.*\.clasp\.json is missing, so nothing was deployed/), mode);
    assert.deepEqual(script.calls, [], mode);
  }
});

test('a linked script with one web app and no record gets that address put on record and nothing pushed; the next run updates it', async () => {
  const { script, checkout, run } = linked();
  script.has(LIVE, OLD_CODE);

  await assert.rejects(run(), refused(new RegExp(`the one web app the linked script has was put in \\.deployment\\.json: ${LIVE_URL}\\. Nothing was pushed`)));
  assert.deepEqual(script.calls, []);
  assert.deepEqual(checkout.record, entry(LIVE));
  assert.equal(script.serves(LIVE), OLD_CODE);

  await run();
  assert.equal(script.serves(LIVE), built(LIVE_URL));
});

test('a linked script with several web apps that could be the friends\' and no record is refused, naming them as Google has them described', async () => {
  const { script, checkout, run } = linked();
  script.has(LIVE, OLD_CODE);
  script.has('AKfycb-other', OLD_CODE, 'Made by hand');

  await assert.rejects(run(), refused(/has 2 web apps and this checkout has none on record: AKfycb-live \("Chips n' Dipshits, deployed some time ago"\), AKfycb-other \("Made by hand"\)/));

  assert.deepEqual(script.calls, []);
  assert.equal(checkout.record, null);
});

test('a checkout with no record of a game that has a staging web app finds both in two runs that push nothing, and never takes the staging one for the friends\'', async () => {
  const { script, checkout, run } = linked();
  script.has('AKfycb-staging', OLD_CODE, `${STAGING_MADE}, deployed last week`);
  script.has(LIVE, OLD_CODE);

  await assert.rejects(run(), refused(new RegExp(`one web app that was not made for staging was put in \\.deployment\\.json: ${LIVE_URL}`)));
  assert.deepEqual(checkout.record, entry(LIVE));

  await assert.rejects(run('staging'), refused(new RegExp(`a staging web app this checkout had no record of, so it was put in \\.deployment\\.json under "staging": ${webAppUrlFor('AKfycb-staging')}\\. Nothing was pushed`)));
  assert.deepEqual(checkout.record, { ...entry(LIVE), staging: entry('AKfycb-staging') });
  assert.deepEqual(script.calls, []);

  await run('staging');
  assert.equal(script.serves('AKfycb-staging'), built(webAppUrlFor('AKfycb-staging')));
  assert.equal(script.serves(LIVE), OLD_CODE);
  assert.equal(script.webApps().length, 2);
});

test('a linked script whose only web app was made for staging has no address to take for the friends\'', async () => {
  const { script, checkout, run } = linked();
  script.has('AKfycb-staging', OLD_CODE, STAGING_MADE);

  await assert.rejects(run(), refused(/has a web app and this checkout has none on record/));
  assert.equal(checkout.record, null);
});

test('a linked script with no web app and no record is refused, and makes none unasked', async () => {
  const { script, run } = linked();

  await assert.rejects(run(), refused(/has no web app.*npm run deploy -- --new/));

  assert.deepEqual(script.calls, []);
  assert.equal(script.webApps().length, 0);
});

test('a deploy puts the build for the friends\' address at that address, which stays the same, and says that it was not staged', async () => {
  const { script, checkout, run, told } = deployed();

  await run();

  assert.equal(script.serves(LIVE), built(LIVE_URL));
  assert.deepEqual(script.calls, ['push', `updateWebApp ${LIVE}`]);
  assert.deepEqual(checkout.record, entry(LIVE));
  assert.match(told(), /^Note: this code was not put at the staging address first/);
  assert.match(told(), new RegExp(`Building for ${LIVE_URL}`));
  assert.match(told(), new RegExp(`Live at ${LIVE_URL}$`));
});

test('link and record files from two different games are refused before anything is pushed', async () => {
  for (const mode of ['live', 'staging'] as const) {
    const { script, checkout, run } = linked();
    checkout.record = entry(LIVE);
    script.has('AKfycb-another-game', OLD_CODE);

    await assert.rejects(run(mode), refused(/has no web app AKfycb-live.*from different games.*Nothing was pushed/), mode);
    assert.deepEqual(script.calls, [], mode);
    assert.equal(script.serves('AKfycb-another-game'), OLD_CODE, mode);
  }
});

test('a record whose friends\' entry is a web app made for staging is refused: a live deploy there would leave the friends on old code', async () => {
  for (const mode of ['live', 'staging'] as const) {
    const { script, checkout, run } = linked();
    script.has(LIVE, OLD_CODE);
    script.has('AKfycb-staging', OLD_CODE, `${STAGING_MADE}, deployed last week`);
    checkout.record = { ...entry('AKfycb-staging'), staging: entry(LIVE) };

    await assert.rejects(run(mode), refused(/has as the friends' address is one this made for staging.*the wrong way around.*Nothing was pushed/), mode);
    assert.deepEqual(script.calls, [], mode);
  }
});

test('staging puts the build on a second web app of the script and leaves the friends\' address serving what it served', async () => {
  const { script, checkout, run, told } = deployed();

  await run('staging');

  const staging = checkout.record!.staging!;
  assert.notEqual(staging.deploymentId, LIVE);
  assert.equal(staging.url, webAppUrlFor(staging.deploymentId));
  assert.equal(staging.build, markOf(staging.url), 'the record says which build was put there');
  assert.equal(script.serves(staging.deploymentId), built(staging.url), 'the staging page is told its own address');
  assert.equal(script.serves(LIVE), OLD_CODE, 'the friends\' address still serves the old code');
  assert.deepEqual({ deploymentId: checkout.record!.deploymentId, url: checkout.record!.url }, entry(LIVE));
  assert.ok(!script.calls.some((call) => call.startsWith(`updateWebApp ${LIVE}`)));
  assert.match(told(), new RegExp(`Staging at ${staging.url}`));
  assert.match(told(), new RegExp(`The friends' address ${LIVE_URL} was not touched: build ${idOf(OLD_CODE)}, which answered there before this, is still the one that answers`));
  assert.match(told(), /If the check fails, nothing has changed for friends: fix the code and run this again\./, 'what a failed check means is said before it is run');
  assert.match(told(), /the Apps Script editor shows this code, .* no address friends have serves it/, 'so that the new code in the editor alarms nobody');
  assert.equal(script.versionsMade(), 2, 'one version for the staging build, and none for making its web app');
  assert.match(script.webApps().find((app) => app.deploymentId === staging.deploymentId)!.description, /^Chips n' Dipshits, staging, deployed /);
});

test('staging again uses the staging web app on record and makes no third', async () => {
  const { script, checkout, run } = deployed();
  await run('staging');
  const { deploymentId, url } = checkout.record!.staging!;

  checkout.code = 'a later change';
  await run('staging');

  assert.deepEqual(checkout.record!.staging, { deploymentId, url, build: markOf(url, 'a later change') });
  assert.equal(script.webApps().length, 2);
  assert.equal(script.serves(deploymentId), built(url, 'a later change'));
  assert.equal(script.serves(LIVE), OLD_CODE);
});

test('staging is refused while the script has a web app this checkout has no record of and did not make', async () => {
  const { script, checkout, run } = deployed();
  script.has('AKfycb-stranger', OLD_CODE, 'Made by hand');

  await assert.rejects(
    run('staging'),
    refused(
      /has a web app that this checkout has no record of: AKfycb-stranger \("Made by hand"\)\. Staging keeps one web app beside the friends' and never makes a third, so nothing was made and nothing was pushed\. Find out what it is for before anything else: if one is the address your friends use.*archived.*which cannot be undone/,
    ),
  );

  assert.deepEqual(script.calls, []);
  assert.equal(checkout.record!.staging, undefined);
});

test('a staging web app on record is told from a stranger: staging goes ahead with the one, and is refused for the other beside it', async () => {
  const { script, checkout, run } = deployed();
  await run('staging');
  const staging = checkout.record!.staging!;

  // Made for staging too, by its description, and still a third
  script.has('AKfycb-stranger', OLD_CODE, STAGING_MADE);
  await assert.rejects(run('staging'), refused(/no record of: AKfycb-stranger/));
  assert.equal(script.serves(staging.deploymentId), built(staging.url));
  assert.deepEqual(checkout.record!.staging, staging);
});

test('a staging web app made with Google whose id never came back is found by the next run, which pushes nothing, and staged at by the one after', async () => {
  const { script, checkout, run } = deployed();
  script.loseNextAnswer = true;

  await assert.rejects(run('staging'), /socket hang up/);
  assert.equal(script.webApps().length, 2, 'it was made');
  assert.equal(checkout.record!.staging, undefined, 'and this checkout does not know of it');

  const before = [...script.calls];
  await assert.rejects(run('staging'), refused(/a staging web app this checkout had no record of, so it was put in \.deployment\.json under "staging"/));
  assert.deepEqual(script.calls, before);

  await run('staging');
  const staging = checkout.record!.staging!;
  assert.equal(script.webApps().length, 2, 'no third was made');
  assert.equal(script.serves(staging.deploymentId), built(staging.url));
  assert.equal(script.serves(LIVE), OLD_CODE);
});

test('a staging web app on record that the script no longer has is replaced by a new one', async () => {
  const { script, checkout, run, told } = deployed();
  checkout.record = { ...checkout.record!, staging: entry('AKfycb-gone') };

  await run('staging');

  const staging = checkout.record!.staging!;
  assert.notEqual(staging.deploymentId, 'AKfycb-gone');
  assert.equal(script.serves(staging.deploymentId), built(staging.url));
  assert.match(told(), /is no longer one of the script's, so a new one is made/);
});

test('a record that names the friends\' address as its own staging web app is refused, and that address keeps its code', async () => {
  const { script, checkout, run } = deployed();
  checkout.record = { ...checkout.record!, staging: entry(LIVE) };

  await assert.rejects(run('staging'), refused(/names the friends' address itself as the staging web app/));

  assert.deepEqual(script.calls, []);
  assert.equal(script.serves(LIVE), OLD_CODE);
});

test('a record whose staging entry is a web app that was not made for staging is refused, and that web app keeps its code', async () => {
  const { script, checkout, run } = deployed();
  script.has('AKfycb-other', OLD_CODE, 'Made by hand');
  checkout.record = { ...checkout.record!, staging: entry('AKfycb-other') };

  await assert.rejects(run('staging'), refused(/has under "staging" is not one this made for staging: Google has it described as "Made by hand"/));

  assert.deepEqual(script.calls, []);
  assert.equal(script.serves('AKfycb-other'), OLD_CODE);
});

/** A script whose web apps all move together, which Google's do not. */
function movingTogether(script: FakeScript): void {
  const update = script.updateWebApp.bind(script);

  script.updateWebApp = (deploymentId, description, version) => {
    const given = update(deploymentId, description, version);
    update(LIVE, description, given ?? undefined);

    return given;
  };
}

test('staging that finds another build answering at the friends\' address than before fails loudly, whatever the list of web apps shows', async () => {
  for (const listLagMs of [60_000, 0]) {
    const { script, run, told } = deployed();
    script.listLagMs = listLagMs;
    movingTogether(script);

    await assert.rejects(
      run('staging'),
      new RegExp(`was answered by build ${idOf(OLD_CODE)} before this and is answered by build ${idOf(built(webAppUrlFor('AKfycb-made-2')))} now, which staging must never bring about`),
      `a list ${listLagMs} ms behind`,
    );
    assert.doesNotMatch(told(), /Staging at|was not touched/);
  }
});

test('staging is refused while two builds answer at the friends\' address, which is when it was given a version a moment ago', async () => {
  const { script, checkout, run } = deployed();
  script.mixMs = 60_000;
  script.givenElsewhere(LIVE, 'code someone put there by hand');

  await assert.rejects(run('staging'), refused(/Two builds answer at the friends' address.*given a version in the last minute or so.*Wait a minute and run this again\. Nothing was pushed/));

  assert.deepEqual(script.calls, []);
  assert.equal(checkout.record!.staging, undefined);
});

test('staging goes ahead when the friends\' address gives no answer to go by, and says that it could not tell', async () => {
  const { script, checkout, run, told } = deployed();
  script.silent = LIVE;

  await run('staging');

  const staging = checkout.record!.staging!;
  assert.equal(script.serves(staging.deploymentId), built(staging.url));
  assert.match(told(), new RegExp(`Staging at ${staging.url}`));
  assert.match(told(), /Whether the friends' address .* still serves what it served could not be told from its answers: it gave none to go by before this \(no answer\)\. Nothing here gives that address a version/);
  assert.doesNotMatch(told(), /was not touched/);
});

test('code from before builds had ids is told from a build by its answers carrying none, and staging beside it says so', async () => {
  const { script, checkout, run, told } = linked();
  checkout.record = entry(LIVE);
  script.has(LIVE, UNNAMED_CODE);

  await run('staging');

  assert.match(told(), /was not touched: code from before builds had ids, which answered there before this, is still the one that answers/);
});

test('a deploy after staging puts the build for the friends\' address there, says it is the code that was staged, and has the staging web app serve that same version', async () => {
  const { script, checkout, run, told } = deployed();
  await run('staging');
  const { deploymentId, url } = checkout.record!.staging!;

  await run();

  assert.equal(script.serves(LIVE), built(LIVE_URL), 'friends get the build made for their address, not the staging one');
  assert.equal(script.serves(deploymentId), built(LIVE_URL), 'and the staging address serves what they are served');
  assert.equal(script.webApps().length, 2, 'the staging web app is kept for the next time');
  assert.equal(script.versionsMade(), 3, 'one version for staging and one for going live');
  assert.deepEqual(checkout.record, { ...entry(LIVE), staging: { deploymentId, url } },'what was tried there is no longer what it serves');
  assert.match(told(), new RegExp(`This is the code that was last put at the staging address \\(${markOf(url)}\\)`));
  assert.match(told(), new RegExp(`The staging web app at ${url} now serves that same version, 3\\.`));
  assert.match(told(), new RegExp(`Live at ${LIVE_URL}$`), 'which is the last thing said: it is when friends can be told');
  assert.match(script.webApps().find((app) => app.deploymentId === deploymentId)!.description, /^Chips n' Dipshits, staging, on the version live since /);
});

test('going live gives the staging web app the version it just made, though the list of web apps still shows the friends\' address on the one before', async () => {
  const { script, checkout, clock, run, told } = deployed();
  await run('staging');
  const { deploymentId, url } = checkout.record!.staging!;

  await clock.pause(600_000);
  script.listLagMs = 60_000;
  await run();

  assert.equal(script.serves(LIVE), built(LIVE_URL));
  assert.equal(script.serves(deploymentId), built(LIVE_URL), 'and not the version friends had before, which is what the list still showed');
  assert.match(told(), new RegExp(`The staging web app at ${url} now serves that same version, 3\\.`));
});

test('a deploy that clasp does not tell which version went live leaves the staging web app for the next deploy, and says so', async () => {
  const { script, checkout, run, told } = deployed();
  await run('staging');
  const { deploymentId, url } = checkout.record!.staging!;

  script.saysNoVersion = true;
  await run();

  assert.equal(script.serves(LIVE), built(LIVE_URL));
  assert.equal(script.serves(deploymentId), built(url), 'it is given no version read off a list that may be behind');
  assert.match(told(), /could not be given the version that just went live \(clasp did not say which version that is\)\. The next deploy tries again/);
  assert.match(told(), new RegExp(`Live at ${LIVE_URL}$`));
});

test('a staging web app made a minute ago, which the list of web apps does not show yet, is waited for: staging makes no second one and going live does not lose it', async () => {
  for (const mode of ['staging', 'live'] as const) {
    const { script, checkout, run, told } = deployed();
    script.listLagMs = 60_000;
    await run('staging');
    const staging = checkout.record!.staging!;

    checkout.code = 'a later change';
    await run(mode);

    assert.deepEqual(script.webAppsNow(), [LIVE, staging.deploymentId], `${mode}: the script has the two web apps it had`);
    assert.equal(checkout.record!.staging!.deploymentId, staging.deploymentId, `${mode}: and the record still has the staging one`);
    assert.equal(script.serves(staging.deploymentId), built(mode === 'staging' ? staging.url : LIVE_URL, 'a later change'), mode);
    assert.match(told(), /Google's list of the script's web apps does not show the staging web app on record yet\. It can be a minute behind/, mode);
  }
});

test('a web app on record is given up for gone only when the list of web apps has had time to catch up and still does not show it', async () => {
  const gone = deployed();
  gone.checkout.record = { ...gone.checkout.record!, staging: entry('AKfycb-gone') };
  const began = gone.clock.ms;

  await gone.run('staging');
  assert.ok(gone.when(/is no longer one of the script's, so a new one is made/)! - began >= LIST_DEADLINE_MS);

  const other = linked();
  other.checkout.record = entry(LIVE);
  other.script.has('AKfycb-another-game', OLD_CODE);

  await assert.rejects(other.run(), refused(/has no web app AKfycb-live.*from different games/));
  assert.ok(other.clock.ms - began >= LIST_DEADLINE_MS, 'the refusal waits as long, in case the web app was only just made');
});

test('an address is said to be live, or staged at, only when the build put there has been the only one to answer for a while', async () => {
  for (const mode of ['live', 'staging'] as const) {
    const { script, checkout, clock, run, when } = deployed();
    script.mixMs = 60_000;
    const began = clock.ms;

    await run(mode);

    const address = mode === 'staging' ? checkout.record!.staging!.url : checkout.record!.url;
    const said = when(mode === 'staging' ? /Staging at/ : /Live at/)!;
    const others = script.answered.filter((answer) => answer.url === address && answer.build !== idOf(built(address)));

    assert.ok(said >= began + script.mixMs, `${mode}: said ${said - began} ms in, while the version the address had was still answering`);
    assert.ok(others.length > 0, `${mode}: the version the address had was heard answering`);
    assert.ok(said - others.at(-1)!.at >= QUIET_MS, `${mode}: said ${said - others.at(-1)!.at} ms after another build last answered`);
  }
});

test('--new does not wait to hear its build at the new address, which answers nobody until its owner has approved the script, and says so', async () => {
  const { script, checkout, clock, run, told } = setup();
  const began = clock.ms;
  let asked = 0;

  script.ask = async () => {
    asked += 1;

    return { failed: 'HTTP 200, and nothing the game answers with' };
  };

  await run('new');

  assert.equal(clock.ms, began, 'no time went by waiting');
  assert.equal(asked, 0);
  assert.match(told(), /The address answers nobody until its owner has opened it once and approved the permission prompt\./);
  assert.match(told(), new RegExp(`Live at ${checkout.record!.url}$`));
});

test('an address where another build still answers at the deadline is not said to be live: the deploy does the rest, ends failed and says what it heard', async () => {
  const { script, checkout, clock, run, told } = deployed();
  await run('staging');
  const { deploymentId, url } = checkout.record!.staging!;

  script.mixMs = Infinity;
  const began = clock.ms;

  await assert.rejects(
    run(),
    (error: unknown) =>
      error instanceof DeployUnsettled &&
      new RegExp(
        `${LIVE_URL} was given this build \\(${idOf(built(LIVE_URL))}\\), and after ${SETTLE_DEADLINE_MS / 1000} s it is still not the only one that answers there: build ${idOf(OLD_CODE)} answered \\d+ s ago\\..*` +
          'a page there can be told the game was updated.*Run "npm run check:live" in a few minutes',
      ).test(error.message),
  );

  assert.ok(clock.ms - began >= SETTLE_DEADLINE_MS);
  assert.doesNotMatch(told(), /Live at/);
  assert.equal(script.serves(deploymentId), built(LIVE_URL), 'the staging web app was given the version all the same');
  assert.deepEqual(checkout.record, { ...entry(LIVE), staging: { deploymentId, url } });
});

test('a staging address where another build still answers at the deadline is not said to be staged at, and the friends\' address is looked at all the same', async () => {
  const quiet = deployed();
  quiet.script.mixMs = Infinity;

  await assert.rejects(quiet.run('staging'), (error: unknown) => error instanceof DeployUnsettled && /is still not the only one that answers there.*Run "npm run check:live -- --staging" in a few minutes/.test(error.message));

  assert.doesNotMatch(quiet.told(), /Staging at/);
  assert.equal(quiet.checkout.record!.staging!.build, markOf(quiet.checkout.record!.staging!.url), 'what was put there is on record, for going live to compare with');

  const moved = deployed();
  moved.script.mixMs = Infinity;
  movingTogether(moved.script);

  await assert.rejects(moved.run('staging'), /which staging must never bring about/);
});

test('an address that never answers as the build put there says so, and that the web app may not have taken the version', async () => {
  const { script, run } = deployed();
  script.silent = LIVE;

  await assert.rejects(
    run(),
    (error: unknown) =>
      error instanceof DeployUnsettled &&
      /has not answered there once: a call \d+ s ago got no answer \(no answer\)\..*look at the script's deployments in the Apps Script editor\. Or the script asks for a permission it did not have/.test(error.message),
  );
});

test('a deploy of other code than was last staged goes ahead and says so', async () => {
  const { script, checkout, run, told } = deployed();
  await run('staging');

  checkout.code = 'a later change';
  await run();

  assert.equal(script.serves(LIVE), built(LIVE_URL, 'a later change'));
  assert.match(told(), /Note: this is not the code that was last put at the staging address/);
});

test('a second deploy with no staging in between says that it was not staged', async () => {
  const { run, said, told } = deployed();
  await run('staging');
  await run();

  said.length = 0;
  await run();

  assert.match(told(), /^Note: this code was not put at the staging address first/);
});

test('a staging web app that cannot be given the live version does not undo the deploy, and the next deploy gives it one', async () => {
  const { script, checkout, run, told } = deployed();
  await run('staging');
  const { deploymentId, url } = checkout.record!.staging!;

  script.unavailable = deploymentId;
  await run();

  assert.equal(script.serves(LIVE), built(LIVE_URL));
  assert.deepEqual(checkout.record!.staging, { deploymentId, url });
  assert.match(told(), /could not be given the version that just went live \(Service unavailable\)\. The next deploy tries again/);

  script.unavailable = null;
  await run();
  assert.equal(script.serves(deploymentId), script.serves(LIVE));
});

test('a deploy does nothing to the friends\' address through the staging entry, whatever the record says of staging', async () => {
  const { script, checkout, run, told } = deployed();
  checkout.record = { ...checkout.record!, staging: { ...entry(LIVE), build: 'anything' } };

  await run();

  assert.deepEqual(script.calls, ['push', `updateWebApp ${LIVE}`]);
  assert.equal(script.serves(LIVE), built(LIVE_URL));
  assert.deepEqual(checkout.record, entry(LIVE));
  assert.match(told(), /is not one this made for staging, so it was taken off the record and nothing was done to it/);
});

test('a deploy leaves a web app that is on record as staging and was not made for it as it was', async () => {
  const { script, checkout, run } = deployed();
  script.has('AKfycb-other', OLD_CODE, 'Made by hand');
  checkout.record = { ...checkout.record!, staging: entry('AKfycb-other') };

  await run();

  assert.deepEqual(script.calls, ['push', `updateWebApp ${LIVE}`]);
  assert.equal(script.serves('AKfycb-other'), OLD_CODE);
  assert.deepEqual(checkout.record, entry(LIVE));
});

test('a deploy whose staging web app is no longer the script\'s drops it from the record', async () => {
  const { script, checkout, run, told } = deployed();
  checkout.record = { ...checkout.record!, staging: entry('AKfycb-gone') };

  await run();

  assert.deepEqual(script.calls, ['push', `updateWebApp ${LIVE}`]);
  assert.deepEqual(checkout.record, entry(LIVE));
  assert.match(told(), /is no longer one of the script's, so it was taken off the record/);
});

test('a deploy leaves a web app it has no record of where it is, and says so', async () => {
  const { script, run, told } = deployed();
  script.has('AKfycb-stranger', OLD_CODE, 'Made by hand');

  await run();

  assert.equal(script.serves('AKfycb-stranger'), OLD_CODE);
  assert.equal(script.serves(LIVE), built(LIVE_URL));
  assert.match(told(), /also has a web app that this checkout has no record of, left as it was: AKfycb-stranger \("Made by hand"\)/);
});

test('the flags: nothing, --staging or --new, and never two', () => {
  assert.equal(modeOf([]), 'live');
  assert.equal(modeOf(['--staging']), 'staging');
  assert.equal(modeOf(['--new']), 'new');
  assert.throws(() => modeOf(['--staging', '--new']), refused(/not both/));
  assert.throws(() => modeOf(['--stagin']), refused(/"--stagin" is nothing this understands/));
  assert.throws(() => modeOf(['new']), refused(/nothing this understands/));
});

test('a flag npm kept for itself, for want of "--" before it, is refused and not taken for a plain deploy', () => {
  // What npm leaves of `npm run deploy --staging`: no argument, and a setting of its own
  assert.throws(() => modeOf([], { npm_config_staging: 'true' }), refused(/npm kept --staging for itself.*did nothing.*npm run deploy -- --staging/));
  assert.throws(() => modeOf([], { npm_config_new: 'true' }), refused(/npm kept --new for itself.*npm run deploy -- --new/));
  assert.equal(modeOf(['--staging'], { npm_config_cache: '/somewhere', npm_lifecycle_event: 'deploy' }), 'staging');

  assert.throws(() => stagingAsked([], { npm_config_staging: 'true' }), refused(/npm kept --staging for itself.*friends' address.*npm run check:live -- --staging/));
  assert.equal(stagingAsked(['--staging'], {}), true);
  assert.equal(stagingAsked([], {}), false);
  assert.throws(() => stagingAsked(['--live'], {}), refused(/"--live" is nothing this understands/));
});

/** clasp as a command line that notes what it was asked and prints what the test gives it. */
function commandLine(prints: Record<string, string> = {}) {
  const asked: string[][] = [];
  const clasp = claspOver((...args) => {
    asked.push(args);

    return prints[args[0]!] ?? '';
  });

  return { clasp, asked };
}

test('the script\'s web apps are read from clasp\'s list, leaving out its test address at @HEAD', () => {
  const { clasp, asked } = commandLine({
    'list-deployments': `- Fetching deployments...\n${JSON.stringify([{ deploymentId: 'AKfycb-head' }, { deploymentId: 'AKfycb-live', versionNumber: 12, description: 'x' }, { deploymentId: 'AKfycb-staging', versionNumber: 14 }])}\n`,
  });

  assert.deepEqual(clasp.webApps(), [
    { deploymentId: 'AKfycb-live', version: 12, description: 'x' },
    { deploymentId: 'AKfycb-staging', version: 14, description: '' },
  ]);
  assert.deepEqual(asked, [['list-deployments', '--json']]);
});

test('a new web app\'s id is read from what clasp prints, and none printed is an error, not a guess', () => {
  const made = commandLine({ 'create-deployment': 'Deployed AKfycbx_New-1 @7\n' });
  assert.equal(made.clasp.createWebApp('Staging'), 'AKfycbx_New-1');
  assert.equal(made.clasp.createWebApp('Staging', 12), 'AKfycbx_New-1');
  assert.deepEqual(made.asked, [
    ['create-deployment', '--description', 'Staging'],
    ['create-deployment', '--versionNumber', '12', '--description', 'Staging'],
  ]);

  assert.throws(() => commandLine({ 'create-deployment': 'Deployed.\n' }).clasp.createWebApp('Staging'), /did not say which web app it made, so nothing was put on record/);
});

test('a web app is updated by its id, to a new version or to one named, and clasp is never asked to delete anything', () => {
  const { clasp, asked } = commandLine({ 'list-deployments': '[]', 'create-deployment': 'Deployed AKfycbx_New-1 @7\n' });

  clasp.updateWebApp('AKfycb-live', 'Deployed today');
  clasp.updateWebApp('AKfycb-staging', 'On the live version', 12);
  assert.deepEqual(asked, [
    ['update-deployment', 'AKfycb-live', '--description', 'Deployed today', '--json'],
    ['update-deployment', 'AKfycb-staging', '--versionNumber', '12', '--description', 'On the live version', '--json'],
  ]);

  // Without an id, clasp's delete removes the only web app a script has, and a removed address cannot be had back
  clasp.createScript('A game');
  clasp.push();
  clasp.webApps();
  clasp.createWebApp('A web app');
  assert.deepEqual([...new Set(asked.map(([command]) => command))].sort(), ['create-deployment', 'create-script', 'list-deployments', 'push', 'update-deployment']);
});

test('the version a web app was given is what clasp says it gave it, and nothing it says is no version rather than a guess', () => {
  const updated = (printed: string) => commandLine({ 'update-deployment': printed }).clasp.updateWebApp('AKfycb-live', 'Deployed today');

  assert.equal(updated('{\n  "deploymentId": "AKfycb-live",\n  "versionNumber": 5,\n  "description": "Deployed today"\n}\n'), 5);
  assert.equal(updated('- Deploying project...\n{"deploymentId": "AKfycb-live", "versionNumber": 12}\n'), 12, 'whatever clasp prints around it');
  assert.equal(updated('{"deploymentId": "AKfycb-live"}'), null, 'a web app at @HEAD has none');
  assert.equal(updated('{"deploymentId": "AKfycb-other", "versionNumber": 5}'), null, 'a version said of another web app is not this one\'s');
  assert.equal(updated('{"deploymentId": "AKfycb-live", "versionNumber": "5"}'), null);
  assert.equal(updated('Redeployed AKfycb-live @5\n'), null, 'the line clasp prints without --json is not read');
  assert.equal(updated(''), null);
});

test('the files a checkout lacks are found in a folder above it, which clasp would go by, or in the checkout it is a git worktree of', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-test-')));

  try {
    const main = join(root, 'main');
    const beside = join(root, 'elsewhere', 'worktree');
    const inside = join(main, 'worktrees', 'inside');
    const linkTo = (worktree: string, gitDir: string) => {
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    };

    mkdirSync(join(main, '.git', 'worktrees'), { recursive: true });
    linkTo(beside, join(main, '.git', 'worktrees', 'worktree'));
    linkTo(inside, join(main, '.git', 'worktrees', 'inside'));

    assert.equal(linkFilesElsewhere(main), null, 'the main checkout is no worktree');
    assert.equal(linkFilesElsewhere(join(root, 'elsewhere')), null, 'nor is a folder that is no checkout at all');
    assert.equal(linkFilesElsewhere(beside), null, 'a main checkout that holds neither file is nowhere to point to');

    writeFileSync(join(main, '.deployment.json'), '{}');
    assert.deepEqual(linkFilesElsewhere(beside), { path: main, linked: false, recorded: true, above: false });
    assert.deepEqual(linkFilesElsewhere(inside), { path: main, linked: false, recorded: true, above: false }, 'a record above is nothing clasp reads');

    writeFileSync(join(main, '.clasp.json'), '{}');
    assert.deepEqual(linkFilesElsewhere(beside), { path: main, linked: true, recorded: true, above: false });
    assert.deepEqual(linkFilesElsewhere(inside), { path: main, linked: true, recorded: true, above: true }, 'a worktree inside the main checkout has its link file above it');
    assert.deepEqual(linkFilesElsewhere(join(main, 'worktrees')), { path: main, linked: true, recorded: true, above: true }, 'as has any folder under it, worktree or not');

    // git can be told to write the path from the worktree to its main checkout, not the whole of it
    linkTo(beside, join(relative(beside, main), '.git', 'worktrees', 'worktree'));
    assert.deepEqual(linkFilesElsewhere(beside), { path: main, linked: true, recorded: true, above: false });

    // A submodule's .git is a file too, and points somewhere that is no worktree
    linkTo(beside, join(main, '.git', 'modules', 'worktree'));
    assert.equal(linkFilesElsewhere(beside), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the record is read as it was written, and one that was changed into something else is refused, not taken for none', async () => {
  const staging = entry('AKfycb-staging');
  const read = (saved: unknown) => deploymentFrom(JSON.stringify(saved));

  assert.deepEqual(read(entry(LIVE)), entry(LIVE));
  assert.deepEqual(read({ ...entry(LIVE), staging }), { ...entry(LIVE), staging });
  assert.deepEqual(read({ ...entry(LIVE), staging: { ...staging, build: 'abc123' } }), { ...entry(LIVE), staging: { ...staging, build: 'abc123' } });

  assert.throws(() => deploymentFrom(`{"deploymentId": "${LIVE}", "url": "${LIVE_URL}",}`), refused(/cannot be gone by as it is: it is not JSON/));
  assert.throws(() => read(null), refused(/the friends' entry is not a web app's id with the address that id gives/));
  assert.throws(() => read({ deploymentId: LIVE }), refused(/the friends' entry/));
  assert.throws(() => read({ deploymentId: LIVE, url: staging.url }), refused(/the friends' entry.*the same id in both places/), 'an address copied from the other entry');
  assert.throws(() => read({ deploymentId: 'my-game', url: webAppUrlFor('my-game') }), refused(/the friends' entry/));
  assert.throws(() => read({ ...entry(LIVE), staging: { deploymentId: 'AKfycb-staging', url: LIVE_URL } }), refused(/the entry under "staging"/));
  assert.throws(() => read({ ...entry(LIVE), staging: null }), refused(/the entry under "staging"/));

  const folder = mkdtempSync(join(tmpdir(), 'deploy-test-'));

  try {
    const file = join(folder, '.deployment.json');
    assert.equal(await readDeployment(file), null, 'no file is no record');

    writeFileSync(file, '{"deploymentId": ');
    await assert.rejects(readDeployment(file), refused(/it is not JSON/));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a check plays at the friends\' address, or at the staging one when asked, and never at one that is not on record', () => {
  const staging = entry('AKfycb-staging');

  assert.equal(addressToCheck(entry(LIVE), false), LIVE_URL);
  assert.equal(addressToCheck({ ...entry(LIVE), staging }, false), LIVE_URL);
  assert.equal(addressToCheck({ ...entry(LIVE), staging }, true), staging.url);
  assert.throws(() => addressToCheck(entry(LIVE), true),/no staging web app on record.*npm run deploy -- --staging/);
  assert.throws(() => addressToCheck(null, false), /Nothing has been deployed from this checkout/);
  assert.throws(() => addressToCheck(null, true), /Nothing has been deployed from this checkout/);
});

test('a command that was refused ends with what it was told and a failed exit, and any other failure is left to be seen whole', async () => {
  const said: unknown[] = [];
  const error = console.error;
  console.error = (line: unknown) => void said.push(line);

  try {
    await exitOnRefusal(async () => {
      throw new DeployRefused('Nothing was deployed.');
    });

    assert.deepEqual(said, ['\nNothing was deployed.']);
    assert.equal(process.exitCode, 1);

    await assert.rejects(
      exitOnRefusal(async () => {
        throw new Error('clasp fell over');
      }),
      /clasp fell over/,
    );
  } finally {
    console.error = error;
    process.exitCode = undefined;
  }
});
