/*
 * What `npm run deploy` does, as steps over the two things it touches: the script with Google, reached
 * through clasp, and this checkout's own files. Two rules hold on every path. An address is made only
 * when asked for in so many words (`--new` for a game, `--staging` for a second web app to try code
 * at), and nothing is pushed to, changed or removed at an address this checkout has no record of.
 */
import { DEPLOYMENT_FILE, LINK_FILE, webAppUrlFor } from './deployment.ts';
import type { Deployment, MainCheckout, WebApp } from './deployment.ts';

export const TITLE = "Chips n' Dipshits";

/** A web app the linked script has, and the version of the script it serves. */
export interface ListedWebApp {
  deploymentId: string;
  version: number;
}

/** The game's script with Google. A web app serves one version of the script until it is given another. */
export interface Clasp {
  /** Makes a new Sheet with a script of its own and links this checkout to it. */
  createScript(title: string): void;
  /** Puts the build's files in the script. No web app serves them until it is given a new version. */
  push(): void;
  webApps(): ListedWebApp[];
  /**
   * Makes a web app at a new address and gives its id. It serves `version` of the script, or with none
   * given a new version of what was last pushed. Google keeps only so many versions of a script, so one
   * is made only where there is none to start from.
   */
  createWebApp(description: string, version?: number): string;
  /** Has one web app serve a new version of what was last pushed. Its address stays the same. */
  updateWebApp(deploymentId: string, description: string): void;
  /** Removes one web app. Its address stops working for good. */
  removeWebApp(deploymentId: string): void;
}

/** This checkout's per-machine files and its build. */
export interface Checkout {
  /** Whether `.clasp.json` links this checkout to a script. */
  linked(): boolean;
  readDeployment(): Promise<Deployment | null>;
  writeDeployment(deployment: Deployment): Promise<void>;
  /** Builds `dist/` for a web app at this address, or with '' for one that has no address yet. */
  build(webAppUrl: string): Promise<void>;
  /** The checkout this one is a git worktree of, if it is one. */
  mainCheckout(): MainCheckout | null;
}

export interface DeployDeps {
  clasp: Clasp;
  checkout: Checkout;
  say(line: string): void;
  now(): Date;
}

/** `live` updates the address friends have, `staging` a second web app beside it, `new` sets up a game where there is none. */
export type Mode = 'live' | 'staging' | 'new';

/** The deploy stopped before doing what was asked, on purpose, and its message says what to do. */
export class DeployRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployRefused';
  }
}

const FLAGS: Record<string, Mode> = { '--new': 'new', '--staging': 'staging' };

export function modeOf(args: readonly string[]): Mode {
  const unknown = args.filter((arg) => !(arg in FLAGS));
  if (unknown.length > 0) {
    throw new DeployRefused(`"${unknown.join(' ')}" is nothing this understands. It takes --staging, --new, or nothing at all.`);
  }

  if (args.length > 1) {
    throw new DeployRefused('Pass --staging or --new, not both: staging is for a game that is already deployed, and --new sets one up.');
  }

  return args.length === 1 ? FLAGS[args[0]!]! : 'live';
}

// Web app deployment ids all start this way
const DEPLOYMENT_ID = /AKfycb[\w-]+/;
const WHOLE_DEPLOYMENT_ID = new RegExp(`^${DEPLOYMENT_ID.source}$`);

/**
 * The script as the clasp command line reaches it. `run` runs clasp with these arguments and gives
 * what it printed.
 */
export function claspOver(run: (...args: string[]) => string): Clasp {
  return {
    createScript: (title) => void run('create-script', '--type', 'sheets', '--title', title, '--rootDir', 'dist/gas'),

    push: () => void run('push', '--force'),

    webApps: () => {
      const output = run('list-deployments', '--json');
      const listed = JSON.parse(output.slice(output.indexOf('['), output.lastIndexOf(']') + 1)) as { deploymentId: string; versionNumber?: number }[];

      // The one with no version is the script's own test address at @HEAD, never one that is handed out
      return listed.flatMap((item) => (item.versionNumber === undefined ? [] : [{ deploymentId: item.deploymentId, version: item.versionNumber }]));
    },

    createWebApp: (description, version) => {
      const atVersion = version === undefined ? [] : ['--versionNumber', String(version)];
      const deploymentId = DEPLOYMENT_ID.exec(run('create-deployment', ...atVersion, '--description', description))?.[0];
      if (!deploymentId) {
        throw new Error(`clasp did not report the id of the web app it made; run "npx clasp list-deployments" and put it in ${DEPLOYMENT_FILE}`);
      }

      return deploymentId;
    },

    updateWebApp: (deploymentId, description) => void run('update-deployment', deploymentId, '--description', description),

    removeWebApp: (deploymentId) => {
      // Asked to delete without an id, clasp deletes the script's only web app, which would be the friends' address
      if (!WHOLE_DEPLOYMENT_ID.test(deploymentId)) {
        throw new Error(`"${deploymentId}" is not the id of a web app, so nothing was removed`);
      }

      run('delete-deployment', deploymentId);
    },
  };
}

