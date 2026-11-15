/*
 * The deploy, on a stand-in for the script with Google and for a checkout's files. What the stand-in
 * keeps is what matters about the real thing: a web app serves the version it was last given, a push
 * changes no web app, and a removed address is gone.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { addressToCheck, mainCheckoutOf, webAppUrlFor } from '../scripts/deployment.ts';
import type { Deployment, MainCheckout } from '../scripts/deployment.ts';
import { claspOver, deploy, DeployRefused, modeOf } from '../scripts/deploySteps.ts';
import type { Checkout, Clasp, ListedWebApp, Mode } from '../scripts/deploySteps.ts';

class FakeCheckout implements Checkout {
  link = false;
  record: Deployment | null = null;
  main: MainCheckout | null = null;
  /** The address the files in `dist/` were last built for. */
  dist = 'built for no address';

  linked(): boolean {
    return this.link;
  }

  async readDeployment(): Promise<Deployment | null> {
    return this.record;
  }

  async writeDeployment(deployment: Deployment): Promise<void> {
    this.record = deployment;
  }

  async build(webAppUrl: string): Promise<void> {
    this.dist = `built for ${webAppUrl || 'no address'}`;
  }

  mainCheckout(): MainCheckout | null {
    return this.main;
  }
}

class FakeScript implements Clasp {
  readonly calls: string[] = [];
  /** What was last pushed. */
  head = 'nothing pushed';
  refuseRemoval = false;
  private readonly checkout: FakeCheckout;
  private readonly versions: string[] = [];
  private readonly apps = new Map<string, number>();

  constructor(checkout: FakeCheckout) {
    this.checkout = checkout;
  }

  /** A web app the script has from before the test, serving `build`. */
  has(deploymentId: string, build: string): void {
    this.versions.push(build);
    this.apps.set(deploymentId, this.versions.length);
  }

  /** The build a visitor to this web app gets, or null when the address is gone. */
  serves(deploymentId: string): string | null {
    const version = this.apps.get(deploymentId);

    return version === undefined ? null : this.versions[version - 1]!;
  }

  createScript(): void {
    this.calls.push('createScript');
    this.checkout.link = true;
    this.checkout.dist = 'the starter files';
  }

  push(): void {
    this.calls.push('push');
    this.head = this.checkout.dist;
  }

  webApps(): ListedWebApp[] {
    return [...this.apps].map(([deploymentId, version]) => ({ deploymentId, version }));
  }

  createWebApp(_description: string, version?: number): string {
    const deploymentId = `AKfycb-made-${this.apps.size + 1}`;

    this.calls.push(`createWebApp ${deploymentId}`);

    if (version === undefined) {
      this.has(deploymentId, this.head);
    } else {
      assert.ok(version >= 1 && version <= this.versions.length, `the script has no version ${version}`);
      this.apps.set(deploymentId, version);
    }

    return deploymentId;
  }

  /** How many versions of the script there are, of the few Google keeps. */
  versionsMade(): number {
    return this.versions.length;
  }

  updateWebApp(deploymentId: string): void {
    this.calls.push(`updateWebApp ${deploymentId}`);
    assert.ok(this.apps.has(deploymentId), `the script has no web app ${deploymentId}`);
    this.has(deploymentId, this.head);
  }

  removeWebApp(deploymentId: string): void {
    this.calls.push(`removeWebApp ${deploymentId}`);

    if (this.refuseRemoval) {
      throw new Error('Service unavailable');
    }

    this.apps.delete(deploymentId);
  }
}

const LIVE = 'AKfycb-live';
const LIVE_URL = webAppUrlFor(LIVE);
const OLD_CODE = 'the code friends are playing on';

function setup() {
  const checkout = new FakeCheckout();
  const script = new FakeScript(checkout);
  const said: string[] = [];
  const run = (mode: Mode = 'live') => deploy(mode, { clasp: script, checkout, say: (line) => said.push(line), now: () => new Date(0) });

  return { checkout, script, said, run, told: () => said.join('\n') };
}

/** A game that is deployed, in a checkout that holds both of its files. */
function deployed() {
  const game = setup();

  game.checkout.link = true;
  game.checkout.record = { deploymentId: LIVE, url: LIVE_URL };
  game.script.has(LIVE, OLD_CODE);

  return game;
}

