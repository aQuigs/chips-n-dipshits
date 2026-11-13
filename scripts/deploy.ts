/*
 * Puts the current build live on Apps Script. The first run creates the Sheet, its script and the web
 * app's deployment; every later run updates that same deployment, so the address friends have keeps working.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildAll } from './bundle.ts';
import { readDeployment, webAppUrlFor, writeDeployment } from './deployment.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TITLE = "Chips n' Dipshits";

// Web app deployment ids all start this way
const DEPLOYMENT_ID = /AKfycb[\w-]+/;

function clasp(...args: string[]): string {
  const output = execFileSync('npx', ['clasp', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });

  process.stdout.write(output);

  return output;
}

let deployment = await readDeployment();

if (!existsSync(`${ROOT}.clasp.json`)) {
  console.log('No Apps Script project is linked yet, so creating a new Sheet with its script.');
  clasp('create-script', '--type', 'sheets', '--title', TITLE, '--rootDir', 'dist/gas');

  // Creating the project downloads its starter files over the build
  await buildAll(deployment?.url ?? '');
}

if (!deployment) {
  // The page is told its own address, and that only exists once something is deployed
  clasp('push', '--force');

  const deploymentId = DEPLOYMENT_ID.exec(clasp('create-deployment', '--description', TITLE))?.[0];
  if (!deploymentId) {
    throw new Error('clasp did not report a deployment id; run "npx clasp list-deployments" and put it in .deployment.json');
  }

  deployment = { deploymentId, url: webAppUrlFor(deploymentId) };
  await writeDeployment(deployment);
  await buildAll(deployment.url);
}

clasp('push', '--force');
clasp('update-deployment', deployment.deploymentId, '--description', `${TITLE}, deployed ${new Date().toISOString()}`);

console.log(`\nLive at ${deployment.url}`);
