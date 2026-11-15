/*
 * What `npm run deploy` does, as steps over the two things it touches: the script with Google, reached
 * through clasp, and this checkout's own files. Three rules hold on every path. An address is made only
 * when asked for in so many words (`--new` for a game, `--staging` for a second web app to try code
 * at). Nothing is pushed to or changed at an address this checkout has no record of. And no address is
 * ever removed: a web app that is gone cannot be had back.
 */
import { DEPLOYMENT_FILE, DeployRefused, keptByNpm, LINK_FILE, WEB_APP_ID, webAppFor } from './deployment.ts';
import type { Deployment, LinkFilesElsewhere, StagingWebApp, WebApp } from './deployment.ts';

export const TITLE = "Chips n' Dipshits";

// How the staging web app is described with Google, which is what tells it from the friends' own when the record is in doubt
const STAGING_TITLE = `${TITLE}, staging`;

/** A web app the linked script has: the version of the script it serves, and how it was described when last given one. */
export interface ListedWebApp {
  deploymentId: string;
  version: number;
  description: string;
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
  /** Has one web app serve `version` of the script, or with none given a new version of what was last pushed. Its address stays the same. */
  updateWebApp(deploymentId: string, description: string, version?: number): void;
}

/** This checkout's per-machine files and its build. */
export interface Checkout {
  /** Whether a `.clasp.json` of this checkout's own links it to a script. */
  linked(): boolean;
  /** The record of where the game is, or null when there is none. A record that is there and cannot be trusted is an error, never none. */
  readDeployment(): Promise<Deployment | null>;
  writeDeployment(deployment: Deployment): Promise<void>;
  /** Builds `dist/` for a web app at this address, or with '' for one that has no address yet, and gives a mark of what was built for Apps Script: the same for the same files, another for any other. */
  build(webAppUrl: string): Promise<string>;
  /** Where the two files are when this checkout lacks them: a folder above it, or the checkout it is a git worktree of. */
  elsewhere(): LinkFilesElsewhere | null;
}

export interface DeployDeps {
  clasp: Clasp;
  checkout: Checkout;
  say(line: string): void;
  now(): Date;
}

/** `live` updates the address friends have, `staging` a second web app beside it, `new` sets up a game where there is none. */
export type Mode = 'live' | 'staging' | 'new';

const FLAGS: Record<string, Mode> = { '--new': 'new', '--staging': 'staging' };

/** Which deploy was asked for. `env` is the environment npm ran the script in, which is where a flag npm kept shows. */
export function modeOf(args: readonly string[], env: Record<string, string | undefined> = {}): Mode {
  const kept = keptByNpm(Object.keys(FLAGS), env);
  if (kept.length > 0) {
    throw new DeployRefused(`npm kept ${kept.join(' and ')} for itself, so this was not told of it and did nothing. Put "--" before it: npm run deploy -- ${kept[0]}`);
  }

  const unknown = args.filter((arg) => !(arg in FLAGS));
  if (unknown.length > 0) {
    throw new DeployRefused(`"${unknown.join(' ')}" is nothing this understands. It takes --staging, --new, or nothing at all.`);
  }

  if (args.length > 1) {
    throw new DeployRefused('Pass --staging or --new, not both: staging is for a game that is already deployed, and --new sets one up.');
  }

  return args.length === 1 ? FLAGS[args[0]!]! : 'live';
}

const ID_IN_OUTPUT = new RegExp(WEB_APP_ID.source.replace(/^\^|\$$/g, ''));

/**
 * The script as the clasp command line reaches it. `run` runs clasp with these arguments and gives
 * what it printed. Nothing here deletes a deployment: asked to delete without an id, clasp deletes
 * the only web app a script has.
 */
export function claspOver(run: (...args: string[]) => string): Clasp {
  const atVersion = (version: number | undefined): string[] => (version === undefined ? [] : ['--versionNumber', String(version)]);

  return {
    createScript: (title) => void run('create-script', '--type', 'sheets', '--title', title, '--rootDir', 'dist/gas'),

    push: () => void run('push', '--force'),

    webApps: () => {
      const output = run('list-deployments', '--json');
      const listed = JSON.parse(output.slice(output.indexOf('['), output.lastIndexOf(']') + 1)) as { deploymentId: string; versionNumber?: number; description?: string }[];

      // The one with no version is the script's own test address at @HEAD, never one that is handed out
      return listed.flatMap((item) => (item.versionNumber === undefined ? [] : [{ deploymentId: item.deploymentId, version: item.versionNumber, description: item.description ?? '' }]));
    },

    createWebApp: (description, version) => {
      const deploymentId = ID_IN_OUTPUT.exec(run('create-deployment', ...atVersion(version), '--description', description))?.[0];
      if (!deploymentId) {
        throw new Error('clasp did not say which web app it made, so nothing was put on record. Run this again: it finds what the script has and says what to do.');
      }

      return deploymentId;
    },

    updateWebApp: (deploymentId, description, version) => void run('update-deployment', deploymentId, ...atVersion(version), '--description', description),
  };
}