const refused = (pattern: RegExp) => (error: unknown) => error instanceof DeployRefused && pattern.test(error.message);

test('a checkout that is not linked to a script deploys nothing and makes nothing, and says how a new game is asked for', async () => {
  const { script, checkout, run } = setup();

  await assert.rejects(run(), refused(/not linked to an Apps Script project.*nothing was made.*npm run deploy -- --new/));

  assert.deepEqual(script.calls, []);
  assert.equal(checkout.record, null);
});

test('a git worktree without the two files, whose main checkout holds them, makes no second game and says where they are', async () => {
  const { script, checkout, run } = setup();
  checkout.main = { path: '/somewhere/the-game', linked: true, recorded: true };

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
  checkout.main = { path: '/somewhere/the-game', linked: true, recorded: false };

  await assert.rejects(run(), refused(/which holds \.clasp\.json: git ignores that file, so a worktree starts without it\./));
});

test('a worktree whose main checkout has neither file is told what any unlinked checkout is', async () => {
  const { checkout, run } = setup();
  checkout.main = { path: '/somewhere/the-game', linked: false, recorded: false };

  await assert.rejects(run(), (error: unknown) => refused(/To set up a new game/)(error) && !/worktree/.test((error as Error).message));
});

test('staging is refused the same way where nothing is linked', async () => {
  const { script, run } = setup();

  await assert.rejects(run('staging'), refused(/not linked/));
  assert.deepEqual(script.calls, []);
});

test('--new sets up a game where there is none: a Sheet with its script, a web app, its address on record and in the build it serves', async () => {
  const { script, checkout, run, told } = setup();

  await run('new');

  const { deploymentId, url } = checkout.record!;
  assert.equal(url, webAppUrlFor(deploymentId));
  assert.equal(checkout.record!.staging, undefined);
  assert.equal(script.calls[0], 'createScript');
  assert.equal(script.serves(deploymentId), `built for ${url}`);
  assert.equal(script.webApps().length, 1);
  assert.match(told(), new RegExp(`Live at ${url}$`));
});

test('--new in a worktree of a checkout that has a game says it is making another one beside it', async () => {
  const { checkout, run, told } = setup();
  checkout.main = { path: '/somewhere/the-game', linked: true, recorded: true };

  await run('new');

  assert.match(told(), /git worktree of \/somewhere\/the-game, which has a game of its own on record\. What --new makes here is another game/);
});

test('--new is refused where a game is on record, and nothing of that game is touched', async () => {
  const { script, checkout, run } = deployed();

  await assert.rejects(run('new'), refused(/already has a game on record.*--new sets one up only where there is none/));

  assert.deepEqual(script.calls, []);
  assert.deepEqual(checkout.record, { deploymentId: LIVE, url: LIVE_URL });
  assert.equal(script.serves(LIVE), OLD_CODE);
});

test('--new is refused for a linked script that already has a web app', async () => {
  const { script, checkout, run } = setup();
  checkout.link = true;
  script.has(LIVE, OLD_CODE);

  await assert.rejects(run('new'), refused(/already has a web app \(AKfycb-live\)/));

  assert.deepEqual(script.calls, []);
  assert.equal(script.webApps().length, 1);
});

test('--new gives a linked script that has no web app its first one, without making another Sheet', async () => {
  const { script, checkout, run } = setup();
  checkout.link = true;

  await run('new');

  assert.ok(!script.calls.includes('createScript'));
  assert.equal(script.serves(checkout.record!.deploymentId), `built for ${checkout.record!.url}`);
});

