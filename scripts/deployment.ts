import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A web app of the game's script: its id with Google, and the address that id gives it. */
export interface WebApp {
  deploymentId: string;
  url: string;
}

/**
 * Where the game is deployed: the web app friends have the address of, and beside it the staging one
 * while there is one. Kept out of git: it is per machine and the address is the only thing guarding the lobby.
 */
export interface Deployment extends WebApp {
  /** A second web app of the same script, where new code is tried before the friends' address gets it. */
  staging?: WebApp;
}

export const LINK_FILE = '.clasp.json';
export const DEPLOYMENT_FILE = '.deployment.json';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILE = join(ROOT, DEPLOYMENT_FILE);

export async function readDeployment(): Promise<Deployment | null> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as Deployment;
  } catch {
    return null;
  }
}

export async function writeDeployment(deployment: Deployment): Promise<void> {
  await writeFile(FILE, `${JSON.stringify(deployment, null, 2)}\n`);
}

export function webAppUrlFor(deploymentId: string): string {
  return `https://script.google.com/macros/s/${deploymentId}/exec`;
}

/** The address a check plays at: the friends', or the staging one when asked. Never one this checkout has no record of. */
export function addressToCheck(deployment: Deployment | null, staging: boolean): string {
  if (!deployment) {
    throw new Error('Nothing has been deployed from this checkout, so there is no address to check; run "npm run deploy" first.');
  }

  if (!staging) {
    return deployment.url;
  }

  if (!deployment.staging) {
    throw new Error('There is no staging web app on record in this checkout; run "npm run deploy -- --staging" first.');
  }

  return deployment.staging.url;
}

/** A checkout of the repo that a git worktree belongs to, and which of the two per-machine files it holds. */
export interface MainCheckout {
  path: string;
  linked: boolean;
  recorded: boolean;
}

// What git writes in a worktree's `.git` file: where the main checkout keeps that worktree's own git files
const WORKTREE_GIT_DIR = /^gitdir: (.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+\s*$/;

/**
 * The checkout that `root` is a git worktree of, or null when it is no worktree. The two per-machine
 * files are ignored by git, so a worktree starts without them however long the main checkout has had them.
 */
export function mainCheckoutOf(root: string): MainCheckout | null {
  const git = join(root, '.git');

  try {
    if (!statSync(git).isFile()) {
      return null;
    }

    const path = WORKTREE_GIT_DIR.exec(readFileSync(git, 'utf8'))?.[1];

    return path ? { path, linked: existsSync(join(path, LINK_FILE)), recorded: existsSync(join(path, DEPLOYMENT_FILE)) } : null;
  } catch {
    return null;
  }
}