const described = (apps: readonly ListedWebApp[]): string => apps.map((app) => `${app.deploymentId} ("${app.description}")`).join(', ');
const webApps = (count: number): string => (count === 1 ? 'a web app' : `${count} web apps`);
const isStaging = (app: ListedWebApp): boolean => app.description.startsWith(STAGING_TITLE);
const withStaging = (record: Deployment, staging: StagingWebApp | undefined): Deployment => ({ deploymentId: record.deploymentId, url: record.url, ...(staging ? { staging } : {}) });

/** Where this checkout's missing files are, when it is a worktree of a checkout that has them: said, or nothing. */
function foundElsewhere(elsewhere: LinkFilesElsewhere | null): string {
  if (!elsewhere) {
    return '';
  }

  const held = [elsewhere.linked ? LINK_FILE : null, elsewhere.recorded ? DEPLOYMENT_FILE : null].filter((file) => file !== null);

  return (
    ` This is a git worktree of ${elsewhere.path}, which holds ${held.join(' and ')}: git ignores ${held.length === 1 ? 'that file' : 'those files'}, so a worktree starts without ${held.length === 1 ? 'it' : 'them'}. ` +
    `To update the game that checkout deploys, run the deploy there, or copy ${LINK_FILE} and ${DEPLOYMENT_FILE} from there into this one.`
  );
}

function notLinked(elsewhere: LinkFilesElsewhere | null): string {
  const found = foundElsewhere(elsewhere);

  return (
    `This checkout is not linked to an Apps Script project (${LINK_FILE} is missing), so nothing was deployed and nothing was made.${found} ` +
    `To set up ${found ? 'another game instead' : 'a new game'}, with a new Sheet and a new address, run "npm run deploy -- --new".`
  );
}

/** Builds for one web app, pushes that build and has the web app serve it. Gives the mark of what was pushed. */
async function publish({ clasp, checkout, say, now }: DeployDeps, app: WebApp, title: string): Promise<string> {
  say(`Building for ${app.url} and pushing that build.`);

  const build = await checkout.build(app.url);
  clasp.push();
  clasp.updateWebApp(app.deploymentId, `${title}, deployed ${now().toISOString()}`);

  return build;
}

/** Sets up a game where there is none: the Sheet and its script unless one is linked, and its web app. */
async function setUp(deps: DeployDeps, linked: boolean, record: Deployment | null, elsewhere: LinkFilesElsewhere | null): Promise<void> {
  const { clasp, checkout, say } = deps;

  if (record) {
    throw new DeployRefused(`This checkout already has a game on record (${record.url}), and --new sets one up only where there is none. "npm run deploy" without it updates that game.`);
  }

  if (linked) {
    const existing = clasp.webApps();

    if (existing.length > 0) {
      throw new DeployRefused(
        `The linked script already has ${webApps(existing.length)}, and --new makes an address only where there is none: ${described(existing)}. ` +
          '"npm run deploy" without it puts the one it has on record.',
      );
    }
  } else {
    if (elsewhere) {
      say(`This is a git worktree of ${elsewhere.path}, which has a game of its own. What --new makes here is another game, beside that one.`);
    }

    say('Creating a new Sheet with its script, as --new asks.');

    try {
      clasp.createScript(TITLE);
    } catch (error) {
      // clasp makes the Sheet and its script first and links the checkout to them last
      say(`\nThat failed part-way, and a Sheet named "${TITLE}" may have been made all the same. Look for it in Google Drive and remove it before running --new again, which would make another.`);
      throw error;
    }
  }

  // Creating the project downloads its starter files over the build, and what was in `dist/` before may be for another address.
  // The page is told its own address, and that only exists once something is deployed
  await checkout.build('');
  clasp.push();

  const live = webAppFor(clasp.createWebApp(TITLE));

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

  // One made for staging is never the friends'. Taking one of several others would leave the links friends have on old code if it were the wrong one
  const candidates = existing.filter((app) => !isStaging(app));

  if (candidates.length !== 1) {
    throw new DeployRefused(
      `The linked script has ${webApps(existing.length)} and this checkout has none on record: ${described(existing)}. ` +
        `Put the one your friends use in ${DEPLOYMENT_FILE} as {"deploymentId": "<id>", "url": "https://script.google.com/macros/s/<id>/exec"}, with the same id in both places, and run this again.`,
    );
  }

  const live = webAppFor(candidates[0]!.deploymentId);
  await checkout.writeDeployment(live);

  throw new DeployRefused(
    `This checkout had no address on record, so the ${existing.length === 1 ? 'one web app the linked script has' : "linked script's one web app that was not made for staging"} was put in ${DEPLOYMENT_FILE}: ${live.url}. Nothing was pushed. ` +
      'If that is the address your friends use, run this again to update it.',
  );
}