test('an address on record in a checkout that is not linked to its script is refused, with --new too', async () => {
  for (const mode of ['live', 'staging', 'new'] as const) {
    const { script, checkout, run } = setup();
    checkout.record = { deploymentId: LIVE, url: LIVE_URL };

    await assert.rejects(run(mode), refused(/has the game's address on record.*\.clasp\.json is missing, so nothing was deployed/), mode);
    assert.deepEqual(script.calls, [], mode);
  }
});

test('a linked script with one web app and no record gets that address put on record and nothing pushed; the next run updates it', async () => {
  const { script, checkout, run } = setup();
  checkout.link = true;
  script.has(LIVE, OLD_CODE);

  await assert.rejects(run(), refused(new RegExp(`was put in \\.deployment\\.json: ${LIVE_URL}\\. Nothing was pushed`)));
  assert.deepEqual(script.calls, []);
  assert.deepEqual(checkout.record, { deploymentId: LIVE, url: LIVE_URL });
  assert.equal(script.serves(LIVE), OLD_CODE);

  await run();
  assert.equal(script.serves(LIVE), `built for ${LIVE_URL}`);
});

test('a linked script with several web apps and no record is refused, naming them', async () => {
  const { script, checkout, run } = setup();
  checkout.link = true;
  script.has(LIVE, OLD_CODE);
  script.has('AKfycb-other', OLD_CODE);

  await assert.rejects(run(), refused(/has 2 web apps \(AKfycb-live, AKfycb-other\) and this checkout has none of them on record/));

  assert.deepEqual(script.calls, []);
  assert.equal(checkout.record, null);
});

test('a linked script with no web app and no record is refused, and makes none unasked', async () => {
  const { script, checkout, run } = setup();
  checkout.link = true;

  await assert.rejects(run(), refused(/has no web app.*npm run deploy -- --new/));

  assert.deepEqual(script.calls, []);
  assert.equal(script.webApps().length, 0);
});

test('a deploy puts the build for the friends\' address at that address, which stays the same', async () => {
  const { script, checkout, run, told } = deployed();

  await run();

  assert.equal(script.serves(LIVE), `built for ${LIVE_URL}`);
  assert.deepEqual(script.calls, ['push', `updateWebApp ${LIVE}`]);
  assert.deepEqual(checkout.record, { deploymentId: LIVE, url: LIVE_URL });
  assert.match(told(), new RegExp(`Building for ${LIVE_URL}`));
  assert.match(told(), new RegExp(`Live at ${LIVE_URL}$`));
});

test('link and record files from two different games are refused before anything is pushed', async () => {
  for (const mode of ['live', 'staging'] as const) {
    const { script, checkout, run } = setup();
    checkout.link = true;
    checkout.record = { deploymentId: LIVE, url: LIVE_URL };
    script.has('AKfycb-another-game', OLD_CODE);

    await assert.rejects(run(mode), refused(/has no web app AKfycb-live.*from different games.*Nothing was pushed/), mode);
    assert.deepEqual(script.calls, [], mode);
    assert.equal(script.serves('AKfycb-another-game'), OLD_CODE, mode);
  }
});

test('staging puts the build on a second web app of the script and leaves the friends\' address serving what it served', async () => {
  const { script, checkout, run, told } = deployed();

  await run('staging');

  const staging = checkout.record!.staging!;
  assert.notEqual(staging.deploymentId, LIVE);
  assert.equal(staging.url, webAppUrlFor(staging.deploymentId));
  assert.equal(script.serves(staging.deploymentId), `built for ${staging.url}`, 'the staging page is told its own address');
  assert.equal(script.serves(LIVE), OLD_CODE, 'the friends\' address still serves the old code');
  assert.deepEqual({ deploymentId: checkout.record!.deploymentId, url: checkout.record!.url }, { deploymentId: LIVE, url: LIVE_URL });
  assert.ok(!script.calls.includes(`updateWebApp ${LIVE}`));
  assert.match(told(), new RegExp(`Staging at ${staging.url}`));
  assert.match(told(), new RegExp(`The friends' address ${LIVE_URL} was not touched: it serves version 1 of the script, as before`));
  assert.equal(script.versionsMade(), 2, 'one version for the staging build, and none for making its web app');
});

test('staging again uses the staging web app on record and makes no third', async () => {
  const { script, checkout, run } = deployed();
  await run('staging');
  const staging = checkout.record!.staging!;

  checkout.dist = 'something else';
  await run('staging');

  assert.deepEqual(checkout.record!.staging, staging);
  assert.equal(script.webApps().length, 2);
  assert.equal(script.serves(staging.deploymentId), `built for ${staging.url}`);
  assert.equal(script.serves(LIVE), OLD_CODE);
});

test('staging is refused while the script has a web app this checkout has no record of', async () => {
  const { script, checkout, run } = deployed();
  script.has('AKfycb-stranger', OLD_CODE);

  await assert.rejects(run('staging'), refused(/has a web app that this checkout has no record of \(AKfycb-stranger\), so no staging web app was made beside it/));

  assert.deepEqual(script.calls, []);
  assert.equal(checkout.record!.staging, undefined);
});

test('a staging web app on record is told from a stranger: staging goes ahead with the one, and is refused for the other beside it', async () => {
  const { script, checkout, run } = deployed();
  await run('staging');
  const staging = checkout.record!.staging!;

  script.has('AKfycb-stranger', OLD_CODE);
  await assert.rejects(run('staging'), refused(/no record of \(AKfycb-stranger\)/));
  assert.equal(script.serves(staging.deploymentId), `built for ${staging.url}`);
});

test('a staging web app on record that the script no longer has is replaced by a new one', async () => {
  const { script, checkout, run, told } = deployed();
  checkout.record = { ...checkout.record!, staging: { deploymentId: 'AKfycb-gone', url: webAppUrlFor('AKfycb-gone') } };

  await run('staging');

  const staging = checkout.record!.staging!;
  assert.notEqual(staging.deploymentId, 'AKfycb-gone');
  assert.equal(script.serves(staging.deploymentId), `built for ${staging.url}`);
  assert.match(told(), /is no longer one of the script's, so a new one is made/);
});

test('a record that names the friends\' address as its own staging web app is refused, and that address keeps its code', async () => {
  const { script, checkout, run } = deployed();
  checkout.record = { ...checkout.record!, staging: { deploymentId: LIVE, url: LIVE_URL } };

  await assert.rejects(run('staging'), refused(/names the friends' address itself as the staging web app/));

  assert.deepEqual(script.calls, []);
  assert.equal(script.serves(LIVE), OLD_CODE);
});

test('staging that finds the friends\' address serving another version than before fails loudly', async () => {
  const { script, run } = deployed();
  const update = script.updateWebApp.bind(script);

  // A script whose web apps all move together, which Google's do not
  script.updateWebApp = (deploymentId) => {
    update(deploymentId);
    update(LIVE);
  };

  await assert.rejects(run('staging'), /served version 1 of the script before this and serves version 3 now, which staging must never bring about/);
});

test('a deploy after staging puts the build for the friends\' address there and removes the staging web app', async () => {
  const { script, checkout, run, told } = deployed();
  await run('staging');
  const staging = checkout.record!.staging!;

  await run();

  assert.equal(script.serves(LIVE), `built for ${LIVE_URL}`, 'friends get the build made for their address, not the staging one');
  assert.equal(script.serves(staging.deploymentId), null);
  assert.deepEqual(script.webApps().map((app) => app.deploymentId), [LIVE]);
  assert.deepEqual(checkout.record, { deploymentId: LIVE, url: LIVE_URL });
  assert.match(told(), new RegExp(`Live at ${LIVE_URL}\nRemoved the staging web app at ${staging.url}\\.$`));
});

test('a staging web app that cannot be removed stays on record for the next deploy, and the deploy itself stands', async () => {
  const { script, checkout, run, told } = deployed();
  await run('staging');
  const staging = checkout.record!.staging!;

  script.refuseRemoval = true;
  await run();

  assert.equal(script.serves(LIVE), `built for ${LIVE_URL}`);
  assert.deepEqual(checkout.record!.staging, staging);
  assert.match(told(), /could not be removed \(Service unavailable\)\. It stays on record, and the next deploy tries again/);

  script.refuseRemoval = false;
  await run();
  assert.equal(script.serves(staging.deploymentId), null);
  assert.equal(checkout.record!.staging, undefined);
});

test('a deploy never removes the friends\' address, whatever the record says of staging', async () => {
  const { script, checkout, run } = deployed();
  checkout.record = { ...checkout.record!, staging: { deploymentId: LIVE, url: LIVE_URL } };

  await run();

  assert.ok(!script.calls.some((call) => call.startsWith('removeWebApp')));
  assert.equal(script.serves(LIVE), `built for ${LIVE_URL}`);
  assert.deepEqual(checkout.record, { deploymentId: LIVE, url: LIVE_URL });
});

test('a deploy whose staging web app is already gone drops it from the record', async () => {
  const { script, checkout, run, told } = deployed();
  checkout.record = { ...checkout.record!, staging: { deploymentId: 'AKfycb-gone', url: webAppUrlFor('AKfycb-gone') } };

  await run();

  assert.ok(!script.calls.some((call) => call.startsWith('removeWebApp')));
  assert.deepEqual(checkout.record, { deploymentId: LIVE, url: LIVE_URL });
  assert.match(told(), /was already gone/);
});

test('a deploy leaves a web app it has no record of where it is, and says so', async () => {
  const { script, run, told } = deployed();
  script.has('AKfycb-stranger', OLD_CODE);

  await run();

  assert.equal(script.serves('AKfycb-stranger'), OLD_CODE);
  assert.equal(script.serves(LIVE), `built for ${LIVE_URL}`);
  assert.match(told(), /also has a web app that this checkout has no record of \(AKfycb-stranger\), left as it was/);
});

test('the flags: nothing, --staging or --new, and never two', () => {
  assert.equal(modeOf([]), 'live');
  assert.equal(modeOf(['--staging']), 'staging');
  assert.equal(modeOf(['--new']), 'new');
  assert.throws(() => modeOf(['--staging', '--new']), refused(/not both/));
  assert.throws(() => modeOf(['--stagin']), refused(/"--stagin" is nothing this understands/));
  assert.throws(() => modeOf(['new']), refused(/nothing this understands/));
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
    { deploymentId: 'AKfycb-live', version: 12 },
    { deploymentId: 'AKfycb-staging', version: 14 },
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

  assert.throws(() => commandLine({ 'create-deployment': 'Deployed.\n' }).clasp.createWebApp('Staging'), /did not report the id/);
});

test('a web app is updated and removed by its id, and clasp is never asked to delete without one', () => {
  const { clasp, asked } = commandLine();

  clasp.updateWebApp('AKfycb-live', 'Deployed today');
  clasp.removeWebApp('AKfycb-staging');
  assert.deepEqual(asked, [
    ['update-deployment', 'AKfycb-live', '--description', 'Deployed today'],
    ['delete-deployment', 'AKfycb-staging'],
  ]);

  // Without an id, clasp deletes the only web app a script has
  for (const noId of ['', ' ', '--all', 'undefined']) {
    assert.throws(() => clasp.removeWebApp(noId), /is not the id of a web app, so nothing was removed/, noId);
  }

  assert.equal(asked.length, 2);
});

test('a git worktree is told from a checkout, and which of the two files its main checkout holds', () => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-test-'));

  try {
    const main = join(root, 'main');
    const worktree = join(root, 'elsewhere', 'worktree');
    mkdirSync(join(main, '.git', 'worktrees', 'worktree'), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'worktree')}\n`);

    assert.equal(mainCheckoutOf(main), null, 'the main checkout is no worktree');
    assert.equal(mainCheckoutOf(join(root, 'elsewhere')), null, 'nor is a folder that is no checkout at all');
    assert.deepEqual(mainCheckoutOf(worktree), { path: main, linked: false, recorded: false });

    writeFileSync(join(main, '.clasp.json'), '{}');
    assert.deepEqual(mainCheckoutOf(worktree), { path: main, linked: true, recorded: false });

    writeFileSync(join(main, '.deployment.json'), '{}');
    assert.deepEqual(mainCheckoutOf(worktree), { path: main, linked: true, recorded: true });

    // A submodule's .git is a file too, and points somewhere that is no worktree
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'modules', 'worktree')}\n`);
    assert.equal(mainCheckoutOf(worktree), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a check plays at the friends\' address, or at the staging one when asked, and never at one that is not on record', () => {
  const staging = { deploymentId: 'AKfycb-staging', url: webAppUrlFor('AKfycb-staging') };

  assert.equal(addressToCheck({ deploymentId: LIVE, url: LIVE_URL }, false), LIVE_URL);
  assert.equal(addressToCheck({ deploymentId: LIVE, url: LIVE_URL, staging }, false), LIVE_URL);
  assert.equal(addressToCheck({ deploymentId: LIVE, url: LIVE_URL, staging }, true), staging.url);
  assert.throws(() => addressToCheck({ deploymentId: LIVE, url: LIVE_URL }, true), /no staging web app on record.*npm run deploy -- --staging/);
  assert.throws(() => addressToCheck(null, false), /Nothing has been deployed from this checkout/);
  assert.throws(() => addressToCheck(null, true), /Nothing has been deployed from this checkout/);
});
