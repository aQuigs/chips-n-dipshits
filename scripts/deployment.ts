import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A web app of the game's script: its id with Google, and the address that id gives it. */
export interface WebApp {
  deploymentId: string;
  url: string;
}

/** The second web app of the same script, where new code is tried before the friends' address gets it. */
export interface StagingWebApp extends WebApp {
  /** The build last put there to be tried, until that one or another goes live. */
  build?: string;
}

/**
 * Where the game is deployed: the web app friends have the address of, and beside it the staging one
 * once there is one. Kept out of git: it is per machine and the address is the only thing guarding the lobby.
 */
export interface Deployment extends WebApp {
  staging?: StagingWebApp;
}

export const LINK_FILE = '.clasp.json';
export const DEPLOYMENT_FILE = '.deployment.json';

/** What Google gives a web app for an id. */
export const WEB_APP_ID = /^AKfycb[\w-]+$/;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILE = join(ROOT, DEPLOYMENT_FILE);

/** The deploy or the check stopped before doing what was asked, on purpose, and its message says what to do. */
export class DeployRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployRefused';
  }
}

export function webAppUrlFor(deploymentId: string): string {
  return `https://script.google.com/macros/s/${deploymentId}/exec`;
}

/**
 * The flags npm kept for itself. `npm run deploy --staging`, with no `--` before the flag, never hands
 * it to the script: npm takes it for a setting of its own, and the script would do what it does unasked.
 */
export function keptByNpm(flags: readonly string[], env: Record<string, string | undefined>): string[] {
  return flags.filter((flag) => env[`npm_config_${flag.replace(/^--/, '')}`] !== undefined);
}

function webAppFrom(saved: unknown, which: string): WebApp {
  const { deploymentId, url } = (saved ?? {}) as Partial<WebApp>;

  // The address is built into the page, which hands out table and seat links under it, so one that is not this id's sends friends elsewhere
  if (typeof deploymentId !== 'string' || !WEB_APP_ID.test(deploymentId) || url !== webAppUrlFor(deploymentId)) {
    throw new DeployRefused(
      `${DEPLOYMENT_FILE} cannot be gone by as it is: ${which} is not a web app's id with the address that id gives. Nothing was done. ` +
        'An entry is {"deploymentId": "<id>", "url": "https://script.google.com/macros/s/<id>/exec"}, with the same id in both places.',
    );
  }

  return { deploymentId, url };
}

/** The record a file holds. One that cannot be gone by is refused, never taken for no record: a deploy with no record may make an address. */
export function deploymentFrom(text: string): Deployment {
  let saved: { staging?: { build?: unknown } };

  try {
    saved = JSON.parse(text) as typeof saved;
  } catch (error) {
    throw new DeployRefused(`${DEPLOYMENT_FILE} cannot be gone by as it is: it is not JSON (${error instanceof Error ? error.message : String(error)}). Nothing was done.`);
  }

  const live = webAppFrom(saved, "the friends' entry");
  if (saved?.staging === undefined) {
    return live;
  }

  const build = saved.staging?.build;

  return { ...live, staging: { ...webAppFrom(saved.staging, 'the entry under "staging"'), ...(typeof build === 'string' ? { build } : {}) } };
}

export async function readDeployment(file: string = FILE): Promise<Deployment | null> {
  let text: string;

  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  return deploymentFrom(text);
}

export async function writeDeployment(deployment: Deployment, file: string = FILE): Promise<void> {
  await writeFile(file, `${JSON.stringify(deployment, null, 2)}\n`);
}

/** Whether a check was asked to play at the staging address, by `--staging` and nothing else. */
export function stagingAsked(args: readonly string[], env: Record<string, string | undefined>): boolean {
  if (keptByNpm(['--staging'], env).length > 0) {
    throw new DeployRefused('npm kept --staging for itself, so this would have played at the friends\' address, and played nowhere. Put "--" before it: npm run check:live -- --staging');
  }

  if (!args.every((arg) => arg === '--staging')) {
    throw new DeployRefused(`"${args.join(' ')}" is nothing this understands. It takes --staging, or nothing at all.`);
  }

  return args.length > 0;
}

/** The address a check plays at: the friends', or the staging one when asked. Never one this checkout has no record of. */
export function addressToCheck(deployment: Deployment | null, staging: boolean): string {
  if (!deployment) {
    throw new DeployRefused('Nothing has been deployed from this checkout, so there is no address to check; run "npm run deploy" first.');
  }

  if (!staging) {
    return deployment.url;
  }

  if (!deployment.staging) {
    throw new DeployRefused('There is no staging web app on record in this checkout; run "npm run deploy -- --staging" first.');
  }

  return deployment.staging.url;
}

/** Another folder that holds per-machine files a checkout lacks. */
export interface LinkFilesElsewhere {
  path: string;
  linked: boolean;
  recorded: boolean;
  /** Whether it is a folder above the checkout. clasp looks there for its link file, and goes by the one it finds. */
  above: boolean;
}

// What git writes in a worktree's `.git` file: where the main checkout keeps that worktree's own git files
const WORKTREE_GIT_DIR = /^gitdir: (.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+\s*$/;

function folderAboveWithLink(root: string): string | null {
  for (let folder = dirname(root); ; folder = dirname(folder)) {
    if (existsSync(join(folder, LINK_FILE))) {
      return folder;
    }

    if (folder === dirname(folder)) {
      return null;
    }
  }
}

/** The checkout that `root` is a git worktree of, or null when it is no worktree. */
function mainCheckoutOf(root: string): string | null {
  const git = join(root, '.git');

  try {
    const gitDir = statSync(git).isFile() ? WORKTREE_GIT_DIR.exec(readFileSync(git, 'utf8'))?.[1] : undefined;

    return gitDir ? resolve(root, gitDir) : null;
  } catch {
    return null;
  }
}

/**
 * Where the per-machine files are for a checkout at `root` that has no link file of its own: a folder
 * above it, which clasp would go by, or else the checkout it is a git worktree of. git ignores the
 * files, so a worktree starts without them however long the main checkout has had them. Null when
 * neither holds any.
 */
export function linkFilesElsewhere(root: string): LinkFilesElsewhere | null {
  const here = resolve(root);
  const above = folderAboveWithLink(here);
  const path = above ?? mainCheckoutOf(here);

  if (!path) {
    return null;
  }

  const found = { path, linked: existsSync(join(path, LINK_FILE)), recorded: existsSync(join(path, DEPLOYMENT_FILE)), above: above !== null };

  return found.linked || found.recorded ? found : null;
}