/** Puts this build on a second web app of the same script, and leaves the friends' address serving what it served. */
async function stage(deps: DeployDeps, record: Deployment, live: ListedWebApp, listed: readonly ListedWebApp[]): Promise<void> {
  const { clasp, checkout, say } = deps;
  const kept = listed.find((app) => app.deploymentId === record.staging?.deploymentId);
  const strangers = listed.filter((app) => app !== live && app !== kept);

  // Only a file changed by hand says either of these, and going on would put the staging build where friends are
  if (kept === live) {
    throw new DeployRefused(`${DEPLOYMENT_FILE} names the friends' address itself as the staging web app. Take "staging" out of it and run this again. Nothing was pushed.`);
  }

  if (kept && !isStaging(kept)) {
    throw new DeployRefused(
      `The web app ${DEPLOYMENT_FILE} has under "staging" is not one this made for staging: Google has it described as "${kept.description}". ` +
        'If it is the address your friends use, the two entries are the wrong way around. Nothing was pushed.',
    );
  }

  // One this made for staging and lost track of: made from another checkout, or made with Google when its id never came back
  if (!kept && strangers.length === 1 && isStaging(strangers[0]!)) {
    const found = webAppFor(strangers[0]!.deploymentId);

    await checkout.writeDeployment(withStaging(record, found));

    throw new DeployRefused(
      `The linked script has a staging web app this checkout had no record of, so it was put in ${DEPLOYMENT_FILE} under "staging": ${found.url}. Nothing was pushed. ` +
        'Run this again to put this build there.',
    );
  }

  if (strangers.length > 0) {
    throw new DeployRefused(
      `The linked script has ${webApps(strangers.length)} that this checkout has no record of: ${described(strangers)}. Staging keeps one web app beside the friends' and never makes a third, so nothing was made and nothing was pushed. ` +
        `Find out what ${strangers.length === 1 ? 'it is' : 'they are'} for before anything else: if one is the address your friends use, ${DEPLOYMENT_FILE} names the wrong web app as theirs. ` +
        'One that nobody uses can be archived in the Apps Script editor under Deploy, Manage deployments, which cannot be undone.',
    );
  }

  if (record.staging && !kept) {
    say(`The staging web app on record (${record.staging.url}) is no longer one of the script's, so a new one is made.`);
  }

  let staging: WebApp | undefined = kept && record.staging;

  if (!staging) {
    // It starts on the version friends are served, and gets the build for its own address below
    staging = webAppFor(clasp.createWebApp(STAGING_TITLE, live.version));
    await checkout.writeDeployment(withStaging(record, staging));
  }

  const build = await publish(deps, staging, STAGING_TITLE);
  await checkout.writeDeployment(withStaging(record, { deploymentId: staging.deploymentId, url: staging.url, build }));

  const after = clasp.webApps().find((app) => app.deploymentId === live.deploymentId);
  if (after?.version !== live.version) {
    throw new Error(
      `The friends' address ${record.url} served version ${live.version} of the script before this and ${after ? `serves version ${after.version}` : 'is gone'} now, which staging must never bring about. ` +
        "Look at the script's deployments in the Apps Script editor before doing anything else.",
    );
  }

  say(`\nStaging at ${staging.url}`);
  say(`The friends' address ${record.url} was not touched: it serves version ${live.version} of the script, as before.`);
  say('Check it with "npm run check:live -- --staging". Then "npm run deploy" puts this code at the friends\' address.');
}

/**
 * Says whether what is about to go live is what was last put at the staging address. Going live without
 * is allowed, and said. Whether the check was run there, and passed, is not something this can know.
 */
async function sayWhetherStaged({ checkout, say }: DeployDeps, staging: StagingWebApp | undefined): Promise<void> {
  if (!staging?.build) {
    say('Note: this code was not put at the staging address first ("npm run deploy -- --staging", then "npm run check:live -- --staging").');

    return;
  }

  // The same sources built for the same address are the same files, and so the same mark
  const now = await checkout.build(staging.url);

  say(
    now === staging.build
      ? `This is the code that was last put at the staging address (${now}).`
      : `Note: this is not the code that was last put at the staging address. That was ${staging.build}; built for that address, this is ${now}.`,
  );
}