const idsOf = (apps: readonly ListedWebApp[]): string => apps.map((app) => app.deploymentId).join(', ');
const webApps = (count: number): string => (count === 1 ? 'a web app' : `${count} web apps`);

/** Where a worktree's missing files are, when the checkout it belongs to holds them: said, or nothing. */
function inMainCheckout(main: MainCheckout | null): string {
  const held = main ? [main.linked ? LINK_FILE : null, main.recorded ? DEPLOYMENT_FILE : null].filter((file) => file !== null) : [];

  if (!main || held.length === 0) {
    return '';
  }

  return (
    ` This is a git worktree of ${main.path}, which holds ${held.join(' and ')}: git ignores ${held.length === 1 ? 'that file' : 'those files'}, so a worktree starts without ${held.length === 1 ? 'it' : 'them'}. ` +
    `To update the game that checkout deploys, run the deploy there, or copy ${LINK_FILE} and ${DEPLOYMENT_FILE} from there into this one.`
  );
}

function notLinked(main: MainCheckout | null): string {
  const found = inMainCheckout(main);

  return (
    `This checkout is not linked to an Apps Script project (${LINK_FILE} is missing), so nothing was deployed and nothing was made.${found} ` +
    `To set up ${found ? 'another game instead' : 'a new game'}, with a new Sheet and a new address, run "npm run deploy -- --new".`
  );
}

/** Builds for one web app, pushes that build and has the web app serve it. */
async function publish({ clasp, checkout, say, now }: DeployDeps, app: WebApp, what: string): Promise<void> {
  say(`Building for ${app.url} and pushing that build.`);
  await checkout.build(app.url);
  clasp.push();
  clasp.updateWebApp(app.deploymentId, `${what}, deployed ${now().toISOString()}`);
}

/** Sets up a game where there is none: the Sheet and its script unless one is linked, and its web app. */
async function setUp(deps: DeployDeps, linked: boolean, record: Deployment | null): Promise<void> {
  const { clasp, checkout, say } = deps;

  if (record) {
    throw new DeployRefused(`This checkout already has a game on record (${record.url}), and --new sets one up only where there is none. "npm run deploy" without it updates that game.`);
  }

  if (linked) {
    const existing = clasp.webApps();

    if (existing.length > 0) {
      throw new DeployRefused(
        `The linked script already has ${webApps(existing.length)} (${idsOf(existing)}), and --new makes an address only where there is none. ` +
          '"npm run deploy" without it puts the one it has on record.',
      );
    }
  } else {
    const main = checkout.mainCheckout();

    if (main && (main.linked || main.recorded)) {
      say(`This is a git worktree of ${main.path}, which has a game of its own on record. What --new makes here is another game, beside that one.`);
    }

    say('Creating a new Sheet with its script, as --new asks.');
    clasp.createScript(TITLE);

    // Creating the project downloads its starter files over the build
    await checkout.build('');
  }

  // The page is told its own address, and that only exists once something is deployed
  clasp.push();

  const deploymentId = clasp.createWebApp(TITLE);
  const live = { deploymentId, url: webAppUrlFor(deploymentId) };

  await checkout.writeDeployment(live);
  await publish(deps, live, TITLE);
  say(`\nLive at ${live.url}`);
}

/** A linked script with no address on record here: the one web app it has goes on record, and nothing else is done to it. */
async function putOnRecord({ clasp, checkout }: DeployDeps): Promise<never> {
  const existing = clasp.webApps();

  if (existing.length === 0) {
    throw new DeployRefused('The linked script has no web app, so there is no address to update. "npm run deploy -- --new" gives it one, at a new address.');
  }

  // Taking one of several would leave the links friends have on old code if it were the wrong one
  if (existing.length > 1) {
    throw new DeployRefused(
      `The linked script has ${existing.length} web apps (${idsOf(existing)}) and this checkout has none of them on record. Put the one your friends use in ${DEPLOYMENT_FILE} as ` +
        '{"deploymentId": "<id>", "url": "https://script.google.com/macros/s/<id>/exec"} and run this again.',
    );
  }

  const url = webAppUrlFor(existing[0]!.deploymentId);
  await checkout.writeDeployment({ deploymentId: existing[0]!.deploymentId, url });

  throw new DeployRefused(
    `This checkout had no address on record, so the one web app the linked script has was put in ${DEPLOYMENT_FILE}: ${url}. Nothing was pushed. ` +
      'If that is the address your friends use, run this again to update it.',
  );
}

