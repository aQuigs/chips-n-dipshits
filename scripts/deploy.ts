/*
 * Puts the current build on Apps Script: `npm run deploy` at the address friends have, which stays the
 * same; `npm run deploy -- --staging` at a second web app of the same script, to try the build where
 * Google serves it before friends get it; `npm run deploy -- --new` sets up a game where there is none.
 * The steps are in `deploySteps.ts`; this file is what they run on for real.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildAll } from './bundle.ts';
import { claspOver, deploy, DeployRefused, modeOf } from './deploySteps.ts';
import { LINK_FILE, mainCheckoutOf, readDeployment, writeDeployment } from './deployment.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function clasp(...args: string[]): string {
  const output = execFileSync('npx', ['clasp', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });

  process.stdout.write(output);

  return output;
}

try {
  await deploy(modeOf(process.argv.slice(2)), {
    clasp: claspOver(clasp),
    checkout: {
      linked: () => existsSync(`${ROOT}${LINK_FILE}`),
      readDeployment,
      writeDeployment,
      build: buildAll,
      mainCheckout: () => mainCheckoutOf(ROOT),
    },
    say: (line) => console.log(line),
    now: () => new Date(),
  });
} catch (error) {
  if (!(error instanceof DeployRefused)) {
    throw error;
  }

  console.error(`\n${error.message}`);
  process.exitCode = 1;
}