/**
 * Puts this build at the friends' address, then has the staging web app serve that same version, so
 * that the second address never runs older code on the Sheet than the first.
 */
async function goLive(deps: DeployDeps, record: Deployment, live: ListedWebApp, listed: readonly ListedWebApp[]): Promise<void> {
  const { clasp, checkout, say, now } = deps;
  const kept = listed.find((app) => app.deploymentId === record.staging?.deploymentId);
  // The staging web app, when the one on record is still the script's and is one this made for staging
  const staging = kept && kept !== live && isStaging(kept) ? record.staging : undefined;

  await sayWhetherStaged(deps, staging);
  await publish(deps, record, TITLE);
  say(`\nLive at ${record.url}`);

  if (staging) {
    try {
      const served = clasp.webApps().find((app) => app.deploymentId === live.deploymentId)?.version;
      if (served === undefined) {
        throw new Error("the friends' web app is not among the script's");
      }

      clasp.updateWebApp(staging.deploymentId, `${STAGING_TITLE}, on the version live since ${now().toISOString()}`, served);
      say(`The staging web app at ${staging.url} now serves that same version, ${served}.`);
    } catch (error) {
      say(`The staging web app at ${staging.url} could not be given the version that just went live (${error instanceof Error ? error.message : String(error)}). The next deploy tries again.`);
    }
  } else if (record.staging) {
    say(`The staging web app on record (${record.staging.url}) ${kept ? 'is not one this made for staging' : "is no longer one of the script's"}, so it was taken off the record and nothing was done to it.`);
  }

  if (record.staging) {
    // What was tried there has gone live or been passed over: the next staging says anew what it tried
    await checkout.writeDeployment(withStaging(record, staging && { deploymentId: staging.deploymentId, url: staging.url }));
  }

  const strangers = listed.filter((app) => app !== live && !(staging && app === kept));
  if (strangers.length > 0) {
    say(`The script also has ${webApps(strangers.length)} that this checkout has no record of, left as ${strangers.length === 1 ? 'it was' : 'they were'}: ${described(strangers)}.`);
  }
}

export async function deploy(mode: Mode, deps: DeployDeps): Promise<void> {
  const { clasp, checkout } = deps;
  const linked = checkout.linked();
  const elsewhere = linked ? null : checkout.elsewhere();

  // clasp looks for its link file in the folders above the one it runs in, and takes the folder it finds it in for the
  // project. From here it would push that folder's build, not this one's, and refuse to make a project under it
  if (elsewhere?.above) {
    throw new DeployRefused(
      `This checkout has no ${LINK_FILE} of its own, and ${elsewhere.path}, a folder above it, has one. clasp would go by that one and push that folder's build, not this one's. ` +
        // With no record beside it, that file may link some other project, and copying it would point this game's deploy there
        (elsewhere.recorded
          ? `Copy ${LINK_FILE} and ${DEPLOYMENT_FILE} from there into this checkout, or run the deploy there.`
          : `That folder has no ${DEPLOYMENT_FILE}, so its ${LINK_FILE} may not be this game's: do not copy it. Give this checkout the ${LINK_FILE} and ${DEPLOYMENT_FILE} of the game, or move that file out of the way.`) +
        ' Nothing was deployed and nothing was made.',
    );
  }

  const record = await checkout.readDeployment();

  // The two files are per machine and must describe the same script. Carrying on with one of them
  // missing would either strand the game's address on old code or push to a script it doesn't belong to
  if (record && !linked) {
    throw new DeployRefused(
      `This checkout has the game's address on record (${DEPLOYMENT_FILE}, ${record.url}) but is not linked to its script: ${LINK_FILE} is missing, so nothing was deployed.` +
        `${foundElsewhere(elsewhere)} Restore ${LINK_FILE} for that script, or delete ${DEPLOYMENT_FILE} and run "npm run deploy -- --new" to set up a new game at a new address.`,
    );
  }

  if (mode === 'new') {
    return setUp(deps, linked, record, elsewhere);
  }

  if (!linked) {
    throw new DeployRefused(notLinked(elsewhere));
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

  if (isStaging(live)) {
    throw new DeployRefused(
      `The web app ${DEPLOYMENT_FILE} has as the friends' address is one this made for staging: Google has it described as "${live.description}". ` +
        'The two entries are the wrong way around, or the friends\' entry was replaced. Nothing was pushed.',
    );
  }

  return mode === 'staging' ? stage(deps, record, live, listed) : goLive(deps, record, live, listed);
}