/** Puts this build on a second web app of the same script, and leaves the friends' address serving what it served. */
async function stage(deps: DeployDeps, record: Deployment, live: ListedWebApp, listed: readonly ListedWebApp[]): Promise<void> {
  const { clasp, checkout, say } = deps;

  // Only a file changed by hand says this, and going on would put the staging build at the friends' address
  if (record.staging?.deploymentId === live.deploymentId) {
    throw new DeployRefused(`${DEPLOYMENT_FILE} names the friends' address itself as the staging web app. Take "staging" out of it and run this again. Nothing was pushed.`);
  }

  const kept = record.staging && listed.some((app) => app.deploymentId === record.staging!.deploymentId) ? record.staging : null;
  const strangers = listed.filter((app) => app.deploymentId !== live.deploymentId && app.deploymentId !== kept?.deploymentId);

  if (strangers.length > 0) {
    throw new DeployRefused(
      `The linked script has ${webApps(strangers.length)} that this checkout has no record of (${idsOf(strangers)}), so no staging web app was made beside ${strangers.length === 1 ? 'it' : 'them'}. ` +
        `If one is a staging web app made from another checkout, put it in ${DEPLOYMENT_FILE} under "staging" as {"deploymentId": "<id>", "url": "https://script.google.com/macros/s/<id>/exec"}; ` +
        'if not, remove it with "npx clasp delete-deployment <id>". Then run this again.',
    );
  }

  if (record.staging && !kept) {
    say(`The staging web app on record (${record.staging.url}) is no longer one of the script's, so a new one is made.`);
  }

  let staging = kept;

  if (!staging) {
    // It starts on the version friends are served, and gets the build for its own address below
    const deploymentId = clasp.createWebApp(`${TITLE}, staging`, live.version);

    staging = { deploymentId, url: webAppUrlFor(deploymentId) };
    await checkout.writeDeployment({ ...record, staging });
  }

  await publish(deps, staging, `${TITLE}, staging`);

  const after = clasp.webApps().find((app) => app.deploymentId === live.deploymentId);
  if (after?.version !== live.version) {
    throw new Error(
      `The friends' address ${record.url} served version ${live.version} of the script before this and ${after ? `serves version ${after.version}` : 'is gone'} now, which staging must never bring about. ` +
        'Look at the script\'s deployments in the Apps Script editor before doing anything else.',
    );
  }

  say(`\nStaging at ${staging.url}`);
  say(`The friends' address ${record.url} was not touched: it serves version ${live.version} of the script, as before.`);
  say('Check it with "npm run check:live -- --staging". Then "npm run deploy" puts this code at the friends\' address and removes the staging web app.');
}

/** Puts this build at the friends' address, then takes away the staging web app, which has done its work. */
async function goLive(deps: DeployDeps, record: Deployment, listed: readonly ListedWebApp[]): Promise<void> {
  const { clasp, checkout, say } = deps;
  const { staging } = record;

  await publish(deps, record, TITLE);
  say(`\nLive at ${record.url}`);

  if (staging && staging.deploymentId !== record.deploymentId) {
    if (listed.some((app) => app.deploymentId === staging.deploymentId)) {
      try {
        clasp.removeWebApp(staging.deploymentId);
      } catch (error) {
        say(`The staging web app at ${staging.url} could not be removed (${error instanceof Error ? error.message : String(error)}). It stays on record, and the next deploy tries again.`);

        return;
      }

      say(`Removed the staging web app at ${staging.url}.`);
    } else {
      say(`The staging web app on record (${staging.url}) was already gone.`);
    }
  }

  if (staging) {
    await checkout.writeDeployment({ deploymentId: record.deploymentId, url: record.url });
  }

  const strangers = listed.filter((app) => app.deploymentId !== record.deploymentId && app.deploymentId !== staging?.deploymentId);
  if (strangers.length > 0) {
    say(`The script also has ${webApps(strangers.length)} that this checkout has no record of (${idsOf(strangers)}), left as ${strangers.length === 1 ? 'it was' : 'they were'}.`);
  }
}

export async function deploy(mode: Mode, deps: DeployDeps): Promise<void> {
  const { clasp, checkout } = deps;
  const linked = checkout.linked();
  const record = await checkout.readDeployment();

  // The two files are per machine and must describe the same script. Carrying on with one of them
  // missing would either strand the game's address on old code or push to a script it doesn't belong to
  if (record && !linked) {
    throw new DeployRefused(
      `This checkout has the game's address on record (${DEPLOYMENT_FILE}, ${record.url}) but is not linked to its script: ${LINK_FILE} is missing, so nothing was deployed.` +
        `${inMainCheckout(checkout.mainCheckout())} Restore ${LINK_FILE} for that script, or delete ${DEPLOYMENT_FILE} and run "npm run deploy -- --new" to set up a new game at a new address.`,
    );
  }

  if (mode === 'new') {
    return setUp(deps, linked, record);
  }

  if (!linked) {
    throw new DeployRefused(notLinked(checkout.mainCheckout()));
  }

  if (!record) {
    return putOnRecord(deps);
  }

  // Checked before anything is pushed: a .clasp.json from one game and a .deployment.json from another would put this code on the wrong script
  const listed = clasp.webApps();
  const live = listed.find((app) => app.deploymentId === record.deploymentId);

  if (!live) {
    throw new DeployRefused(
      `The linked script (${LINK_FILE}) has no web app ${record.deploymentId}, which is the one on record in ${DEPLOYMENT_FILE}. ` +
        'The two files are from different games; restore the pair that belongs together. Nothing was pushed.',
    );
  }

  return mode === 'staging' ? stage(deps, record, live, listed) : goLive(deps, record, listed);
}
