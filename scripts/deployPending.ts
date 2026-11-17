/*
 * Says whether the code in this checkout is still to go live: `deploy=true` when the friends' address
 * is answered by anything but the build this code makes for it, `deploy=false` when it serves this code
 * already. That line is all it writes to standard output, so a workflow can take it as a step's
 * output; what it found goes to standard error. It deploys nothing.
 */
import { answersOver } from './answering.ts';
import { buildAll } from './bundle.ts';
import { pending } from './deploySteps.ts';
import { exitOnRefusal, readDeployment } from './deployment.ts';

await exitOnRefusal(async () => {
  const deploy = await pending({
    answers: answersOver(fetch),
    checkout: { readDeployment, build: buildAll },
    say: (line) => console.error(line),
  });

  console.log(`deploy=${deploy}`);
});
