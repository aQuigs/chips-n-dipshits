import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Where the game is deployed. Kept out of git: it is per machine and the address is the only thing guarding the lobby. */
export interface Deployment {
  deploymentId: string;
  url: string;
}

const FILE = fileURLToPath(new URL('../.deployment.json', import.meta.url));

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
