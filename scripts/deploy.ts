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

/** The web apps the linked script already has. The one at @HEAD is the script's own test address, never the one handed out. */
function existingDeployments(): string[] {
  const output = clasp('list-deployments', '--json');
  const listed = JSON.parse(output.slice(output.indexOf('['), output.lastIndexOf(']') + 1)) as { deploymentId: string; versionNumber?: number }[];

  return listed.filter((item) => item.versionNumber !== undefined).map((item) => item.deploymentId);
}

const linked = existsSync(`${ROOT}.clasp.json`);
let deployment = await readDeployment();

// The two files are per machine and must describe the same script. Carrying on with one of them
// missing would either strand the game's address on old code or push to a script it doesn't belong to
if (deployment && !linked) {
  throw new Error(
    `This checkout has the game's address on record (.deployment.json, ${deployment.url}) but is not linked to its script: .clasp.json is missing. ` +
      'Restore .clasp.json for that script, or delete .deployment.json to set up a new game at a new address.',
  );
}

if (!linked) {
  console.log('No Apps Script project is linked yet, so creating a new Sheet with its script.');
  clasp('create-script', '--type', 'sheets', '--title', TITLE, '--rootDir', 'dist/gas');

  // Creating the project downloads its starter files over the build
  await buildAll(deployment?.url ?? '');
}

if (!deployment) {
  // The page is told its own address, and that only exists once something is deployed
  clasp('push', '--force');

  // A script that already has a web app keeps it. A second one would get a new address, and the links friends have would stay on old code
  const existing = existingDeployments();
  if (existing.length > 1) {
    throw new Error(
      `This script already has ${existing.length} web apps (${existing.join(', ')}). Put the one your friends use in .deployment.json as ` +
        '{"deploymentId": "<id>", "url": "https://script.google.com/macros/s/<id>/exec"} and run this again.',
    );
  }

  const deploymentId = existing[0] ?? DEPLOYMENT_ID.exec(clasp('create-deployment', '--description', TITLE))?.[0];
  if (!deploymentId) {
    throw new Error('clasp did not report a deployment id; run "npx clasp list-deployments" and put it in .deployment.json');
  }

  deployment = { deploymentId, url: webAppUrlFor(deploymentId) };
  await writeDeployment(deployment);
  await buildAll(deployment.url);
}

// Checked before anything is pushed: a .clasp.json from one game and a .deployment.json from another would put this code on the wrong script
if (!existingDeployments().includes(deployment.deploymentId)) {
  throw new Error(
    `The linked script (.clasp.json) has no web app ${deployment.deploymentId}, which is the one on record in .deployment.json. ` +
      'The two files are from different games; restore the pair that belongs together.',
  );
}

clasp('push', '--force');
clasp('update-deployment', deployment.deploymentId, '--description', `${TITLE}, deployed ${new Date().toISOString()}`);

console.log(`\nLive at ${deployment.url}`);
